// Agent definitions: a subagent spawned with `agent` starts with the definition's role, model, thinking level, and
// tools, the spawn's own options win, and a bad name or level fails without starting anything.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { listAgents, loadAgent } from "../src/server/agents.ts";

const dataDir = join(root, "agents-data");
const folder = join(dataDir, "agents");

/** What each subagent's requests carried: its system prompt, model, and tools. */
const seen: Record<string, { systemPrompt: string; model: string; tools: string[] }> = {};
/** The spawn arguments the parent sends for its next "go". */
let spawn: Record<string, unknown> = {};
let lastResult = "";

/** The prompt and tools a request carries: replaying its system messages, as a provider does. */
function replay(messages: Message[]) {
    const sections: Record<string, string> = {};
    const tools = new Set<string>();
    let content = "";

    for (const message of messages) {
        if (message.role !== "system") {
            continue;
        }

        content += JSON.stringify(message.content);

        for (const [key, value] of Object.entries(message.sections ?? {})) {
            if (value === null) {
                delete sections[key];
            } else {
                sections[key] = value;
            }
        }

        for (const tool of message.toolsAdded ?? []) {
            tools.add(tool.name);
        }

        for (const tool of message.toolsRemoved ?? []) {
            tools.delete(tool.name);
        }
    }

    return { systemPrompt: content + Object.values(sections).join("\n"), tools: [...tools] };
}

const route: FauxResponseStep = (request, _options, _state, model) => {
    const { messages } = request as { messages: Message[] };
    const { systemPrompt, tools } = replay(messages);
    const subagent = /You are the subagent \\?"([^"\\]+)\\?"/.exec(systemPrompt)?.[1];

    if (subagent !== undefined) {
        seen[subagent] = {
            systemPrompt,
            model: model.id,
            tools,
        };

        return fauxAssistantMessage([fauxText(`result of ${subagent}`)]);
    }

    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        lastResult = JSON.stringify(messages.at(-1));

        return fauxAssistantMessage([fauxText("ok")]);
    }

    if (text.endsWith("go")) {
        return fauxAssistantMessage([fauxToolCall("subagent", { action: "spawn", ...spawn })], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText("noted")]);
};

let app: App;

before(async () => {
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    writeFileSync(
        join(folder, "reviewer.md"),
        [
            "---",
            "description: Reviews a diff. Never edits.",
            "model: faux-2",
            "thinking: high",
            "tools: [read, bash]",
            "---",
            "",
            "You are the reviewer. Report findings with file:line.",
            "",
        ].join("\n"),
    );
    writeFileSync(join(folder, "plain.md"), "Just a role, no front matter.\n");
    writeFileSync(join(folder, "odd.md"), "---\nthinking: enormous\n---\nOdd.\n");
    app = await openApp(scriptedModel(route), dataDir);
});

after(async () => {
    await app?.close();
    cleanUp();
});

async function go(args: Record<string, unknown>) {
    spawn = args;
    lastResult = "";
    const id = await newSession(app);

    await app.commands.submit(id, owner(app), { text: "go", requestId: `go-${String(args.name)}` });
    await until(() => lastResult !== "" && !app.isBusy(id), "the spawn's result");

    return lastResult;
}

test("definitions parse: front matter optional, tools as a list, the body as instructions", () => {
    assert.deepEqual(
        listAgents(dataDir)
            .filter((agent) => agent.builtIn !== true)
            .map((agent) => agent.name),
        ["odd", "plain", "reviewer"],
    );
    assert.deepEqual(loadAgent(dataDir, "reviewer"), {
        name: "reviewer",
        description: "Reviews a diff. Never edits.",
        model: "faux-2",
        thinking: "high",
        tools: ["read", "bash"],
        instructions: "You are the reviewer. Report findings with file:line.",
    });
    assert.deepEqual(loadAgent(dataDir, "plain"), {
        name: "plain",
        instructions: "Just a role, no front matter.",
    });
    assert.throws(() => loadAgent(dataDir, "../reviewer"), /Available: odd, plain, reviewer/);
    assert.deepEqual(
        listAgents(join(root, "no-such-folder")).filter((agent) => agent.builtIn !== true),
        [],
    );
});

test("a subagent spawned as a definition gets its role, model, and tools", async () => {
    await go({ name: "rev", agent: "reviewer", message: "Review it." });
    await until(() => seen.rev !== undefined, "the subagent's request");
    assert.match(seen.rev!.systemPrompt, /You are the reviewer\. Report findings with file:line\./);
    assert.equal(seen.rev!.model, "faux-2");
    assert.deepEqual([...seen.rev!.tools].sort(), ["bash", "read"]);
});

test("the spawn's own options win over the definition's", async () => {
    await go({
        name: "rev2",
        agent: "reviewer",
        message: "Review it.",
        model: "faux-1",
        tools: ["read"],
    });
    await until(() => seen.rev2 !== undefined, "the subagent's request");
    assert.equal(seen.rev2!.model, "faux-1");
    assert.deepEqual(seen.rev2!.tools, ["read"]);
});

test("the parent's prompt lists the definitions", async () => {
    let prompt = "";
    const id = await newSession(app);

    await app.commands.submit(id, owner(app), { text: "hello", requestId: "list" });
    await until(() => !app.isBusy(id), "the answer");
    const conversation = (await app.harness.conversation(id, context))!;

    prompt = JSON.stringify(await conversation.context(context));
    assert.match(prompt, /reviewer \(runs on faux\/faux-2\): Reviews a diff\. Never edits\./);
});

test("an unknown definition or a bad thinking level starts nothing and says why", async () => {
    assert.match(
        await go({ name: "nope", agent: "ghost", message: "x" }),
        /No agent definition named ghost/,
    );
    assert.match(
        await go({ name: "odd1", agent: "odd", message: "x" }),
        /asks for thinking enormous/,
    );
    assert.equal(seen.nope, undefined);
    assert.equal(seen.odd1, undefined);
});
