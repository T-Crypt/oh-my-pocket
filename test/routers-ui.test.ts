// The router editor in a headless browser: the rail opens it with the routers on this machine; a router duplicated,
// given a stage model, and saved shows in the list and in the model picker's Routers group; a session runs as it.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
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
const DESKTOP = { width: 1440, height: 900, scale: 1, mobile: false };
const dataDir = join(root, "routers-ui-data");
/** Where to leave screenshots, when set: for a person to look at the layout. */
const shots = process.env.PI_POCKET_SHOTS;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let id: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** Click the first element matching `selector` whose text includes `text`. */
async function clickText(selector: string, text: string) {
    const found = await inPage<boolean>(`
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
            .find((each) => each.textContent.includes(${JSON.stringify(text)}));
        el?.click();
        return JSON.stringify(el !== undefined);
    `);

    assert.ok(found, `${selector} with ${text}`);
}

async function shot(name: string) {
    if (shots !== undefined) {
        writeFileSync(
            join(shots, `${name}.jpg`),
            Buffer.from((await page.screenshot()).data, "base64"),
        );
    }
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(join(dataDir, "agents"), { recursive: true });
    mkdirSync(join(dataDir, "hq"), { recursive: true });
    writeFileSync(
        join(dataDir, "agents", "planner.md"),
        "---\ndescription: Writes plan.md.\nmodel: faux/faux-2\n---\nPlan.\n",
    );
    writeFileSync(
        join(dataDir, "agents", "builder.md"),
        "---\ndescription: Builds what the plan says.\nmodel: faux/faux-2\n---\nBuild.\n",
    );
    writeFileSync(
        join(dataDir, "hq", "ROUTER.md"),
        "You route. Spawn `planner`, then `builder`.\n",
    );
    app = await openApp(scriptedModel(), dataDir);
    id = await newSession(app);
    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
    });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "routers-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.setViewport(DESKTOP);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "the rail opens the editor; a duplicated router with a stage model saves, and a session runs as it",
    real,
    async () => {
        await page.navigate(`${base}/s/${id}`);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".rail-routers") !== null)`,
                ),
            "the rail's Routers button",
            20_000,
        );
        await page.click({ selector: ".rail-routers" });
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify([...document.querySelectorAll(".routers-list .list-item")].some((each) => each.textContent.includes("router-main")))`,
                ),
            "the detected router in the list",
        );
        assert.equal(
            await inPage<string>(
                `return JSON.stringify([...document.querySelectorAll(".routers-stage .mono")].map((each) => each.textContent).join(","))`,
            ),
            "planner,builder",
            "the roles the prompt names, first",
        );
        await shot("editor");

        await clickText(".routers-actions .button", "Duplicate");
        await page.evaluate(`
        const set = (el, value) => {
            const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
            el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
        };
        const inputs = document.querySelectorAll(".routers-form input:not([type])");
        set(inputs[0], "Vision planner");
        set(inputs[1], "vision-planner");
        set(document.querySelector('select[aria-label="Router model"]'), "faux/faux-1");
        set(document.querySelector('select[aria-label="Model for planner"]'), "faux/faux-vision");
        return "null";
    `);
        await clickText(".routers-actions .button", "Save");
        await until(
            () => app.routers().some((router) => router.id === "vision-planner"),
            "the saved router",
        );
        assert.deepEqual(app.routers().find((router) => router.id === "vision-planner")?.stages, {
            // Duplicated: the detected router's stages come along, the one changed here with them.
            planner: "faux/faux-vision",
            builder: "faux/faux-2",
        });

        await clickText(".routers-actions .button", "Use in this session");
        await until(
            async () => (await app.routerFor(id))?.id === "vision-planner",
            "the session's router",
        );
        await page.click({ selector: ".board-head .icon-button" });
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".model-chip .model-name")?.textContent.trim() === "Vision planner")`,
                ),
            "the model chip names the router",
        );

        await page.click({ selector: ".model-chip" });
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify([...document.querySelectorAll(".router-row")].some((each) => each.textContent.includes("Vision planner")))`,
                ),
            "the picker's Routers group",
        );
        await shot("picker");
        await page.setViewport(VIEWPORTS.mobile);
        await page.press("Escape");
        await page.click({ selector: ".rail-routers" }).catch(() => {});
        await shot("phone");
    },
);
