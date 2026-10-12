// The message box's Subagents chip in a headless browser: it says what the session's choice comes to, and its sheet
// changes it.
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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const DESKTOP = { width: 1440, height: 900, scale: 1, mobile: false };
const dataDir = join(root, "chip-data");

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let id: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const chip = () =>
    inPage<string | null>(
        `return JSON.stringify(document.querySelector(".subagents-chip")?.textContent.replace(/\\s+/g, " ").trim() ?? null)`,
    );

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(join(dataDir, "agents"), { recursive: true });
    writeFileSync(join(dataDir, "agents", "near.md"), "---\nmodel: faux/faux-2\n---\nNear.\n");
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
        dataDir: mkdtempSync(join(root, "chip-ui-")),
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

test("the chip says what the choice comes to, and its sheet changes it", real, async () => {
    await page.navigate(`${base}/s/${id}`);
    await until(async () => (await chip()) === "auto · local", "the chip on auto", 20_000);

    await page.click({ selector: ".subagents-chip" });
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify([...document.querySelectorAll(".sheet .list-item")].some((each) => each.textContent.includes("This session's model")))`,
            ),
        "the sheet",
    );
    await page.evaluate(
        `[...document.querySelectorAll(".sheet .list-item")].find((each) => each.textContent.includes("This session's model")).click(); return "null"`,
    );
    await until(async () => (await chip()) === "own", "the chip on own");
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".sheet") === null)`,
            ),
        "the sheet closed",
    );

    await app.commands.setSubagents(id, owner(app), { mode: "local" });
    await until(async () => (await chip()) === "local", "the chip follows a change from elsewhere");
});
