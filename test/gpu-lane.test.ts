// The GPU lane end to end: Pi Pocket talks to a llama-swap stand-in through the real OpenAI provider. It serves one
// request at a time and swaps when the model changes, as llama-swap on one card does. Two sessions on two models,
// answering at once, swap far less with the lane; a model being loaded shows in every tab; a warm-up loads it.
import {
    cleanUp,
    context,
    fakeTab,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";

const SWAP_MS = 150;

/** The stand-in: what is on its card, how often it swapped, and the order it served requests in. */
const card = { loaded: undefined as string | undefined, swaps: 0, served: [] as string[] };
let queue: Promise<unknown> = Promise.resolve();
let site: Server;
let base = "";

const MODELS = [
    { id: "Big-27B", aliases: ["agent"] },
    { id: "Fast-A3B", aliases: ["agent-fast"] },
];
const physical = (name: string) =>
    MODELS.find((model) => model.id === name || model.aliases.includes(name))?.id ?? name;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
    site = createServer((request, response) => {
        const url = request.url ?? "";

        if (url === "/v1/models") {
            response.end(
                JSON.stringify({
                    data: MODELS.map((model) => ({
                        id: model.id,
                        owned_by: "llama-swap",
                        meta: { llamaswap: { aliases: model.aliases } },
                        status: { value: card.loaded === model.id ? "ready" : "unloaded" },
                    })),
                }),
            );

            return;
        }

        if (url.startsWith("/upstream/")) {
            const model = decodeURIComponent(url.split("/")[2]!);

            queue = queue.then(async () => {
                if (card.loaded !== model) {
                    await sleep(SWAP_MS);
                    card.swaps++;
                    card.loaded = model;
                }
            });
            void queue.then(() => response.end("ok"));

            return;
        }

        let body = "";

        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
            const asked = JSON.parse(body) as { model: string; messages: { role: string }[] };
            const model = physical(asked.model);
            // An agent's run: three bash calls, each answered by its result, then the final answer.
            const toolTurn = asked.messages.filter((message) => message.role === "tool").length < 3;

            // One request at a time, and a swap first when the card holds another model.
            queue = queue.then(async () => {
                if (card.loaded !== model) {
                    await sleep(SWAP_MS);
                    card.swaps++;
                    card.loaded = model;
                }

                card.served.push(model);
                response.writeHead(200, { "content-type": "text/event-stream" });

                const chunk = (delta: object, finish: string | null) =>
                    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish === null ? {} : { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }) })}\n\n`;

                if (toolTurn) {
                    response.write(
                        chunk(
                            {
                                role: "assistant",
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: `call_${crypto.randomUUID()}`,
                                        type: "function",
                                        function: {
                                            name: "bash",
                                            arguments: JSON.stringify({ command: "true" }),
                                        },
                                    },
                                ],
                            },
                            null,
                        ),
                    );
                    response.write(chunk({}, "tool_calls"));
                } else {
                    for (const piece of ["Answer ", "from ", model]) {
                        response.write(chunk({ role: "assistant", content: piece }, null));
                        await sleep(5);
                    }

                    response.write(chunk({}, "stop"));
                }

                response.end("data: [DONE]\n\n");
            });
        });
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
    writeFileSync(
        join(root, "agent", "models.json"),
        JSON.stringify({
            providers: {
                "llama-swap": {
                    baseUrl: `${base}/v1`,
                    api: "openai-completions",
                    apiKey: "none",
                    models: ["Big-27B", "Fast-A3B", "agent", "agent-fast"].map((id) => ({ id })),
                },
            },
        }),
    );
});

after(() => {
    site?.close();
    cleanUp();
});

/** Two sessions, on two names of two models, each running `runs` agent runs in a row (four model turns each), at once. */
async function twoAtOnce(lane: boolean, runs = 1) {
    process.env.PI_POCKET_GPU_LANE = lane ? "1" : "0";

    const app = await openApp(scriptedModel(), join(root, lane ? "with" : "without"));

    try {
        await app.providers.modelRefresh.refresh();

        const session = async (modelId: string) => {
            const id = await newSession(app);

            await app.commands.configure(id, owner(app), {
                model: { provider: "llama-swap", modelId },
            });

            for (let run = 0; run < runs; run++) {
                const { submissionId } = await app.commands.submit(id, owner(app), {
                    text: `run ${run}`,
                    requestId: crypto.randomUUID(),
                });

                await (await app.harness.submission(submissionId, context))!.wait(context);
            }

            return id;
        };

        card.loaded = undefined;
        card.swaps = 0;
        card.served = [];

        const started = performance.now();

        await Promise.all([session("agent"), session("agent-fast")]);

        return { swaps: card.swaps, ms: performance.now() - started, served: [...card.served] };
    } finally {
        await app.close();
    }
}

test("two agent runs on two models at once: each keeps the card for its run instead of swapping each turn", async () => {
    const without = await twoAtOnce(false);
    const withLane = await twoAtOnce(true);

    assert.equal(without.served.length, 8, "four model turns in each run");
    assert.equal(withLane.served.length, 8);
    assert.ok(without.swaps >= 5, `without it, a swap on most turns: ${without.swaps}`);
    assert.equal(withLane.swaps, 2, "with it, each run keeps the card: one load per model");
    assert.ok(
        withLane.ms < without.ms,
        `and sooner: ${Math.round(withLane.ms)} ms against ${Math.round(without.ms)} ms`,
    );
});

test("every tab hears a model loading, and a warm-up loads the session's model before the message", async () => {
    process.env.PI_POCKET_GPU_LANE = "1";

    const app = await openApp(scriptedModel(), join(root, "warm"));

    try {
        await app.providers.modelRefresh.refresh();
        card.loaded = "Fast-A3B";

        const id: ConversationId = await newSession(app);

        await app.commands.configure(id, owner(app), {
            model: { provider: "llama-swap", modelId: "agent" },
        });

        const tab = fakeTab(id, owner(app));

        await app.attach(tab.client);
        assert.equal(await app.warmFor(id, owner(app)), true);
        assert.equal(await app.warmFor(id, owner(app)), false, "not twice in a row");

        for (let tries = 0; tries < 100 && card.loaded !== "Big-27B"; tries++) {
            await sleep(20);
        }

        assert.equal(card.loaded, "Big-27B", "loaded while the person writes");

        // Swapped away again, the next message waits for the load, and every tab hears it.
        card.loaded = "Fast-A3B";

        const { submissionId } = await app.commands.submit(id, owner(app), {
            text: "hello",
            requestId: crypto.randomUUID(),
        });

        await (await app.harness.submission(submissionId, context))!.wait(context);

        const heard = tab.events
            .filter((each) => each.event === "gpu")
            .map((each) => (each.data as { loading: string[] }).loading)
            .filter((loading) => loading.length > 0);

        assert.deepEqual(heard[0], ["Big-27B"]);
        await sleep(300);
        assert.deepEqual((tab.last("gpu") as unknown as { loading: string[] }).loading, []);
        app.detach(tab.client);
    } finally {
        await app.close();
    }
});
