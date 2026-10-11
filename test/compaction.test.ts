// Compaction settings: Pi's own keys pass through, and `compaction.backgroundTokens` reaches Pi Durable, which Pi's
// settings reader alone would drop.
import assert from "node:assert/strict";
import { test } from "node:test";
import { compactionSettings } from "../src/server/compaction.ts";

const settings = (compaction: Record<string, unknown> | undefined) => ({
    getCompactionSettings: () => ({ enabled: true, reserveTokens: 39000, keepRecentTokens: 20000 }),
    getSettings: () => (compaction === undefined ? {} : { compaction }) as never,
});

test("backgroundTokens from Pi's settings reaches Pi Durable, 0 included", () => {
    assert.deepEqual(compactionSettings(settings({ backgroundTokens: 0 })), {
        enabled: true,
        reserveTokens: 39000,
        keepRecentTokens: 20000,
        backgroundTokens: 0,
    });
    assert.equal(compactionSettings(settings({ backgroundTokens: 8192 })).backgroundTokens, 8192);
});

test("without a valid backgroundTokens, Pi Durable keeps its default", () => {
    for (const value of [undefined, -1, 1.5, "0"]) {
        assert.equal(
            "backgroundTokens" in compactionSettings(settings({ backgroundTokens: value })),
            false,
        );
    }

    assert.equal("backgroundTokens" in compactionSettings(settings(undefined)), false);
});

test("unreadable settings fall back to Pi Durable's defaults", () => {
    assert.deepEqual(
        compactionSettings({
            getCompactionSettings: () => {
                throw new Error("bad json");
            },
            getSettings: () => ({}) as never,
        }),
        {},
    );
});
