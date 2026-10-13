// Session-row actions in a dedicated headless browser, with isolated app data and a scripted model.
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
import { mkdirSync, mkdtempSync } from "node:fs";
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

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let active: ConversationId;
let archived: ConversationId;
let folderSessions: ConversationId[];
const longFolder = "a-directory-with-a-name-long-enough-to-ellipsis-in-the-session-sidebar";

let list = ".sidebar";
const row = (id: ConversationId) => `${list} .session-row[data-id="${id}"]`;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

async function focused(selector: string): Promise<boolean> {
    return await inPage<boolean>(
        `return JSON.stringify(document.activeElement?.matches(${JSON.stringify(selector)}) ?? false)`,
    );
}

/** Use real Tab input, so the main button gets keyboard focus without hovering the row. */
async function tabTo(selector: string): Promise<void> {
    for (let step = 0; step < 40; step++) {
        await page.press("Tab");

        if (await focused(selector)) {
            return;
        }
    }

    assert.fail(`Tab did not reach ${selector}`);
}

type Appearance = {
    actions: string[];
    opacity: number[];
    transforms: string[];
    display: string;
    sideOpacity: number;
    reserved: number;
    sideWidth: number;
    titleRight: number;
    actionLeft: number;
    outlineStyle: string;
    outlineWidth: number;
    outlineOffset: number;
};

const appearance = (id: ConversationId) =>
    inPage<Appearance>(`
        const row = document.querySelector(${JSON.stringify(row(id))});
        const buttons = [...row.querySelectorAll(".session-act")];
        const side = row.querySelector(".session-side");
        const style = getComputedStyle(side);
        const outline = getComputedStyle(row.querySelector(".session"));

        return JSON.stringify({
            actions: buttons.map((button) => button.getAttribute("aria-label")),
            opacity: buttons.map((button) => Number(getComputedStyle(button).opacity)),
            transforms: buttons.map((button) => getComputedStyle(button).transform),
            display: getComputedStyle(row.querySelector(".session-actions")).display,
            sideOpacity: Number(style.opacity),
            reserved: parseFloat(style.minWidth) || 0,
            sideWidth: side.getBoundingClientRect().width,
            titleRight: row.querySelector(".session-title").getBoundingClientRect().right,
            actionLeft: buttons[0].getBoundingClientRect().left,
            outlineStyle: outline.outlineStyle,
            outlineWidth: parseFloat(outline.outlineWidth),
            outlineOffset: parseFloat(outline.outlineOffset),
        });
    `);

/** Wait for the CSS transitions too, then check the space the controls need. */
async function shown(id: ConversationId, actions: string[]): Promise<void> {
    await until(async () => {
        const now = await appearance(id);

        return (
            now.opacity.every((opacity) => opacity === 1) &&
            now.transforms.every((transform) => transform === "none") &&
            now.sideOpacity === 0
        );
    }, "actions shown, metadata hidden");
    const now = await appearance(id);
    const reserved = actions.length === 1 ? 26 : 56;

    assert.deepEqual(now.actions, actions);
    assert.deepEqual(
        now.transforms,
        actions.map(() => "none"),
    );
    assert.equal(now.reserved, reserved);
    assert.ok(now.sideWidth >= reserved, "metadata reserves the controls' width");
    assert.ok(now.titleRight <= now.actionLeft, "the title does not run underneath the controls");
}

async function hidden(id: ConversationId): Promise<void> {
    await until(async () => {
        const now = await appearance(id);

        return now.opacity.every((opacity) => opacity === 0) && now.sideOpacity === 1;
    }, "actions hidden, metadata restored");
    assert.equal((await appearance(id)).reserved, 0);
}

async function selectTab(name: "Recent" | "Folders" | "Archived"): Promise<void> {
    const index = await inPage<number>(`
        const tabs = [...document.querySelectorAll(${JSON.stringify(`${list} .session-tabs [role="tab"]`)})];
        return JSON.stringify(tabs.findIndex((tab) => tab.textContent.trim() === ${JSON.stringify(name)}));
    `);

    assert.ok(index >= 0, `${name} tab exists in the current list`);
    await page.click({ selector: `${list} .session-tabs [role="tab"]:nth-of-type(${index + 1})` });
    await until(
        async () =>
            await inPage<boolean>(`
                const tab = document.querySelector(${JSON.stringify(`${list} .session-tabs [aria-selected="true"]`)});
                return JSON.stringify(tab?.textContent.trim() === ${JSON.stringify(name)});
            `),
        `${name} tab selected`,
    );
}

/** Check the painted outline against every scrolling/folding ancestor, not just its offset. */
async function insetOutline(selector: string): Promise<void> {
    assert.ok(await focused(selector), "real keyboard input focused the requested control");
    const outline = await inPage<{
        visible: boolean;
        style: string;
        width: number;
        offset: number;
        clipped: string[];
    }>(`
        const button = document.querySelector(${JSON.stringify(selector)});
        const style = getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        const width = parseFloat(style.outlineWidth);
        const offset = parseFloat(style.outlineOffset);
        const outside = width + offset;
        const clipped = [];

        for (let parent = button.parentElement; parent; parent = parent.parentElement) {
            const bounds = parent.getBoundingClientRect();
            const css = getComputedStyle(parent);
            const clips = (value) => ["hidden", "auto", "scroll", "clip"].includes(value);

            if ((clips(css.overflowX) && (rect.left - outside < bounds.left - 0.5 || rect.right + outside > bounds.right + 0.5)) ||
                (clips(css.overflowY) && (rect.top - outside < bounds.top - 0.5 || rect.bottom + outside > bounds.bottom + 0.5))) {
                clipped.push(parent.className);
            }
        }

        return JSON.stringify({ visible: button.matches(":focus-visible"), style: style.outlineStyle, width, offset, clipped });
    `);

    assert.equal(outline.visible, true);
    assert.equal(outline.style, "solid");
    assert.ok(outline.width > 0, "keyboard focus has a visible outline");
    assert.ok(outline.offset + outline.width <= 0, "the complete outline is inset");
    assert.deepEqual(outline.clipped, [], "no folding or scrolling ancestor clips the outline");

    if (selector.includes(".group-head")) {
        await until(async () => {
            const colors = await inPage<[number[], number[]]>(`
                const style = getComputedStyle(document.querySelector(${JSON.stringify(selector)}));
                const context = new OffscreenCanvas(1, 1).getContext("2d");
                return JSON.stringify([style.color, style.getPropertyValue("--text").trim()].map((color) => {
                    context.fillStyle = color;
                    context.fillRect(0, 0, 1, 1);
                    return [...context.getImageData(0, 0, 1, 1).data];
                }));
            `);

            return colors[0].every((channel, index) => channel === colors[1][index]);
        }, "keyboard-focused group label transitions to the readable theme text color");
    }
}

async function fresh(mobile = false): Promise<void> {
    list = mobile ? ".home-list" : ".sidebar";
    await page.setViewport(mobile ? VIEWPORTS.mobile : DESKTOP);
    await page.navigate(`${base}/`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(row(active))}) !== null)`,
            ),
        "the session list",
        20_000,
    );
    await selectTab("Recent");
    await page.hover({ x: 1, y: 1 });
    assert.equal(
        await inPage<boolean>(`return JSON.stringify(matchMedia("(hover: hover)").matches)`),
        !mobile,
        "a mouse on the desktop, touch on the phone",
    );
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    active = await newSession(app);
    archived = await newSession(app);
    await app.commands.updateSession(archived, owner(app), { archived: true });
    const cwd = join(root, longFolder);

    mkdirSync(cwd);
    folderSessions = [await newSession(app, cwd), await newSession(app, cwd)];
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "session-row-ui-")),
        load: async () => undefined,
        save: () => {},
        // A mouse, whatever this machine has: headless Chromium without one says (hover: none), and rows show their
        // buttons only where a pointer can hover. The phone size's touch emulation still makes it (hover: none).
        args: [
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ],
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "keyboard focus on a session reveals Archive and Pin; tabbing keeps them shown",
    real,
    async () => {
        await fresh();
        await hidden(active);
        await tabTo(`${row(active)} > .session`);
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(row(active))}).matches(":hover"))`,
            ),
            false,
            "keyboard focus alone, not hover",
        );
        await shown(active, ["Archive", "Pin"]);
        const outline = await appearance(active);

        assert.equal(outline.outlineStyle, "solid");
        assert.ok(outline.outlineWidth > 0, "the focused row has an outline");
        assert.ok(
            outline.outlineOffset + outline.outlineWidth <= 0,
            "the outline stays inside the row rather than being clipped by the folding group",
        );
        await page.press("Tab");
        assert.ok(await focused(`${row(active)} [aria-label="Archive"]`));
        await shown(active, ["Archive", "Pin"]);
        await page.press("Tab");
        assert.ok(await focused(`${row(active)} [aria-label="Pin"]`));
        await shown(active, ["Archive", "Pin"]);
        await page.press("Tab");
        await hidden(active);

        // Hover still reveals the same controls, and leaving still restores metadata.
        await page.hover({ selector: `${row(active)} > .session` });
        await shown(active, ["Archive", "Pin"]);
        await page.hover({ x: 1, y: 1 });
        await hidden(active);
    },
);

test("a click opens a session without leaving its row's actions shown", real, async () => {
    await fresh();
    await page.click({ selector: `${row(active)} > .session` });
    await page.hover({ x: 1, y: 1 });
    assert.ok(await focused(`${row(active)} > .session`), "the click left focus on the row");
    await hidden(active);
});

test("an archived row reserves only one action's space on keyboard focus", real, async () => {
    await fresh();
    await selectTab("Archived");
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(row(archived))}) !== null)`,
            ),
        "the archived row",
    );
    await page.hover({ x: 1, y: 1 });
    await hidden(archived);
    await tabTo(`${row(archived)} > .session`);
    await shown(archived, ["Unarchive"]);
    await page.press("Tab");
    assert.ok(await focused(`${row(archived)} [aria-label="Unarchive"]`));
    await shown(archived, ["Unarchive"]);
    await page.press("Tab");
    await hidden(archived);
});

for (const mobile of [false, true]) {
    test(
        `Today header has an unclipped Tab focus outline on ${mobile ? "mobile" : "desktop"}`,
        real,
        async () => {
            await fresh(mobile);
            const header = `${list} .session-group:first-child > .group-head`;

            assert.equal(
                await inPage<string>(
                    `return JSON.stringify(document.querySelector(${JSON.stringify(header)}).querySelector(".group-name").textContent.trim())`,
                ),
                "Today",
            );
            await tabTo(header);
            await insetOutline(header);
        },
    );
}

async function toggleFocusedGroup(header: string): Promise<void> {
    for (const key of ["Enter", "Space"]) {
        for (const expanded of [false, true]) {
            await page.press(key);
            await until(
                async () =>
                    await inPage<boolean>(`
                const header = document.querySelector(${JSON.stringify(header)});
                const group = header.closest(".session-group");
                const height = group.querySelector(".group-body").getBoundingClientRect().height;
                return JSON.stringify(header.getAttribute("aria-expanded") === ${JSON.stringify(String(expanded))} &&
                    group.classList.contains("closed") === ${!expanded} && ${expanded ? "height > 34" : "height === 0"});
            `),
                `${key} ${expanded ? "expands" : "collapses"} the group`,
            );
            await insetOutline(header);
        }
    }
}

test(
    "Today group collapses and expands with Enter and Space while retaining focus",
    real,
    async () => {
        await fresh();
        const header = `${list} .session-group:first-child > .group-head`;

        await tabTo(header);
        await toggleFocusedGroup(header);
        await page.press("Tab");
        assert.ok(
            await focused(`${list} .session-group:first-child .session-row:first-child > .session`),
        );
    },
);

test(
    "Folders groups long directory names with inset keyboard focus and retained toggle focus",
    real,
    async () => {
        await fresh();
        await selectTab("Folders");
        const header = `${list} .session-group:has(.session-row[data-id="${folderSessions[0]}"]) > .group-head`;
        const grouping = await inPage<{
            count: number;
            ids: string[];
            name: string;
            ellipsis: boolean;
        }>(`
        const header = document.querySelector(${JSON.stringify(header)});
        const group = header.closest(".session-group");
        const name = header.querySelector(".last");
        return JSON.stringify({
            count: document.querySelectorAll(${JSON.stringify(`${list} .session-group`)}).length,
            ids: [...group.querySelectorAll(".session-row")].map((row) => row.dataset.id),
            name: name.textContent,
            ellipsis: name.scrollWidth > name.clientWidth && getComputedStyle(name).textOverflow === "ellipsis",
        });
    `);

        assert.equal(grouping.count, 2, "distinct working directories form separate groups");
        assert.deepEqual(grouping.ids.sort(), folderSessions.map(String).sort());
        assert.equal(grouping.name, longFolder);
        assert.equal(
            grouping.ellipsis,
            true,
            "the long directory name is constrained instead of overflowing",
        );
        await page.hover({ x: 1, y: 1 });
        await tabTo(header);
        await insetOutline(header);
        await toggleFocusedGroup(header);
    },
);

for (const tab of ["Recent", "Folders"] as const) {
    test(
        `${tab} first and last rows have unclipped keyboard outlines in every group`,
        real,
        async () => {
            await fresh();
            await selectTab(tab);
            await page.hover({ x: 1, y: 1 });
            const boundaries = await inPage<ConversationId[]>(`
            const groups = [...document.querySelectorAll(${JSON.stringify(`${list} .session-group`)})];
            return JSON.stringify(groups.flatMap((group) => {
                const rows = [...group.querySelectorAll(".session-row")];
                return [...new Set([Number(rows[0].dataset.id), Number(rows.at(-1).dataset.id)])];
            }));
        `);

            assert.equal(boundaries.length, tab === "Folders" ? 3 : 2);

            for (const id of boundaries) {
                await tabTo(`${row(id)} > .session`);
                await shown(id, ["Archive", "Pin"]);
                await until(
                    async () =>
                        await inPage<boolean>(
                            `return JSON.stringify(getComputedStyle(document.querySelector(${JSON.stringify(row(id))})).transform === "none")`,
                        ),
                    "row entrance animation finished",
                );
                await insetOutline(`${row(id)} > .session`);
            }
        },
    );
}

for (const tab of ["Recent", "Folders"] as const) {
    test(
        `${tab} collapsed groups skip hidden rows and actions in both Tab directions`,
        real,
        async () => {
            await fresh();
            await selectTab(tab);
            await page.hover({ x: 1, y: 1 });
            const header = `${list} .session-group:first-child > .group-head`;
            const next =
                tab === "Folders"
                    ? `${list} .session-group:nth-child(2) > .group-head`
                    : ".splash-actions > button:first-child";

            await tabTo(header);
            await page.press("Enter");
            await until(
                async () =>
                    await inPage<boolean>(`
                    const header = document.querySelector(${JSON.stringify(header)});
                    return JSON.stringify(header.getAttribute("aria-expanded") === "false" &&
                        header.closest(".session-group").querySelector(".group-body").inert);
                `),
                "collapsed contents are inert",
            );
            assert.ok(await focused(header), "collapsing retains focus on the header");
            await page.press("Tab");
            assert.ok(await focused(next), "Tab skips every hidden row and its action buttons");
            await page.press("Shift+Tab");
            assert.ok(await focused(header), "Shift+Tab skips hidden contents back to the header");
            await insetOutline(header);
            await page.press("Space");
            await until(
                async () =>
                    await inPage<boolean>(`
                    const header = document.querySelector(${JSON.stringify(header)});
                    return JSON.stringify(header.getAttribute("aria-expanded") === "true" &&
                        !header.closest(".session-group").querySelector(".group-body").inert);
                `),
                "expanded contents are no longer inert",
            );
            await page.press("Tab");
            assert.ok(
                await focused(
                    `${list} .session-group:first-child .session-row:first-child > .session`,
                ),
                "expanding restores the first row to the tab order",
            );
        },
    );
}

test(
    "touch screens keep actions out of layout and tab order, even when the row has focus",
    real,
    async () => {
        await fresh(true);
        assert.equal(
            await inPage<boolean>(`return JSON.stringify(matchMedia("(hover: none)").matches)`),
            true,
        );
        await tabTo(`${row(active)} > .session`);
        await hidden(active);
        assert.equal((await appearance(active)).display, "none");
        await page.press("Tab");
        assert.equal(await focused(`${row(active)} .session-act`), false);
        await page.hover({ selector: `${row(active)} > .session` });
        await hidden(active);
        assert.equal((await appearance(active)).display, "none");
    },
);

test(
    "a focused text field takes Escape before the session selection",
    real,
    async () => {
        await fresh();
        // Open a session so the composer is rendered.
        await page.click({ selector: `${row(active)} > .session` });
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(${JSON.stringify(".composer-wrap textarea")}) !== null)`,
                ),
            "the composer textarea",
        );
        // Ctrl+click the open row to select it (it stays open, we just add it to the selection).
        await tabTo(`${row(active)} > .session`);
        // Native Control+Enter does not carry the modifier through headless clicks;
        // dispatch a MouseEvent with ctrlKey as the reliable fallback.
        await page.evaluate(
            `document.querySelector(${JSON.stringify(row(active) + " > .session")}).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }))`,
        );
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(${JSON.stringify(".select-bar")}) !== null)`,
                ),
            "the select bar appears",
        );
        // Focus the composer textarea, then press Escape.
        await page.evaluate(
            "document.querySelector('.composer-wrap textarea').focus();",
        );
        // Verify textarea is focused
        assert.ok(
            await inPage<boolean>(
                `return JSON.stringify(document.activeElement?.tagName === "TEXTAREA")`,
            ),
            "textarea is focused before Escape",
        );
        await page.press("Escape");
        // The select bar must still be present: the textarea took Escape.
        assert.ok(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(".select-bar")}) !== null)`,
            ),
            "select bar stays while a text field is focused",
        );
        // Blur the field, then press Escape again: the selection clears.
        await page.evaluate("document.activeElement?.blur();");
        await page.press("Escape");
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(${JSON.stringify(".select-bar")}) === null)`,
                ),
            "the select bar disappears after blur + Escape",
        );
    },
);
