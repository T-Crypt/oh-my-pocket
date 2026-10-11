// Read economy: a read without an explicit limit returns at most five hundred lines, and the result carries a
// structural map of the part it did not read - how many lines remain and where the sections sit - so a model that
// opens a big file knows what it did not read and how to come back for it. The map starts at the line the tool's
// own report says the read stopped at - where its line or byte cap really cut the read, not the limit asked for -
// and a read of a multi-megabyte file costs the map only a bounded slice of the tail. An explicit limit is
// honoured; a file that fits the window is read whole, with no map.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ContextView, ConversationId } from "@earendil-works/pi-durable";
import {
    outlineRegion,
    OUTLINE_LINE_BUDGET,
    READ_ECONOMY_LIMIT,
    readWindow,
} from "../src/server/read-economy.ts";
import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    say,
    scriptedModel,
    work,
} from "./helpers.ts";

// --- The window and the outline, pure ----------------------------------------------

test("the window a read reported is read from its own report", () => {
    assert.deepEqual(readWindow("Showing lines 1-500 of 1200. Use offset=501 to continue."), {
        end: 500,
        total: 1200,
    });
    assert.deepEqual(readWindow("701 more lines in file. Use offset=501 to continue."), {
        end: 500,
        total: 1201,
    });
    assert.deepEqual(readWindow("Use offset=501 to continue."), { end: 500 });
    assert.equal(readWindow("plain output"), undefined);
});

test("the outline counts the unread lines and names the sections that sit in them", () => {
    const outline = outlineRegion(
        "line a\nfunction mid() {}\nplain\n# Section two\n",
        501,
        504,
        504,
    );

    assert.match(outline, /\[The rest of this file, lines 501–504: 4 lines, 2 headings, e\./);
    assert.match(outline, /L502: function mid\(\) \{\}/);
    assert.match(outline, /L504: # Section two/);
    assert.match(outline, /offset: 501 and a limit/);
});

test("an outline whose budget stopped short of the file says where it stops", () => {
    const outline = outlineRegion("line a\nfunction mid() {}\nplain", 501, 510, 503);

    assert.match(
        outline,
        /\[The rest of this file, lines 501–510: 3 of 10 lines are mapped, but the outline's budget stops at line 503 and 7 lines run on past it, 1 heading, e\./,
    );
    assert.match(outline, /L502: function mid\(\) \{\}/);
    assert.match(outline, /offset: 501 and a limit/);
});

test("an outline with more headings than it shows says so, and a tail without any says none", () => {
    const many = Array.from({ length: 12 }, (_, i) => `function f${i}() {}`).join("\n");

    assert.match(outlineRegion(many, 1, 12, 12), /\(and more\)/);
    assert.equal(outlineRegion(many, 1, 12, 12).match(/L\d+: /g)!.length, 8);
    assert.match(outlineRegion(many, 1, 12, 12), /, 12 headings, e\./);
    assert.match(outlineRegion("plain\nplain\n", 1, 2, 2), /no headings found/);
});

// --- In a running session -------------------------------------------------------------

let app: App;
let steps: FauxResponseStep[] = [];
let stepIndex = 0;

const done: FauxResponseStep = () => fauxAssistantMessage([fauxText("done")]);

const route: FauxResponseStep = (request, options, state, model) => {
    const step = steps[stepIndex++] ?? done;

    return typeof step === "function" ? step(request, options, state, model) : step;
};

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) => () =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

const textOf = (content: Message["content"]): string =>
    typeof content === "string"
        ? content
        : content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");

/** The newest tool result of the conversation: its file text, and everything it was shown. */
const newest = async (id: ConversationId) => {
    const view = (await (await app.harness.conversation(id, context))!.context(
        context,
    )) as ContextView;
    const results = view.messages.filter(
        (message): message is Extract<Message, { role: "toolResult" }> =>
            message.role === "toolResult",
    );
    const message = results.at(-1)!;
    const parts = message.content as Array<{ type: string; text?: string }>;

    return { first: parts[0]?.text ?? "", all: textOf(message.content) };
};

before(async () => {
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app.close();
    cleanUp();
});

/** 1,200 lines with a function at line 600 and a heading at line 900. */
const bigFile = () => {
    const lines = Array.from({ length: 1200 }, (_, i) => {
        const n = i + 1;

        return n === 600 ? "function mid() {" : n === 900 ? "# Section two" : `line ${n}`;
    });

    const path = join(work, "big.ts");

    writeFileSync(path, lines.join("\n") + "\n");

    return path;
};

test("a read without a limit stops at the cap and maps the rest of the file", async () => {
    const id = await newSession(app);
    const path = bigFile();

    steps = [tool("read", { path }), done];
    stepIndex = 0;
    await say(app, id, "read big");
    const { first, all } = await newest(id);

    assert.match(first, /line 500/);
    assert.doesNotMatch(first, /line 501/);
    assert.match(
        all,
        new RegExp(
            `\\[The rest of this file, lines ${READ_ECONOMY_LIMIT + 1}–1201: 701 lines, 2 headings, e\\.`,
        ),
    );
    assert.match(all, /L600: function mid\(\) \{/);
    assert.match(all, /L900: # Section two/);
    assert.match(all, new RegExp(`offset: ${READ_ECONOMY_LIMIT + 1} and a limit`));
});

test("a read that says how much to read keeps its own limit and still maps the rest", async () => {
    const id = await newSession(app);
    const path = bigFile();

    steps = [tool("read", { path, limit: 100 }), done];
    stepIndex = 0;
    await say(app, id, "read a hundred");
    const { first, all } = await newest(id);

    assert.match(first, /line 100/);
    assert.doesNotMatch(first, /line 101/);
    assert.match(all, /\[The rest of this file, lines 101–1201: 1101 lines/);
});

test("a file that fits the window is read whole, with no map of what was cut", async () => {
    const id = await newSession(app);
    const path = join(work, "small.ts");

    writeFileSync(path, Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");

    steps = [tool("read", { path }), done];
    stepIndex = 0;
    await say(app, id, "read small");
    const { first, all } = await newest(id);

    assert.match(first, /line 50/);
    assert.doesNotMatch(all, /The rest of this file/);
});

// --- The stop point and the budget, on files the window cannot hold ------------------

/** 1,200 lines of 200 characters each: the tool's 50KB byte cap cuts the read far short of its five hundred lines. */
const longLineFile = () => {
    const lines = Array.from({ length: 1200 }, (_, i) =>
        i + 1 === 700 ? "# part two" : `line ${String(i + 1).padStart(5, "0")} ${"x".repeat(189)}`,
    );

    const path = join(work, "long.ts");

    writeFileSync(path, lines.join("\n") + "\n");

    return path;
};

test("the outline starts where the read really stopped, not where its limit was asked to go", async () => {
    const id = await newSession(app);
    const path = longLineFile();

    steps = [tool("read", { path }), done];
    stepIndex = 0;
    await say(app, id, "read long");
    const { first, all } = await newest(id);

    // The byte cap stopped the read mid-window: the tool's own report names the last line it showed.
    const stop = Number(all.match(/Showing lines 1-(\d+) of 1201 \(/)![1]);

    assert.ok(
        stop < READ_ECONOMY_LIMIT,
        `the byte cap should cut the read before its ${READ_ECONOMY_LIMIT} lines; it stopped at ${stop}`,
    );
    assert.match(first, new RegExp(`line ${String(stop).padStart(5, "0")} `));
    assert.doesNotMatch(first, new RegExp(`line ${String(stop + 1).padStart(5, "0")} `));

    // The outline maps from the reported stop - the same line the diagnostic continues from, and no gap between.
    assert.match(all, new RegExp(`\\[The rest of this file, lines ${stop + 1}–1201:`));
    assert.match(all, /L700: # part two/);
    assert.match(all, new RegExp(`offset: ${stop + 1} and a limit`));
});

/** ~10MB of long lines: the read's own 50KB cap stops it mid-window, and the map of the rest stops at its
// own byte budget, far short of the file's end. */
const hugeFile = () => {
    const lines = Array.from({ length: 10_000 }, (_, i) => {
        const n = i + 1;

        return n === 600 ? "# part two" : `line ${String(n).padStart(6, "0")} ${"x".repeat(988)}`;
    });

    const path = join(work, "huge.log");

    writeFileSync(path, lines.join("\n") + "\n");

    return path;
};

test("a read of a multi-megabyte file maps a bounded slice of its tail and says so", async () => {
    const id = await newSession(app);
    const path = hugeFile();

    const rssBefore = process.memoryUsage.rss();

    steps = [tool("read", { path }), done];
    stepIndex = 0;
    await say(app, id, "read huge");
    const rssGrowth = process.memoryUsage.rss() - rssBefore;

    const { first, all } = await newest(id);

    // The tool's own 50KB cap stopped the read mid-window; the map starts at the line it really stopped at.
    const stop = Number(all.match(/Showing lines 1-(\d+) of 10001 \(/)![1]);

    assert.ok(
        stop < READ_ECONOMY_LIMIT,
        `the byte cap should cut the read early; it stopped at ${stop}`,
    );
    assert.match(first, /line 000001 /);
    assert.doesNotMatch(first, new RegExp(`line ${String(stop + 1).padStart(6, "0")} `));

    // The file's tail runs on far past the map's own byte budget: the map is partial, and it names the line
    // its budget stopped at instead of pretending to cover the whole tail.
    const stopsAt = Number(all.match(/budget stops at line (\d+)/)![1]);

    assert.match(
        all,
        new RegExp(
            `lines ${stop + 1}–10001: ${stopsAt - stop} of ${10_001 - stop} lines are mapped`,
        ),
    );
    assert.ok(
        stopsAt - stop < OUTLINE_LINE_BUDGET,
        `the byte budget should bind before the line budget; ${stopsAt - stop} lines were mapped`,
    );
    assert.ok(
        stopsAt > stop + 900,
        `~1MB of ~1KB lines should map ~1,000 lines; it stopped ${stopsAt - stop} in`,
    );
    assert.match(all, /L600: # part two/);
    assert.match(all, new RegExp(`offset: ${stop + 1} and a limit`));

    // The map reads, decodes and line-splits only its budgeted slice: mapping the whole tail of this file
    // would add many hundreds of megabytes to the process serving every open conversation.
    console.log(`[read-economy] rss grew ${Math.round(rssGrowth / 1e6)}MB for a 10MB read`);
    assert.ok(rssGrowth < 150_000_000, `rss grew ${Math.round(rssGrowth / 1e6)}MB`);
});
