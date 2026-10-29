// A local model reuses what it already read only while each request starts with exactly the one before: llama.cpp keeps
// the prefix it has, and reads again from the first token that differs. Turns, tool calls, a tool loaded on request,
// the browser switch, and plan mode must only add at the end. Pi Durable adds a changed section or tool set as a new
// system message rather than rewriting the first, so the other cost is a section that changes on every turn: a copy
// added each time. Turns and tool calls alone must add none.
import { cleanUp, lastText, newSession, openApp, owner, say, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { JsonObject } from "@earendil-works/pi-durable";

type App = Awaited<ReturnType<typeof openApp>>;

let app: App;
/** Each request's messages, as the model got them, in order. */
const requests: string[][] = [];
/** The calls Pi makes next, one per step, before it answers. */
const calls: { name: string; args: JsonObject }[] = [];

const route: FauxResponseStep = (request) => {
    const { messages } = request as unknown as { messages: unknown[] };

    requests.push(messages.map((message) => JSON.stringify(message)));

    const { role } = lastText(request as never);
    const call = calls.shift();

    return call === undefined || (role !== "user" && role !== "toolResult")
        ? fauxAssistantMessage([fauxText("done")])
        : fauxAssistantMessage([fauxToolCall(call.name, call.args)], { stopReason: "toolUse" });
};

before(async () => {
    process.env.PI_POCKET_LEAN_PROMPT = "1";
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** The first message where `next` stops repeating `previous`, or -1 when it repeats all of it. */
function firstChange(previous: string[], next: string[]): number {
    return previous.findIndex((message, index) => next[index] !== message);
}

test("every request starts with the one before it, whatever changed between them", async () => {
    const id = await newSession(app);
    const steps: string[] = [];

    /**
     * The requests of steps that changed nothing a person sets, after steps that did not either: none of them may add
     * a section or a tool.
     */
    const steady: number[] = [];

    const step = async (what: string, run: () => Promise<void>, still = false) => {
        const before = requests.length;

        await run();
        assert.ok(requests.length > before, `${what}: a request was made`);
        steps.push(what);

        if (still) {
            for (let index = Math.max(before, 1); index < requests.length; index++) {
                steady.push(index);
            }
        }
    };

    await step("a first message", () => say(app, id, "hello"));
    await step("a second message", () => say(app, id, "and another"), true);
    calls.push({ name: "bash", args: { command: "echo one" } });
    calls.push({ name: "read", args: { path: "." } });
    await step("two tool calls", () => say(app, id, "look around"), true);
    calls.push({ name: "load_tools", args: { names: ["schedule"] } });
    await step("a tool loaded on request", () => say(app, id, "I need schedules"));
    await step("the browser switched on", async () => {
        await app.commands.setBrowserUse(id, owner(app), true);
        await say(app, id, "now with the browser");
    });
    await step("the browser switched off", async () => {
        await app.commands.setBrowserUse(id, owner(app), false);
        await say(app, id, "and without it");
    });
    await step("plan mode", async () => {
        await app.commands.setPlan(id, owner(app), true);
        await say(app, id, "plan something");
    });

    for (let index = 1; index < requests.length; index++) {
        const previous = requests[index - 1]!;
        const next = requests[index]!;
        const changed = firstChange(previous, next);

        assert.equal(
            changed,
            -1,
            `request ${index + 1} rewrote message ${changed + 1} of ${previous.length}: ${previous[changed]?.slice(0, 160)} -> ${next[changed]?.slice(0, 160)}`,
        );
        assert.ok(next.length > previous.length, `request ${index + 1} adds to the one before`);
    }

    assert.ok(steady.length >= 3, "turns and tool calls were seen");

    for (const index of steady) {
        const added = requests[index]!.slice(requests[index - 1]!.length).map(
            (message) =>
                JSON.parse(message) as {
                    role: string;
                    sections?: Record<string, unknown>;
                    toolsAdded?: unknown[];
                    toolsRemoved?: unknown[];
                },
        );
        const resent = added.filter(
            (message) =>
                Object.keys(message.sections ?? {}).length > 0 ||
                (message.toolsAdded?.length ?? 0) > 0 ||
                (message.toolsRemoved?.length ?? 0) > 0,
        );

        assert.deepEqual(
            resent.map((message) => Object.keys(message.sections ?? {})),
            [],
            `request ${index + 1} sent sections or tools again with nothing changed`,
        );
    }
});
