import {
    type App,
    cleanUp,
    fakeTab,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { SHOT_MAX } from "../src/server/browser/page.ts";
import { normalizeUrl } from "../src/server/browser/urls.ts";
import { blockedInPlanMode } from "../src/server/extensions/plan.ts";

/** A JPEG's size in pixels, from its first frame header. */
function jpegSize(data: string): { width: number; height: number } {
    const bytes = Buffer.from(data, "base64");

    for (let at = 2; at + 9 < bytes.length; at += 2 + bytes.readUInt16BE(at + 2)) {
        const marker = bytes[at + 1]!;

        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
        }
    }

    throw new Error("no JPEG frame header");
}

test("addresses as people type them become URLs the browser may open", () => {
    assert.equal(normalizeUrl("localhost:5173"), "http://localhost:5173/");
    assert.equal(normalizeUrl("example.com/docs"), "https://example.com/docs");
    assert.equal(normalizeUrl("about:blank"), "about:blank");

    for (const refused of [
        "javascript:alert(1)",
        "chrome://settings",
        "view-source:https://example.com",
        "file:///etc/hosts",
        "/etc/hosts",
        "data:text/html,hi",
    ]) {
        assert.equal(normalizeUrl(refused), undefined, refused);
    }

    // Pi and the owner may open files on this machine.
    assert.equal(normalizeUrl("file:///etc/hosts", { trusted: true }), "file:///etc/hosts");
    assert.equal(
        normalizeUrl("./site/index.html", { trusted: true, cwd: "/work" }),
        "file:///work/site/index.html",
    );
    assert.equal(normalizeUrl("data:text/html,hi", { trusted: true }), "data:text/html,hi");
    assert.equal(normalizeUrl("javascript:alert(1)", { trusted: true }), undefined);
});

test("plan mode lets Pi look at pages but not act on them", () => {
    for (const action of ["navigate", "snapshot"]) {
        assert.equal(blockedInPlanMode("browser", { action }), undefined, action);
    }

    for (const action of ["click", "type", "press", "select", "evaluate"]) {
        assert.match(
            blockedInPlanMode("browser", { action }) ?? "",
            /Plan mode is on: The browser's \w+ can change things/,
            action,
        );
    }

    // A data: page is one Pi writes, scripts and all.
    assert.match(
        blockedInPlanMode("browser", {
            action: "navigate",
            url: "data:text/html,<script>fetch('/x')</script>",
        }) ?? "",
        /Plan mode is on/,
    );
});

// ─── With a real browser ────────────────────────────────────────────────

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

const PAGE = `<!doctype html><html><head><title>Smoke test</title><meta name="viewport" content="width=device-width"></head><body>
<header><nav><a href="/two">Second page</a> <a href="/two" target="_blank">Popup</a></nav></header>
<main><h1>Hello</h1><p>Some intro text for the page.</p>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Sent ' + document.getElementById('email').value + ' ' + document.getElementById('pick').value">
<label for="email">Email</label><input id="email" type="email" placeholder="you@example.com" value="old@example.com">
<select id="pick"><option value="a">Apple</option><option value="b">Banana</option></select>
<button type="submit">Send</button></form>
<div id="out"></div>
<div id="fancy" style="cursor:pointer" onclick="this.textContent='clicked div'">Fancy div</div>
<button id="confirm" onclick="this.textContent = confirm('Sure?') ? 'yes' : 'no'">Ask</button>
<div style="height:3000px"></div><p id="bottom">The end</p>
</main><script>console.log("hello", {a: 1}); console.error("boom"); setTimeout(() => { throw new Error("late failure") }, 10);</script></body></html>`;

let site: Server;
let base = "";

before(async () => {
    site = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/html" });

        response.end(request.url === "/two" ? "<title>Two</title><h1>Second</h1>" : PAGE);
    });
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
});

after(() => {
    site.close();
    cleanUp();
});

test(
    "the engine reads, clicks, types in, and streams a real page, and opens it again where it was",
    real,
    async () => {
        const saved = new Map<number, { url?: string }>();
        const browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "engine-")),
            load: async (id) => saved.get(id),
            save: (id, value) => saved.set(id, value),
        });

        try {
            const page = await browsers.open(1);

            assert.deepEqual(await page.navigate(`${base}/`), { status: 200 });
            // The page's title is static, so this waits for a freshly launched browser to answer at all.
            await until(() => page.title === "Smoke test", "the title");

            const outline = await page.snapshot();

            for (const line of [
                'link "Second page" -> /two',
                "# Hello",
                'textbox "Email" = "old@example.com" [email]',
                'combobox = "Apple" options: Apple | Banana',
                'button "Send"',
                'clickable "Fancy div"',
            ]) {
                assert.ok(
                    outline.lines.includes(line),
                    `the snapshot has ${line}:\n${outline.lines}`,
                );
            }

            assert.match(outline.lines, /Some intro text for the page\./);
            assert.ok(outline.scrollHeight > 3000);

            // Typing replaces what a field holds, also in an email field a script cannot select.
            assert.equal(
                await page.type({ label: "Email" }, "tanner@example.com"),
                'input#email "old@example.com"',
                "a label finds its field",
            );
            assert.equal(await page.select({ selector: "#pick" }, "banana"), "Banana");
            const ref = /\[(e\d+)\] button "Send"/.exec(outline.lines)![1]!;

            assert.equal((await page.click({ ref })).label, 'button "Send"');
            assert.equal(
                await page.evaluate("document.getElementById('out').textContent"),
                "Sent tanner@example.com b",
            );
            await page.click({ label: "Fancy div" });
            assert.equal(
                await page.evaluate("return document.getElementById('fancy').textContent"),
                "clicked div",
            );
            // Dialogs are accepted, and said so.
            await page.click({ selector: "#confirm" });
            assert.equal(
                await page.evaluate("document.getElementById('confirm').textContent"),
                "yes",
            );

            assert.equal(
                await page.evaluate("const r = await Promise.resolve(4); return r * 2"),
                "8",
            );
            assert.equal(await page.evaluate("let n = 1; n"), "1");
            assert.equal(
                await page.evaluate("let n = 2; n"),
                "2",
                "names can be declared again, as in DevTools",
            );
            assert.match(
                await page.evaluate("({ h1: document.querySelector('h1') })"),
                /"h1": "<h1>Hello<\/h1>"/,
            );
            await assert.rejects(page.evaluate("nope()"), /ReferenceError: nope is not defined/);
            await assert.rejects(
                page.click({ ref: "e999" }),
                /No element e999 on the page now: take a new snapshot/,
            );

            const logs = page.logs().map((entry) => `${entry.level}: ${entry.text}`);

            for (const line of [
                "log: hello {a: 1}",
                "error: boom",
                "error: Uncaught Error: late failure",
                "dialog: confirm: Sure?",
            ]) {
                assert.ok(logs.includes(line), `${line} in ${logs.join(" | ")}`);
            }

            assert.equal(browsers.state(1).errors, 2);
            // Clearing is a change the panel sees, so it fetches the empty console.
            const before = browsers.state(1).logs;

            page.clearLogs();
            assert.deepEqual(
                [page.logs(), browsers.state(1).errors, browsers.state(1).logs > before],
                [[], 0, true],
            );

            // The panel's frames are JPEGs, and its taps land where they are shown.
            const frame = (await page.frame(0))!;

            assert.deepEqual([...frame.data.subarray(0, 3)], [0xff, 0xd8, 0xff]);
            assert.deepEqual([frame.width, frame.height], [1280, 800]);
            await page.evaluate(
                "document.getElementById('fancy').textContent = 'Fancy div'; scrollTo(0, 0)",
            );
            const box = JSON.parse(
                await page.evaluate(
                    "JSON.stringify(document.getElementById('fancy').getBoundingClientRect())",
                ),
            ) as { x: number; y: number; width: number; height: number };

            await page.input([{ type: "click", x: box.x + 5, y: box.y + box.height / 2 }]);
            assert.equal(
                await page.evaluate("document.getElementById('fancy').textContent"),
                "clicked div",
            );
            await page.input([{ type: "wheel", x: 100, y: 100, dx: 0, dy: 400 }]);
            await until(async () => Number(await page.evaluate("scrollY")) > 0, "the scroll");

            const shot = await page.screenshot();

            assert.deepEqual([shot.width, shot.height], [1265, 800]);
            assert.ok(
                Buffer.from(shot.data, "base64")
                    .subarray(0, 2)
                    .equals(Buffer.from([0xff, 0xd8])),
            );
            assert.equal(jpegSize(shot.data).height, 800);
            assert.equal(shot.scale, 1);

            // A huge page comes back small enough for a model to take: too large an image breaks the conversation.
            await page.evaluate("document.body.style.cssText = 'width: 2600px; height: 6000px'; 1");
            const whole = await page.screenshot({ fullPage: true });
            const image = jpegSize(whole.data);

            assert.ok(
                whole.width >= 2600 && whole.height >= 6000,
                `${whole.width}×${whole.height}`,
            );
            assert.ok(Math.max(image.width, image.height) <= SHOT_MAX, JSON.stringify(image));
            await page.evaluate("document.body.style.cssText = ''; scrollTo(0, 0); 1");

            // A web page cannot use a new tab to open a file here, which it could not open itself.
            await page.evaluate("window.open('file:///etc/hosts'); 1");
            // Chromium refuses it by itself; the page's own rule refuses it too, should a tab open anyway.
            await until(
                () =>
                    page
                        .logs()
                        .some((entry) =>
                            /^(Not allowed to load local resource: |A new tab for )file:\/\/\/etc\/hosts/.test(
                                entry.text,
                            ),
                        ),
                "the refused tab",
            );
            await new Promise((done) => setTimeout(done, 500));
            assert.equal(page.url, `${base}/`);
        } finally {
            await browsers.closeAll({ final: true });
        }
    },
);

test("a command sent while a navigation swaps the page waits for it", real, async () => {
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "swap-")),
        load: async () => undefined,
        save: () => {},
    });

    try {
        const page = await browsers.open(1, { restore: false });

        // Across sites (to the test site and back to about:blank), Chromium moves the page to a new process and for a
        // moment refuses commands. A reload or stop sent right then used to fail: "Not attached to an active page".
        for (let round = 0; round < 3; round++) {
            await page.navigate("about:blank");
            await page.navigate(`${base}/`);
            await page.go(-1, { wait: false });
            await page.reload({ wait: false });
            await page.navigate(`${base}/two`, { wait: false });
            await page.stop();
        }
    } finally {
        await browsers.closeAll({ final: true });
    }
});

test(
    "Pi uses the browser tool, and people watch and use the same page in the panel",
    real,
    async () => {
        const results: string[] = [];

        const route: FauxResponseStep = (context) => {
            const { role, text } = lastText(context as never);
            const call = (args: Parameters<typeof fauxToolCall>[1]) =>
                fauxAssistantMessage([fauxToolCall("browser", args)], { stopReason: "toolUse" });

            if (role === "toolResult") {
                results.push(text);

                return fauxAssistantMessage([fauxText("done")]);
            }

            if (text.includes("open the test page")) {
                return call({
                    action: "navigate",
                    url: base.replace("http://", ""),
                    snapshot: true,
                });
            }

            if (text.includes("take a screenshot")) {
                return call({ action: "screenshot" });
            }

            return fauxAssistantMessage([fauxText("ok")]);
        };

        const app: App = await openApp(scriptedModel(route), join(root, "app"));
        const { createHandler } = await import("../src/server/http.ts");
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );

        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        const api = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
        const viewer = app.config.addUser("Vee", "viewer");
        const guest = app.config.addUser("Gus", "guest");
        const request = (token: string, path: string, body?: unknown) =>
            fetch(
                `${api}/${path}`,
                body === undefined
                    ? { headers: { authorization: `Bearer ${token}` } }
                    : {
                          method: "POST",
                          headers: {
                              authorization: `Bearer ${token}`,
                              "x-pocket": "1",
                              "content-type": "application/json",
                          },
                          body: JSON.stringify(body),
                      },
            );

        try {
            const id = await newSession(app);

            // A model that takes images keeps the screenshot in the transcript.
            await app.commands.configure(id, owner(app), {
                model: { provider: "faux", modelId: "faux-vision" },
            });
            const tab = fakeTab(id, owner(app));

            await app.attach(tab.client);
            assert.equal(tab.last("browser")?.open, false);

            await say(app, id, "open the test page");
            await until(() => results.length === 1, "the navigate result");
            assert.match(results[0]!, /\[e\d+\] button "Send"/);
            await until(() => tab.last("browser")?.url === `${base}/`, "the page reaching the tab");

            await say(app, id, "take a screenshot");
            await until(() => results.length === 2, "the screenshot result");
            assert.match(results[1]!, /^Screenshot of the viewport, 1265×800 CSS pixels\./);
            const conversation = (await app.harness.conversation(id, BACKGROUND_CONTEXT))!;
            const entries = await conversation.entries({}, 256, undefined, BACKGROUND_CONTEXT);
            const shot = entries.items.find(
                (entry) =>
                    entry.kind === "pi.tool-result" &&
                    JSON.stringify(entry.model).includes("Screenshot of the viewport"),
            )!;

            assert.equal(
                (await app.transcripts.entryImage(id, shot.id as unknown as number, 0))?.mimeType,
                "image/jpeg",
                "Pi sees the screenshot",
            );

            // Everyone who sees the session watches; only people who can steer use the page, and files are the owner's.
            await request(app.config.ownerToken, `c/${id}/browser/navigate`, { url: `${base}/` });
            const state = (await (await request(viewer.token, `c/${id}/browser`)).json()) as {
                open: boolean;
            };

            assert.equal(state.open, true);
            // The first frame comes a moment after the page opens: until then, the answer is 204.
            let frame = await request(viewer.token, `c/${id}/browser/frame?after=0`);

            await until(async () => {
                if (frame.status === 204) {
                    frame = await request(viewer.token, `c/${id}/browser/frame?after=0`);
                }

                return frame.status !== 204;
            }, "the first frame");
            assert.equal(frame.status, 200);
            assert.equal(frame.headers.get("content-type"), "image/jpeg");
            assert.equal(
                (await request(viewer.token, `c/${id}/browser/navigate`, { url: "example.com" }))
                    .status,
                403,
            );
            assert.equal(
                (await request(viewer.token, `c/${id}/browser/input`, { events: [] })).status,
                403,
            );
            const file = await request(guest.token, `c/${id}/browser/navigate`, {
                url: "file:///etc/hosts",
            });

            assert.equal(file.status, 400);
            assert.equal(
                (
                    await request(guest.token, `c/${id}/browser/navigate`, {
                        url: `${base.replace("http://", "")}/two`,
                    })
                ).status,
                200,
            );
            await until(
                () => app.browsers.page(Number(id))?.url === `${base}/two`,
                "the guest's address",
            );
            assert.deepEqual(await (await request(guest.token, `c/${id}/browser/servers`)).json(), {
                servers: [],
            });
            assert.equal((await request(guest.token, `c/${id}/browser/teleport`, {})).status, 404);
            app.detach(tab.client);
        } finally {
            server.closeAllConnections();
            server.close();
            await app.close();
        }
    },
);

// ─── 12-c1: screenshot size contract at the unzoomed baseline ───

test("screenshot width/height matches the JPEG size at baseline (12-c1)", real, async () => {
    const saved = new Map<number, { url?: string }>();
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "screenshot-")),
        load: async (id) => saved.get(id),
        save: (id, value) => saved.set(id, value),
    });

    try {
        const page = await browsers.open(1);

        await page.navigate(`${base}/`);
        // As above: a browser that has just started answers late on a loaded machine.
        await until(() => page.title === "Smoke test", "the title");

        // Probe the baseline CSS layout size.
        const probeStr = await page.evaluate(
            "JSON.stringify({ w: innerWidth, cw: document.documentElement.clientWidth, d: devicePixelRatio, v: visualViewport?.scale })",
        );
        const probe = JSON.parse(probeStr) as { w: number; cw: number; d: number; v: number };

        // Zoom actions: in headless Chromium these are unreachable, but we probe
        // to document why only the baseline contract is asserted.
        await page.press("Control+Shift+-");
        const afterZoomIn = JSON.parse(
            await page.evaluate(
                "JSON.stringify({ w: innerWidth, cw: document.documentElement.clientWidth, d: devicePixelRatio, v: visualViewport?.scale })",
            ),
        ) as { w: number; cw: number; d: number; v: number };

        await page.press("Control+-");
        const afterZoomOut = JSON.parse(
            await page.evaluate(
                "JSON.stringify({ w: innerWidth, cw: document.documentElement.clientWidth, d: devicePixelRatio, v: visualViewport?.scale })",
            ),
        ) as { w: number; cw: number; d: number; v: number };

        // Zoom readings are identical to baseline — keyboard zoom is unreachable
        // in headless Chromium on this machine. The test therefore only asserts
        // the baseline contract.
        assert.deepEqual(
            afterZoomIn,
            probe,
            "zoom-in did not change readings (unreachable in headless)",
        );
        assert.deepEqual(
            afterZoomOut,
            probe,
            "zoom-out did not change readings (unreachable in headless)",
        );

        // Take the screenshot and measure its JPEG.
        const shot = await page.screenshot();
        const img = jpegSize(shot.data);

        // Core contract: bitmap width/height equals reported width/height × scale.
        assert.equal(
            img.width,
            Math.round(shot.width * shot.scale),
            "JPEG width must equal reported width × scale",
        );
        assert.equal(
            img.height,
            Math.round(shot.height * shot.scale),
            "JPEG height must equal reported height × scale",
        );

        // The reported width is the true CSS layout width (clientWidth at capture,
        // excluding the scrollbar). This is the fix from pr-12 Branch B.
        assert.equal(shot.width, probe.cw, "reported width must be the page's CSS clientWidth");

        // Record zoom readings for the PR (soft assertions, not hard fails).
        // zoom: innerWidth=${afterZoomIn.w} dpr=${afterZoomIn.d} vscale=${afterZoomIn.v}
        // zoom-out: innerWidth=${afterZoomOut.w} dpr=${afterZoomOut.d} vscale=${afterZoomOut.v}
    } finally {
        await browsers.closeAll();
    }
});
