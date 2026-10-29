// Events, services, and settings for extensions (since 0.22.0): `host.on` hears sessions, messages, and runs; one
// module's service (`web.provide`) is used by another (`web.use`) and follows it as it goes and comes back; and a
// module's settings (`web.settings`) are kept by core, set by the owner alone, read by the module, and never give a
// secret to a browser.
import { cleanUp, newSession, openApp, owner, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { checkSettings } from "../src/server/extension-settings.ts";
import { createHandler } from "../src/server/http.ts";

const dataDir = join(root, "data");
const dropIns = join(dataDir, "extensions");
let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let base = "";
const tokens: Record<string, string> = {};

const module = (name: string, body: string) =>
    writeFileSync(join(dropIns, `${name}.ts`), `/** ${name}: for tests. */\n${body}`);

before(async () => {
    mkdirSync(dropIns, { recursive: true });
    module(
        "watcher",
        `export default (host, web) => {
    const seen = [];

    for (const event of ["session.created", "session.renamed", "session.archived", "message.sent", "run.started", "run.ended"]) {
        web.onDispose(host.on(event, (data) => { seen.push({ event, ...data }); }));
    }

    // A listener that throws hurts no one.
    web.onDispose(host.on("message.sent", () => { throw new Error("listener boom"); }));
    web.route("GET", "seen", () => seen);
};
`,
    );
    module(
        "provider",
        `export default (_host, web) => {
    web.provide({ greet: (name) => "hello " + String(name) });
};
`,
    );
    module(
        "consumer",
        `export default (_host, web) => {
    let heard = 0;

    web.onService("provider", () => { heard++; });
    web.route("GET", "call", () => {
        const service = web.use("provider");

        return { said: typeof service?.greet === "function" ? service.greet("Tevis") : null, heard };
    });
};
`,
    );
    module(
        "configured",
        `export default (_host, web) => {
    let changes = 0;

    web.settings([
        { name: "every", label: "Every (minutes)", type: "number", default: 15, min: 1, max: 60 },
        { name: "loud", label: "Loud", type: "boolean", default: false },
        { name: "region", label: "Region", type: "choice", default: "eu", choices: [{ value: "eu", label: "Europe" }, { value: "us", label: "United States" }] },
        { name: "apiKey", label: "API key", type: "text", secret: true },
        { name: "token", label: "Token", type: "text", secret: true, default: "env-secret-default" },
    ]);
    web.onSettings(() => { changes++; });
    web.client("configured.js", { access: "view" });
    web.route("GET", "values", () => ({
        every: web.setting("every"),
        loud: web.setting("loud"),
        region: web.setting("region"),
        apiKey: web.setting("apiKey") ?? null,
        changes,
    }));
};
`,
    );
    writeFileSync(join(dropIns, "configured.js"), "export default () => {};\n");
    module(
        "broken",
        `export default (_host, web) => {
    web.settings([
        { name: "a", label: "A", type: "boolean" },
        { name: "a", label: "Again", type: "boolean" },
    ]);
};
`,
    );

    app = await openApp(scriptedModel(), dataDir);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    tokens.owner = app.config.ownerToken;
    tokens.guest = app.config.addUser("Gus", "guest").token;
    tokens.viewer = app.config.addUser("Vic", "viewer").token;

    for (const file of ["watcher.ts", "provider.ts", "consumer.ts", "configured.ts"]) {
        await app.setExtensionEnabled(owner(app), file, true);
    }
});

after(async () => {
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
});

async function call(path: string, who = "owner", body?: unknown, method?: string) {
    const response = await fetch(`${base}${path}`, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: {
            authorization: `Bearer ${tokens[who]}`,
            "x-pocket": "1",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

test("host.on hears sessions made, renamed, and archived, messages, and runs", async () => {
    const id = await newSession(app);

    await say(app, id, "hello there");
    await app.commands.updateSession(id, owner(app), { title: "Renamed" });
    await app.commands.updateSession(id, owner(app), { archived: true });

    const seen = async () =>
        ((await call("/api/x/watcher/seen")).data as unknown as Record<string, unknown>[]).filter(
            (each) => each.conversationId === Number(id),
        );

    await until(
        async () => (await seen()).some((each) => each.event === "session.archived"),
        "the events",
    );

    const events = await seen();
    const names = events.map((each) => String(each.event));

    // The first message gives the session its title, then the rename.
    assert.deepEqual(
        names.filter((name) => name.startsWith("session.")),
        ["session.created", "session.renamed", "session.renamed", "session.archived"],
    );
    assert.ok(names.includes("run.started") && names.includes("run.ended"));

    const sent = events.find((each) => each.event === "message.sent")!;

    assert.equal(sent.by, owner(app).id);
    assert.equal(sent.text, "hello there");
    assert.equal(events.find((each) => each.event === "run.ended")!.session, Number(id));
    assert.deepEqual(
        events.filter((each) => each.event === "session.renamed").map((each) => each.title),
        ["hello there", "Renamed"],
    );
    assert.equal(events.find((each) => each.event === "session.archived")!.archived, true);
});

test("a message sent again with the same request is one message, and one event", async () => {
    const id = await newSession(app);
    const requestId = crypto.randomUUID();

    await app.commands.submit(id, owner(app), { text: "only once", requestId });
    await app.commands.submit(id, owner(app), { text: "a retry with other words", requestId });
    await Promise.all([
        app.commands.submit(id, owner(app), { text: "twice at once", requestId: "same-moment" }),
        app.commands.submit(id, owner(app), { text: "twice at once", requestId: "same-moment" }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const sent = ((await call("/api/x/watcher/seen")).data as unknown as Record<string, unknown>[])
        .filter((each) => each.event === "message.sent" && each.conversationId === Number(id))
        .map((each) => each.text);

    assert.deepEqual(sent, ["only once", "twice at once"]);
});

test("settings that nothing could fill are a mistake, and a secret is text only", () => {
    const number = { name: "every", label: "Every", type: "number" };

    assert.throws(() => checkSettings([{ ...number, min: 5, max: 1 }]), /min is more than its max/);
    assert.throws(() => checkSettings([{ ...number, min: 1, max: 5, default: 9 }]), /outside/);
    assert.throws(() => checkSettings([{ ...number, secret: true }]), /secret only as text/);
    assert.throws(
        () => checkSettings([{ name: "on", label: "On", type: "boolean", secret: true }]),
        /secret only as text/,
    );
    assert.equal(checkSettings([{ ...number, min: 1, max: 5, default: 5 }]).length, 1);
});

test("an unknown event, or a listener that is not a function, throws", () => {
    assert.throws(() => app.events.on("session.exploded" as never, () => {}), /no event/);
    assert.throws(() => app.events.on("run.ended", null as never), /a function/);
});

test("one module uses another's service, and follows it as it goes and comes back", async () => {
    const first = (await call("/api/x/consumer/call")).data;

    assert.equal(first.said, "hello Tevis");

    await app.setExtensionEnabled(owner(app), "provider.ts", false);

    const gone = (await call("/api/x/consumer/call")).data;

    assert.equal(gone.said, null);
    assert.ok((gone.heard as number) > (first.heard as number), "it heard the service go");

    await app.setExtensionEnabled(owner(app), "provider.ts", true);
    assert.equal((await call("/api/x/consumer/call")).data.said, "hello Tevis");
});

test("settings: core keeps the owner's values, the module reads them, and secrets stay on the server", async () => {
    const values = async () => (await call("/api/x/configured/values")).data;

    assert.deepEqual(await values(), {
        every: 15,
        loud: false,
        region: "eu",
        apiKey: null,
        changes: 0,
    });

    // Only the owner changes them, each to a value that fits.
    assert.equal(
        (await call("/api/extension-settings/configured", "guest", { every: 5 }, "PUT")).status,
        403,
    );

    for (const bad of [
        { every: 0 },
        { every: "5" },
        { region: "mars" },
        { nope: 1 },
        { loud: "yes" },
    ]) {
        assert.equal(
            (await call("/api/extension-settings/configured", "owner", bad, "PUT")).status,
            400,
            JSON.stringify(bad),
        );
    }

    const saved = await call(
        "/api/extension-settings/configured",
        "owner",
        { every: 5, loud: true, region: "us", apiKey: "sk-very-secret" },
        "PUT",
    );

    assert.equal(saved.status, 200);
    assert.doesNotMatch(JSON.stringify(saved.data), /sk-very-secret/);
    assert.ok((saved.data.set as string[]).includes("apiKey"));
    assert.deepEqual(await values(), {
        every: 5,
        loud: true,
        region: "us",
        apiKey: "sk-very-secret",
        changes: 1,
    });
    assert.equal(app.config.extensionSettings("configured").every, 5);

    // A viewer, whom its browser module is for, reads them without the secret, or a secret's default.
    const read = await call("/api/extension-settings/configured", "viewer");

    assert.equal(read.status, 200);
    assert.equal((read.data.values as Record<string, unknown>).every, 5);
    assert.doesNotMatch(JSON.stringify(read.data), /sk-very-secret|env-secret-default/);
    assert.doesNotMatch(
        JSON.stringify((await call("/api/extension-settings/configured", "owner")).data),
        /sk-very-secret|env-secret-default/,
    );

    // Null puts the default back.
    await call("/api/extension-settings/configured", "owner", { every: null, apiKey: null }, "PUT");
    assert.equal((await values()).every, 15);
    assert.equal((await values()).apiKey, null);

    // A module that declares none has none here.
    assert.equal((await call("/api/extension-settings/consumer", "owner")).status, 404);
});

test("a module whose settings are wrong does not load, and says why", async () => {
    await assert.rejects(
        app.setExtensionEnabled(owner(app), "broken.ts", true),
        /two settings have the same name/,
    );
});
