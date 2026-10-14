// Routers: Pi Pocket ships a Standard router of stages; the editor saves routers made of stages (a template's words,
// the skills a stage reads first, its model and effort, or one of the person's role files); prompts already on the
// machine are detected read-only; a session running as a router gets a prompt written from its stages, and each
// stage runs on the model and effort its router gives it; a dispatcher router may not run commands itself.
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
import { namedStages, pipelinePrompt, STANDARD } from "../src/server/routers.ts";

const dataDir = join(root, "routers-data");
const ompDir = join(home, ".omp", "agent", "router");
const skillDir = join(home, ".agents", "skills", "checklist");

/** What each subagent's requests carried: its model and system prompt. */
const seen: Record<string, { model: string; prompt: string }> = {};
let call: { name: string; args: JsonObject } = { name: "subagent", args: {} };
let lastResult = "";
let lastPrompt = "";

const route: FauxResponseStep = (request, _options, _state, model) => {
    const { messages } = request as { messages: Message[] };
    const all = JSON.stringify(messages);
    const subagent = /You are the subagent \\?"([^"\\]+)\\?"/.exec(all)?.[1];

    if (subagent !== undefined) {
        seen[subagent] = { model: model.id, prompt: all };

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
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
        join(skillDir, "SKILL.md"),
        "---\nname: checklist\ndescription: A checklist to follow.\n---\nCheck every box.\n",
    );
    writeFileSync(
        join(dataDir, "agents", "planner.md"),
        "---\nmodel: faux/faux-2\n---\nYou are PLANNERFILE.\n",
    );
    writeFileSync(join(dataDir, "agents", "builder.md"), "---\nmodel: faux/faux-2\n---\nBuild.\n");
    writeFileSync(
        join(dataDir, "routers", "ROUTER.md"),
        "You are MAINROUTER. Spawn `planner`, then `builder`.\n",
    );
    writeFileSync(join(ompDir, "ROUTER.md"), "OMP's main router, shadowed.\n");
    writeFileSync(join(ompDir, "ROUTER-FAST.md"), "You are FASTROUTER: `builder` only.\n");
    // An old saved router with no stages: not one from this editor, so left out.
    writeFileSync(join(dataDir, "routers", "old.json"), JSON.stringify({ id: "old", prompt: "x" }));

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
    rmSync(join(home, ".agents"), { recursive: true, force: true });
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

const stage = (id: string, template: string, extra: Record<string, unknown> = {}) => ({
    id,
    template,
    instructions: `Do ${id}.`,
    ...extra,
});

test("Standard ships; prompts on the machine are detected read-only; old saved files without stages are left out", () => {
    const routers = app.routers(true);

    assert.deepEqual(
        routers.find((router) => router.id === "standard")?.pipeline?.map((each) => each.template),
        ["plan", "implement", "review", "fix", "ship"],
    );
    assert.equal(routers.find((router) => router.id === "router")?.from, "Pi Pocket");
    assert.deepEqual(routers.find((router) => router.id === "router")?.stages, {
        planner: "faux/faux-2",
        builder: "faux/faux-2",
    });
    assert.equal(routers.find((router) => router.id === "router-fast")?.from, "Oh My Pi");
    assert.equal(
        routers.find((router) => router.id === "old"),
        undefined,
    );
    assert.deepEqual(namedStages("`a` `planner`", [{ name: "planner", instructions: "" }]), [
        "planner",
    ]);

    const prompt = pipelinePrompt(STANDARD);

    assert.match(prompt, /1\. Plan \(agent: `plan`\)/);
    assert.match(prompt, /fit check/);
    assert.match(prompt, /Run the fix stage only when the review stage reported findings/);
    assert.match(prompt, /Run the ship stage last/);
});

test("the editor's routers are checked, saved, replace Standard by its id, and deleting brings it back", () => {
    const guest = app.config.addUser("Router guest", "guest").user;
    const save = (router: Record<string, unknown>) => app.saveRouter(owner(app), router);

    assert.throws(() => app.saveRouter(guest, { id: "x" }), { status: 403 });
    assert.throws(() => save({ id: "Bad Id", pipeline: [stage("plan", "plan")] }), { status: 400 });
    assert.throws(() => save({ id: "x", pipeline: [] }), /at least one stage/);
    assert.throws(() => save({ id: "x", pipeline: [stage("a", "nope")] }), /template/);
    assert.throws(
        () => save({ id: "x", pipeline: [stage("a", "plan"), stage("a", "fix")] }),
        /own id/,
    );
    assert.throws(
        () => save({ id: "x", pipeline: [stage("a", "plan", { skills: ["not-installed"] })] }),
        /skills installed here/,
    );
    assert.throws(
        () => save({ id: "x", pipeline: [stage("a", "plan", { role: "ghost" })] }),
        /role ghost/,
    );
    assert.throws(() => save({ id: "x", model: "nope/m", pipeline: [stage("a", "plan")] }), {
        status: 400,
    });
    assert.throws(
        () =>
            save({
                id: "x",
                pipeline: [stage("a", "plan")],
                dispatcher: { blockedTools: ["bash"] },
            }),
        /router x: dispatcher must be a boolean/,
    );

    const withTrue = save({ id: "bool-true", pipeline: [stage("a", "plan")], dispatcher: true });

    assert.equal(withTrue.dispatcher, true);
    const withFalse = save({ id: "bool-false", pipeline: [stage("a", "plan")], dispatcher: false });

    assert.equal(withFalse.dispatcher, undefined);
    app.deleteRouter(owner(app), "bool-true");
    app.deleteRouter(owner(app), "bool-false");

    const over = save({
        id: "standard",
        label: "Mine",
        pipeline: [stage("fix", "fix"), stage("ship", "ship")],
    });

    assert.equal(over.overrides, true);
    assert.equal(app.routers().find((router) => router.id === "standard")?.label, "Mine");
    app.deleteRouter(owner(app), "standard");
    assert.equal(app.routers().find((router) => router.id === "standard")?.source, "built in");
});

test("a session running as a router gets its stages' prompt, and each stage its model, effort, skills, and words", async () => {
    app.saveRouter(owner(app), {
        id: "mix",
        label: "Mix",
        model: "faux/faux-think",
        thinking: "low",
        pipeline: [
            stage("plan", "plan", {
                model: "faux/faux-think",
                thinking: "high",
                skills: ["checklist"],
            }),
            stage("build", "implement"),
            stage("role-plan", "custom", { role: "planner" }),
        ],
    });
    const id = await newSession(app);

    await app.commands.setRouter(id, owner(app), "mix");
    assert.equal((await app.agentState(id))?.model?.modelId, "faux-think");
    assert.equal((await app.harness.snapshot(RouterDoc, id, context))?.router, "mix");

    // The stage's own model and effort, above the router's; its words, and the skill to read first.
    await go(id, "subagent", { action: "spawn", name: "p1", agent: "plan", message: "x" });
    await until(() => seen.p1 !== undefined, "the stage's request");
    assert.equal(seen.p1!.model, "faux-think");
    assert.match(seen.p1!.prompt, /You are the Plan stage/);
    assert.match(seen.p1!.prompt, /Do plan\./);
    assert.match(seen.p1!.prompt, /- checklist: .*checklist[\\/]+SKILL\.md/);

    const p1 = (await app.harness.snapshot(SubagentsDoc, id, context))?.agents.p1;

    assert.equal((await app.agentState(p1!.conversationId))?.thinkingLevel, "high");
    assert.match(lastPrompt, /You are a router: Mix/);
    assert.doesNotMatch(lastPrompt, /Agent definitions you can spawn/, "no one's role files");

    // No model of its own: the router's.
    await go(id, "subagent", { action: "spawn", name: "b1", agent: "build", message: "x" });
    await until(() => seen.b1 !== undefined, "the stage's request");
    assert.equal(seen.b1!.model, "faux-think");

    // A role file in place of the words.
    await go(id, "subagent", { action: "spawn", name: "r1", agent: "role-plan", message: "x" });
    await until(() => seen.r1 !== undefined, "the stage's request");
    assert.match(seen.r1!.prompt, /You are PLANNERFILE\./);

    // Another model picked by hand: the session is plain again.
    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-2" },
    });
    assert.equal((await app.harness.snapshot(RouterDoc, id, context))?.router, undefined);
    await assert.rejects(app.commands.setRouter(id, owner(app), "ghost"), { status: 404 });
});

test("a router saved with a model moves the sessions running as it; picked again it sets the model again; it spawns only its stages", async () => {
    // Picked while it had no model: the session keeps its own.
    app.saveRouter(owner(app), { id: "late", label: "Late", pipeline: [stage("plan", "plan")] });
    const id = await newSession(app);

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
    });
    await app.commands.setRouter(id, owner(app), "late");
    assert.equal((await app.agentState(id))?.model?.modelId, "faux-1");

    // Saved with a model: the session runs on it, and still as the router.
    app.saveRouter(owner(app), {
        id: "late",
        label: "Late",
        model: "faux/faux-think",
        pipeline: [stage("plan", "plan")],
    });
    await app.commands.followRouter(owner(app), "late");
    assert.equal((await app.agentState(id))?.model?.modelId, "faux-think");
    assert.equal((await app.harness.snapshot(RouterDoc, id, context))?.router, "late");

    // Picked again after the model moved off it: back on the router's model.
    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
    });
    await app.commands.setRouter(id, owner(app), "late");
    await app.commands.setRouter(id, owner(app), "late");
    assert.equal((await app.agentState(id))?.model?.modelId, "faux-think");
    assert.equal((await app.harness.snapshot(RouterDoc, id, context))?.router, "late");

    // A role file that is not one of its stages is refused.
    assert.match(
        await go(id, "subagent", { action: "spawn", name: "x1", agent: "planner", message: "x" }),
        /planner is not a stage of the router Late\. Its stages: plan/,
    );
});

test("a detected router runs its prompt, its roles on their models; one with no model here keeps the session's", async () => {
    const id = await newSession(app);

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
    });
    await app.commands.setRouter(id, owner(app), "router");
    assert.equal(
        (await app.agentState(id))?.model?.modelId,
        "faux-1",
        "no model named router here",
    );
    await go(id, "subagent", { action: "spawn", name: "d1", agent: "planner", message: "x" });
    await until(() => seen.d1 !== undefined, "the stage's request");
    assert.equal(seen.d1!.model, "faux-2");
    assert.match(lastPrompt, /You are MAINROUTER\./);
});

test("a dispatcher router may not run commands itself", async () => {
    app.saveRouter(owner(app), {
        id: "dispatch",
        pipeline: [stage("fix", "fix")],
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
