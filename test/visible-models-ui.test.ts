// The Providers sheet's model switches in a real browser at phone size, where this machine has Chromium: the owner
// turns some of a provider's models on, so only those reach the model menu in a session, and a provider they did not
// touch still offers every model it has.
import { type App, cleanUp, home, newSession, root, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

/** Six models, like a hosted provider with hundreds, and a small provider beside it, like a local server. */
const flood = fauxProvider({
    models: [1, 2, 3, 4, 5, 6].map((each) => ({ id: `faux-${each}` })),
});
const local = fauxProvider({ provider: "local", models: [{ id: "local-1" }, { id: "local-2" }] });

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

/** Run a script in the page and read back the JSON it returns. */
async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** Click the element the expression names, and fail the test with `what` when it names nothing. */
async function tap(expression: string, what: string): Promise<void> {
    const clicked = await inPage<boolean>(`
        const target = ${expression};

        if (target === undefined || target === null) {
            return JSON.stringify(false);
        }

        target.click();

        return JSON.stringify(true);
    `);

    assert.ok(clicked, what);
}

/** Wait until a script in the page says true. */
const see = (script: string, what: string) =>
    until(async () => (await inPage<boolean>(script)) === true, what);

const gone = (selector: string) =>
    `return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) === null)`;

/** Wait for the slide in or out to end, so the screen rests before the next tap. */
const slid = () =>
    see(`return JSON.stringify(document.documentElement.dataset.route === undefined)`, "the slide");

/** The store's model list: what every picker in the app holds. */
const offered = () =>
    inPage<string[]>(
        `return JSON.stringify((await import("/store.js")).store.state.models.map((model) => model.provider + "/" + model.id))`,
    );

/** Open the menu in the session's top bar, and the Providers sheet from it. */
async function openProviders(): Promise<void> {
    await tap(`document.querySelector('.topbar [aria-label="Menu"]')`, "the Menu button");
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.sheet?.type === "menu")`,
        "the menu",
    );
    await slid();
    await tap(
        `[...document.querySelectorAll(".sheet .list-item")].find((each) => each.textContent.trim() === "Providers")`,
        "the Providers row",
    );
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.sheet?.type === "providers")`,
        "the Providers sheet",
    );
    await slid();
    await see(
        `return JSON.stringify(document.querySelector(".provider-block") !== null)`,
        "the providers",
    );
}

/** A provider's block in the sheet, by the name its row shows. */
const block = (provider: string) =>
    `[...document.querySelectorAll(".provider-block")].find((each) => each.querySelector(".provider").textContent.includes(${JSON.stringify(provider)}))`;

/** Open a provider's models, or close them, with the button on its row. */
const modelsButton = (provider: string) =>
    `[...${block(provider)}.querySelectorAll("button")].find((each) => each.textContent.trim() === "Models")`;

/** The wording of a provider's row: how many of its models the pickers offer. */
const rowText = (provider: string) =>
    inPage<string>(
        `return JSON.stringify(${block(provider)}.querySelector(".provider .muted").textContent.replace(/\\s+/g, " ").trim())`,
    );

const panel = (provider: string) =>
    see(
        `return JSON.stringify(${block(provider)}.querySelector(".provider-models") !== null)`,
        "the model list",
    );

const panelText = (provider: string) =>
    inPage<string>(
        `return JSON.stringify(${block(provider)}.querySelector(".provider-models").textContent.replace(/\\s+/g, " ").trim())`,
    );

/** Turn a model in the open list on or off, by its row's switch. */
const modelSwitch = (provider: string, id: string) =>
    `[...${block(provider)}.querySelectorAll(".provider-models .setting")].find((each) => each.textContent.includes(${JSON.stringify(id)}))?.querySelector(".switch")`;

/** Buttons in the open list: All, None. */
const panelButton = (provider: string, label: string) =>
    `[...${block(provider)}.querySelectorAll(".provider-models button")].find((each) => each.textContent.trim() === ${JSON.stringify(label)})`;

/** Open the session's model menu and read the models it lists, as `provider/id`, then close it. */
async function menu(): Promise<string[]> {
    await tap(`document.querySelector(".composer-row .model-chip")`, "the model chip");
    await see(
        `return JSON.stringify(document.querySelector(".pop-menu-list") !== null)`,
        "the model menu",
    );
    const rows = await inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll(".pop-menu-list .pop-menu-row")].map((row) => row.title.split(" · ")[0]))`,
    );

    await tap(`document.querySelector(".pop-overlay")`, "the menu's backdrop");
    await see(gone(".pop-menu-list"), "the model menu closed");

    return rows;
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    const { PocketApp } = await import("../src/server/app.ts");

    app = await PocketApp.open({
        dataDir: mkdtempSync(join(root, "visible-models-ui-data-")),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        configureModels: (models) => {
            models.registerNativeProvider(flood.provider);
            models.registerNativeProvider(local.provider);
        },
        home,
    });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "visible-models-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    session = await newSession(app);
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(
        async () =>
            (await inPage<string | null>(
                `return JSON.stringify((await import("/store.js")).store.state.me?.role ?? null)`,
            )) === "owner",
        "signed in",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("the owner's switches decide which models the model menu offers", real, async () => {
    const everyModel = [
        "faux/faux-1",
        "faux/faux-2",
        "faux/faux-3",
        "faux/faux-4",
        "faux/faux-5",
        "faux/faux-6",
        "local/local-1",
        "local/local-2",
    ];

    await page.navigate(`${base}/s/${session}`);
    await see(
        `return JSON.stringify(document.querySelector(".composer textarea") !== null)`,
        "the message box",
    );
    await slid();

    // Before the owner chooses, both providers offer every model they have.
    assert.deepEqual((await offered()).sort(), everyModel);
    assert.deepEqual((await menu()).sort(), everyModel);

    await openProviders();
    assert.match(await rowText("faux"), /6 models/);

    // The list is the provider's catalog, every model switched on.
    await tap(modelsButton("faux"), "the Models button");
    await panel("faux");
    assert.match(await panelText("faux"), /6 of 6 shown/);

    // None, then one model on: only that one is left for the menu, and the other provider keeps all of its own.
    await tap(panelButton("faux", "None"), "None");
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.models.length === 2)`,
        "the models taken out",
    );
    assert.deepEqual((await offered()).sort(), ["local/local-1", "local/local-2"]);
    assert.match(await panelText("faux"), /0 of 6 shown/);

    await tap(modelSwitch("faux", "faux-2"), "the switch for faux-2");
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.models.length === 3)`,
        "the model added back",
    );
    assert.deepEqual((await offered()).sort(), ["faux/faux-2", "local/local-1", "local/local-2"]);
    assert.match(await panelText("faux"), /1 of 6 shown/);

    // The rows say what the sheet did, and the provider the owner did not touch still offers everything.
    assert.match(await rowText("faux"), /1 of 6 models shown/);
    assert.match(await rowText("local"), /2 models/);

    // The session's model menu, which was open over the whole flood: only the chosen models now.
    await page.evaluate(`(await import("/store.js")).closeSheet()`);
    await see(gone(".provider-block"), "the Providers sheet closed");
    assert.deepEqual((await menu()).sort(), ["faux/faux-2", "local/local-1", "local/local-2"]);
});
