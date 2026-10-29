/**
 * Tabs that stop reading: a phone asleep, or a link gone quiet behind a VPN, keeps its event stream open while the
 * server writes every update of every streaming session into it. This holds such streams open (raw sockets that never
 * read) while sessions stream, and prints the server's memory as it goes.
 *
 *   node bench/stalled.ts [--tabs 4] [--sessions 3] [--seconds 60]
 */
import { cleanUp, newSession, openApp, owner } from "../test/helpers.ts";
import { createServer } from "node:http";
import { connect } from "node:net";
import { parseArgs } from "node:util";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";

const { values } = parseArgs({
    options: {
        tabs: { type: "string", default: "4" },
        sessions: { type: "string", default: "3" },
        seconds: { type: "string", default: "60" },
    },
});
const LONG = Array.from(
    { length: 400 },
    (_, index) =>
        `Line ${index}: the answer goes on, with \`code\` and **words**, as a long reply does.\n`,
).join("");
const faux = fauxProvider({ tokensPerSecond: 400, models: [{ id: "faux-1" }] });

faux.setResponses(Array.from({ length: 5000 }, () => fauxAssistantMessage([fauxText(LONG)])));

const app = await openApp(faux);
const server = createServer(
    createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
);

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

const port = (server.address() as { port: number }).port;
const ids = [];

for (let index = 0; index < Number(values.sessions); index++) {
    ids.push(await newSession(app));
}

const heads: string[] = [];
// Tabs that connect, then never read again: their sockets stay open, paused.
const sockets = ids.flatMap((id) =>
    Array.from({ length: Number(values.tabs) }, (_, tab) => {
        const socket = connect(port, "127.0.0.1", () => {
            socket.write(
                `GET /api/events?c=${Number(id)}&tab=stalled-${Number(id)}-${tab}&p=5 HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${app.config.ownerToken}\r\nX-Pocket: 1\r\nAccept: text/event-stream\r\n\r\n`,
            );
            // The first bytes say whether the stream opened; after them, nothing is read again.
            socket.once("data", (chunk) => {
                heads.push(chunk.toString("latin1").split("\r\n")[0]!);
                socket.pause();
            });
        });

        socket.setRecvBufferSize?.(4096);
        socket.on("error", () => {});

        return socket;
    }),
);

const end = Date.now() + Number(values.seconds) * 1000;
const mb = (n: number) => Math.round(n / 1048576);
let streaming = true;

// Every session answers, one long reply after another, until the time is up.
const runs = ids.map(async (id) => {
    while (streaming) {
        const { submissionId } = await app.commands.submit(id, owner(app), {
            text: "again",
            requestId: crypto.randomUUID(),
        });

        await (await app.harness.submission(
            submissionId,
            (await import("../test/helpers.ts")).context,
        ))!.wait((await import("../test/helpers.ts")).context);
    }
});

const start = Date.now();

await new Promise((resolve) => setTimeout(resolve, 1000));
console.log(`streams answered: ${[...new Set(heads)].join(", ")} (${heads.length})`);

while (Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const memory = process.memoryUsage();
    const open = sockets.filter((socket) => !socket.destroyed).length;

    console.log(
        `${Math.round((Date.now() - start) / 1000)}s rss ${mb(memory.rss)} MB heap ${mb(memory.heapUsed)} MB external ${mb(memory.external)} MB buffers ${mb(memory.arrayBuffers)} MB, stalled tabs still open ${open}/${sockets.length}`,
    );
}

streaming = false;
await Promise.race([Promise.all(runs), new Promise((resolve) => setTimeout(resolve, 10_000))]);

for (const socket of sockets) {
    socket.destroy();
}

server.closeAllConnections();
server.close();
await app.close();
cleanUp();
process.exit(0);
