// Read economy: a read without an explicit limit returns at most five hundred lines, and the result carries a
// structural map of the part it did not read - how many lines remain and where the sections sit - so a model that
// opens a big file knows what it did not read and how to come back for it. An explicit limit is honoured; a file
// that fits the window is read whole, with no map.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ContextView, ConversationId } from "@earendil-works/pi-durable";
import { outlineRegion, READ_ECONOMY_LIMIT, readWindow } from "../src/server/read-economy.ts";
import { type App, cleanUp, context, newSession, openApp, say, scriptedModel, work } from "./helpers.ts";

// --- The window and the outline, pure ----------------------------------------------

test("the window a read reported is read from its own report", () => {
    assert.deepEqual(
        readWindow("Showing lines 1-500 of 1200. Use offset=501 to continue."),
        { end: 500, total: 1200 },
    );
    assert.deepEqual(readWindow("700 more lines in file. Use offset=501 to continue."), { end: 500 });
    assert.equal(readWindow("plain output"), undefined);
});

test("the outline counts the unread lines and names the sections that sit in them", () => {
    const outline = outlineRegion("line a\nfunction mid() {}\nplain\n# Section two\n", 501, 504);

    assert.match(outline, /\[The rest of this file, lines 501–504: 4 lines, 2 headings, e\./);
    assert.match(outline, /L502: function mid\(\) \{\}/);
    assert.match(outline, /L504: # Section two/);
    assert.match(outline, /offset: 501 and a limit/);
});

test("an outline with more headings than it shows says so, and a tail without any says none", () => {
    const many = Array.from({ length: 12 }, (_, i) => `function f${i}() {}`).join("\n");

    assert.match(outlineRegion(many, 1, 12), /\(and more\)/);
    assert.equal(outlineRegion(many, 1, 12).match(/L\d+: /g)!.length, 8);
    assert.match(outlineRegion(many, 1, 12), /, 12 headings, e\./);
    assert.match(outlineRegion("plain\nplain\n", 1, 2), /no headings found/);
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

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
    () => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

const textOf = (content: Message["content"]): string =>
    typeof content === "string"
        ? content
        : content
              .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
              .join("\n");

/** The newest tool result of the conversation: its file text, and everything it was shown. */
const newest = async (id: ConversationId) => {
    const view = (await (await app.harness.conversation(id, context))!.context(context)) as ContextView;
    const results = view.messages.filter(
        (message): message is Extract<Message, { role: "toolResult" }> => message.role === "toolResult",
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
    assert.match(all, new RegExp(`\\[The rest of this file, lines ${READ_ECONOMY_LIMIT + 1}–1200: 700 lines, 2 headings, e\\.`));
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
    assert.match(all, /\[The rest of this file, lines 101–1200: 1100 lines/);
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
