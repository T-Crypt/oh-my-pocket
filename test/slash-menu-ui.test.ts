// The slash menu in a real browser where this machine has Chromium: skills are
// offered at the start of a later message, and when "/" is typed later in the
// message. Picking a suggestion mid-text completes it inline: the rest of the
// message stays, and commands never run from mid-text.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
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

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let id: ConversationId;

/** Run a script in the page and read back the JSON it returns. */
async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** Wait until a script in the page returns true. */
const see = (script: string, what: string) =>
    until(async () => (await inPage<boolean>(script)) === true, what);

const settled = () => new Promise((resolve) => setTimeout(resolve, 450));

/** Whether the slash menu currently offers the skill. */
const offersSkill = `return JSON.stringify([...document.querySelectorAll("[role=option]")].some((option) => option.textContent.includes("/skill:poteto")))`;

/** Set the box text the way typing does, with the caret where told. */
const setBox = (text: string, caret = text.length) =>
    page.evaluate(
        `{ const el = document.querySelector(".composer textarea"); el.focus(); el.value = ${JSON.stringify(text)}; el.setSelectionRange(${caret}, ${caret}); el.dispatchEvent(new Event("input", { bubbles: true })); }`,
    );

const boxText = () =>
    inPage<string>(
        `return JSON.stringify(document.querySelector(".composer textarea")?.value ?? null)`,
    );

const notices = () =>
    inPage<number>(`return JSON.stringify((await import("/store.js")).store.state.notices.length)`);

/** Click the menu option naming `name`. */
const pick = (name: string) =>
    page.evaluate(
        `[...document.querySelectorAll("[role=option]")].find((o) => o.textContent.includes(${JSON.stringify(name)}))?.click()`,
    );

before(async () => {
    if (chromium === undefined) {
        return;
    }

    // A user skill: loads with no trust question.
    const dir = join(process.env.PI_CODING_AGENT_DIR!, "skills", "poteto");

    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, "SKILL.md"),
        `---\nname: poteto\ndescription: The poteto steps.\n---\nDo the poteto steps.\n`,
    );
    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "slash-menu-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
        "signed in",
    );
    id = await newSession(app);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("a skill is offered again in a later message", real, async () => {
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${id}`);
    await see(
        `return JSON.stringify(document.querySelector(".composer textarea") !== null)`,
        "the message box",
    );

    await page.type({ selector: ".composer textarea" }, "/skill:poteto do the thing");
    await settled();
    await page.click({ label: "Send" });
    await see(
        `return JSON.stringify(document.querySelector(".composer textarea")?.value === "")`,
        "the box cleared after sending",
    );

    await setBox("/skill");
    await see(offersSkill, "the skill among the commands, second message");
    await setBox("");
});

test("a slash later in the message offers skills", real, async () => {
    await setBox("ask pi to /skill");
    await see(offersSkill, "the skill among the commands, mid-message");
});

test("picking a skill mid-text completes it inline and keeps the rest", real, async () => {
    await setBox("ask pi to /skill");
    await see(offersSkill, "the skill among the commands");
    await pick("/skill:poteto");
    await settled();
    assert.equal(await boxText(), "ask pi to /skill:poteto ");
    await setBox("");
});

test("picking a command mid-text does not run it", real, async () => {
    const before = await notices();

    await setBox("please /copy now", "please /copy".length);
    await see(
        `return JSON.stringify([...document.querySelectorAll("[role=option]")].some((option) => option.textContent.includes("/copy")))`,
        "the command among the options",
    );
    await pick("/copy");
    await settled();
    assert.equal(await boxText(), "please /copy  now");
    assert.equal(await notices(), before, "no command ran");
    await setBox("");
});
