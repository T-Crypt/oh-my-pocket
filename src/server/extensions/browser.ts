/**
 * Browser: Pi opens, reads, clicks through, and screenshots web pages in a real Chromium on this machine, the same page
 * the people in the conversation watch and use in the Browser panel. Turning it off turns off the panel too.
 *
 * Pi uses it only in a session where a person turned browser use on (the Browser switch by the message box): the tool
 * is deferred, so elsewhere the model is offered neither it nor its guide. There it asks first, as the owner's settings
 * say, before a new site, the local network, a sign-in, a form, a purchase or a deletion, and a script; it never types
 * into a password or payment field.
 *
 * A call is not replayed after a restart (clicking twice is not harmless), and the page itself does not survive one:
 * its address comes back when it opens again, but not what was typed or clicked on it.
 */
import { awaitWithContext } from "@earendil-works/chord/context";
import { type ImageContent, StringEnum, type TextContent } from "@earendil-works/pi-ai";
import { bool, num, obj, opt, str } from "@earendil-works/pi-schema";
import { AgentDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { BrowserUseDoc } from "../docs.ts";
import type { BrowserPage, LogEntry, Target } from "../browser/page.ts";
import { displayUrl, hostOf, normalizeUrl, REMOTE_FILES } from "../browser/urls.ts";
import {
    FOCUS_SCRIPT,
    POLICY_SETTINGS,
    policyFrom,
    riskyWord,
    siteOf,
    siteVerdict,
} from "../browser/policy.ts";
import { presetOf, viewportFrom } from "../browser/viewport.ts";
import type { ExtensionWeb, PocketHost } from "../host.ts";
import { workspaceScheme } from "../paths.ts";

const ACTIONS = [
    "navigate",
    "snapshot",
    "screenshot",
    "click",
    "type",
    "press",
    "select",
    "hover",
    "scroll",
    "wait",
    "evaluate",
    "console",
    "back",
    "forward",
    "reload",
    "viewport",
] as const;

type Action = (typeof ACTIONS)[number];

/** Actions that may change the page, after which a snapshot can come along. */
const CHANGING = new Set<Action>([
    "navigate",
    "click",
    "type",
    "press",
    "select",
    "back",
    "forward",
    "reload",
    "viewport",
]);
const MAX_TEXT = 20_000;
/** A console line, as Pi reads it: a stack or a long payload past this is cut. */
const MAX_LINE = 300;
/** The console action reads this many of the newest lines. */
const CONSOLE_LINES = 80;

const GUIDE = `The browser tool is a real Chromium on this machine. The people in this conversation see its page live in the Browser panel and can use it too: show and test web work there (local dev servers, HTML files on this machine, any site).
- Start a dev server in the background with bash first (\`nohup npm run dev > /tmp/dev.log 2>&1 &\`), then navigate to it.
- snapshot gives refs like [e12] for click, type, select, and hover, valid until the next snapshot. screenshot shows the layout; viewport changes the size. After a change, check console for errors.
- Failed loads to other sites (analytics, trackers) are usually blocked on purpose: ignore them unless the page itself breaks.`;

function clip(text: string, max = MAX_TEXT): string {
    return text.length > max
        ? `${text.slice(0, max)}\n… (${text.length - max} more characters)`
        : text;
}

/** Where the page is, for the end of every answer. */
function where(page: BrowserPage): string {
    const viewport = page.viewport;
    const size = `${presetOf(viewport) ?? "custom"} ${viewport.width}×${viewport.height}`;
    const url = page.url === "about:blank" ? "a blank page" : page.url;

    return `Page: ${page.title === "" ? "" : `"${page.title}" · `}${url} · ${size}`;
}

function formatLog(entry: LogEntry): string {
    if (entry.level === "nav") {
        return `--- navigated to ${entry.text} ---`;
    }

    const repeated = (entry.count ?? 1) > 1 ? ` ×${entry.count}` : "";

    return `[${entry.level}]${repeated} ${clip(entry.text, MAX_LINE)}${entry.source === undefined ? "" : ` (${clip(entry.source, 120)})`}`;
}

/** Loads that failed on other sites (trackers, beacons a blocker refused), as one line: how many, and to where. */
function otherSites(entries: readonly LogEntry[]): string | undefined {
    const hosts = new Map<string, number>();

    for (const entry of entries) {
        if (entry.level === "net" && entry.other === true) {
            const host = hostOf(entry.source ?? "another site");

            hosts.set(host, (hosts.get(host) ?? 0) + (entry.count ?? 1));
        }
    }

    if (hosts.size === 0) {
        return undefined;
    }

    const total = [...hosts.values()].reduce((sum, count) => sum + count, 0);
    const top = [...hosts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([host, count]) => (count > 1 ? `${host} ×${count}` : host));

    return `${total} failed load${total === 1 ? "" : "s"} to other sites (${top.join(", ")}${hosts.size > 4 ? ", …" : ""}): trackers or blocked hosts, not this page's own.`;
}

const OFF =
    "Browser use is off in this session: only a person turns it on, with the Browser switch by the message box. Say what you would look up or check, and ask them.";

export default function createBrowser(host: PocketHost, web: ExtensionWeb) {
    web.settings(POLICY_SETTINGS);

    const browser = defineTool({
        name: "browser",
        // Offered to the model only in a session where a person turned browser use on (`commands.setBrowserUse`).
        deferred: true,
        description:
            "Use a real web browser (Chromium on this machine) that the people in this conversation watch live. Open pages (local dev servers, files, sites), read them as a snapshot with element refs, click, type, take screenshots you can see, read console errors, and run JavaScript in the page.",
        parameters: obj(
            {
                action: StringEnum(ACTIONS, {
                    description:
                        "navigate (url), snapshot, screenshot, click/hover (ref, selector, label, or x and y), type (text into ref/selector/label, or the focused element), press (key), select (value in a select element), scroll (to ref/selector/label, or by dy), wait (text, selector, or timeoutMs), evaluate (script), console, back, forward, reload, viewport.",
                }),
                url: opt(
                    str({
                        description:
                            "navigate: an http(s) URL, host:port such as localhost:5173, or a path to an HTML file on this machine.",
                    }),
                ),
                ref: opt(
                    str({ description: "An element ref from the last snapshot, such as e12." }),
                ),
                selector: opt(
                    str({
                        description:
                            "Instead of ref: a CSS selector. wait: wait until it is visible.",
                    }),
                ),
                label: opt(
                    str({
                        description:
                            "Instead of ref: the element's visible text or label, such as a button's text.",
                    }),
                ),
                x: opt(
                    num({
                        description:
                            "click, hover: a point in CSS pixels of the viewport, as seen in a screenshot (one shown smaller says how to scale its points).",
                    }),
                ),
                y: opt(num()),
                text: opt(
                    str({
                        description:
                            "type: the text to type (empty clears the field). wait: text to wait for.",
                    }),
                ),
                submit: opt(bool({ description: "type: press Enter afterwards." })),
                append: opt(
                    bool({
                        description: "type: add to what the field holds instead of replacing it.",
                    }),
                ),
                key: opt(
                    str({
                        description:
                            "press: a key or combination, such as Enter, Escape, Tab, ArrowDown, Control+A.",
                    }),
                ),
                value: opt(str({ description: "select: the option's value or text." })),
                dy: opt(
                    num({
                        description:
                            "scroll: pixels down (negative: up). Default: most of a screen down.",
                    }),
                ),
                script: opt(
                    str({
                        description:
                            "evaluate: JavaScript run in the page: an expression or statements (top-level await works), or a body that ends with return. Its value comes back as JSON.",
                    }),
                ),
                viewport: opt(
                    str({
                        description:
                            "viewport: mobile (390×844), tablet (820×1180), desktop (1280×800), or WIDTHxHEIGHT.",
                    }),
                ),
                fullPage: opt(
                    bool({
                        description: "screenshot: the whole page, not only what fits the viewport.",
                    }),
                ),
                timeoutMs: opt(
                    num({
                        description:
                            "navigate, wait: how long to wait in milliseconds (default 30000 for navigate, 10000 for wait).",
                    }),
                ),
                snapshot: opt(
                    bool({
                        description:
                            "After an action that changes the page: also return its snapshot.",
                    }),
                ),
                clear: opt(bool({ description: "console: clear the lines after reading them." })),
            },
            { open: true },
        ),
        // Pages are shared and stateful: a round's calls run in order.
        executionMode: "sequential",
        execute: async (args, api, context) => {
            const signal = context.abortSignal;
            const action = args.action as Action;
            const use = await api.snapshot(BrowserUseDoc, api.conversationId, context);

            // Tools can call a deferred tool too (codemode): the session's switch holds for them as well.
            if (use?.on !== true) {
                throw new Error(OFF);
            }

            const policy = policyFrom((name) => web.setting(name));
            const sitesHere = [...use.sites];
            let asked = 0;

            /** A card on this call: Allow goes on, anything else stops the call. */
            const askFirst = async (title: string, text?: string) => {
                const answer = await host.ask(
                    {
                        conversationId: api.conversationId,
                        id: `${api.taskId}:${api.callId}:${asked++}`,
                        taskId: api.taskId,
                        callId: api.callId,
                        title,
                        ...(text === undefined ? {} : { text }),
                        submit: "Allow",
                    },
                    context,
                );

                if (!answer.answered) {
                    throw new Error(
                        `Not allowed: ${title} Do not try to do it another way. Say what you wanted to do and why, and let the person decide.`,
                    );
                }
            };

            /** Pi works on this page only when its site is allowed: by the settings, earlier here, or now. */
            const allowSite = async (url: string) => {
                const verdict = siteVerdict(url, policy, sitesHere);

                if (verdict.go) {
                    return;
                }

                if ("refuse" in verdict) {
                    throw new Error(`${verdict.refuse} Do not try to reach it another way.`);
                }

                await askFirst(
                    `Let Pi use ${verdict.ask} in the browser?`,
                    "Allowed once, it stays allowed for the rest of this session.",
                );
                sitesHere.push(verdict.ask);
                await api.commit(async (tx) => {
                    const doc = await tx.doc(BrowserUseDoc, api.conversationId);

                    if (!doc.sites.includes(verdict.ask)) {
                        doc.sites.push(verdict.ask);
                    }
                }, context);
            };

            /** Ask before an action that signs in, submits, sends, buys, or deletes, when the settings say so. */
            const allowAction = async (what: string, why: string | undefined) => {
                if (policy.actions === "allow" || why === undefined) {
                    return;
                }

                await askFirst(
                    `Let Pi ${what} on ${siteOf(page.url)?.site ?? "this page"}?`,
                    `It looks like it may ${why}.`,
                );
            };

            const agent = await api.snapshot(AgentDoc, api.conversationId, context);
            const cwd = agent?.cwd ?? process.cwd();
            // A page opened again comes back at its last address, unless Pi is about to open another.
            const page = await awaitWithContext(
                host.browsers.open(Number(api.conversationId), { restore: action !== "navigate" }),
                context,
            );

            // A click can lead to another site: the next action there is checked like an opening.
            if (action !== "navigate" && page.url !== "" && page.url !== "about:blank") {
                await allowSite(page.url);
            }

            const before = page.logSeq;
            const target: Target = {
                ...(args.ref === undefined ? {} : { ref: args.ref.replace(/^\[|\]$/g, "") }),
                ...(args.selector === undefined ? {} : { selector: args.selector }),
                ...(args.label === undefined ? {} : { label: args.label }),
                ...(args.x === undefined || args.y === undefined ? {} : { x: args.x, y: args.y }),
            };
            const pointed = Object.keys(target).length > 0;

            const need = (ok: boolean, what: string) => {
                if (!ok) {
                    throw new Error(`${action} needs ${what}.`);
                }
            };

            const lines: string[] = [];
            let image: ImageContent | undefined;
            let failed = false;
            const run = <T>(promise: Promise<T>) => awaitWithContext(promise, context);

            switch (action) {
                case "navigate": {
                    need(args.url !== undefined && args.url.trim() !== "", "a url");
                    const url = normalizeUrl(args.url!, { trusted: true, cwd });

                    if (url === undefined) {
                        throw new Error(
                            `"${args.url}" is not an address the browser opens: give an http(s) URL, host:port, or a file path.`,
                        );
                    }

                    if (url.startsWith("file:") && workspaceScheme(cwd) !== undefined) {
                        throw new Error(REMOTE_FILES);
                    }

                    await allowSite(url);

                    const result = await run(
                        page.navigate(url, {
                            timeoutMs: args.timeoutMs ?? 30_000,
                            ...(signal === undefined ? {} : { signal }),
                        }),
                    );

                    if (result.error !== undefined) {
                        failed = true;
                        const refused = /CONNECTION_REFUSED/.test(result.error);

                        lines.push(
                            `Could not open ${url}: ${result.error}.${refused ? " Nothing answers there: is the server running?" : ""}`,
                        );
                    } else {
                        lines.push(
                            `Opened ${url}${result.status === undefined ? "" : ` (HTTP ${result.status})`}.`,
                        );

                        if (result.slow === true) {
                            lines.push("It is still loading.");
                        }
                    }

                    break;
                }

                case "back":

                case "forward": {
                    const moved = await run(
                        page.go(action === "back" ? -1 : 1, signal === undefined ? {} : { signal }),
                    );

                    lines.push(moved ? `Went ${action}.` : `There is no page to go ${action} to.`);
                    break;
                }

                case "reload":
                    await run(page.reload(signal === undefined ? {} : { signal }));
                    lines.push("Reloaded.");
                    break;
                case "snapshot":
                    break;

                case "screenshot": {
                    const shot = await run(page.screenshot({ fullPage: args.fullPage === true }));

                    // Models refuse bigger images once a conversation holds many, so a big page comes back smaller.
                    const smaller =
                        shot.scale < 1
                            ? `, shown at ${Math.round(shot.width * shot.scale)}×${Math.round(shot.height * shot.scale)}: multiply a point in it by ${(1 / shot.scale).toFixed(2)} for CSS pixels`
                            : "";

                    image = { type: "image", data: shot.data, mimeType: "image/jpeg" };
                    lines.push(
                        `Screenshot of ${args.fullPage === true ? "the whole page" : "the viewport"}, ${shot.width}×${shot.height} CSS pixels${smaller}.`,
                    );
                    break;
                }

                case "click": {
                    need(pointed, "a ref, selector, label, or x and y");

                    if (policy.actions === "ask") {
                        const found =
                            target.x !== undefined && target.y !== undefined
                                ? await run(page.describeAt(target.x, target.y))
                                : await run(page.locate(target));
                        const label = found.label;
                        const word =
                            riskyWord(label) ?? (found.kind === "submit" ? "submit" : undefined);

                        await allowAction(`click ${label}`, word && `${word.toLowerCase()}`);
                    }

                    const clicked = await run(
                        page.click(target, signal === undefined ? {} : { signal }),
                    );

                    lines.push(`Clicked ${clicked.label}.`);

                    if (clicked.covered !== undefined) {
                        lines.push(
                            `Something else was on top of it: ${clicked.covered}, which got the click.`,
                        );
                    }

                    if (clicked.navigated) {
                        lines.push(`The page changed to ${page.url}.`);
                    }

                    break;
                }

                case "hover":
                    need(pointed, "a ref, selector, label, or x and y");
                    lines.push(`The mouse is over ${await run(page.hover(target))}.`);
                    break;

                case "type": {
                    need(args.text !== undefined, "text");

                    {
                        const found = pointed ? await run(page.locate(target)) : undefined;
                        const focus = JSON.parse(await run(page.evaluate(FOCUS_SCRIPT))) as {
                            secret?: boolean;
                            password?: boolean;
                            submit?: string;
                        };

                        // People type passwords and card numbers themselves, in the Browser panel.
                        if (found?.password === true || (!pointed && focus.secret === true)) {
                            throw new Error(
                                "That is a password or payment field: Pi does not type into those. Ask the person to type it in the Browser panel, then carry on.",
                            );
                        }

                        if (args.submit === true) {
                            await allowAction(
                                "press Enter and send the form",
                                focus.password === true
                                    ? "sign in"
                                    : riskyWord(focus.submit ?? "")?.toLowerCase(),
                            );
                        }
                    }

                    const into = await run(
                        page.type(pointed ? target : undefined, args.text!, {
                            ...(args.append === undefined ? {} : { append: args.append }),
                            ...(args.submit === undefined ? {} : { submit: args.submit }),
                            ...(signal === undefined ? {} : { signal }),
                        }),
                    );

                    lines.push(
                        args.text === ""
                            ? `Cleared ${into}.`
                            : `Typed into ${into}${args.submit === true ? " and pressed Enter" : ""}.`,
                    );
                    break;
                }

                case "press":
                    need(args.key !== undefined && args.key !== "", "a key");

                    if (/(^|\+)Enter$/i.test(args.key!)) {
                        const focus = JSON.parse(await run(page.evaluate(FOCUS_SCRIPT))) as {
                            form?: boolean;
                            password?: boolean;
                            submit?: string;
                        };

                        await allowAction(
                            "press Enter and send the form",
                            focus.form !== true
                                ? undefined
                                : focus.password === true
                                  ? "sign in"
                                  : riskyWord(focus.submit ?? "")?.toLowerCase(),
                        );
                    }

                    await run(page.press(args.key!, signal === undefined ? {} : { signal }));
                    lines.push(`Pressed ${args.key}.`);
                    break;
                case "select":
                    need(pointed && args.value !== undefined, "a ref or selector and a value");
                    lines.push(`Selected "${await run(page.select(target, args.value!))}".`);
                    break;
                case "scroll":
                    lines.push(
                        `Scrolled ${pointed ? "to " : ""}${await run(page.scroll(pointed ? target : undefined, args.dy))}.`,
                    );
                    break;

                case "wait": {
                    const found = await run(
                        page.waitFor({
                            ...(args.text === undefined ? {} : { text: args.text }),
                            ...(args.selector === undefined ? {} : { selector: args.selector }),
                            ...(args.timeoutMs === undefined
                                ? {}
                                : { timeoutMs: args.timeoutMs, ms: args.timeoutMs }),
                            ...(signal === undefined ? {} : { signal }),
                        }),
                    );
                    const what = args.text !== undefined ? `"${args.text}"` : args.selector;

                    lines.push(
                        what === undefined
                            ? "Waited."
                            : found
                              ? `Found ${what}.`
                              : `${what} did not show up in time.`,
                    );

                    if (what !== undefined && !found) {
                        failed = true;
                    }

                    break;
                }

                case "evaluate":
                    need(args.script !== undefined && args.script.trim() !== "", "a script");

                    if (policy.scripts === "never") {
                        throw new Error(
                            "Running scripts in pages is turned off in the browser's settings. Use snapshot, click, and type instead.",
                        );
                    }

                    await askFirst(
                        `Let Pi run a script on ${siteOf(page.url)?.site ?? "this page"}?`,
                        clip(args.script!, 600),
                    );
                    lines.push(
                        clip(
                            await run(
                                page.evaluate(args.script!, {
                                    timeoutMs: args.timeoutMs ?? 30_000,
                                }),
                            ),
                        ),
                    );
                    break;

                case "console": {
                    const all = page.logs();
                    const own = all.filter((entry) => !(entry.level === "net" && entry.other));
                    const shown = own.slice(-CONSOLE_LINES);
                    const elsewhere = otherSites(all);

                    if (all.length === 0) {
                        lines.push("The console is empty.");
                    } else {
                        if (own.length > shown.length) {
                            lines.push(`(${own.length - shown.length} older lines not shown)`);
                        }

                        lines.push(clip(shown.map(formatLog).join("\n")));

                        if (elsewhere !== undefined) {
                            lines.push(elsewhere);
                        }
                    }

                    if (args.clear === true) {
                        page.clearLogs();
                    }

                    break;
                }

                case "viewport": {
                    const viewport = viewportFrom(args.viewport);

                    if (viewport === undefined) {
                        throw new Error("viewport needs mobile, tablet, desktop, or WIDTHxHEIGHT.");
                    }

                    await run(page.setViewport(viewport));
                    lines.push(
                        `The page is now ${presetOf(viewport) ?? "custom"} ${viewport.width}×${viewport.height}.`,
                    );
                    break;
                }
            }

            if (action === "snapshot" || (args.snapshot === true && CHANGING.has(action))) {
                const outline = await run(page.snapshot());
                const below = outline.scrollHeight - outline.scrollY - outline.innerHeight;

                lines.push(
                    `Snapshot (scrolled ${outline.scrollY} of ${outline.scrollHeight}px${below > 0 ? `, ${below}px below the viewport` : ""}):`,
                    outline.lines === "" ? "(no text or controls)" : outline.lines,
                );

                if (outline.truncated) {
                    lines.push(
                        "… the snapshot stops here: scroll, or use evaluate to read the rest.",
                    );
                }
            }

            if (action !== "console") {
                const fresh = page.logs(before);
                const errors = fresh.filter(
                    (entry) =>
                        entry.level === "error" ||
                        entry.level === "dialog" ||
                        (entry.level === "net" && entry.other !== true),
                );
                const elsewhere = otherSites(fresh);

                if (errors.length > 0) {
                    lines.push(
                        "Console errors and dialogs during this call:",
                        ...errors.slice(0, 10).map((entry) => `- ${formatLog(entry)}`),
                        ...(errors.length > 10
                            ? [`- … and ${errors.length - 10} more (see console)`]
                            : []),
                    );
                }

                if (elsewhere !== undefined) {
                    lines.push(elsewhere);
                }
            }

            lines.push(where(page));
            const content: (TextContent | ImageContent)[] = [
                { type: "text", text: lines.join("\n") },
            ];

            if (image !== undefined) {
                content.push(image);
            }

            return {
                output: content,
                ...(failed ? { isError: true } : {}),
                details: {
                    action,
                    url: page.url,
                    address: displayUrl(page.url),
                    title: page.title,
                },
            };
        },
    });

    return defineExtension({
        name: "pocket-browser",
        tools: [browser],
        sections: [
            // Offered, or for scripts alone (codemode's Only mode).
            section("browser", ({ agent }) =>
                agent.tools.some((tool) => tool.name === "browser") ||
                agent.callable.some(
                    (tool) => tool.name === "browser" && tool.callers?.includes("model") === false,
                )
                    ? GUIDE
                    : undefined,
            ),
        ],
    });
}
