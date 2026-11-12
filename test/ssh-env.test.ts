// SSH hosts' execution environment: Pi Durable's own conformance cases for an `ExecutionEnv`, run with `sh -c` in
// place of `ssh host`, so the scripts the environment sends are tested without an SSH server. Then what conformance
// does not cover: commands keep their quoting through the launcher, a stopped command leaves nothing running on the
// host, and ssh's own failures read as ssh's message.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { shellQuote, sshFailure, SshExecutionEnv } from "../src/server/ssh-env.ts";

const context = BACKGROUND_CONTEXT;

/** Cases that need what a host over SSH does not offer: a file watcher. */
const UNSUPPORTED = /watch/i;

async function withEnv(use: (env: SshExecutionEnv) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "ssh-env-"));

    try {
        await use(new SshExecutionEnv({ id: "ssh:test", cwd: dir, transport: ["sh", "-c"] }));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

const assertions = {
    ok: (value: unknown, message?: string) =>
        assert.ok(value, message ?? "expected a truthy value"),
    strictEqual: (actual: unknown, expected: unknown) => assert.strictEqual(actual, expected),
    deepEqual: (actual: unknown, expected: unknown) => assert.deepStrictEqual(actual, expected),
    partialDeepEqual: (actual: unknown, expected: unknown) =>
        assert.partialDeepStrictEqual(actual, expected),
    greaterThan: (actual: number, expected: number) =>
        assert.ok(actual > expected, `${actual} > ${expected}`),
    rejects: async (operation: Promise<unknown>, includes: string) =>
        assert.rejects(operation, (error: Error) => error.message.includes(includes)),
};

for (const each of createEnvConformance({ assertions, withEnv })) {
    test(
        `conformance: ${each.name}`,
        { skip: UNSUPPORTED.test(each.name), timeout: each.timeoutMs ?? 20_000 },
        () => each.run(),
    );
}

test("a command keeps its quotes, dollars, newlines and unicode", async () => {
    await withEnv(async (env) => {
        let out = "";
        const command = `printf '%s|' "it's" '$HOME' "two\nlines" 'ünï ✓'`;
        const result = getOrThrow(
            await env.exec(command, { onOutput: (text) => (out += text) }, context),
        );

        assert.equal(result.exitCode, 0);
        assert.equal(out, `it's|$HOME|two\nlines|ünï ✓|`);
    });
});

test("the command runs in the environment's folder with the variables it was given", async () => {
    await withEnv(async (env) => {
        let out = "";

        getOrThrow(
            await env.exec(
                'pwd; printf "%s" "$QUIET"',
                { env: { QUIET: "a b'c" }, onOutput: (text) => (out += text) },
                context,
            ),
        );
        assert.equal(out, `${env.cwd}\na b'c`);
    });
});

test("a stopped command leaves nothing running on the host", async () => {
    await withEnv(async (env) => {
        const marker = join(env.cwd, "survived");
        const controller = new AbortController();
        const running = env.exec(
            `sleep 3; touch ${shellQuote(marker)}`,
            undefined,
            withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
        );

        await new Promise((resolve) => setTimeout(resolve, 300));
        controller.abort();

        const result = await running;

        assert.equal(result.ok, false);
        assert.equal(!result.ok && result.error.code, "aborted");
        await new Promise((resolve) => setTimeout(resolve, 3500));
        assert.equal(existsSync(marker), false, "the command went on after it was stopped");
    });
});

test("a timeout stops the command on the host too", async () => {
    await withEnv(async (env) => {
        const marker = join(env.cwd, "survived");
        const result = await env.exec(
            `sleep 3; touch ${shellQuote(marker)}`,
            { timeout: 0.5 },
            context,
        );

        assert.equal(!result.ok && result.error.code, "timeout");
        await new Promise((resolve) => setTimeout(resolve, 3500));
        assert.equal(existsSync(marker), false);
    });
});

test("a stopped command leaves none of its descendants running on the host", async () => {
    await withEnv(async (env) => {
        const marker = join(env.cwd, "survived");
        const controller = new AbortController();
        // The marker is written by a subshell: killing the command's own shell would leave it going.
        const running = env.exec(
            `(sleep 3; touch ${shellQuote(marker)}) & wait`,
            undefined,
            withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
        );

        await new Promise((resolve) => setTimeout(resolve, 300));
        controller.abort();

        const result = await running;

        assert.equal(result.ok, false);
        assert.equal(!result.ok && result.error.code, "aborted");
        await new Promise((resolve) => setTimeout(resolve, 3500));
        assert.equal(existsSync(marker), false, "a descendant went on after it was stopped");
    });
});

test("a timeout stops a command's descendants on the host too", async () => {
    await withEnv(async (env) => {
        const marker = join(env.cwd, "survived");
        const result = await env.exec(
            `(sleep 3; touch ${shellQuote(marker)}) & wait`,
            { timeout: 0.5 },
            context,
        );

        assert.equal(!result.ok && result.error.code, "timeout");
        await new Promise((resolve) => setTimeout(resolve, 3500));
        assert.equal(existsSync(marker), false);
    });
});

test("output past the spill thresholds is kept whole in a local file", async () => {
    await withEnv(async (env) => {
        const result = getOrThrow(
            await env.exec("seq 1 5000", { spill: { afterBytes: 1000, afterLines: 100 } }, context),
        );

        assert.ok(result.spillPath !== undefined);
        assert.equal(
            getOrThrow(await env.readTextFile(result.spillPath, context)).split("\n").length,
            5001,
        );
    });
});

test("ssh's own failure is told apart from a command that exited 255", () => {
    assert.equal(
        sshFailure(255, "tcrypt@omarchy: Permission denied (publickey,password).\n"),
        "tcrypt@omarchy: Permission denied (publickey,password).",
    );
    assert.equal(
        sshFailure(
            255,
            "ssh: connect to host 10.0.0.52 port 22: Connection timed out\n",
        )?.startsWith("ssh:"),
        true,
    );
    assert.equal(sshFailure(255, "my tool failed\n"), undefined);
    assert.equal(sshFailure(1, "ssh: whatever"), undefined);
});
