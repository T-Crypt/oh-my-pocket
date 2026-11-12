// Five habits from DSH for local models. Bash stops a command the model gave no timeout, and runs every command
// without colors, pagers, or prompts. Write and edit refuse a file the session has not read, or one that changed
// since. A todo list keeps a long job on its plan. A forked subagent starts with its parent's conversation, so its
// first request repeats the parent's last one and a local server reuses the cached prompt.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Context, FauxResponseStep, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ContextView, ConversationId } from "@earendil-works/pi-durable";
import { renderTodo } from "../src/server/extensions/todo.ts";
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    say,
    scriptedModel,
    work,
} from "./helpers.ts";

let app: App;
let steps: FauxResponseStep[] = [];
const requests: Context[] = [];

const done: FauxResponseStep = () => fauxAssistantMessage([fauxText("done")]);
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) => () =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

const route: FauxResponseStep = (request, options, state, model) => {
    requests.push(structuredClone(request));
    const last = lastText(request as never);

    // A forked subagent answers its task; one told to nest tries a subagent of its own first.
    if (last.role === "user" && last.text.startsWith("[forked subagent")) {
        return last.text.includes("nest")
            ? tool("subagent", { action: "spawn", name: "deeper", message: "x" })()
            : fauxAssistantMessage([fauxText("child done")]);
    }

    if (last.role === "toolResult" && requests.at(-2) !== undefined) {
        const brief = (request as Context).messages.findLast((message) => message.role === "user");

        if (
            brief !== undefined &&
            lastText({ messages: [brief] }).text.startsWith("[forked subagent")
        ) {
            return fauxAssistantMessage([fauxText("child done")]);
        }
    }

    const step = steps.shift() ?? done;

    return typeof step === "function" ? step(request, options, state, model) : step;
};

const textOf = (content: Message["content"]): string =>
    typeof content === "string"
        ? content
        : content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");

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
    process.env.PI_POCKET_BASH_TIMEOUT = "1";
    app = await openApp(scriptedModel(route));
});

after(async () => {
    delete process.env.PI_POCKET_BASH_TIMEOUT;
    await app.close();
    cleanUp();
});

test("a command with no timeout stops at the default, and the model is told what to do instead", async () => {
    const id = await newSession(app);

    steps = [
        tool("bash", { command: "sleep 5" }),
        tool("bash", { command: "sleep 2", timeout: 4 }),
    ];
    await say(app, id, "wait");

    const [cut, kept] = await resultsOf(id);

    assert.equal(cut!.isError, true);
    assert.match(textOf(cut!.content), /default 1 seconds/);
    assert.match(textOf(cut!.content), /nohup/);
    assert.equal(kept!.isError, false, textOf(kept!.content));
});

test("the model's commands run without colors, pagers, or git prompts", async () => {
    const id = await newSession(app);

    steps = [
        tool("bash", { command: 'echo "$TERM $PAGER $GIT_PAGER $NO_COLOR $GIT_TERMINAL_PROMPT"' }),
    ];
    await say(app, id, "env");

    assert.match(textOf((await resultsOf(id))[0]!.content), /dumb cat cat 1 0/);
});

test("write and edit need a read first, and a fresh one after the file changed", async () => {
    const id = await newSession(app);
    const file = join(work, "read-first.txt");
    const fresh = join(work, "read-first-new.txt");

    writeFileSync(file, "one\n");
    steps = [
        tool("write", { path: file, content: "lost\n" }),
        tool("read", { path: file }),
        tool("edit", { path: file, edits: [{ oldText: "one", newText: "two" }] }),
        tool("edit", { path: file, edits: [{ oldText: "two", newText: "three" }] }),
        tool("write", { path: fresh, content: "new\n" }),
    ];
    await say(app, id, "change it");

    const results = await resultsOf(id);

    assert.equal(results[0]!.isError, true);
    assert.match(textOf(results[0]!.content), /have not read it/);
    assert.equal(results[2]!.isError, false, textOf(results[2]!.content));
    // Its own edit does not count as a change: it knows what it wrote.
    assert.equal(results[3]!.isError, false, textOf(results[3]!.content));
    assert.equal(results[4]!.isError, false, textOf(results[4]!.content));
    assert.equal(readFileSync(file, "utf8"), "three\n");

    // Someone else changes it: the next edit is refused until the model reads it again.
    writeFileSync(file, "three and more\n");
    steps = [tool("edit", { path: file, edits: [{ oldText: "three", newText: "four" }] })];
    await say(app, id, "again");

    const refused = (await resultsOf(id)).at(-1)!;

    assert.equal(refused.isError, true);
    assert.match(textOf(refused.content), /changed since you last read it/);
});

test("the todo list keeps one item in progress and comes back when asked", async () => {
    assert.equal(
        renderTodo([
            { text: "a", status: "done" },
            { text: "b", status: "doing" },
        ]),
        "Tasks (1/2 done):\n[x] a\n[>] b\nNext: b",
    );

    const id = await newSession(app);

    steps = [
        tool("todo", {
            items: [
                { text: "a", status: "doing" },
                { text: "b", status: "doing" },
            ],
        }),
        tool("todo", {
            items: [
                { text: "a", status: "done" },
                { text: "b", status: "pending" },
            ],
        }),
        tool("todo", {}),
    ];
    await say(app, id, "plan");

    const [two, set, shown] = await resultsOf(id);

    assert.equal(two!.isError, true);
    assert.match(textOf(two!.content), /one item may be doing/);
    assert.equal(textOf(set!.content), textOf(shown!.content));
    assert.match(textOf(shown!.content), /Next: b/);
});

test("a forked subagent starts with its parent's prompt, and cannot start subagents of its own", async () => {
    const id = await newSession(app);

    steps = [
        tool("subagent", {
            action: "spawn",
            name: "side",
            message: "count the files",
            fork: true,
            wait: true,
        }),
    ];
    requests.length = 0;
    await say(app, id, "fork it");

    const parent = requests[0]!;
    const child = requests.find((request) =>
        request.messages.some(
            (message) =>
                message.role === "user" &&
                lastText({ messages: [message] }).text.startsWith("[forked subagent"),
        ),
    )!;

    assert.ok(
        child !== undefined,
        `the fork made a request: ${JSON.stringify((await resultsOf(id)).map((each) => textOf(each.content)))} ${requests.length}`,
    );
    assert.deepEqual(child.messages.slice(0, parent.messages.length), parent.messages);
    assert.deepEqual(
        (child.tools ?? []).map((each) => each.name),
        (parent.tools ?? []).map((each) => each.name),
    );
    assert.match(textOf((await resultsOf(id)).at(-1)!.content), /child done/);

    steps = [
        tool("subagent", {
            action: "spawn",
            name: "nested",
            message: "nest",
            fork: true,
            wait: true,
        }),
    ];
    requests.length = 0;
    await say(app, id, "fork and nest");

    const nested = requests.flatMap((request) =>
        request.messages.filter((message) => message.role === "toolResult"),
    );

    assert.ok(
        nested.some((message) => /cannot use subagents/.test(textOf(message.content))),
        "the fork's own subagent call was refused",
    );

    steps = [
        tool("subagent", {
            action: "spawn",
            name: "mixed",
            message: "x",
            fork: true,
            thinking: "low",
        }),
    ];
    await say(app, id, "fork with options");
    assert.match(textOf((await resultsOf(id)).at(-1)!.content), /A fork runs as you/);
});
