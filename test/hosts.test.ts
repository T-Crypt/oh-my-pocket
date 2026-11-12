// SSH hosts in a running app: bash, read, write and edit take `host` once the owner has set a host up, and do their
// work in that host's environment; without hosts the tools are exactly as they were. A fake `ssh` (`PI_POCKET_SSH`)
// runs what it is given with `sh` in a folder that stands for the host, so no SSH server is needed. Read first still
// guards a host's files, a host in `ask` mode waits for a person, and Pi typing `ssh host` into bash is sent back to
// the host argument.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ContextView, ConversationId } from "@earendil-works/pi-durable";
import { sshedHost } from "../src/server/extensions/hosts.ts";
import { checkHosts, type HostEntry } from "../src/server/hosts.ts";
import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    work,
} from "./helpers.ts";

const remote = join(root, "host-home");
const fakeSsh = join(root, "fake-ssh");

let app: App;
let steps: FauxResponseStep[] = [];
let stepIndex = 0;
let lastRequest: ReturnType<typeof replay> | undefined;

const done: FauxResponseStep = () => fauxAssistantMessage([fauxText("done")]);

/** The tools and prompt a request carries: its system messages replayed, as a provider does. */
function replay(messages: Message[]) {
    const sections: Record<string, string> = {};
    const tools = new Map<string, { parameters: { properties: Record<string, unknown> } }>();

    for (const message of messages) {
        if (message.role !== "system") {
            continue;
        }

        for (const [key, value] of Object.entries(message.sections ?? {})) {
            if (value === null) {
                delete sections[key];
            } else {
                sections[key] = value;
            }
        }

        for (const each of message.toolsAdded ?? []) {
            tools.set(each.name, each as never);
        }

        for (const each of message.toolsRemoved ?? []) {
            tools.delete(each.name);
        }
    }

    return {
        prompt: Object.entries(sections)
            .map(([key, value]) => `<${key}>${value}`)
            .join("\n"),
        tools,
    };
}

const route: FauxResponseStep = (request, options, state, model) => {
    const seen = replay((request as { messages: Message[] }).messages);

    // The session's own requests: a title request carries no tools.
    if (seen.tools.size > 0) {
        lastRequest = seen;
    }

    const step = steps[stepIndex++] ?? done;

    return typeof step === "function" ? step(request, options, state, model) : step;
};

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) => () =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

/** Every tool result of the conversation, oldest first, as text, with whether it was an error. */
const results = async (id: ConversationId) => {
    const view = (await (await app.harness.conversation(id, context))!.context(
        context,
    )) as ContextView;

    return view.messages
        .filter(
            (message): message is Extract<Message, { role: "toolResult" }> =>
                message.role === "toolResult",
        )
        .map((message) => ({
            error: message.isError === true,
            text: (message.content as Array<{ type: string; text?: string }>)
                .map((part) => part.text ?? "")
                .join("\n"),
        }));
};

const run = async (id: ConversationId, ...calls: FauxResponseStep[]) => {
    steps = [...calls, done];
    stepIndex = 0;
    await say(app, id, "go");

    return results(id);
};

const toolSchema = (name: string) => lastRequest?.tools.get(name)?.parameters;

const gpu: HostEntry = {
    name: "gpu",
    target: "tcrypt@gpu.example",
    cwd: remote,
    mode: "allow",
    note: "the GPU box",
};

before(async () => {
    mkdirSync(remote, { recursive: true });
    // Options are ignored, a control check always finds the connection, and the remote command runs with sh.
    writeFileSync(
        fakeSsh,
        '#!/bin/sh\nfor a; do last=$a; done\ncase " $* " in *" -O "*) exit 0;; esac\ncd "$FAKE_HOST_HOME" && exec sh -c "$last"\n',
    );
    chmodSync(fakeSsh, 0o755);
    process.env.PI_POCKET_SSH = fakeSsh;
    process.env.FAKE_HOST_HOME = remote;
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app.close();
    delete process.env.PI_POCKET_SSH;
    delete process.env.FAKE_HOST_HOME;
    cleanUp();
});

test("with no hosts the tools take no host and the prompt says nothing of hosts", async () => {
    const id = await newSession(app);

    await run(id);
    assert.ok(toolSchema("bash") !== undefined);
    assert.equal("host" in toolSchema("bash")!.properties, false);
    assert.doesNotMatch(lastRequest?.prompt ?? "", /<hosts>/);
});

test("the owner's hosts are checked: a destination that could pass for an option is refused", async () => {
    assert.throws(
        () => checkHosts([{ name: "x", target: "-oProxyCommand=sh", mode: "allow" }]),
        /destination/,
    );
    assert.throws(() => checkHosts([{ name: "Bad Name", target: "a", mode: "allow" }]), /name/);
    assert.throws(() => checkHosts([{ name: "a", target: "a", mode: "maybe" }]), /mode/);
    assert.throws(
        () => checkHosts([{ name: "a", target: "a", mode: "allow", cwd: "relative" }]),
        /absolute/,
    );
    assert.throws(
        () =>
            checkHosts([
                { name: "a", target: "a", mode: "allow" },
                { name: "a", target: "b", mode: "allow" },
            ]),
        /Two hosts/,
    );
    assert.deepEqual(
        checkHosts([{ name: "a", target: "u@h", mode: "ask", cwd: "", note: " n " }]),
        [{ name: "a", target: "u@h", mode: "ask", note: "n" }],
    );
});

test("with a host, bash runs there and the tools and prompt offer it", async () => {
    await app.setHosts(owner(app), [gpu]);

    const id = await newSession(app);
    const [result] = await run(id, tool("bash", { command: "pwd; echo hi", host: "gpu" }));

    assert.equal(result?.error, false);
    assert.match(result!.text, new RegExp(`${remote}\\nhi`));
    assert.ok("host" in toolSchema("bash")!.properties);
    assert.ok("host" in toolSchema("edit")!.properties);
    assert.match(lastRequest?.prompt ?? "", /- gpu: the GPU box/);

    // Without host, bash is still this machine's, in the session's folder.
    const local = (await run(id, tool("bash", { command: "pwd" }))).at(-1);

    assert.match(local!.text, new RegExp(work));
});

test("write, read and edit work on the host's files, and read first guards them there", async () => {
    await app.setHosts(owner(app), [gpu]);

    const id = await newSession(app);
    const path = join(remote, "notes.txt");

    writeFileSync(path, "alpha\nbeta\n");

    // A file on the host that was not read is refused, as one here is.
    const [refused] = await run(
        id,
        tool("edit", {
            path: "notes.txt",
            host: "gpu",
            edits: [{ oldText: "beta", newText: "gamma" }],
        }),
    );

    assert.equal(refused?.error, true);
    assert.match(refused!.text, /have not read it/);

    const [read, edited] = (
        await run(
            id,
            tool("read", { path: "notes.txt", host: "gpu" }),
            tool("edit", {
                path: "notes.txt",
                host: "gpu",
                edits: [{ oldText: "beta", newText: "gamma" }],
            }),
        )
    ).slice(-2);

    assert.equal(read?.error, false);
    assert.match(read!.text, /alpha/);
    assert.equal(edited?.error, false, edited?.text ?? "no result");
    assert.equal(readFileSync(path, "utf8"), "alpha\ngamma\n");

    const [written] = (
        await run(id, tool("write", { path: "deep/new.txt", host: "gpu", content: "made" }))
    ).slice(-1);

    assert.equal(written?.error, false, written?.text ?? "no result");
    assert.equal(readFileSync(join(remote, "deep", "new.txt"), "utf8"), "made");
});

test("ssh to a host from bash is sent back to the host argument; an unknown host is refused", async () => {
    await app.setHosts(owner(app), [gpu]);

    const id = await newSession(app);
    const [sshed, unknown] = await run(
        id,
        tool("bash", { command: "ssh -o BatchMode=yes tcrypt@gpu.example nvidia-smi" }),
        tool("bash", { command: "true", host: "elsewhere" }),
    );

    assert.equal(sshed?.error, true);
    assert.match(sshed!.text, /host: "gpu"/);
    assert.equal(unknown?.error, true);
    assert.match(unknown!.text, /no host named elsewhere\. Hosts: gpu/);
});

test("a host in ask mode waits for a person, and a denial blocks the call", async () => {
    await app.setHosts(owner(app), [{ ...gpu, mode: "ask" }]);

    const id = await newSession(app);
    const answering = (async () => {
        for (let tries = 0; tries < 200; tries++) {
            const waiting = app.approvals.forConversation(id)[0];

            if (waiting !== undefined) {
                assert.equal(waiting.tool, "bash on gpu");
                app.approvals.answer(waiting.id, { allow: false, by: "Owner" });

                return;
            }

            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        assert.fail("no approval was asked for");
    })();
    const [denied] = await run(id, tool("bash", { command: "touch made-anyway", host: "gpu" }));

    await answering;
    assert.equal(denied?.error, true);
    assert.match(denied!.text, /denied this bash call on gpu/);
});

test("a host turned off is not offered", async () => {
    await app.setHosts(owner(app), [{ ...gpu, mode: "off" }]);

    const id = await newSession(app);

    await run(id);
    assert.equal("host" in toolSchema("bash")!.properties, false);
    await app.setHosts(owner(app), []);
});

test("sshedHost finds the host a command reaches, by name, destination or address", () => {
    const hosts: HostEntry[] = [gpu, { name: "nas", target: "nas", mode: "allow" }];

    assert.equal(sshedHost("ssh gpu 'ls'", hosts)?.name, "gpu");
    assert.equal(sshedHost("timeout 30 ssh -o X=1 tcrypt@gpu.example ls", hosts)?.name, "gpu");
    assert.equal(sshedHost("ssh root@nas df", hosts)?.name, "nas");
    assert.equal(sshedHost("scp gpu:/a b", hosts), undefined);
    assert.equal(sshedHost("echo ssh gpu", hosts), undefined);
    assert.equal(sshedHost("ssh other ls", hosts), undefined);
});

test("the transcript tags a call on another machine with its host", async () => {
    const { describeCall } = (await import(new URL("../web/calls.js", import.meta.url).href)) as {
        describeCall: (call: { name: string; args?: Record<string, unknown> }) => {
            label: string;
            subject: string;
        };
    };

    assert.equal(
        describeCall({ name: "bash", args: { command: "nvidia-smi", host: "gpu" } }).label,
        "@gpu",
    );
    assert.equal(
        describeCall({ name: "read", args: { path: "a.txt", host: "gpu" } }).label,
        "Read @gpu",
    );
    assert.equal(describeCall({ name: "read", args: { path: "a.txt" } }).label, "Read");
    assert.equal(describeCall({ name: "bash", args: { command: "ls" } }).label, "");
});
