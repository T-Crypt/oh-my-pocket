// A subagent thinks at the level Pi asks, also above its session's; a level its model lacks becomes a lower one, and a
// level raised by hand stays as work is sent.
import { type App, cleanUp, context, lastText, openApp, owner, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "../src/server/docs.ts";

/** The parent does as its message says: `spawn <name> <level>` or `send <name>`. Subagents answer, and the parent is done. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    const asked = /spawn (\S+) (\S+)(?: (\S+))?$/.exec(text);
    const again = /^send (\S+)$/.exec(text);

    if (role === "user" && again !== null) {
        return fauxAssistantMessage(
            [
                fauxToolCall("subagent", {
                    action: "send",
                    name: again[1]!,
                    message: "Think again.",
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (role === "user" && asked !== null) {
        const [, name, thinking, model] = asked;

        return fauxAssistantMessage(
            [
                fauxToolCall("subagent", {
                    action: "spawn",
                    name: name!,
                    message: "Think about it.",
                    ...(thinking === "-" ? {} : { thinking }),
                    ...(model === undefined ? {} : { model }),
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText("done")]);
};

const faux = fauxProvider({ models: [{ id: "deep", reasoning: true }, { id: "plain" }] });

faux.setResponses(Array.from({ length: 100 }, () => route));

let app: App;

before(async () => {
    app = await openApp(faux);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/**
 * A session on `modelId` at `thinkingLevel` whose Pi spawns as `text` says; the subagent's thinking level, and what the
 * tool answered.
 */
async function spawn(modelId: string, text: string, thinkingLevel = "off") {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId },
        thinkingLevel,
    });
    await app.commands.submit(id, owner(app), { text, requestId: `spawn-${id}` });

    const name = /spawn (\S+)/.exec(text)![1]!;
    let child: ConversationId | undefined;

    await until(async () => {
        child = (await app.harness.snapshot(SubagentsDoc, id, context))?.agents[name]
            ?.conversationId;

        return child !== undefined && !app.isBusy(id);
    }, `${name} spawned`);

    const messages = (await (await app.harness.conversation(id, context))!.context(context))
        .messages;
    const answer = JSON.stringify(messages.filter((message) => message.role === "toolResult"));

    return { thinking: (await app.agentState(child!))?.thinkingLevel, answer };
}

test("a subagent with no level named takes its session's", async () => {
    assert.equal((await spawn("deep", "spawn same -", "medium")).thinking, "medium");
});
