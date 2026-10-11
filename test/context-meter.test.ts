// The context meter: where a conversation's context goes, by system section, tool schema, and kind of history.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { contextMeter } from "../src/server/context-meter.ts";

const tool = (name: string) => ({
    name,
    description: "x".repeat(100),
    parameters: { type: "object", properties: {} },
});

const system = (sections: Record<string, string | null>, tools: string[] = []) =>
    ({
        role: "system",
        content: "",
        sections,
        toolsAdded: tools.map(tool),
        timestamp: 0,
    }) as unknown as Message;

const assistant = (content: unknown[], input = 0) =>
    ({
        role: "assistant",
        content,
        usage: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
    }) as unknown as Message;

const row = (meter: ReturnType<typeof contextMeter>, group: string, name: string) =>
    meter.rows.find((each) => each.group === group && each.name === name)?.tokens;

test("rows split the system prompt by section, tools by schema, and history by kind", () => {
    const meter = contextMeter([
        system({ preamble: "p".repeat(400), skills: "s".repeat(800) }, ["read", "bash"]),
        { role: "user", content: "u".repeat(40), timestamp: 0 } as Message,
        assistant([
            { type: "thinking", thinking: "t".repeat(80) },
            { type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } },
        ]),
        {
            role: "toolResult",
            toolCallId: "1",
            toolName: "read",
            content: [{ type: "text", text: "r".repeat(2000) }],
            isError: false,
            timestamp: 0,
        } as Message,
    ]);

    assert.equal(meter.measured, false, "no response measured a prompt yet");
    assert.equal(row(meter, "system", "preamble"), 100);
    assert.equal(row(meter, "system", "skills"), 200);
    assert.ok(row(meter, "tools", "read")! > 0 && row(meter, "tools", "bash")! > 0);
    assert.equal(row(meter, "history", "user"), 10);
    assert.equal(row(meter, "history", "reasoning"), 20);
    assert.equal(row(meter, "history", "result: read"), 500);
    assert.ok(row(meter, "history", "call: read")! > 0);
    assert.equal(
        meter.tokens,
        meter.rows.reduce((sum, each) => sum + each.tokens, 0),
    );
});

test("a later section replaces an earlier one, and null removes it", () => {
    const meter = contextMeter([
        system({ a: "a".repeat(400), b: "b".repeat(400) }),
        { role: "user", content: "hi", timestamp: 0 } as Message,
        system({ a: "a".repeat(40), b: null }),
    ]);

    assert.equal(row(meter, "system", "a"), 10);
    assert.equal(row(meter, "system", "b"), undefined);
});

test("the newest measured prompt sets the scale, so rows add up to what the provider counted", () => {
    // 1,000 characters sent before the answer, which counted 500 prompt tokens: two characters a token.
    const meter = contextMeter([
        system({ preamble: "p".repeat(960) }),
        { role: "user", content: "u".repeat(40), timestamp: 0 } as Message,
        assistant([{ type: "text", text: "a".repeat(100) }], 500),
        // A cut-off answer measured nothing: the one before it still sets the scale.
        assistant([], 0),
    ]);

    assert.equal(meter.measured, true);
    assert.equal(row(meter, "system", "preamble"), 480);
    assert.equal(row(meter, "history", "user"), 20);
    assert.equal(row(meter, "history", "answers"), 50);
});
