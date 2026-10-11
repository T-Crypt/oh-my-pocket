// Prune before summarising: compaction first replaces its range with a note that costs no model call - most tool
// output masked to one line, the newest results in full, stale re-reads and loops dropped - and the LLM summary runs
// only when the note would still leave the context over its limit. PiP writes its own summaries and is left to them.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";import { after, before, test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { type ContextView, type ConversationId, type HookApi } from "@earendil-works/pi-durable";
import { pruneSettings } from "../src/server/compaction.ts";
import { PRUNED_HEAD, pruneSummary, worthPruning } from "../src/server/pruner.ts";
import { type App, cleanUp, context, newSession, openApp, say, scriptedModel, work } from "./helpers.ts";

// --- The note itself -------------------------------------------------------------

const user = (text: string): Message =>
    ({ role: "user", content: text, timestamp: 0 }) as Message;

const call = (name: string, args: Record<string, unknown>): Message =>
    (fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" }) as unknown) as Message;

const resultOf = (
    message: Message,
    name: string,
    content: string,
    isError = false,
): Message => {
    const toolCall = (message.content as { id: string; name: string; type?: string }[]).findLast(
        (part) => part.type === "toolCall",
    )!;

    return ({
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: name,
        content: [{ type: "text", text: content }],
        isError,
        timestamp: 0,
    }) as Message;
};

test("a note masks old tool output, keeps the newest in full, and names stale and repeated calls", () => {
    const readA = call("read", { path: "/x/a.ts" });
    const big = call("bash", { command: "cat /x/b.log" });
    const readC = call("read", { path: "/x/c.ts" });
    const huge = "B".repeat(30_000);

    const pruned = pruneSummary(
        [
            user("look at a, b, and c"),
            readA,
            resultOf(readA, "read", "line one\nline two"),
            big,
            resultOf(big, "bash", huge),
            readC,
            resultOf(readC, "read", "c-content"),
        ],
        { keepLast: 1 },
    )!;

    assert.ok(pruned.summary.startsWith(PRUNED_HEAD));
    // The huge output is a placeholder, not the output.
    assert.ok(!pruned.summary.includes(huge.slice(0, 100)));
    assert.match(pruned.summary, /cat \/x\/b\.log\"\} → masked: 30000 chars of output/);
    // The newest result stays in full.
    assert.match(pruned.summary, /\[Full output of the newest tool results\][\s\S]*c-content/);
    // Person's words and Pi's calls are carried on.
    assert.ok(pruned.summary.includes("[Message]: look at a, b, and c"));
    assert.ok(pruned.summary.includes("[Pi called read {\"path\":\"/x/a.ts\"}]"));
    assert.ok(pruned.saved > 0);
});

test("a read of a file read again goes stale, in the range or in the kept part", () => {
    const first = call("read", { path: "/x/a.ts" });
    const second = call("read", { path: "/x/a.ts" });

    const pruned = pruneSummary(
        [first, resultOf(first, "read", "old version"), second, resultOf(second, "read", "new version")],
        { keepLast: 2 },
    )!;

    assert.match(pruned.summary, /read \{"path":"\/x\/a\.ts"\}, stale → masked/);
    assert.match(pruned.summary, /\[Full output of the newest tool results\][\s\S]*new version/);
    assert.ok(!pruned.summary.includes("old version\n"));

    // A file the kept part reads again supersedes its reads in the range, too.
    const readD = call("read", { path: "/x/d.ts" });

    const pruned2 = pruneSummary([readD, resultOf(readD, "read", "d-version")], {
        keepLast: 1,
        supersededPaths: new Set(["/x/d.ts"]),
    })!;

    assert.match(pruned2.summary, /stale → masked/);
});

test("a call repeated in a loop collapses to one line and its results are masked", () => {
    const a = call("bash", { command: "make it work" });
    const b = call("bash", { command: "make it work" });
    const c = call("bash", { command: "make it work" });

    const pruned = pruneSummary(
        [a, resultOf(a, "bash", "first"), b, resultOf(b, "bash", "second"), c, resultOf(c, "bash", "third")],
        { keepLast: 1 },
    )!;

    assert.ok(pruned.summary.includes("[Pi called bash again]"));
    assert.ok(!pruned.summary.includes("third"));
});

test("failed calls keep their output, and an earlier note is carried on, not re-masked", () => {
    const failed = call("bash", { command: "nope" });
    const earlier = PRUNED_HEAD + " To save context, 12 older messages were compressed.";

    const pruned = pruneSummary(
        [
            user(earlier),
            failed,
            resultOf(failed, "bash", "nope: command not found", true),
            user("ok"),
        ],
        { keepLast: 1 },
    )!;

    assert.match(pruned.summary, /\[Earlier notes\]:/);
    assert.match(pruned.summary, /nope: command not found/);
});

test("a range with nothing to mask has no note, and an empty range has none", () => {
    assert.equal(pruneSummary([user("just talk")], { keepLast: 1 }), undefined);
    assert.equal(pruneSummary([], { keepLast: 1 }), undefined);
});

test("a note is worth taking when it is tiny or no bigger than half of its range", () => {
    assert.equal(worthPruning({ summary: "", chars: 1000, tokens: 250, saved: 100 }), true);
    assert.equal(worthPruning({ summary: "", chars: 10_000, tokens: 2500, saved: 10_000 }), true);
    assert.equal(worthPruning({ summary: "", chars: 10_000, tokens: 2500, saved: 5_000 }), false);
});

test("prune settings: valid values pass through, invalid ones fall back to the defaults", () => {
    const settings = (block: Record<string, unknown> | undefined) => ({
        getSettings: () => (block === undefined ? {} : { compaction: block }) as never,
    });

    assert.deepEqual(pruneSettings(settings({ pruneToolOutput: false, pruneKeepLast: 5 })), {
        pruneToolOutput: false,
        pruneKeepLast: 5,
    });
    assert.deepEqual(pruneSettings(settings({ pruneToolOutput: "off", pruneKeepLast: 99 })), {
        pruneToolOutput: true,
        pruneKeepLast: 2,
    });
    assert.deepEqual(pruneSettings(settings(undefined)), { pruneToolOutput: true, pruneKeepLast: 2 });
});

// --- The hook's decision, end to end ----------------------------------------------

let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});

after(async () => {
    await app.close();
    cleanUp();
});

const lastEntryId = async (id: ConversationId): Promise<number> => {
    const view = (await (await app.harness.conversation(id, context))!.context(context)) as ContextView;

    return view.entries[view.entries.length - 1]!.id;
};

test("a compaction a note can carry is pruned without a summary call", async () => {
    const id = await newSession(app);

    await say(app, id, "hello there");
    const firstKept = await lastEntryId(id);

    // A range of many large results: the note masks all but the newest two, so it is far smaller.
    const range: Message[] = [user("process the logs")];

    for (let index = 0; index < 20; index++) {
        const round = call("bash", { command: `cat log-${index}` });

        range.push(round, resultOf(round, "bash", `${"x".repeat(5000)}\n`));
    }

    const summary = await app.pruner.summarize(
        { reason: "manual", messages: range, firstKept },
        { conversationId: id, taskId: 1 } as HookApi,
        context,
    );

    assert.notEqual(summary, undefined);
    assert.ok(summary!.summary.startsWith(PRUNED_HEAD));
    assert.ok(summary!.summary.includes("[Full output of the newest tool results]"));
    assert.match(summary!.summary, /cat log-17\"\} → masked/);
    // The 100 KB of results became a note a third of that size.
    assert.ok(summary!.summary.length < 30_000);
});

test("a note that would still leave the context over its limit leaves the summary to the model", async () => {
    const small = fauxProvider({
        tokensPerSecond: 2000,
        models: [{ id: "faux-1", contextWindow: 16_000, maxTokens: 4096 }],
    });
    const agentDir = process.env.PI_CODING_AGENT_DIR!;
    const dataDir = join(agentDir, "pruner-small");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
        compaction: { reserveTokens: 3000, keepRecentTokens: 4000 },
    }));

    const tight = await openApp(small, dataDir);
    const id = await newSession(tight, work);

    // A range of mostly people's words: the note keeps them all, so it is still over.
    const wall = Array.from(
        { length: 40 },
        (_, index) => user(`message ${index}: ${"word ".repeat(120)}`),
    );
    const big = call("bash", { command: "cat everything" });
    const firstKept = await lastEntryId(id);

    const summary = await tight.pruner.summarize(
        {
            reason: "manual",
            messages: [...wall, big, resultOf(big, "bash", `${"x".repeat(50_000)}`)],
            firstKept,
        },
        { conversationId: id, taskId: 1 } as HookApi,
        context,
    );

    await tight.close();
    assert.equal(summary, undefined);
});
