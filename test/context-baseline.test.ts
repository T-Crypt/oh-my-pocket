// Context baseline: the owner takes a meter of where the context goes before changing something - a prompt line, a
// tool, a skill list - and the next meter lines up against it: the rows the change touched, before and after,
// biggest moves first. Clear it when the change is done with.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { type ContextDiffRow, type ContextRow, contextDiff } from "../src/server/context-meter.ts";
import { type App, cleanUp, newSession, openApp, say, scriptedModel } from "./helpers.ts";

// --- The diff, pure ----------------------------------------------------------------

const rows = (each: Array<[ContextRow["group"], string, number]>): ContextRow[] =>
    each.map(([group, name, tokens]) => ({ group, name, tokens }));

test("the diff names the rows a change moved, biggest moves first", () => {
    const diff = contextDiff(
        rows([
            ["system", "instructions", 300],
            ["system", "preamble", 100],
            ["history", "user", 10],
        ]),
        rows([
            ["system", "preamble", 100],
            ["system", "guidelines", 400],
            ["history", "user", 10],
        ]),
    );

    assert.deepEqual(
        diff.map((row) => [row.name, row.baseline, row.tokens, row.delta]),
        [
            ["guidelines", 400, 0, -400],
            ["instructions", 0, 300, 300],
            ["preamble", 100, 100, 0],
            ["user", 10, 10, 0],
        ],
    );
});

test("an unchanged meter diffs to all-zero deltas", () => {
    const same = rows([
        ["system", "preamble", 50],
        ["history", "answers", 10],
    ]);

    assert.deepEqual(
        contextDiff(same, same).map((row: ContextDiffRow) => row.delta),
        [0, 0],
    );
});

// --- Baseline across a change, end to end -------------------------------------------

let app: App;
const model = scriptedModel(() => fauxAssistantMessage([fauxText("done")]));

before(async () => {
    app = await openApp(model);
});

after(async () => {
    await app.close();
    cleanUp();
});

test("take, diff a change against it, and clear", async () => {
    const id = await newSession(app);

    await say(app, id, "hello");

    assert.equal(await app.contextBaseline(id), undefined, "no baseline until one is taken");

    const baseline = await app.takeContextBaseline(id);

    assert.ok(baseline.takenAt > 0);
    assert.ok(baseline.rows.length > 0);

    // The change: what Pi is told with every message here. It lands in the transcript when the next request goes out.
    const owner = app.config.users.find((user) => user.role === "owner")!;

    await app.commands.setInstructions(id, owner, "keep every answer short".repeat(16));
    await say(app, id, "again");

    const after = await app.contextMeter(id);
    const diff = contextDiff(after.rows, baseline.rows);
    const moved = diff.find((row) => row.name === "instructions");

    assert.ok(
        moved !== undefined,
        `the diff names the row the change touched: ${diff.map((row) => row.name).join(", ")}`,
    );
    assert.equal(moved.baseline, 0);
    assert.ok(moved.tokens > 0);
    assert.equal(moved.delta, moved.tokens);
    // The rows the change did not touch may still move, because the newest measured prompt rescales the meter;
    // the contract is that the touched row is named, which the pure diff test covers for the ordering.

    await app.clearContextBaseline(id);
    assert.equal(await app.contextBaseline(id), undefined, "cleared");
});

test("the routes: take over POST, clear over DELETE, and GET carries the baseline and the diff", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const get = (path: string, init?: RequestInit) =>
        fetch(`http://127.0.0.1:${port}/api/${path}`, {
            headers: { authorization: `Bearer ${app.config.ownerToken}`, "X-Pocket": "1" },
            ...init,
        });

    const id = await newSession(app);

    await say(app, id, "hello");

    try {
        const before = await (await get(`c/${id}/context`)).json();

        assert.equal(before.baseline, undefined);

        const taken = await (await get(`c/${id}/context/baseline`, { method: "POST" })).json();

        assert.ok(taken.takenAt > 0);
        assert.ok(taken.rows.length > 0);

        const withBaseline = await (await get(`c/${id}/context`)).json();

        assert.ok(withBaseline.baseline.takenAt > 0);
        assert.ok(Array.isArray(withBaseline.diff));

        const cleared = await (await get(`c/${id}/context/baseline`, { method: "DELETE" })).json();

        assert.deepEqual(cleared, { ok: true });
        assert.equal((await (await get(`c/${id}/context`)).json()).baseline, undefined);
    } finally {
        server.closeAllConnections();
        server.close();
    }
});
