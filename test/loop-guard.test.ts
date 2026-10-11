// Loop guard: a tool call is blocked when it is identical to one that already failed this turn, or identical to
// one repeated a third time, whatever the result - and the system prompt tells the model the same thing. A call a
// restart interrupted is not a failure, and a mutating call clears the repeats of reads. Tool arguments a model
// wrote slightly wrong (a JSON string where an object belongs, one item where a list belongs) are repaired before
// validation, instead of failing it.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import type { ContextView, ConversationId } from "@earendil-works/pi-durable";
import { signatureOf } from "../src/server/loop-guard.ts";
import { repairToolArguments } from "../src/server/tool-repair.ts";
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

// --- The guard's key and the JSON repair, pure ------------------------------------

test("a call's key is its tool and its arguments, object key order aside", () => {
    assert.equal(signatureOf("bash", { a: 1, b: 2 }), signatureOf("bash", { b: 2, a: 1 }));
    assert.notEqual(signatureOf("bash", { a: 1 }), signatureOf("bash", { a: 2 }));
    assert.notEqual(signatureOf("bash", { a: 1 }), signatureOf("read", { a: 1 }));
});

const objectSchema = {
    type: "object",
    properties: {
        path: { type: "string" },
        limit: { type: "number" },
        edits: {
            type: "array",
            items: {
                type: "object",
                properties: { oldText: { type: "string" }, newText: { type: "string" } },
            },
        },
    },
};

test("an object sent as a JSON string is parsed back to the object", () => {
    assert.deepEqual(repairToolArguments('{"path":"/x","limit":"5"}', objectSchema), {
        path: "/x",
        limit: "5",
    });
});

test("one item where a list belongs becomes the list, one level deep", () => {
    assert.deepEqual(
        repairToolArguments({ path: "/x", edits: { oldText: "a", newText: "b" } }, objectSchema),
        { path: "/x", edits: [{ oldText: "a", newText: "b" }] },
    );
});

test("arguments that already fit, or that are not JSON, come back unchanged", () => {
    const fine = { path: "/x" };

    assert.equal(repairToolArguments(fine, objectSchema), fine);
    assert.equal(repairToolArguments("123", objectSchema), "123");
    assert.equal(repairToolArguments("not json {", objectSchema), "not json {");
});

// --- The guard's decisions, in a running session ----------------------------------

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

/** The tool results of the conversation, oldest first, as the model sees them. */
const resultsOf = async (id: ConversationId) => {
    const view = (await (await app.harness.conversation(id, context))!.context(
        context,
    )) as ContextView;

    return view.messages.filter(
        (message): message is Extract<Message, { role: "toolResult" }> =>
            message.role === "toolResult",
    );
};

before(async () => {
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app.close();
    cleanUp();
});

test("a third identical call is blocked, and after a failure the block says it failed", async () => {
    const id = await newSession(app);
    const attempt = tool("bash", { command: "definitely-not-a-command" });

    steps = [attempt, attempt, attempt, () => fauxAssistantMessage([fauxText("done")])];
    stepIndex = 0;
    await say(app, id, "try it");

    const results = await resultsOf(id);

    assert.equal(results.length, 3);
    assert.equal(results[0]!.isError, true);
    assert.ok(!textOf(results[0]!.content).includes("blocked"));
    assert.ok(!textOf(results[1]!.content).includes("blocked"));
    const blocked = textOf(results[2]!.content);

    assert.match(
        blocked,
        /blocked: you already ran bash with exactly these arguments and it failed/,
    );
});

test("a third identical call is blocked even when the earlier ones succeeded", async () => {
    const id = await newSession(app);
    const attempt = tool("bash", { command: "true" });

    steps = [attempt, attempt, attempt, () => fauxAssistantMessage([fauxText("done")])];
    stepIndex = 0;
    await say(app, id, "again");

    const results = await resultsOf(id);

    assert.equal(results.length, 3);
    assert.match(
        textOf(results[2]!.content),
        /blocked: you already ran bash with exactly these arguments 2 times this turn; the result will not change/,
    );
});

test("a mutating call clears the repeats of a read, so a retry after the fix is allowed", async () => {
    const id = await newSession(app);
    const file = join(work, "loop-guard.txt");

    steps = [
        tool("read", { path: file }),
        tool("write", { path: file, content: "hello again" }),
        tool("read", { path: file }),
        () => fauxAssistantMessage([fauxText("done")]),
    ];
    stepIndex = 0;
    await say(app, id, "create and verify");

    const results = await resultsOf(id);

    assert.equal(results.length, 3);
    assert.equal(results[0]!.isError, true);
    assert.equal(results[1]!.isError, false);
    // The third read of the same path is the write's consequence, not a loop: it runs, and it succeeds.
    assert.equal(results[2]!.isError, false);
    assert.ok(textOf(results[2]!.content).includes("hello again"));
});

test("two identical failing calls are fine: the guard blocks the third, not the second", async () => {
    const id = await newSession(app);
    const attempt = tool("bash", { command: "definitely-not-a-command" });

    steps = [attempt, attempt, () => fauxAssistantMessage([fauxText("done")])];
    stepIndex = 0;
    await say(app, id, "twice is fine");

    const results = await resultsOf(id);

    assert.equal(results.length, 2);
    assert.ok(!textOf(results[1]!.content).includes("blocked"));
});

test("the no-repeat rule is in the prompt the model gets", async () => {
    const id = await newSession(app);

    steps = [() => fauxAssistantMessage([fauxText("ok")])];
    stepIndex = 0;
    await say(app, id, "hello");

    const view = await (await app.harness.conversation(id, context))!.context(context);
    const system = getCurrentSystemMessage(view.messages);

    assert.notEqual(system, undefined);
    assert.match(
        system?.sections?.["guidelines"] ?? "",
        /Never repeat a tool call that just failed/,
    );
});

test("an object or array sent as a JSON string is repaired before validation, and the call runs", async () => {
    const id = await newSession(app);
    const file = join(work, "repaired.txt");

    writeFileSync(file, "the first line\nthe second line\n");
    const doubleEncoded = JSON.stringify({ path: file, limit: 1 });

    steps = [
        // The arguments are a JSON string, not the object they describe: only the repair can run this call.
        () =>
            fauxAssistantMessage([fauxToolCall("read", doubleEncoded as never)], {
                stopReason: "toolUse",
            }),
        () => fauxAssistantMessage([fauxText("done")]),
    ];
    stepIndex = 0;
    await say(app, id, "read it");

    const results = await resultsOf(id);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.isError, false);
    assert.ok(textOf(results[0]!.content).includes("the first line"));
});
