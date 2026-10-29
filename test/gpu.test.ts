// The GPU lane: requests for the model on the card go on, those for another wait and then go together, and nothing
// waits past the hold. Against a card that swaps as llama-swap does, two sessions on two models swap far less.
import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Gpu, GpuLane, LlamaSwap } from "../src/server/gpu.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the model on the card goes on; another waits, then its requests go together", async () => {
    const lane = new GpuLane({ holdMs: 60_000, graceMs: 0 });
    const order: string[] = [];
    const a1 = await lane.acquire("A");

    order.push("A1");

    const b1 = lane.acquire("B").then((release) => (order.push("B1"), release));
    const b2 = lane.acquire("B").then((release) => (order.push("B2"), release));
    const a2 = await lane.acquire("A");

    order.push("A2");
    assert.deepEqual(lane.waiting(), [{ model: "B", count: 2, since: lane.waiting()[0]!.since }]);
    a1();
    assert.deepEqual(order, ["A1", "A2"], "B waits while A is in flight");
    a2();

    const [r1, r2] = await Promise.all([b1, b2]);

    assert.deepEqual(order, ["A1", "A2", "B1", "B2"], "both B requests go together");
    assert.equal(lane.serving, "B");
    r1();
    r2();
    assert.equal(lane.busy, false);
});

test("past the hold, the model on the card takes no new requests until the other has had its turn", async () => {
    let now = 0;
    const lane = new GpuLane({ holdMs: 100, graceMs: 0, now: () => now });
    const a1 = await lane.acquire("A");
    const b = lane.acquire("B");

    now = 150;

    let a2Started = false;
    const a2 = lane.acquire("A").then((release) => ((a2Started = true), release));

    await sleep(5);
    assert.equal(a2Started, false, "A queues behind B");
    a1();
    (await b)();
    (await a2)();
    assert.equal(a2Started, true);
});

test("a request aborted while it waits stops waiting and holds nothing", async () => {
    const lane = new GpuLane();
    const a = await lane.acquire("A");
    const stop = new AbortController();
    const waiting = lane.acquire("B", stop.signal);

    stop.abort();
    (await waiting)();
    assert.deepEqual(lane.waiting(), []);
    a();
    assert.equal(lane.busy, false);
});

/** A card as llama-swap runs one: a request at a time, and a swap whenever the model changes. */
class Card {
    loaded: string | undefined;
    swaps = 0;
    #queue: Promise<unknown> = Promise.resolve();

    serve(model: string, swapMs: number, workMs: number): Promise<void> {
        const run = this.#queue.then(async () => {
            if (this.loaded !== model) {
                await sleep(swapMs);
                this.swaps++;
                this.loaded = model;
            }

            await sleep(workMs);
        });

        this.#queue = run;

        return run;
    }
}

/** Two sessions on two models, each a run of turns with tool time between: with or without the lane. */
async function twoSessions(withLane: boolean) {
    const card = new Card();
    // Scaled down: a swap of 60 ms, turns of 15 ms, tools of 10 ms between them, a grace of 50 ms.
    const lane = new GpuLane({ holdMs: 2_000, graceMs: 50 });
    const started = performance.now();

    const session = async (model: string) => {
        for (let turn = 0; turn < 6; turn++) {
            const release = withLane ? await lane.acquire(model) : () => {};

            await card.serve(model, 60, 15);
            // Each turn but the last called tools: the run goes on.
            release(turn < 5);
            // The tools run between turns: the card is free meanwhile.
            await sleep(10);
        }
    };

    await Promise.all([session("A"), session("B")]);

    return { swaps: card.swaps, ms: performance.now() - started };
}

test("two sessions on two models swap far less in turns, and finish sooner", async () => {
    const without = await twoSessions(false);
    const withLane = await twoSessions(true);

    assert.ok(
        without.swaps >= 10,
        `without the lane they swap on almost every turn: ${without.swaps}`,
    );
    assert.ok(withLane.swaps <= 4, `with it they take turns by model: ${withLane.swaps}`);
    assert.ok(
        withLane.ms < without.ms,
        `sooner: ${Math.round(withLane.ms)} ms against ${Math.round(without.ms)} ms`,
    );
});

/** A llama-swap's /v1/models: two models, one with role aliases; `loaded` is the one on the card. */
function fakeSwap(loaded: string) {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
        const path = String(url);

        calls.push(path);

        if (path.endsWith("/v1/models")) {
            return new Response(
                JSON.stringify({
                    data: [
                        {
                            id: "Big-27B",
                            owned_by: "llama-swap",
                            meta: { llamaswap: { aliases: ["agent", "router"] } },
                            status: { value: loaded === "Big-27B" ? "ready" : "unloaded" },
                        },
                        {
                            id: "Fast-A3B",
                            owned_by: "llama-swap",
                            meta: { llamaswap: { aliases: ["agent-fast"] } },
                            status: { value: loaded === "Fast-A3B" ? "ready" : "unloaded" },
                        },
                    ],
                }),
            );
        }

        return new Response("ok");
    }) as typeof fetch;

    return { calls, fetchImpl };
}

const at = (id: string) => ({ id, api: "openai-completions", baseUrl: "http://swap:9090/v1" });

test("role names share their model's turn, and a model llama-swap must load shows as loading until it answers", async () => {
    const { fetchImpl } = fakeSwap("Fast-A3B");
    const gpu = new Gpu({ fetch: fetchImpl });
    const first = await gpu.acquire(at("agent"));
    let second: Awaited<ReturnType<Gpu["acquire"]>> | undefined;

    void gpu.acquire(at("router")).then((held) => (second = held));
    await sleep(5);
    assert.ok(second !== undefined, "router is agent's model: it goes on");
    assert.equal(gpu.status().serving, "Big-27B");
    assert.deepEqual(gpu.status().loading, ["Big-27B"]);
    first.started();
    assert.deepEqual(gpu.status().loading, ["Big-27B"], "until every request for it has a token");
    second!.started();
    assert.deepEqual(gpu.status().loading, []);
    first.release();
    second!.release();
});

test("a provider that is not llama-swap goes straight through", async () => {
    const gpu = new Gpu({
        fetch: (async () =>
            new Response(
                JSON.stringify({ data: [{ id: "x", owned_by: "openai" }] }),
            )) as typeof fetch,
    });
    const held = await gpu.acquire(at("x"));

    held.release();
    assert.deepEqual(gpu.status(), { waiting: [], loading: [] });
    assert.equal(
        await new LlamaSwap("http://x/v1", (async () => {
            throw new Error("down");
        }) as typeof fetch).models(),
        null,
    );
});

test("a warm-up loads only an idle card's missing model, and not again within two minutes", async () => {
    const { calls, fetchImpl } = fakeSwap("Fast-A3B");
    let now = 0;
    const gpu = new Gpu({ fetch: fetchImpl, now: () => now });

    assert.equal(await gpu.warm(at("agent-fast")), false, "already on the card");
    assert.equal(await gpu.warm(at("agent")), true);
    await sleep(5);
    assert.ok(calls.some((url) => url === "http://swap:9090/upstream/Big-27B/health"));
    assert.equal(await gpu.warm(at("router")), false, "the same model, too soon");
    now = 10_000_000;

    const busy = await gpu.acquire(at("agent-fast"));

    assert.equal(
        await gpu.warm(at("agent")),
        false,
        "never while another session's work is in flight",
    );
    busy.release();
});
