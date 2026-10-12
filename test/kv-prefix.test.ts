// KV prefix discipline: a provider caches the system prompt byte for byte from its start, so the stable sections
// come first and the one thing that changes on its own - the day - sits in the last section of each pack, with
// only the harness's own instructions behind it. When volatile content regresses to the front of the pack, every
// change of it turns a cache hit into a thousands-of-tokens re-prefill, so this test pins the order both prompt
// packs actually resolve to: the date last in each, and each pack's own date section the only one that renders.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId, PromptSection } from "@earendil-works/pi-durable";
import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
} from "./helpers.ts";

let app: App;

const dataDir = join(root, "data");

before(async () => {
    // A drop-in with a big stable section, as a router setup has: the date must still come after it.
    mkdirSync(join(dataDir, "extensions"), { recursive: true });
    writeFileSync(
        join(dataDir, "extensions", "router-pack.ts"),
        `import { defineExtension, section } from "@earendil-works/pi-durable";
export default () => defineExtension({ name: "router-pack", sections: [section("router_pack", () => "stable router instructions")] });
`,
    );
    writeFileSync(
        join(dataDir, "extensions", "late-pack.ts"),
        `import { defineExtension, section } from "@earendil-works/pi-durable";
export default () => defineExtension({ name: "late-pack", sections: [section("late_pack", () => "turned on later")] });
`,
    );
    app = await openApp(scriptedModel(), dataDir);
    await app.setExtensionEnabled(owner(app), "router-pack.ts", true);
    await app.close();
    // A restart loads the drop-in at startup, the way a router setup runs.
    app = await openApp(scriptedModel(), dataDir);
});

after(async () => {
    await app.close();
    cleanUp();
});

const keysOf = (sections: readonly PromptSection[]): string[] =>
    sections.map((section) => section.key);

/** Sections render with as little as their conversation, for a pin that only asks who renders what. */
const rendered = (
    id: ConversationId,
    agent: { sections: readonly PromptSection[] },
    key: string,
) => {
    const section = agent.sections.find((each) => each.key === key)!;

    return section.render(
        { conversationId: id, agent: agent as never, env: undefined, shown: {}, read: {} as never },
        context,
    );
};

test("the session pack ends with its date, after every stable section", async () => {
    const id = await newSession(app);
    const agent = (await (await app.harness.conversation(id, context))!.agent(context))!;
    const keys = keysOf(agent.sections);
    const today = keys.indexOf("today");

    assert.ok(today >= 0, `the today section is installed: ${keys.join(", ")}`);
    assert.ok(
        keys.indexOf("environment") < today,
        `environment should come before today: ${keys.join(", ")}`,
    );
    // Only the harness's own instructions may sit behind the date.
    assert.ok(today >= keys.length - 2, `today should be last but one: ${keys.join(", ")}`);

    assert.match((await rendered(id, agent, "today")) ?? "", /Today: \d{4}-\d{2}-\d{2}/);
    assert.equal(await rendered(id, agent, "pip_today"), undefined);
});

test("the PiP pack ends with its date in its own time zone", async () => {
    const id = await app.pip.ensure(owner(app));
    const agent = (await (await app.harness.conversation(id, context))!.agent(context))!;
    const keys = keysOf(agent.sections);
    const today = keys.indexOf("pip_today");

    assert.ok(today >= 0, `the pip today section is installed: ${keys.join(", ")}`);
    assert.ok(
        keys.indexOf("pip_environment") < today,
        `pip_environment should come before pip_today: ${keys.join(", ")}`,
    );
    assert.ok(today >= keys.length - 2, `pip_today should be last but one: ${keys.join(", ")}`);

    assert.match((await rendered(id, agent, "pip_today")) ?? "", /Today: \d{4}-\d{2}-\d{2}/);
    assert.equal(await rendered(id, agent, "today"), undefined);
});

test("the date stays behind a drop-in's sections, at startup and when one is turned on later", async () => {
    const order = async () => {
        const id = await newSession(app);
        const agent = (await (await app.harness.conversation(id, context))!.agent(context))!;

        return keysOf(agent.sections);
    };

    const atStart = await order();

    assert.ok(atStart.indexOf("router_pack") >= 0, `the drop-in is loaded: ${atStart.join(", ")}`);
    assert.ok(
        atStart.indexOf("router_pack") < atStart.indexOf("today"),
        `today should come after the drop-in's section: ${atStart.join(", ")}`,
    );

    await app.setExtensionEnabled(owner(app), "late-pack.ts", true);
    const later = await order();

    assert.ok(
        later.indexOf("late_pack") < later.indexOf("today"),
        `today should come after a drop-in turned on later: ${later.join(", ")}`,
    );
});
