// Routers: prompts already on the machine are detected, with the stages they name; the editor saves routers, one
// with a detected router's id takes its place; a session running as a router gets its prompt, its model, and its
// stages' models; picking another model by hand ends that; a dispatcher router may not run commands itself.
import {
    type App,
    cleanUp,
    context,
    home,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep, Message } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, JsonObject } from "@earendil-works/pi-durable";
import { RouterDoc, SubagentsDoc } from "../src/server/docs.ts";
import { checkRouter, detectRouters, namedStages } from "../src/server/routers.ts";

const dataDir = join(root, "routers-data");
const ompDir = join(home, ".omp", "agent", "router");

/** The model each subagent's requests went to. */
const seen: Record<string, string> = {};
/** The tool call the parent makes for its next "go". */
let call: { name: string; args: JsonObject } = { name: "subagent", args: {} };
let lastResult = "";
let lastPrompt = "";

const route: FauxResponseStep = (request, _options, _state, model) => {
    const { messages } = request as { messages: Message[] };
    const all = JSON.stringify(messages);
    const subagent = /You are the subagent \\?"([^"\\]+)\\?"/.exec(all)?.[1];

    if (subagent !== undefined) {
        seen[subagent] = model.id;

        return fauxAssistantMessage([fauxText(`result of ${subagent}`)]);
    }

    lastPrompt = all;
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        lastResult = JSON.stringify(messages.at(-1));

        return fauxAssistantMessage([fauxText("ok")]);
    }

    if (text.endsWith("go")) {
        return fauxAssistantMessage([fauxToolCall(call.name, call.args)], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText("noted")]);
};

let app: App;

before(async () => {
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(join(dataDir, "agents"), { recursive: true });
    mkdirSync(join(dataDir, "routers"), { recursive: true });
    mkdirSync(ompDir, { recursive: true });
    writeFileSync(join(dataDir, "agents", "planner.md"), "---\nmodel: faux/faux-2\n---\nPlan.\n");
    writeFileSync(join(dataDir, "agents", "builder.md"), "---\nmodel: faux/faux-2\n---\nBuild.\n");
    writeFileSync(
        join(dataDir, "routers", "ROUTER.md"),
        "You are MAINROUTER. Spawn `planner`, then `builder`. Never `nobody`.\n",
    );
    writeFileSync(join(ompDir, "ROUTER.md"), "OMP's main router, shadowed by Pi Pocket's.\n");
    writeFileSync(join(ompDir, "ROUTER-FAST.md"), "You are FASTROUTER: `builder` only.\n");
    // The scripted models, and one that thinks, for stage thinking levels.
    const faux = fauxProvider({
        tokensPerSecond: 2000,
        models: [
            { id: "faux-1" },
            { id: "faux-2" },
            { id: "faux-vision", input: ["text", "image"] },
            { id: "faux-think", reasoning: true },
        ],
    });

    faux.setResponses(Array.from({ length: 1000 }, () => route));
    app = await openApp(faux, dataDir);
});

after(async () => {
    await app?.close();
    rmSync(join(home, ".omp"), { recursive: true, force: true });
    cleanUp();
});

async function go(id: ConversationId, name: string, args: JsonObject) {
    call = { name, args };
    lastResult = "";
    await app.commands.submit(id, owner(app), {
        text: "go",
        requestId: `go-${String(args.name ?? name)}-${Date.now()}`,
    });
    await until(() => lastResult !== "" && !app.isBusy(id), "the call's result");

    return lastResult;
}

test("prompts on the machine are detected, Pi Pocket's first, with the stages they name", () => {
    const routers = app.routers(true);
    const main = routers.find((router) => router.id === "router");
    const fast = routers.find((router) => router.id === "router-fast");

    assert.equal(main?.from, "Pi Pocket", "Pi Pocket's ROUTER.md wins over Oh My Pi's");
    assert.deepEqual(main?.stages, { planner: "faux/faux-2", builder: "faux/faux-2" });
    assert.equal(fast?.from, "Oh My Pi");
    // Pi Pocket's own pipeline, with its own roles: no one's skills or models needed.
    assert.deepEqual(routers.find((router) => router.id === "pipeline")?.from, "built in");
    assert.deepEqual(
        Object.keys(routers.find((router) => router.id === "pipeline")?.stages ?? {}),
        [],
    );
    assert.deepEqual(Object.keys(fast?.stages ?? {}), ["builder"]);
    assert.deepEqual(
        namedStages("`a` `planner` `planner`", [{ name: "planner", instructions: "" }]),
        ["planner"],
    );
    assert.deepEqual(
        detectRouters([{ dir: join(root, "nowhere"), from: "x" }], [], () => undefined),
        [],
    );
});

test("a router from the editor is checked, saved, takes a detected one's place, and deleting brings it back", async () => {
    const resolve = (spec: string) => {
        if (spec.startsWith("faux/")) {
            return { provider: "faux", modelId: spec.slice(5) };
        }

        throw new Error(`${spec} is not available`);
    };

    assert.throws(
        () => checkRouter({ id: "Bad Id", model: "faux/faux-1" }, resolve, ["off"]),
        /id must/,
    );
    assert.throws(
        () => checkRouter({ id: "x", model: "nope/m", prompt: "p", stages: {} }, resolve, ["off"]),
        /not available/,
    );
    assert.throws(
        () => checkRouter({ id: "x", model: "faux/faux-1", stages: {} }, resolve, ["off"]),
        /needs a prompt/,
    );
    assert.throws(
        () =>
            checkRouter(
                { id: "x", model: "faux/faux-1", prompt: "p", stages: { a: "nomodel" } },
                resolve,
                ["off"],
            ),
        /stage a/,
    );

    const guest = app.config.addUser("Router guest", "guest").user;

    assert.throws(() => app.saveRouter(guest, { id: "x" }), { status: 403 });
    // A prompt file outside the router prompt folders is refused.
    assert.throws(
        () =>
            app.saveRouter(owner(app), {
                id: "leak",
                model: "faux/faux-1",
                promptFile: join(dataDir, "agents", "planner.md"),
                stages: {},
            }),
        { status: 400 },
    );

    const over = app.saveRouter(owner(app), {
        id: "router",
        label: "Main, edited",
        model: "faux/faux-1",
        prompt: "You are EDITEDMAIN.",
        stages: { planner: "faux/faux-1" },
    });

    assert.equal(over.overrides, true);
    assert.equal(app.routers().find((router) => router.id === "router")?.label, "Main, edited");
    app.deleteRouter(owner(app), "router");
    assert.equal(app.routers().find((router) => router.id === "router")?.source, "detected");
    assert.throws(() => app.deleteRouter(owner(app), "router"), { status: 404 });
});

test("a session running as a router gets its model and prompt, and its stages run on the router's models", async () => {
    app.saveRouter(owner(app), {
        id: "mix",
        label: "Mix",
        model: "faux/faux-1",
        prompt: "You are MIXROUTER.",
        stages: { planner: "faux/faux-vision" },
    });
    const id = await newSession(app);

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-2" },
    });
    await app.commands.setRouter(id, owner(app), "mix");
    assert.equal((await app.agentState(id))?.model?.modelId, "faux-1", "the router's model");
    assert.equal((await app.harness.snapshot(RouterDoc, id, context))?.router, "mix");

    // The router's stage model, over the definition's, and allowed though auto would not reach it.
    assert.match(
        await go(id, "subagent", { action: "spawn", name: "p1", agent: "planner", message: "x" }),
        /on faux\/faux-vision/,
    );
    await until(() => seen.p1 !== undefined, "the stage's request");
    assert.equal(seen.p1, "faux-vision");
    assert.match(lastPrompt, /You are MIXROUTER\./);
    assert.match(lastPrompt, /- planner \(runs on faux\/faux-vision\)/);

    // A role the router does not map runs as its definition and the session's choice say.
    assert.match(
        await go(id, "subagent", { action: "spawn", name: "b1", agent: "builder", message: "x" }),
        /on faux\/faux-2/,
    );

    // Another model picked by hand: the session is plain again.
    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-2" },
    });
    assert.equal((await app.harness.snapshot(RouterDoc, id, context))?.router, undefined);

    await assert.rejects(app.commands.setRouter(id, owner(app), "ghost"), { status: 404 });
});

test("a dispatcher router may not run commands itself", async () => {
    app.saveRouter(owner(app), {
        id: "dispatch",
        model: "faux/faux-1",
        prompt: "Dispatch.",
        stages: {},
        dispatcher: true,
    });
    const id = await newSession(app);

    await app.commands.setRouter(id, owner(app), "dispatch");
    assert.match(
        await go(id, "bash", { command: "echo hi" }),
        /dispatch is a dispatcher: bash, edit and write are blocked/,
    );

    await app.commands.setRouter(id, owner(app), null);
    assert.doesNotMatch(await go(id, "bash", { command: "echo hi" }), /dispatcher/);
});

test("a router's stage thinks as its person set it, above the session's own level too", async () => {
    app.saveRouter(owner(app), {
        id: "deep",
        model: "faux/faux-think",
        thinking: "low",
        prompt: "Deep.",
        stages: { planner: "faux/faux-think" },
        stageThinking: { planner: "high" },
    });
    assert.throws(
        () =>
            app.saveRouter(owner(app), {
                id: "bad",
                model: "faux/faux-1",
                prompt: "x",
                stages: {},
                stageThinking: { planner: "enormous" },
            }),
        { status: 400 },
    );

    const id = await newSession(app);

    await app.commands.setRouter(id, owner(app), "deep");
    assert.equal((await app.agentState(id))?.thinkingLevel, "low");
    await go(id, "subagent", { action: "spawn", name: "d1", agent: "planner", message: "x" });
    await until(() => seen.d1 !== undefined, "the stage's request");

    const stage = (await app.harness.snapshot(SubagentsDoc, id, context))?.agents.d1;

    assert.equal((await app.agentState(stage!.conversationId))?.thinkingLevel, "high");
});
