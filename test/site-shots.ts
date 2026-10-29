/**
 * Makes the five screenshots on the product site (`site/shots/*.webp`) from the current web app: a throwaway app with
 * made-up people and projects, a scripted model (so nothing costs money and every run looks the same), and Chromium
 * driven over the DevTools protocol. It needs Chromium and ImageMagick (`magick`).
 *
 *   node test/site-shots.ts              writes the five files into site/shots/
 *   node test/site-shots.ts --serve      stages the same data and keeps the app up, to look at it by hand
 *
 * The phones use a mobile viewport with safe-area insets (the site draws the status bar and the home bar over them);
 * the desktop shot is 1440×900 at 2×.
 */
// helpers.ts first: it points Pi's folder at a temporary one before anything from src/ loads.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    home,
    newSession,
    openApp,
    owner,
    recordCost,
    root,
    until,
} from "./helpers.ts";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, FauxResponseStep } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "../src/server/config.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

// The app shows folders as `~/dev/shop-web`, measured from the home folder: a made-up one.
process.env.HOME = home;

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "..", "site", "shots");
const SERVE = process.argv.includes("--serve");

// ─── The made-up project ────────────────────────────────────────────────────

const SESSION_TS = `export type CookieOptions = {
    name: string;
    value: string;
    httpOnly: boolean;
    sameSite: "strict" | "lax" | "none";
    secure?: boolean;
    path: string;
    maxAge: number;
};

const WEEK = 60 * 60 * 24 * 7;

/** The cookie that keeps a shopper signed in. */
export function sessionCookie(token: string): CookieOptions {
    return {
        name: "sid",
        value: token,
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: WEEK,
    };
}

/** Where to send a shopper after they sign in. */
export function redirectTarget(next: string | undefined): string {
    return next !== undefined && next.startsWith("/") && !next.startsWith("//") ? next : "/account";
}
`;

const SESSION_TEST_TS = `import assert from "node:assert/strict";
import { test } from "node:test";
import { redirectTarget, sessionCookie } from "../src/session.ts";

test("the session cookie is not readable from scripts", () => {
    assert.equal(sessionCookie("abc").httpOnly, true);
});

test("the session cookie lasts a week", () => {
    assert.equal(sessionCookie("abc").maxAge, 604800);
});

test("sign-in goes back to the page the shopper came from", () => {
    assert.equal(redirectTarget("/cart"), "/cart");
    assert.equal(redirectTarget("//evil.example"), "/account");
});
`;

/** A test runner that counts the tests in each file, so "4 passed" is true of the files as they are. */
const RUN_TESTS = `import { readdirSync, readFileSync } from "node:fs";

let total = 0;

for (const file of readdirSync("test").filter((name) => name.endsWith(".test.ts"))) {
    const count = (readFileSync("test/" + file, "utf8").match(/^test\\(/gm) ?? []).length;

    total += count;
    console.log(" ✓ test/" + file + " (" + count + " tests)");
}

console.log("");
console.log(" Tests  " + total + " passed (" + total + ")");
`;

const git = (cwd: string, ...args: string[]) =>
    execFileSync(
        "git",
        [
            "-c",
            "user.name=Riley",
            "-c",
            "user.email=riley@example.com",
            "-c",
            "init.defaultBranch=main",
            ...args,
        ],
        { cwd, stdio: "pipe" },
    );

/** A folder with a package.json, and, for the main project, a git repository. */
function makeProject(name: string, files: Record<string, string>, scripts: Record<string, string>) {
    const dir = join(home, "dev", name);

    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "test"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name, private: true, type: "module", scripts }, null, 4) + "\n",
    );

    for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
    }

    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "Initial commit");

    return dir;
}

// ─── The scripted model ─────────────────────────────────────────────────────

type Step = () => AssistantMessage;

const text = (words: string) => fauxAssistantMessage([fauxText(words)]);
const call = (words: string, name: string, args: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage([...(words === "" ? [] : [fauxText(words)]), fauxToolCall(name, args)], {
        stopReason: "toolUse",
    });

/** What Pi says in answer to a message that contains `match`: one step per model request, the last one a reply. */
const scripts: { match: RegExp; steps: Step[] }[] = [];
const script = (match: RegExp, ...steps: Step[]) => scripts.push({ match, steps });

const SAFE_EDIT = {
    path: "src/session.ts",
    edits: [
        {
            oldText: `        sameSite: "strict",\n`,
            newText: `        sameSite: "lax",\n        secure: true,\n`,
        },
    ],
};

script(
    /redirect loop after signing in/,
    () => call("I'll start with the session code.", "read", { path: "src/session.ts" }),
    () =>
        call(
            'The cookie uses `sameSite: "strict"`. Safari drops it on the redirect back from the sign-in page, so the shopper lands on `/login` again. I will switch it to `lax` and mark it `secure`.',
            "edit",
            SAFE_EDIT,
        ),
    () => call("", "bash", { command: "npm test" }),
    () =>
        text(
            'Fixed. The cookie in `src/session.ts` now uses `sameSite: "lax"` with `secure`, so Safari keeps it through the redirect and the loop is gone. All 3 tests pass.',
        ),
);
script(
    /Push the branch/,
    () =>
        call("Pushing the branch now.", "bash", {
            command: "git push -u origin fix/login-redirect",
        }),
    () => text("Pushed. The branch `fix/login-redirect` is on origin."),
);
script(
    /regression test/,
    () =>
        call("I'll look at the existing session tests first.", "read", {
            path: "test/session.test.ts",
        }),
    () =>
        call("Adding a test that checks the cookie settings Safari needs.", "edit", {
            path: "test/session.test.ts",
            edits: [
                {
                    oldText: `test("sign-in goes back to the page the shopper came from", () => {`,
                    newText: `test("the cookie survives Safari's sign-in redirect", () => {
    assert.equal(sessionCookie("abc").sameSite, "lax");
    assert.equal(sessionCookie("abc").secure, true);
});

test("sign-in goes back to the page the shopper came from", () => {`,
                },
            ],
        }),
    () => call("", "bash", { command: "npm test" }),
    () =>
        text(
            "I added a regression test for the Safari redirect in `test/session.test.ts`. All 4 tests pass in this worktree. Nothing else needs action.",
        ),
);
script(
    /payments API/,
    () =>
        call("Running the checkout end-to-end tests against the new payments API.", "bash", {
            command: "npm run e2e",
        }),
    () => text("The end-to-end run ended."),
);

/** Sessions that only need a believable first exchange. */
const talk = (match: RegExp, ...steps: Step[]) => script(match, ...steps);

talk(
    /release notes for v2\.4/,
    () =>
        call("Reading the changelog since v2.3.", "bash", {
            command: "git log --oneline v2.3..HEAD",
        }),
    () =>
        text(
            "Drafted the v2.4 release notes in `docs/releases/2.4.md`: 6 new features, 11 fixes, and one breaking change to the webhook payload.",
        ),
);
talk(
    /product image grid/,
    () => call("Looking at how the grid loads images.", "read", { path: "src/session.ts" }),
    () =>
        text(
            "The grid loads every image at full size. I suggest `srcset` with lazy loading: it cuts the first load by about 70%.",
        ),
);
talk(
    /Expo to SDK 52/,
    () =>
        call("Checking which packages block the upgrade.", "bash", { command: "npx expo-doctor" }),
    () =>
        text(
            "The upgrade is ready to start. Two packages need newer versions, and nothing else blocks it.",
        ),
);
talk(/staging database credentials/, () =>
    text(
        "Here is the plan: create the new user, update the secret in the vault, restart the API, then drop the old user. I will not touch production.",
    ),
);
talk(
    /dark mode to the account page/,
    () => call("Finding the account page styles.", "read", { path: "src/session.ts" }),
    () =>
        text(
            "The account page uses hard-coded colors. I moved them to CSS variables and added a dark palette.",
        ),
);

talk(/checkout page/, () =>
    text(
        "The checkout page already uses the shared color variables, so it picks up the dark palette. It needs no change.",
    ),
);

function lastUser(request: { messages: { role: string; content: unknown }[] }) {
    const index = request.messages.findLastIndex((message) => message.role === "user");
    const content = request.messages[index]?.content;
    const parts =
        typeof content === "string"
            ? [{ type: "text", text: content }]
            : (content as { type: string; text?: string }[]);

    return {
        index,
        words: parts.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join(""),
    };
}

/** PiP: start the session Riley asks for, say so, then say what the report said. */
const pipRoute = (request: unknown): AssistantMessage => {
    const { words } = lastUser(request as never);
    const messages = (request as { messages: { role: string; content: unknown }[] }).messages;
    const last = messages.at(-1)!;

    if (words.startsWith("[report]")) {
        return text(
            "Pi added a regression test for the Safari redirect. All 4 tests pass in its worktree, and nothing needs you there.",
        );
    }

    if (last.role === "toolResult") {
        const output = JSON.stringify(last.content);
        const id = /\/s\/(\d+)/.exec(output)?.[1] ?? "";

        return text(
            `Started [Safari redirect regression test](/s/${id}) in a worktree of \`shop-web\`. I'm following it and will tell you when it's done.`,
        );
    }

    return call("", "session_start", {
        title: "Safari redirect regression test",
        folder: SHOP,
        worktree: true,
        message:
            'Add a regression test for the Safari sign-in redirect loop in `test/session.test.ts`. The test must check that the session cookie uses `sameSite: "lax"` and `secure`. Run `npm test` and write the result.',
    });
};

const route: FauxResponseStep = (request) => {
    const messages = (request as { messages: { role: string; content: unknown }[] }).messages;

    if (JSON.stringify(messages).includes("You are PiP")) {
        return pipRoute(request);
    }

    const { index, words } = lastUser(request as never);
    const done = messages.slice(index).filter((message) => message.role === "toolResult").length;
    const found = scripts.find((each) => each.match.test(words));

    return (found?.steps[done] ?? (() => text("Done.")))();
};

// ─── Chromium over the DevTools protocol ────────────────────────────────────

type Send = (method: string, params?: Record<string, unknown>) => Promise<Record<string, any>>;

async function launchBrowser() {
    const binary = findBrowser();

    if (binary === undefined) {
        throw new Error("No Chromium on this machine");
    }

    const profile = mkdtempSync(join(root, "chrome-"));
    const child = spawn(
        binary,
        [
            "--headless=new",
            "--remote-debugging-port=0",
            `--user-data-dir=${profile}`,
            "--no-first-run",
            "--no-sandbox",
            "--hide-scrollbars",
            "--force-color-profile=srgb",
            "--disable-gpu",
            "about:blank",
        ],
        { stdio: "ignore" },
    );
    const portFile = join(profile, "DevToolsActivePort");

    await until(() => existsSync(portFile), "Chromium's debugging port");
    const port = readFileSync(portFile, "utf8").split("\n")[0];
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
        type: string;
        webSocketDebuggerUrl: string;
    }[];
    const socket = new WebSocket(
        targets.find((target) => target.type === "page")!.webSocketDebuggerUrl,
    );

    await new Promise((done, fail) => {
        socket.onopen = done;
        socket.onerror = fail;
    });

    let next = 0;
    const waiting = new Map<number, { done: (value: any) => void; fail: (error: Error) => void }>();

    socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        const pending = waiting.get(message.id);

        if (pending !== undefined) {
            waiting.delete(message.id);

            if (message.error === undefined) {
                pending.done(message.result);
            } else {
                pending.fail(new Error(`${message.error.message}`));
            }
        }
    };

    const send: Send = (method, params = {}) =>
        new Promise((done, fail) => {
            const id = ++next;

            waiting.set(id, { done, fail });
            socket.send(JSON.stringify({ id, method, params }));
        });

    return {
        send,
        close: () => {
            socket.close();
            child.kill();
        },
    };
}

type Look = {
    width: number;
    height: number;
    /** Safe-area insets: the phone's status bar and home bar, drawn by the site. */
    top?: number;
    bottom?: number;
    mobile: boolean;
};

const IPHONE: Look = { width: 402, height: 874, top: 62, bottom: 34, mobile: true };
const PIXEL: Look = { width: 412, height: 915, top: 52, bottom: 24, mobile: true };
const DESKTOP: Look = { width: 1440, height: 900, mobile: false };

// ─── Staging ────────────────────────────────────────────────────────────────

let SHOP = "";

async function stage() {
    // The scripted model, under a neutral name: the message box and PiP's panel show it.
    const model = fauxProvider({
        tokensPerSecond: 2000,
        models: [{ id: "faux-1", name: "Demo" }],
    });

    model.setResponses(Array.from({ length: 1000 }, () => route));
    const app = await openApp(model);

    app.config.updateUser(owner(app).id, { name: "Riley" });
    const riley = owner(app);
    const alex = app.config.addUser("Alex", "guest").user;
    const sam = app.config.addUser("Sam", "guest").user;

    // Lancet Guard is off in tests. Turn its module on, make it "on", and make it ask about a push.
    await app.setExtensionEnabled(riley, "guard.ts", true);
    // PiP's panel would show a "Pending memories" row.
    await app.setExtensionEnabled(riley, "memory.ts", false);

    app.guard.status = async () => ({
        available: true,
        enabled: true,
        detail: "Lancet Guard is on.",
        model: { state: "ready", detail: "The LANCET model is installed." },
    });

    app.guard.judge = async (tool, args) => {
        const command = String((args as { command?: string }).command ?? "");

        if (tool === "bash" && /^git push\b/.test(command)) {
            return {
                subject: command,
                decision: {
                    action: "ask",
                    source: "classifier",
                    reason: "git push sends commits to a remote",
                    score: 0.62,
                },
            };
        }

        return undefined;
    };

    SHOP = makeProject(
        "shop-web",
        {
            "src/session.ts": SESSION_TS,
            "test/session.test.ts": SESSION_TEST_TS,
            "scripts/test.mjs": RUN_TESTS,
        },
        { test: "node scripts/test.mjs" },
    );
    git(SHOP, "checkout", "-q", "-b", "fix/login-redirect");

    const other = (name: string, scripts: Record<string, string> = {}) =>
        makeProject(
            name,
            { "src/index.ts": "export {};\n" },
            { test: "node scripts/test.mjs", ...scripts },
        );
    const gateway = other("api-gateway", { e2e: "sleep 3600" });
    const mobile = other("mobile-app");
    const docs = other("docs-site");
    const infra = other("infra");

    /** A session in `cwd` whose first message is `first`, from `user`. */
    const start = async (cwd: string, title: string, user: User, first: string) => {
        const id = await newSession(app, cwd);

        await app.commands.updateSession(id, riley, { title });
        await send(app, id, user, first);

        return id;
    };

    const ids = {} as Record<"login" | "gateway" | "tests" | "dark", ConversationId>;

    ids.login = await start(
        SHOP,
        "Fix the login redirect loop",
        alex,
        "Safari users get stuck in a redirect loop after signing in. Can you find out why? I think it's the cookie.",
    );
    // Committed, so the worktree that PiP's session gets starts from the fix.
    git(SHOP, "commit", "-q", "-am", "Fix the Safari sign-in redirect loop");

    await start(
        docs,
        "Write release notes for v2.4",
        riley,
        "Write release notes for v2.4 from the changelog.",
    );
    await start(
        SHOP,
        "Speed up the product image grid",
        sam,
        "Speed up the product image grid on the category page.",
    );
    await start(
        mobile,
        "Upgrade Expo to SDK 52",
        riley,
        "Upgrade Expo to SDK 52 and tell me what blocks it.",
    );
    await start(
        infra,
        "Rotate the staging database credentials",
        riley,
        "Rotate the staging database credentials. Give me the plan first.",
    );
    ids.dark = await start(
        SHOP,
        "Add dark mode to the account page",
        alex,
        "Add dark mode to the account page.",
    );

    // Working: this one never ends while the shots are taken.
    ids.gateway = await newSession(app, gateway);
    await app.commands.updateSession(ids.gateway, riley, {
        title: "Migrate checkout to the new payments API",
    });
    void send(
        app,
        ids.gateway,
        riley,
        "Migrate checkout to the new payments API, then run the end-to-end tests.",
        false,
    );

    for (const [id, dollars] of [
        [ids.login, 0.38],
        [ids.gateway, 1.12],
    ] as const) {
        await recordCost(app, id, dollars);
    }

    // Riley asks Pi to push. The guard asks, and the call waits for an answer.
    void send(app, ids.login, riley, "Looks good. Push the branch, and I'll open the PR.", false);
    await until(() => app.approvals.forConversation(ids.login).length > 0, "the push to wait");

    // PiP starts a session in a worktree, follows it, and reports.
    const pip = await app.pip.ensure(riley);

    await app.commands.configure(pip, riley, {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    await send(
        app,
        pip,
        riley,
        "Start a session in shop-web that adds a regression test for the Safari redirect, in a worktree, and tell me when it's done.",
    );
    await until(async () => {
        const entries = await app.transcripts.allEntries(pip, true);

        return entries.some(
            (entry) =>
                entry.kind === "assistant" &&
                entry.blocks.some(
                    (block) => block.type === "text" && block.text.includes("nothing needs you"),
                ),
        );
    }, "PiP's report");

    ids.tests = app
        .sessions()
        .find((session) => session.title === "Safari redirect regression test")!
        .id as unknown as ConversationId;
    await recordCost(app, ids.tests, 0.14);

    // Alex and Sam are in the session with Riley, and talk in its side chat.
    const tabs = [alex, sam].map((user) => fakeTab(ids.login, user));

    for (const tab of tabs) {
        await app.attach(tab.client);
    }

    const say = (user: User, words: string) =>
        app.collab.postChat(ids.login, user, { text: words, requestId: crypto.randomUUID() });

    await say(
        alex,
        "@Riley it was the cookie: sameSite strict. Safari drops it on the redirect, so I set lax and secure.",
    );
    await say(sam, "Does iOS have the same problem?");
    await say(alex, "Yes. Chrome on iOS uses WebKit too, so the fix covers it.");

    return { app, riley, alex, sam, ids, pip, tabs };
}

/** Send a message as `user`; wait for Pi's answer unless `wait` is false. */
async function send(app: App, id: ConversationId, user: User, words: string, wait = true) {
    const { submissionId } = await app.commands.submit(id, user, {
        text: words,
        requestId: crypto.randomUUID(),
    });

    if (wait) {
        await (await app.harness.submission(submissionId, context))!.wait(context);
    }
}

const staged = await stage();
const { app, ids } = staged;
const server = createServer(
    createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
);

await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const login = `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`;

const stop = async () => {
    // The end-to-end run in "Migrate checkout" would go on for an hour.
    await app.commands.abort(ids.gateway, staged.riley).catch(() => {});
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
};

if (SERVE) {
    console.log(login);
    process.on("SIGINT", () => void stop().then(() => process.exit(0)));
    await new Promise(() => {});
}

// ─── The shots ──────────────────────────────────────────────────────────────

const browser = await launchBrowser();
const { send: cdp } = browser;
const png = process.env.SITE_SHOTS_PNG;

if (png !== undefined) {
    mkdirSync(png, { recursive: true });
}

/** Run a script in the page; it may await, and returns JSON. */
async function page<T = unknown>(script: string): Promise<T> {
    const result = await cdp("Runtime.evaluate", {
        expression: `(async () => { ${script} })()`,
        awaitPromise: true,
        returnByValue: true,
    });

    if (result.exceptionDetails !== undefined) {
        throw new Error(`In the page: ${JSON.stringify(result.exceptionDetails)}`);
    }

    return result.result.value as T;
}

/** Wait until a script in the page returns something true. */
const seen = (script: string, what: string) =>
    until(async () => Boolean(await page(script)), what, 15_000);
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Let animations and fonts finish, so the picture is of a page at rest. */
async function settle() {
    await page(`
        await document.fonts.ready;
        await Promise.all(document.getAnimations()
            .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
            .map((animation) => animation.finished.catch(() => {})));
    `);
    await pause(500);
}

async function frame(look: Look, path: string, ready = ".composer textarea") {
    await cdp("Emulation.setDeviceMetricsOverride", {
        width: look.width,
        height: look.height,
        deviceScaleFactor: 2,
        mobile: look.mobile,
    });
    await cdp("Emulation.setTouchEmulationEnabled", { enabled: look.mobile });
    await cdp("Emulation.setSafeAreaInsetsOverride", {
        insets: { top: look.top ?? 0, bottom: look.bottom ?? 0, left: 0, right: 0 },
    });
    await cdp("Page.navigate", { url: `${base}${path}` });
    await seen(`return document.querySelector(${JSON.stringify(ready)}) !== null`, "the page");
    await seen(`return document.fonts.status === "loaded"`, "fonts");
}

/** Scroll every scrolling box in the page to its end: the newest messages. */
const toEnd = () =>
    page(`
        for (const element of document.querySelectorAll("*")) {
            const style = getComputedStyle(element);

            if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight) {
                element.scrollTop = element.scrollHeight;
            }
        }
    `);

/** Click the first button whose label or text matches. */
const tap = (match: string, within = "document") =>
    page(`
        const button = [...${within}.querySelectorAll("button, [role=button], summary")].find((each) =>
            new RegExp(${JSON.stringify(match)}).test((each.getAttribute("aria-label") ?? "") + " " + each.textContent));

        if (button === undefined) {
            throw new Error("No button: " + ${JSON.stringify(match)});
        }

        button.click();
    `);

async function shoot(name: string) {
    await settle();
    const { data } = await cdp("Page.captureScreenshot", { format: "png", fromSurface: true });
    const file = join(root, `${name}.png`);

    writeFileSync(file, Buffer.from(String(data), "base64"));

    if (png !== undefined) {
        writeFileSync(join(png, `${name}.png`), Buffer.from(String(data), "base64"));
    }

    const out = join(OUT, `${name}.webp`);

    execFileSync("magick", [file, "-quality", "82", "-define", "webp:method=6", out]);
    console.log(`${name}.webp  ${(readFileSync(out).length / 1024).toFixed(0)} KB`);
}

try {
    await cdp("Page.enable");
    await cdp("Runtime.enable");
    // Signs the browser in as Riley.
    await cdp("Page.navigate", { url: login });
    await seen(
        `return location.pathname === "/" && document.querySelector("nav, aside") !== null`,
        "sign-in",
    );

    // PiP, over the session Riley is in. Closing it marks what it said as seen, so its corner mark stays away later.
    await frame(PIXEL, `/s/${ids.login}?pip=1`);
    await seen(`return document.querySelector(".pip-panel") !== null`, "PiP's panel");
    await seen(
        `return /nothing needs you/.test(document.querySelector(".pip-panel").textContent)`,
        "PiP's report",
    );
    await toEnd();
    await shoot("pip-phone");
    await tap("^Close", `document.querySelector(".pip-panel")`);
    await pause(600);

    // The session, with Lancet Guard's card waiting.
    await frame(IPHONE, `/s/${ids.login}`);
    await seen(`return /Lancet Guard asks/.test(document.body.textContent)`, "the approval card");
    await toEnd();
    await shoot("session-phone");

    // The People sheet, with the side chat.
    await tap("^Chat with");
    await seen(`return /covers it/.test(document.body.textContent)`, "the side chat");
    await toEnd();
    await shoot("chat-phone");

    // The session list. A run that ends after the browser first looked is new in it: the dark mode session answers now.
    await send(
        app,
        ids.dark,
        staged.sam,
        "Can you also check that the checkout page gets the dark palette?",
    );
    await frame(PIXEL, "/", ".session-row");
    await seen(`return document.querySelectorAll(".session-row").length >= 8`, "the session list");
    await shoot("sessions-phone");
    // Looking at it again would clear what is new; the desktop shot shows no tile for it.
    await page(
        `localStorage.setItem("pocket.peekSeen." + ${ids.dark}, String(Date.now() + 60000))`,
    );

    // The desktop: a session where Pi edited a test, and the other sessions' peek tiles.
    await frame(DESKTOP, `/s/${ids.tests}`);
    await seen(`return /4 passed/.test(document.body.textContent)`, "the test result");
    await pause(1000);

    // The People sheet from before stays open as a panel on a wide screen: close it.
    if (await page(`return document.querySelector('[data-part="people-panel"]') !== null`)) {
        await tap("^Close", `document.querySelector('[data-part="people-panel"]')`);
        await pause(800);
    }

    // They may be on already: Alt+P and the header's button switch them.
    if (!(await page(`return document.querySelector(".peek") !== null`))) {
        await tap("^Peek tiles", `document.querySelector("header")`);
    }

    await seen(`return document.querySelectorAll(".peek").length >= 2`, "the peek tiles");
    await tap("Read 1 file");
    await tap("edit\\s*test/session\\.test\\.ts");
    await page(`document.activeElement?.blur()`);
    await toEnd();
    await shoot("desktop");
} finally {
    browser.close();
    await stop();
}

process.exit(0);
