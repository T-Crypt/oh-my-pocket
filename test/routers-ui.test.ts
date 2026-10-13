// The router editor in a headless browser: a new router starts as Standard's stages on this session's model; `/` adds
// an installed skill to a stage; stages are added, moved, and removed; it saves, and a session runs as it. On a phone
// the list and one router take the screen in turn. Routers found on the machine sit apart, read-only.
import {
    type App,
    cleanUp,
    home,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** Set a field's value as a person would, so the page hears it. */
async function fill(selector: string, value: string) {
    await page.evaluate(`
        const el = document.querySelector(${JSON.stringify(selector)});
        const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
        return "null";
    `);
}

const shown = (selector: string) =>
    inPage<boolean>(
        `const el = document.querySelector(${JSON.stringify(selector)}); return JSON.stringify(el !== null && el.offsetParent !== null)`,
    );

const stageNames = () =>
    inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll(".router-stage-name")].map((each) => each.value))`,
    );

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

    mkdirSync(join(dataDir, "routers"), { recursive: true });
    mkdirSync(join(home, ".agents", "skills", "checklist"), { recursive: true });
    writeFileSync(
        join(home, ".agents", "skills", "checklist", "SKILL.md"),
        "---\nname: checklist\ndescription: A checklist to follow.\n---\nCheck.\n",
    );
    writeFileSync(join(dataDir, "routers", "ROUTER.md"), "A router of this machine's own.\n");
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
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    rmSync(join(home, ".agents"), { recursive: true, force: true });
    cleanUp();
});

/** The session, with its model on the page, and the editor open on the list. */
async function openEditor() {
    await page.navigate(`${base}/s/${id}`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify((document.querySelector(".model-chip .model-name")?.textContent.trim() ?? "") !== "")`,
            ),
        "the session",
        20_000,
    );
    await inPage<null>(
        `(document.querySelector(".rail-routers") ?? document.querySelector('[data-place="routers"]'))?.click(); return "null"`,
    );
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify([...document.querySelectorAll(".routers-list .button")].some((each) => each.textContent.includes("New router")))`,
            ),
        "the editor's list",
    );
}

test(
    "a new router: Standard's stages on this session's model, a skill by /, stages added, moved, removed, saved, used",
    real,
    async () => {
        await page.setViewport(DESKTOP);
        await openEditor();
        assert.ok(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".routers-found summary").textContent.includes("From this machine (1)"))`,
            ),
            "the machine's own router, apart",
        );

        await clickText(".routers-list .button", "New router");
        await until(async () => (await stageNames()).length === 5, "the new router's stages");
        assert.deepEqual(await stageNames(), ["Plan", "Implement", "Review", "Fix", "Ship"]);
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector('select[aria-label="Router model"]').value)`,
            ),
            "faux/faux-1",
        );

        // `/` lists the installed skills; one picked shows as a chip.
        await fill('input[aria-label="Plan: add a skill"]', "/che");
        await until(async () => await shown(".router-skill-menu"), "the skill menu");
        await shot("skill-menu");
        await clickText(".router-skill-menu button", "/checklist");
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".router-skill")?.textContent.includes("checklist") === true)`,
                ),
            "the skill's chip",
        );

        await fill('select[aria-label="Model for Plan"]', "faux/faux-vision");
        await fill('select[aria-label="New stage\'s template"]', "custom");
        await clickText(".routers-add .button", "Add stage");
        await until(async () => (await stageNames()).length === 6, "the added stage");
        await page
            .click({ selector: '.router-card:last-of-type [aria-label="Move up"]' })
            .catch(() => {});
        await inPage<null>(
            `[...document.querySelectorAll('[aria-label="Move up"]')].at(-1).click(); return "null"`,
        );
        await until(async () => (await stageNames())[4] === "Custom", "the stage moved up");
        await inPage<null>(
            `document.querySelector('[aria-label="Remove Fix"]').click(); return "null"`,
        );
        await until(async () => !(await stageNames()).includes("Fix"), "the stage removed");
        await fill(".routers-form input", "Vision planner");
        await shot("new-router");
        await clickText(".routers-actions .button", "Save");
        await until(
            () => app.routers().some((router) => router.id === "my-router"),
            "the saved router",
        );

        const router = app.routers().find((each) => each.id === "my-router")!;

        assert.equal(router.label, "Vision planner");
        assert.deepEqual(
            router.pipeline!.map((each) => each.id),
            ["plan", "implement", "review", "custom", "ship"],
        );
        assert.deepEqual(router.pipeline![0]!.skills, ["checklist"]);
        assert.equal(router.pipeline![0]!.model, "faux/faux-vision");

        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify([...document.querySelectorAll(".routers-actions .button")].some((each) => each.textContent.includes("Use in this session")))`,
                ),
            "Use in this session",
        );
        await clickText(".routers-actions .button", "Use in this session");
        await until(
            async () => (await app.routerFor(id))?.id === "my-router",
            "the session's router",
        );
    },
);

test("on a phone, the list and one router take the screen in turn", real, async () => {
    await app.commands.setRouter(id, owner(app), null);
    await page.setViewport(VIEWPORTS.mobile);
    await openEditor();
    assert.equal(await shown(".routers-list"), true);
    await shot("phone-list");

    await clickText(".routers-list .list-item", "Standard");
    await until(async () => await shown(".routers-form"), "the router");
    assert.equal(await shown(".routers-list"), false, "the list gives the screen up");
    assert.equal(await shown(".routers-back"), true);
    await shot("phone-router");

    await page.click({ selector: ".routers-back" });
    await until(async () => await shown(".routers-list"), "back to the list");
    assert.equal(await shown(".routers-form"), false);
});
