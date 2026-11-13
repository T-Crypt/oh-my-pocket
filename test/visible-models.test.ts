// Which models each provider offers the pickers: the ones the owner turned on in the Providers sheet, and every model
// it has when they never chose. A model that is not offered still runs; hiding it only takes it out of the pickers.
import {
    type App,
    cleanUp,
    echo,
    fakeTab,
    modelTexts,
    openApp,
    owner,
    root,
    say,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";

const faux = fauxProvider({ models: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }] });

faux.setResponses(Array.from({ length: 100 }, () => echo));

let app: App;

before(async () => {
    app = await openApp(faux);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** The provider as the Providers sheet sees it. */
function provider() {
    return app.providers.list().find((each) => each.id === "faux")!;
}

/** What a picker holds for `faux`: the models the hello carries, as the web app's model list does. */
async function offered(): Promise<string[]> {
    const { models } = await app.hello(owner(app));

    return models.filter((model) => model.provider === "faux").map((model) => model.id);
}

test("a provider offers every model it has until the owner chooses", async () => {
    assert.deepEqual(await offered(), ["alpha", "beta", "gamma"]);
    assert.deepEqual(
        { models: provider().models, shown: provider().shown },
        { models: 3, shown: 3 },
    );
});

test("the models chosen are the ones the pickers offer", async () => {
    app.providers.setVisible("faux", ["beta"]);
    assert.deepEqual(await offered(), ["beta"]);
    assert.deepEqual(
        { models: provider().models, shown: provider().shown },
        { models: 3, shown: 1 },
    );
    assert.deepEqual(app.providers.modelsFor("faux"), [
        { id: "alpha", name: "alpha", shown: false },
        { id: "beta", name: "beta", shown: true },
        { id: "gamma", name: "gamma", shown: false },
    ]);
});

test("no models chosen offers none, and every model comes back", async () => {
    app.providers.setVisible("faux", []);
    assert.deepEqual(await offered(), []);
    assert.equal(provider().shown, 0);

    app.providers.setVisible("faux", null);
    assert.deepEqual(await offered(), ["alpha", "beta", "gamma"]);
    assert.equal(app.config.visibleModels("faux"), undefined);
});

test("a model its provider does not have is refused, and nothing changes", async () => {
    app.providers.setVisible("faux", ["beta"]);
    assert.throws(() => app.providers.setVisible("faux", ["beta", "nope"]), {
        status: 400,
        message: /No such model: faux\/nope/,
    });
    assert.deepEqual(await offered(), ["beta"]);
    assert.throws(() => app.providers.setVisible("nope", null), { status: 404 });
    assert.deepEqual(await offered(), ["beta"]);
});

test("a model that is not offered still runs its session", async () => {
    app.providers.setVisible("faux", ["alpha"]);
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "gamma" },
        thinkingLevel: "off",
    });
    await say(app, id, "still here?");

    assert.ok((await modelTexts(app, id)).some((text) => text.includes("echo: still here?")));
});

test("every tab is told what the pickers offer now", async () => {
    const tab = fakeTab(undefined, owner(app));

    await app.attach(tab.client);
    app.providers.setVisible("faux", ["alpha", "beta"]);

    const offered = () =>
        ((tab.last("models") ?? []) as unknown as { provider: string; id: string }[])
            .filter((model) => model.provider === "faux")
            .map((model) => model.id)
            .join(",");

    // The list goes out once the sign-in scope is read, a moment later.
    await until(() => offered() === "alpha,beta", "the tab told the models offered now");
    app.detach(tab.client);
    app.providers.setVisible("faux", null);
});

test("the choice is kept for the next start", async () => {
    const dataDir = mkdtempSync(join(root, "visible-models-"));
    const before = await openApp(faux, dataDir);

    before.providers.setVisible("faux", ["gamma"]);
    await before.close();

    const after = await openApp(faux, dataDir);

    try {
        assert.deepEqual(after.config.visibleModels("faux"), ["gamma"]);
        assert.deepEqual(
            (await after.hello(owner(after))).models
                .filter((model) => model.provider === "faux")
                .map((model) => model.id),
            ["gamma"],
        );
    } finally {
        await after.close();
    }
});

test("the route sets them for the owner only, and answers with both lists", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const bearer = (token: string) => ({
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-pocket": "1",
    });
    const set = (token: string, models: unknown) =>
        fetch(`http://127.0.0.1:${port}/api/providers/faux/models`, {
            method: "POST",
            headers: bearer(token),
            body: JSON.stringify({ models }),
        });
    const readModels = (token: string, provider = "faux") =>
        fetch(`http://127.0.0.1:${port}/api/providers/${provider}/models`, {
            headers: bearer(token),
        });

    app.providers.setVisible("faux", null);

    try {
        const guest: string = app.config.addUser("Bea", "guest").token;

        assert.equal((await set(guest, ["beta"])).status, 403);
        assert.equal(app.config.visibleModels("faux"), undefined);

        const answer = await set(app.config.ownerToken, ["beta"]);

        assert.equal(answer.status, 200);
        const body = (await answer.json()) as {
            providers: { id: string; shown: number }[];
            models: { id: string; shown: boolean }[];
        };

        assert.equal(body.providers.find((each) => each.id === "faux")?.shown, 1);
        assert.deepEqual(
            body.models.filter((each) => each.shown).map((each) => each.id),
            ["beta"],
        );

        const read = await readModels(guest);

        assert.equal(read.status, 200);
        assert.deepEqual(((await read.json()) as { models: string[] }).models, [
            { id: "alpha", name: "alpha", shown: false },
            { id: "beta", name: "beta", shown: true },
            { id: "gamma", name: "gamma", shown: false },
        ]);

        // Not an array and not null: the request cannot mean anything.
        assert.equal((await set(app.config.ownerToken, "beta")).status, 400);
        assert.equal((await readModels(app.config.ownerToken, "nope")).status, 404);
        assert.deepEqual(app.config.visibleModels("faux"), ["beta"]);
    } finally {
        server.closeAllConnections();
        server.close();
        app.providers.setVisible("faux", null);
    }
});
