// Subagents per session (`/subagents`): a session's person chooses which models its subagents may run on besides its
// own. On `auto`, the default, an agent definition on the session's own provider runs on its model, and one on another
// provider (a local role, from a cloud session) runs its role on the session's model; `own` keeps every subagent on the
// session's model, `local` allows every definition's model, and `custom` the models listed. Pi cannot change it.
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
import type { ConversationId } from "@earendil-works/pi-durable";
import { SubagentPolicyDoc } from "../src/server/docs.ts";

const dataDir = join(root, "policy-data");
const folder = join(dataDir, "agents");

/** The model each subagent's requests went to. */
const seen: Record<string, string> = {};
/** The spawn arguments the parent sends for its next "go". */
let spawn: Record<string, unknown> = {};
let lastResult = "";

const route: FauxResponseStep = (request, _options, _state, model) => {
    const { messages } = request as { messages: Message[] };
    const all = JSON.stringify(messages);
    const subagent = /You are the subagent \\?"([^"\\]+)\\?"/.exec(all)?.[1];

    if (subagent !== undefined) {
        seen[subagent] = model.id;

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
    // On the session's provider, as a router session's roles are.
    writeFileSync(join(folder, "near.md"), "---\nmodel: faux/faux-2\n---\nYou are near.\n");
    // On another provider, as a local role is to a cloud session.
    writeFileSync(join(folder, "far.md"), "---\nmodel: elsewhere/big\n---\nYou are far.\n");
    app = await openApp(scriptedModel(route), dataDir);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** A session on faux/faux-1. */
async function session(): Promise<ConversationId> {
    const id = await newSession(app);

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
    });

    return id;
}

async function go(id: ConversationId, args: Record<string, unknown>) {
    spawn = args;
    lastResult = "";
    await app.commands.submit(id, owner(app), {
        text: "go",
        requestId: `go-${String(args.name)}`,
    });
    await until(
        () => lastResult !== "" && !app.isBusy(id),
        `the spawn result of ${String(args.name)}`,
    );

    return lastResult;
}

async function runsOn(name: string) {
    await until(() => seen[name] !== undefined, `${name}'s request`);

    return seen[name];
}

async function prompt(id: ConversationId) {
    return JSON.stringify(await (await app.harness.conversation(id, context))!.context(context));
}

test("on auto, a definition on the session's provider runs on its model, one on another runs on the session's", async () => {
    const id = await session();

    assert.match(await go(id, { name: "a-near", agent: "near", message: "x" }), /on faux\/faux-2/);
    assert.equal(await runsOn("a-near"), "faux-2");

    const far = await go(id, { name: "a-far", agent: "far", message: "x" });

    assert.match(far, /Started a-far on faux\/faux-1 \(your model: elsewhere\/big is not allowed/);
    assert.match(far, /\/subagents/);
    assert.equal(await runsOn("a-far"), "faux-1");

    const said = await prompt(id);

    assert.match(said, /- near \(runs on faux\/faux-2\)/);
    assert.match(said, /- far \(runs on your model\)/);
});

test("own keeps every subagent on the session's model, and a model Pi names is refused with word of /subagents", async () => {
    const id = await session();

    await app.commands.setSubagents(id, owner(app), { mode: "own" });
    assert.match(await go(id, { name: "o-near", agent: "near", message: "x" }), /your model/);
    assert.equal(await runsOn("o-near"), "faux-1");

    const refused = await go(id, { name: "o-named", message: "x", model: "faux/faux-2" });

    assert.match(refused, /cannot choose another/);
    assert.match(refused, /\/subagents/);
    assert.equal(seen["o-named"], undefined);
});

test("local allows every definition's model; one that cannot be used fails, never falling back", async () => {
    const id = await session();

    await app.commands.setSubagents(id, owner(app), { mode: "local" });
    assert.match(await go(id, { name: "l-far", agent: "far", message: "x" }), /not available/);
    assert.equal(seen["l-far"], undefined);
    assert.match(await prompt(id), /- far \(runs on elsewhere\/big\)/);
});

test("custom allows exactly the models listed, which must be ones Pi can use", async () => {
    const id = await session();

    await app.commands.setSubagents(id, owner(app), { mode: "custom", models: ["faux-2"] });
    assert.deepEqual(
        (await app.harness.snapshot(SubagentPolicyDoc, id, context))?.models,
        ["faux/faux-2"],
        "stored as provider/modelId",
    );
    assert.match(
        await go(id, { name: "c-named", message: "x", model: "faux/faux-2" }),
        /Started c-named on faux\/faux-2/,
    );
    assert.equal(await runsOn("c-named"), "faux-2");

    await app.commands.setSubagents(id, owner(app), { mode: "custom", models: [] });
    assert.match(await go(id, { name: "c-near", agent: "near", message: "x" }), /your model/);

    await assert.rejects(
        app.commands.setSubagents(id, owner(app), { mode: "custom", models: ["nope/none"] }),
        { status: 400 },
    );
    await assert.rejects(app.commands.setSubagents(id, owner(app), { mode: "most" }), {
        status: 400,
    });
});

test("the room shows the choice and what it comes to", async () => {
    const id = await session();
    const view = (mode?: string) =>
        app.subagentsView(mode === undefined ? undefined : { mode: mode as "own" }, {
            provider: "faux",
            modelId: "faux-1",
        });

    assert.deepEqual(view(), {
        mode: "auto",
        label: "auto · local",
        models: [],
        allowed: ["faux/faux-2"],
    });
    assert.equal(view("own").label, "own");
    assert.deepEqual(
        app.subagentsView(undefined, { provider: "cloud", modelId: "big" }).label,
        "auto · own",
        "a session on another provider than its roles",
    );
    await app.commands.setSubagents(id, owner(app), { mode: "local" });
    assert.equal((await app.harness.snapshot(SubagentPolicyDoc, id, context))?.mode, "local");
});
