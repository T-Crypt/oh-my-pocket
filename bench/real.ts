/**
 * The same checks as `load.ts`, on a copy of a real data folder: how long the server takes to open it, what it holds
 * in memory, how long the session list takes to show, and how long the biggest sessions take to open in a real
 * browser. Pi's own folder is a temporary one and the only model is a scripted one, so nothing in the copy (a
 * schedule, a trigger) can reach a real model. Never point it at a live data folder: copy it first.
 *
 *   node bench/real.ts --data /tmp/pocket-copy [--open 8] [--json]
 */
import { home, work } from "../test/isolate.ts";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { PocketApp } from "../src/server/app.ts";
import { Browsers } from "../src/server/browser.ts";
import { createHandler } from "../src/server/http.ts";

const { values } = parseArgs({
    options: {
        data: { type: "string" },
        open: { type: "string", default: "8" },
        json: { type: "boolean", default: false },
    },
});

if (values.data === undefined) {
    throw new Error("--data: a copy of a data folder");
}

const dataDir = values.data;
const ms = (n: number) => Math.round(n * 10) / 10;
const mb = (n: number) => Math.round(n / 1048576);
const lag = monitorEventLoopDelay({ resolution: 10 });

// The biggest top-level sessions, by entries.
const db = new DatabaseSync(join(dataDir, "pocket.sqlite"), { readOnly: true });
const biggest = db
    .prepare(
        `SELECT e.conversation_id AS id, count(*) AS n FROM entries e JOIN conversations c ON c.id = e.conversation_id
         WHERE c.owner_conversation_id IS NULL GROUP BY 1 ORDER BY 2 DESC LIMIT ?`,
    )
    .all(Number(values.open)) as { id: number; n: number }[];

db.close();

const faux = fauxProvider({ tokensPerSecond: 100, models: [{ id: "faux-1" }] });
const rssBefore = process.memoryUsage().rss;
let started = performance.now();
const app = await PocketApp.open({
    dataDir,
    defaultCwd: work,
    supervised: false,
    log: () => {},
    configureModels: (models) => models.registerNativeProvider(faux.provider),
    home,
});
const openMs = performance.now() - started;

// From here on: what a person feels while the server runs, not its start.
lag.enable();
const rssOpen = process.memoryUsage().rss;
const server = createServer(
    createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
);

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const token = (
    JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as { ownerToken: string }
).ownerToken;
const browsers = new Browsers({
    dataDir: mkdtempSync(join(tmpdir(), "bench-real-")),
    load: async () => undefined,
    save: () => {},
});
const page = await browsers.open(1);

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script, { timeoutMs: 60_000 })) as T;

await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });
await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
started = performance.now();

// The home screen: until the session list has rows.
const listMs = await inPage<number>(`
    const start = performance.now();
    while (document.querySelectorAll(".session").length === 0 && performance.now() - start < 60000) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return JSON.stringify(performance.now() - start);
`);
const firstLoadMs = performance.now() - started;

await inPage(`
    globalThis.bench = { long: [] };
    new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) bench.long.push(entry.duration);
    }).observe({ type: "longtask", buffered: false });
    return "null";
`);

const opens: { id: number; entries: number; ms: number }[] = [];

for (const { id, n } of biggest) {
    const took = await inPage<number>(`
        const { navigate, store } = await import("/store.js");
        const start = performance.now();
        navigate(${id});
        while (
            (store.state.conversationId !== ${id} ||
                store.state.view.conversation?.id !== ${id} ||
                document.querySelectorAll('[id^="entry-"]').length === 0) &&
            performance.now() - start < 60000
        ) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        return JSON.stringify(performance.now() - start);
    `);

    opens.push({ id, entries: n, ms: ms(took) });
}

lag.disable();

const long = (await inPage<{ long: number[] }>(`return JSON.stringify(bench)`)).long;
const rssEnd = process.memoryUsage().rss;
const heap = process.memoryUsage().heapUsed;
// With --expose-gc: what stays alive once the garbage is gone and the rooms have closed (30 s after their last tab).
const gc = (globalThis as { gc?: () => void }).gc;

await new Promise((resolve) => setTimeout(resolve, 35_000));
gc?.();

const live = process.memoryUsage();

const result = {
    sessionsOpened: opens.length,
    server: {
        openDataMs: ms(openMs),
        rssBeforeMb: mb(rssBefore),
        rssAfterOpenMb: mb(rssOpen),
        rssEndMb: mb(rssEnd),
        heapEndMb: mb(heap),
        ...(gc === undefined ? {} : { heapLiveMb: mb(live.heapUsed), rssAfterGcMb: mb(live.rss) }),
        loopLagP99Ms: ms(lag.percentile(99) / 1e6),
        loopLagMaxMs: ms(lag.max / 1e6),
    },
    browser: {
        firstLoadMs: ms(firstLoadMs),
        listMs: ms(listMs),
        openMs: opens,
        longTasks: long.length,
        longestTaskMs: ms(Math.max(0, ...long)),
        blockedMs: ms(long.reduce((sum, each) => sum + Math.max(0, each - 50), 0)),
    },
};

console.log(values.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));

await browsers.closeAll({ final: true });
server.closeAllConnections();
server.close();
await app.close();
process.exit(0);
