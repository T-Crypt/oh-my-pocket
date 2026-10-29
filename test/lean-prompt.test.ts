// Lean prompt: seldom-used tools are offered on request. A request carries them in a one-line list, not their schemas
// and guides; load_tools adds one for the steps after it; the browser is never loaded this way; the owner's list decides.
// The shared isolation offers every tool (0); the module reads this when the app loads it, after the imports.
process.env.PI_POCKET_LEAN_PROMPT = "1";

import {
    type App,
    cleanUp,
    lastText,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { JsonObject } from "@earendil-works/pi-durable";

let app: App;
/** The tools the last request offered, and its prompt sections as they stand after replaying the transcript. */
let tools: string[] = [];
let system = "";
/** The next call Pi makes, when a step sets one; its result lands in `results`. */
let next: { name: string; args: JsonObject } | undefined;
const results: string[] = [];

const route: FauxResponseStep = (request) => {
    const { messages } = request as unknown as {
        messages: {
            role: string;
            toolsAdded?: { name: string }[];
            toolsRemoved?: ({ name: string } | string)[];
        }[];
    };
    const offered = new Set<string>();

    for (const message of messages) {
        for (const tool of message.toolsAdded ?? []) {
            offered.add(tool.name);
        }

        for (const tool of message.toolsRemoved ?? []) {
            offered.delete(typeof tool === "string" ? tool : tool.name);
        }
    }

    tools = [...offered];

    // Sections travel the same way: a later system message replaces a section, or (null) ends it.
    const sections: Record<string, string> = {};

    for (const message of messages as {
        role: string;
        sections?: Record<string, string | null>;
    }[]) {
        for (const [key, text] of Object.entries(message.sections ?? {})) {
            if (text === null) {
                delete sections[key];
            } else {
                sections[key] = `<${key}>${text}</${key}>`;
            }
        }
    }

    system = Object.values(sections).join("\n");

    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        results.push(text);

        return fauxAssistantMessage([fauxText("done")]);
    }

    const call = next;

    next = undefined;

    return call === undefined
        ? fauxAssistantMessage([fauxText("ok")])
        : fauxAssistantMessage([fauxToolCall(call.name, call.args)], { stopReason: "toolUse" });
};

before(async () => {
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("a request offers the everyday tools, and lists the rest instead of carrying them", async () => {
    const id = await newSession(app);

    await say(app, id, "hello");

    for (const name of ["bash", "read", "edit", "write", "load_tools"]) {
        assert.ok(tools.includes(name), `${name} is offered`);
    }

    for (const name of ["artifact", "artifact_inline", "schedule", "background", "codemode"]) {
        assert.equal(tools.includes(name), false, `${name} waits to be loaded`);
        assert.match(system, new RegExp(`- ${name}: `), `${name} is in the list`);
    }

    assert.doesNotMatch(system, /<artifacts>/, "the artifacts guide waits with its tools");
    assert.doesNotMatch(system, /- browser: /, "the browser is a person's switch, not on the list");

    const meter = await app.contextMeter(id);

    assert.ok(meter.tokens < 9000, `the prompt is lean: ${meter.tokens} tokens`);
});

test("load_tools adds a tool and its guide for the next steps; the browser stays a person's", async () => {
    const id = await newSession(app);

    next = { name: "load_tools", args: { names: ["schedule", "browser", "nope"] } };
    await say(app, id, "I need to schedule something");

    const loaded = results.at(-1)!;

    assert.match(loaded, /Loaded schedule/);
    assert.match(loaded, /Not on the list: browser, nope\. The browser is a person's switch/);
    // The answer after the call is the next request: it carries the tool and its guide now.
    assert.ok(tools.includes("schedule"), "schedule is offered");
    assert.match(system, /<schedules>/);
    assert.equal(tools.includes("browser"), false);

    await say(app, id, "and again");
    assert.ok(tools.includes("schedule"), "it stays loaded");
    assert.doesNotMatch(system, /- schedule: /, "and leaves the list");
});

test("plan mode lets load_tools through", async () => {
    const id = await newSession(app);

    await app.commands.setPlan(id, owner(app), true);
    next = { name: "load_tools", args: { names: ["codemode"] } };
    await say(app, id, "plan with codemode");
    assert.match(results.at(-1)!, /Loaded codemode/);
});

test("an empty list from the owner offers every tool again", async () => {
    app.setExtensionSettings(owner(app), "lean-prompt", { onRequest: "" });
    // The module loads again with the owner's list.
    await until(async () => {
        await say(app, await newSession(app), "hello");

        return tools.includes("artifact");
    }, "the module loaded again");

    const id = await newSession(app);

    await say(app, id, "hello");
    assert.ok(tools.includes("artifact"), "artifact is offered");
    assert.doesNotMatch(system, /More tools are offered on request/);
});
