/**
 * A load check for what a person feels while models stream: N sessions answer at once at a local model's speed, one of
 * them is open in a real browser, and someone types into its message box the whole time. It prints the server's
 * event-loop lag, how long a plain request waits, the process's memory, and in the browser how long each key took to
 * show and how much the page was blocked.
 *
 *   node bench/load.ts [--sessions 4] [--tps 50] [--seconds 20] [--history 0] [--json]
 *
 * `--history N` gives every session N earlier exchanges first (each a tool call, its output, and an answer), as a day's
 * sessions have; then, while the answers stream, it opens each other session as a click in the session list does and
 * times how long until its messages show.
 *
 * Needs a Chromium-based browser (as the browser tests do). Uses a scripted model: no GPU, no network.
 */
import { cleanUp, home, newSession, owner, say, work } from "../test/helpers.ts";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { PocketApp } from "../src/server/app.ts";
import { Browsers } from "../src/server/browser.ts";
import { createHandler } from "../src/server/http.ts";
import { root } from "../test/helpers.ts";

const { values } = parseArgs({
    options: {
        sessions: { type: "string", default: "4" },
        tps: { type: "string", default: "50" },
        seconds: { type: "string", default: "20" },
        history: { type: "string", default: "0" },
        json: { type: "boolean", default: false },
    },
});
const sessions = Number(values.sessions);
const seconds = Number(values.seconds);
const history = Number(values.history);

// A long answer with the shapes that cost the most to draw: paragraphs, lists, code, a table.
const block = (n: number) => `## Part ${n}

The change touches the room's update path. Each delta reaches every tab that shows the session, and the transcript
draws the newest entry again. **Measured**, not guessed: the number below is from the run, and \`room.ts\` holds it.

- the first point, with \`inline code\` and a [link](https://example.com)
- the second point, longer, so that it wraps on a phone and makes the layout do some work for each line it adds
- the third point

\`\`\`ts
export function update(state: State, delta: Delta): State {
    const entries = state.entries.map((entry) => (entry.id === delta.id ? { ...entry, text: entry.text + delta.text } : entry));

    return { ...state, entries, version: state.version + 1 };
}
\`\`\`

| Column | Value | Note |
| ------ | ----- | ---- |
| a      | 1     | one  |
| b      | 2     | two  |
`;
const LONG = Array.from({ length: 40 }, (_, index) => block(index + 1)).join("\n");

const faux = fauxProvider({
    tokensPerSecond: Number(values.tps),
    models: [{ id: "faux-1" }],
});

faux.setResponses(Array.from({ length: 1000 }, () => fauxAssistantMessage([fauxText(LONG)])));

// The history: a quick model that reads a file with bash, then answers with a few paragraphs.
const seed = fauxProvider({
    provider: "seed",
    tokensPerSecond: 1_000_000,
    models: [{ id: "seed" }],
});

const seedStep: FauxResponseStep = (request) => {
    const messages = (request as { messages: { role: string }[] }).messages;

    return messages.at(-1)?.role === "toolResult"
        ? fauxAssistantMessage([fauxText(block(messages.length))])
        : fauxAssistantMessage([fauxToolCall("bash", { command: "seq 1 200" })]);
};

seed.setResponses(Array.from({ length: 2 * Math.max(1, history) * sessions + 10 }, () => seedStep));

const app = await PocketApp.open({
    dataDir: join(root, "data"),
    defaultCwd: work,
    supervised: false,
    log: () => {},
    configureModels: (models) => {
        models.registerNativeProvider(faux.provider);
        models.registerNativeProvider(seed.provider);
    },
    home,
});
const server = createServer(
    createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
);

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const ids: ConversationId[] = [];

for (let index = 0; index < sessions; index++) {
    const id = await newSession(app);

    if (history > 0) {
        await app.commands.configure(id, owner(app), {
            model: { provider: "seed", modelId: "seed" },
        });

        for (let turn = 0; turn < history; turn++) {
            await say(app, id, `Step ${turn} of session ${id}: read the numbers and explain them.`);
        }

        await app.commands.configure(id, owner(app), {
            model: { provider: "faux", modelId: "faux-1" },
        });
    }

    ids.push(id);
}

const browsers = new Browsers({
    dataDir: mkdtempSync(join(root, "bench-")),
    load: async () => undefined,
    save: () => {},
});
const page = await browsers.open(1);

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;

await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });
await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
await page.navigate(`${base}/s/${ids[0]}`);

for (let tries = 0; ; tries++) {
    if (
        await inPage<boolean>(
            `return JSON.stringify(!!document.querySelector(".composer textarea"))`,
        )
    ) {
        break;
    }

    if (tries > 100) {
        throw new Error("the message box never showed");
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
}

// Keys and long tasks, as the browser times them (Event Timing: input delay + handlers + the frame that shows it).
await inPage(`
    globalThis.bench = { keys: [], long: [] };
    new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
            if (entry.name === "keydown" || entry.name === "keypress" || entry.name === "input" || entry.name === "keyup") {
                bench.keys.push(entry.duration);
            }
        }
    }).observe({ type: "event", durationThreshold: 16, buffered: false });
    new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) bench.long.push(entry.duration);
    }).observe({ type: "longtask", buffered: false });
    globalThis.typed = 0;
    return "null";
`);

const cookie = await (async () => {
    const response = await fetch(
        `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`,
        {
            redirect: "manual",
        },
    );

    return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
})();

const rssStart = process.memoryUsage().rss;
let rssPeak = rssStart;
let heapPeak = 0;
const lag = monitorEventLoopDelay({ resolution: 10 });

lag.enable();

// Every session answers at once.
for (const id of ids) {
    void app.commands
        .submit(id, owner(app), { text: "Write the long answer.", requestId: crypto.randomUUID() })
        .catch(() => {});
}

const probes: number[] = [];
let keysSent = 0;
const end = Date.now() + seconds * 1000;
const memory = setInterval(() => {
    const { rss, heapUsed } = process.memoryUsage();

    rssPeak = Math.max(rssPeak, rss);
    heapPeak = Math.max(heapPeak, heapUsed);
}, 250);

const probing = (async () => {
    while (Date.now() < end) {
        const start = performance.now();

        await fetch(`${base}/api/sessions`, { headers: { cookie } }).then((response) =>
            response.arrayBuffer(),
        );
        probes.push(performance.now() - start);
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
})();

// A person typing at about eight keys a second, as real key events through the browser's input pipeline.
while (Date.now() < end) {
    await page.press("a");
    keysSent++;
    await new Promise((resolve) => setTimeout(resolve, 120));
}

await probing;

// Each other session opened as a click in the list does, while the answers still stream: until its messages show.
const opens: number[] = [];

for (const id of [...ids.slice(1), ids[0]!]) {
    const took = await inPage<number>(`
        const { navigate, store } = await import("/store.js");
        const start = performance.now();
        navigate(${Number(id)});
        const mark = ${JSON.stringify(history > 0 ? `of session ${id}:` : "")};
        while (store.state.conversationId !== ${Number(id)} || document.querySelectorAll('[id^="entry-"]').length === 0 || (mark !== "" && !document.querySelector(".transcript")?.textContent.includes(mark))) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
            if (performance.now() - start > 30000) break;
        }
        return JSON.stringify(performance.now() - start);
    `);

    opens.push(took);
}

clearInterval(memory);
lag.disable();

const client = await inPage<{ keys: number[]; long: number[] }>(`return JSON.stringify(bench)`);
const typedShown = await inPage<number>(
    `return JSON.stringify(document.querySelector(".composer textarea").value.length)`,
);

const pct = (list: number[], p: number) => {
    if (list.length === 0) {
        return 0;
    }

    const sorted = [...list].sort((a, b) => a - b);

    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

const ms = (n: number) => Math.round(n * 10) / 10;
const mb = (n: number) => Math.round(n / 1048576);

const result = {
    sessions,
    tps: Number(values.tps),
    seconds,
    server: {
        loopLagP50Ms: ms(lag.percentile(50) / 1e6),
        loopLagP99Ms: ms(lag.percentile(99) / 1e6),
        loopLagMaxMs: ms(lag.max / 1e6),
        requestP50Ms: ms(pct(probes, 50)),
        requestP95Ms: ms(pct(probes, 95)),
        requestMaxMs: ms(Math.max(0, ...probes)),
        rssStartMb: mb(rssStart),
        rssPeakMb: mb(rssPeak),
        heapPeakMb: mb(heapPeak),
        rssEndMb: mb(process.memoryUsage().rss),
    },
    open: {
        history,
        p50Ms: ms(pct(opens, 50)),
        p95Ms: ms(pct(opens, 95)),
        maxMs: ms(Math.max(0, ...opens)),
    },
    browser: {
        keysSent,
        keysShown: typedShown,
        slowKeyEvents: client.keys.length,
        keyP95Ms: ms(pct(client.keys, 95)),
        keyMaxMs: ms(Math.max(0, ...client.keys)),
        longTasks: client.long.length,
        blockedMs: ms(client.long.reduce((sum, each) => sum + Math.max(0, each - 50), 0)),
        longestTaskMs: ms(Math.max(0, ...client.long)),
    },
};

console.log(values.json ? JSON.stringify(result) : result);

await browsers.closeAll({ final: true });
server.closeAllConnections();
server.close();
await app.close();
cleanUp();
process.exit(0);
