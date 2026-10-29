// Browser use, a session's switch: off, the model is offered neither the browser tool nor its guide; on, Pi asks
// before new sites and the local network, sign-ins and forms, and scripts, as the owner's settings say, and never types
// into a password field.
import {
    type App,
    cleanUp,
    lastText,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, JsonObject } from "@earendil-works/pi-durable";
import { findBrowser } from "../src/server/browser/discovery.ts";
import {
    isLocal,
    listed,
    policyFrom,
    riskyWord,
    siteVerdict,
} from "../src/server/browser/policy.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

test("the policy: sites, the local network, lists, and risky labels", () => {
    const policy = policyFrom(() => undefined);

    assert.deepEqual(policy, {
        sites: "ask",
        actions: "ask",
        scripts: "ask",
        local: "ask",
        blocked: [],
        allowed: [],
    });

    for (const host of [
        "localhost",
        "proxmox",
        "pihole.lan",
        "aphotic.tail2a8bb.ts.net",
        "10.0.0.20",
        "192.168.1.1",
        "172.20.0.5",
        "100.101.102.103",
        "169.254.1.1",
        "::1",
        "fd12::1",
    ]) {
        assert.equal(isLocal(host), true, host);
    }

    for (const host of ["example.com", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1"]) {
        assert.equal(isLocal(host), false, host);
    }

    assert.equal(listed("docs.example.com", ["example.com"]), true);
    assert.equal(listed("notexample.com", ["example.com"]), false);
    assert.deepEqual(siteVerdict("https://www.example.com/a", policy, []), {
        go: false,
        ask: "example.com",
    });
    assert.deepEqual(siteVerdict("https://example.com/b", policy, ["example.com"]), { go: true });
    assert.deepEqual(siteVerdict("about:blank", policy, []), { go: true });
    assert.deepEqual(siteVerdict("http://localhost:5173", policy, []), {
        go: false,
        ask: "localhost",
    });

    const strict = policyFrom(
        (name) => ({ local: "never", blocked: "bank.example", allowed: "docs.example.com" })[name],
    );

    assert.match(
        (siteVerdict("http://10.0.0.20:8006", strict, []) as { refuse: string }).refuse,
        /local network/,
    );
    assert.match(
        (siteVerdict("https://my.bank.example", strict, ["my.bank.example"]) as { refuse: string })
            .refuse,
        /blocked/,
    );
    assert.deepEqual(siteVerdict("https://docs.example.com/x", strict, []), { go: true });

    assert.equal(riskyWord("Sign in"), "Sign in");
    assert.equal(riskyWord("Place order"), "order");
    assert.equal(riskyWord("Delete repository"), "Delete");
    assert.equal(riskyWord("Next page"), undefined);
    assert.equal(riskyWord("Documentation"), undefined);
});

const PAGE = `<!doctype html><title>Login</title>
<form onsubmit="event.preventDefault(); document.title = 'sent'">
<label>Name <input id="name"></label>
<label>Password <input id="pass" type="password"></label>
<button type="submit">Sign in</button>
</form>
<button id="next" onclick="document.title = 'next'">Next page</button>`;

let app: App;
let site: Server;
let base = "";
/** The next call the scripted model makes, set by each step; its results land in `results`. */
let next: JsonObject | undefined;
const results: string[] = [];
/** What the last model request carried: its system messages, and the names of the tools it offered. */
let lastSystem = "";
let lastTools: string[] = [];

const route: FauxResponseStep = (request) => {
    const { messages } = request as unknown as {
        messages: {
            role: string;
            toolsAdded?: { name: string }[];
            toolsRemoved?: ({ name: string } | string)[];
        }[];
    };
    // The transcript carries the tool set as changes: replayed in order, they give what this request offers.
    const tools = new Set<string>();

    for (const message of messages) {
        for (const tool of message.toolsAdded ?? []) {
            tools.add(tool.name);
        }

        for (const tool of message.toolsRemoved ?? []) {
            tools.delete(typeof tool === "string" ? tool : tool.name);
        }
    }

    lastSystem = JSON.stringify(messages.filter((message) => message.role === "system"));
    lastTools = [...tools];

    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        results.push(text);

        return fauxAssistantMessage([fauxText("done")]);
    }

    const call = next;

    next = undefined;

    return call === undefined
        ? fauxAssistantMessage([fauxText("nothing to do")])
        : fauxAssistantMessage([fauxToolCall("browser", call)], { stopReason: "toolUse" });
};

before(async () => {
    if (real.skip !== false) {
        return;
    }

    site = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(PAGE);
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
    app = await openApp(scriptedModel(route));
});

after(async () => {
    site?.close();
    await app?.close();
    cleanUp();
});

/** What the model is offered in a session now, as its next request carries it: the tool, and the browser's guide. */
async function offered(id: ConversationId) {
    await say(app, id, "anything?");

    return {
        browser: lastTools.includes("browser"),
        guide: lastSystem.includes("You have a browser tool"),
    };
}

/** Run one browser call as Pi, answering each card it raises with `answer` (true: Allow, false: Deny). */
async function act(id: ConversationId, call: JsonObject, answer?: boolean) {
    const before = results.length;
    const asked: string[] = [];

    next = call;

    const said = say(app, id, "go");

    while (results.length === before) {
        const card = app.approvals.forConversation(id)[0];

        if (card !== undefined && answer !== undefined) {
            asked.push(card.form?.title ?? card.subject);
            await app.answerApproval(card.id, answer, owner(app), {});
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await said;

    return { result: results.at(-1)!, asked };
}

test("off by default: no tool, no guide, and a call is refused", real, async () => {
    const id = await newSession(app);

    assert.deepEqual(await offered(id), { browser: false, guide: false });

    next = { action: "navigate", url: base };
    await say(app, id, "go");
    assert.match(results.at(-1)!, /not available|Browser use is off/);
});

test(
    "on: a local site asks once, sign-ins and scripts ask, passwords are refused",
    real,
    async () => {
        const id = await newSession(app);

        await app.commands.setBrowserUse(id, owner(app), true);
        assert.deepEqual(await offered(id), { browser: true, guide: true });

        // The test page is on this machine: the first visit asks, and Allow keeps it allowed here.
        const first = await act(id, { action: "navigate", url: base }, true);

        assert.equal(first.asked.length, 1);
        assert.match(first.asked[0]!, /127\.0\.0\.1/);
        assert.match(first.result, /Opened/);
        assert.equal(
            (await act(id, { action: "snapshot" })).asked.length,
            0,
            "allowed for the session",
        );

        // An ordinary control goes without a card; a sign-in asks, and Deny stops the call.
        assert.match((await act(id, { action: "click", label: "Next page" })).result, /Clicked/);

        const denied = await act(id, { action: "click", label: "Sign in" }, false);

        assert.equal(denied.asked.length, 1);
        assert.match(denied.asked[0]!, /Sign in/);
        assert.match(denied.result, /Not allowed/);

        assert.match(
            (await act(id, { action: "type", selector: "#pass", text: "hunter2" })).result,
            /password or payment field/,
        );
        assert.match(
            (await act(id, { action: "type", selector: "#name", text: "ada" })).result,
            /Typed into/,
        );

        const script = await act(id, { action: "evaluate", script: "document.title" }, true);

        assert.equal(script.asked.length, 1);
        assert.match(script.asked[0]!, /run a script/);

        app.setExtensionSettings(owner(app), "browser", { scripts: "never" });
        assert.match(
            (await act(id, { action: "evaluate", script: "1" })).result,
            /turned off in the browser's settings/,
        );
        app.setExtensionSettings(owner(app), "browser", { scripts: "ask" });
    },
);

test("turned off again, the tool goes and the rest of the session's tools stay", real, async () => {
    const id = await newSession(app);

    await app.commands.setBrowserUse(id, owner(app), true);
    await app.commands.setBrowserUse(id, owner(app), false);
    assert.deepEqual(await offered(id), { browser: false, guide: false });
    assert.ok(lastTools.includes("bash"), "bash is still offered");
});
