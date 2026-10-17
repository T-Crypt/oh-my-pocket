// The push routes: the key a device subscribes with, the kinds it is notified about, and how many devices are on.
// A subscription that is not a browser's is refused, the prefs merge keeps only the kinds the app knows, and a test
// with no device says so instead of pretending it went out.
import { type App, cleanUp, openApp, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import type { PushPrefs, PushSubscriptionJson } from "../src/server/push.ts";
import { DEFAULT_PREFS } from "../src/server/push.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let base = "";

/** A subscription a browser would make: a P-256 key and an auth secret, at a browser push service. */
function browser(): PushSubscriptionJson {
    const ecdh = createECDH("prime256v1");

    ecdh.generateKeys();

    return {
        endpoint: "https://fcm.googleapis.com/fcm/send/route-test",
        keys: {
            p256dh: ecdh.getPublicKey().toString("base64url"),
            auth: randomBytes(16).toString("base64url"),
        },
    };
}

/** A route as the owner's tab sends it: GET without a body, POST with one and the header the app asks for. */
const call = (path: string, body?: unknown) =>
    fetch(`${base}/api/push${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            ...(body === undefined ? {} : { "content-type": "application/json", "x-pocket": "1" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

before(async () => {
    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("a device asks for the key, what it is notified about, and how many are on", async () => {
    const answer = await call("");

    assert.equal(answer.status, 200);
    const body = (await answer.json()) as {
        publicKey: string;
        prefs: PushPrefs;
        devices: number;
    };

    assert.equal(body.publicKey, app.pushStore!.publicKey);
    assert.deepEqual(body.prefs, DEFAULT_PREFS);
    assert.equal(body.devices, 0);
});

test("a browser subscription is kept, one that is not a browser's is refused, and the prefs merge", async () => {
    const good = await call("/subscribe", { subscription: browser() });

    assert.equal(good.status, 200);
    assert.deepEqual(await good.json(), { ok: true, devices: 1 });

    const bad = await call("/subscribe", {
        subscription: { endpoint: "https://example.com/x", keys: browser().keys },
    });

    assert.equal(bad.status, 400);
    assert.match(
        String(((await bad.json()) as { error: string }).error),
        /not a browser push service/,
    );

    const prefs = await call("/prefs", { done: false, junk: true });

    assert.equal(prefs.status, 200);
    assert.deepEqual(await prefs.json(), { prefs: { ...DEFAULT_PREFS, done: false } });

    const now = (await (await call("")).json()) as { prefs: PushPrefs; devices: number };

    assert.equal(now.devices, 1, "the refused one was not kept");
    assert.equal(now.prefs.done, false);
});

test("unsubscribing takes the device off, and a test with no device says so", async () => {
    const gone = await call("/unsubscribe", { endpoint: browser().endpoint });

    assert.equal(gone.status, 200);
    assert.deepEqual(await gone.json(), { ok: true, devices: 0 });

    const test = await call("/test", {});

    assert.equal(test.status, 409);
    assert.match(
        String(((await test.json()) as { error: string }).error),
        /No device took the test notification/,
    );
});
