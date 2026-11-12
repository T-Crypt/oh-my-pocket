/**
 * SSH hosts: other machines the owner lets Pi work on. Each has a name Pi uses (`host: "gpu"` on bash, read, write and
 * edit), an SSH destination (`user@address` or an alias from `~/.ssh/config`), and a mode: `allow` runs calls, `ask`
 * waits for a person to allow each one, `off` hides the host. Calls go through one kept SSH connection per host (a
 * control master under the data folder), with the system's `ssh`, so the user's keys, agent and SSH config apply and
 * nothing secret is stored here.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { HttpError } from "./errors.ts";
import { SshExecutionEnv, shellQuote } from "./ssh-env.ts";

export type HostMode = "allow" | "ask" | "off";

export interface HostEntry {
    /** What Pi names it: lowercase letters, digits and dashes. */
    name: string;
    /** The SSH destination: `user@address`, an address, or a `~/.ssh/config` alias. */
    target: string;
    /** The folder relative paths and commands start in; the SSH user's home when absent. */
    cwd?: string;
    /** How commands run there, program and flag (`bash -lc` for a login PATH); `sh -c` when absent. */
    shell?: string;
    mode: HostMode;
    /** One line Pi reads about the machine: what it is for. */
    note?: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
/** An SSH destination that cannot be taken for an option or carry a shell word. */
const TARGET = /^[A-Za-z0-9_][A-Za-z0-9_.@:%[\]-]{0,200}$/;
const SHELL = /^[A-Za-z0-9_./-]+( -[A-Za-z]+)*$/;
const MODES = new Set<HostMode>(["allow", "ask", "off"]);

export const MAX_HOSTS = 20;
/** How long a kept connection outlives its last use. */
const PERSIST_SECONDS = 600;
/** How long a connection that was checked is trusted before it is checked again. */
const CHECKED_MS = 30_000;

/** Hosts as the owner sent them, checked; throws a 400 that says what is wrong. */
export function checkHosts(value: unknown): HostEntry[] {
    if (!Array.isArray(value) || value.length > MAX_HOSTS) {
        throw new HttpError(400, `hosts must be a list of at most ${String(MAX_HOSTS)} hosts.`);
    }

    const names = new Set<string>();

    return value.map((raw: unknown) => {
        const each = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
            string,
            unknown
        >;
        const { name, target, cwd, shell, mode, note } = each;

        if (typeof name !== "string" || !NAME.test(name)) {
            throw new HttpError(
                400,
                "A host's name is lowercase letters, digits and dashes, 31 at most.",
            );
        }

        if (names.has(name)) {
            throw new HttpError(400, `Two hosts are named ${name}.`);
        }

        names.add(name);

        if (typeof target !== "string" || !TARGET.test(target)) {
            throw new HttpError(
                400,
                `${name}: the SSH destination is user@address, an address, or an SSH config alias.`,
            );
        }

        if (
            cwd !== undefined &&
            cwd !== "" &&
            (typeof cwd !== "string" || !cwd.startsWith("/") || cwd.length > 500)
        ) {
            throw new HttpError(400, `${name}: the folder must be an absolute path.`);
        }

        if (
            shell !== undefined &&
            shell !== "" &&
            (typeof shell !== "string" || !SHELL.test(shell))
        ) {
            throw new HttpError(
                400,
                `${name}: the shell is a program and its flags, such as bash -lc.`,
            );
        }

        if (typeof mode !== "string" || !MODES.has(mode as HostMode)) {
            throw new HttpError(400, `${name}: the mode is allow, ask, or off.`);
        }

        if (
            note !== undefined &&
            (typeof note !== "string" || note.length > 200 || /[\r\n]/.test(note))
        ) {
            throw new HttpError(400, `${name}: the note is one line of at most 200 characters.`);
        }

        return {
            name,
            target,
            mode: mode as HostMode,
            ...(typeof cwd === "string" && cwd !== "" ? { cwd } : {}),
            ...(typeof shell === "string" && shell !== "" ? { shell } : {}),
            ...(typeof note === "string" && note.trim() !== "" ? { note: note.trim() } : {}),
        };
    });
}

/** What a test of a host found: it answered, and how fast, or what ssh said. */
export type HostTest = { ok: true; ms: number; cwd: string } | { ok: false; error: string };

interface Spawned {
    code: number | null;
    stdout: string;
    stderr: string;
}

/** A program run to its exit, stdin closed; `exit` rather than `close`, as a backgrounded master keeps stderr open. */
function run(program: string, args: readonly string[], timeoutMs: number): Promise<Spawned> {
    return new Promise((resolve) => {
        const child = spawn(program, args, {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
        child.on("error", (error) => {
            stderr += error.message;
        });
        child.on("exit", (code) => {
            clearTimeout(timer);
            // A moment for the last of the output, without waiting on a descendant that holds the pipes.
            setTimeout(() => {
                child.stdout.destroy();
                child.stderr.destroy();
                resolve({ code, stdout, stderr });
            }, 20);
        });
    });
}

export class Hosts {
    readonly #socketDir: string;
    readonly #list: () => readonly HostEntry[];
    readonly #ssh: string;
    readonly #envs = new Map<string, { key: string; env: Promise<SshExecutionEnv> }>();
    readonly #masters = new Map<string, { checkedAt: number; opening?: Promise<void> }>();

    /** `list` reads the owner's hosts each time, so a change applies to the next call. */
    constructor(dataDir: string, list: () => readonly HostEntry[], ssh = "ssh") {
        this.#socketDir = join(dataDir, "hosts");
        this.#list = list;
        this.#ssh = ssh;
    }

    list(): readonly HostEntry[] {
        return this.#list();
    }

    /** The hosts Pi is offered: every one not turned off. */
    usable(): HostEntry[] {
        return this.#list().filter((each) => each.mode !== "off");
    }

    get(name: string): HostEntry | undefined {
        return this.#list().find((each) => each.name === name);
    }

    /** The options every ssh call shares: no prompts, a kept connection, a dead link noticed within a minute. */
    #options(): string[] {
        return [
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
            "-o",
            `ControlPath=${join(this.#socketDir, "%C")}`,
        ];
    }

    /** A kept connection to `target`: checked at most every half minute, opened when missing. */
    async #master(target: string): Promise<void> {
        const known = this.#masters.get(target) ?? { checkedAt: 0 };

        this.#masters.set(target, known);

        if (known.opening !== undefined) {
            return known.opening;
        }

        if (Date.now() - known.checkedAt < CHECKED_MS) {
            return;
        }

        known.opening = (async () => {
            mkdirSync(this.#socketDir, { recursive: true, mode: 0o700 });

            const check = await run(
                this.#ssh,
                [...this.#options(), "-O", "check", "--", target],
                5000,
            );

            if (check.code !== 0) {
                const opened = await run(
                    this.#ssh,
                    [
                        ...this.#options(),
                        "-o",
                        "ControlMaster=yes",
                        "-o",
                        `ControlPersist=${String(PERSIST_SECONDS)}`,
                        "-f",
                        "-N",
                        "--",
                        target,
                    ],
                    20_000,
                );

                if (opened.code !== 0) {
                    const said = opened.stderr.trim().split("\n").at(-1) ?? "";

                    throw new Error(
                        `${target}: ${said === "" ? `ssh exited with ${String(opened.code)}` : said}`,
                    );
                }
            }

            known.checkedAt = Date.now();
        })().finally(() => {
            known.opening = undefined;
        });

        return known.opening;
    }

    /** The environment calls with `host: name` run in. Throws, in words for Pi, when the host is unknown or off. */
    envFor(name: string): Promise<SshExecutionEnv> {
        const host = this.get(name);

        if (host === undefined || host.mode === "off") {
            const names = this.usable().map((each) => each.name);

            return Promise.reject(
                new Error(
                    names.length === 0
                        ? `There is no host named ${name}.`
                        : `There is no host named ${name}. Hosts: ${names.join(", ")}.`,
                ),
            );
        }

        const key = JSON.stringify(host);
        const cached = this.#envs.get(name);

        if (cached?.key === key) {
            return cached.env;
        }

        const transport = [
            this.#ssh,
            ...this.#options(),
            "-o",
            "ControlMaster=no",
            "--",
            host.target,
        ];
        const ready = () => this.#master(host.target);
        const env = (async () => {
            let cwd = host.cwd;

            if (cwd === undefined) {
                // The SSH user's home, asked once: the env needs an absolute folder to resolve paths against.
                const probe = new SshExecutionEnv({
                    id: `ssh:${host.target}`,
                    cwd: "/",
                    transport,
                    ready,
                });
                let home = "";
                const asked = await probe.exec(
                    'printf %s "$HOME"',
                    { onOutput: (text) => (home += text) },
                    BACKGROUND_CONTEXT,
                );

                if (!asked.ok) {
                    throw new Error(asked.error.message);
                }

                cwd = home.startsWith("/") ? home : "/";
            }

            return new SshExecutionEnv({
                id: `ssh:${host.target}`,
                cwd,
                transport,
                ready,
                ...(host.shell === undefined ? {} : { shell: host.shell }),
            });
        })();

        // A host that could not be reached is asked again next time, not remembered as broken.
        env.catch(() => {
            if (this.#envs.get(name)?.env === env) {
                this.#envs.delete(name);
            }
        });
        this.#envs.set(name, { key, env });

        return env;
    }

    /** Connect to a host and run a no-op there: for the owner's Test button. */
    async test(name: string): Promise<HostTest> {
        const started = Date.now();

        try {
            const host = this.get(name);

            if (host === undefined) {
                return { ok: false, error: `There is no host named ${name}.` };
            }

            // A test checks the connection now, whatever was checked a moment ago.
            this.#masters.delete(host.target);

            const env = await this.envFor(name);
            const result = await env.exec(
                `cd -- ${shellQuote(env.cwd)}`,
                { timeout: 20 },
                BACKGROUND_CONTEXT,
            );

            if (!result.ok) {
                return { ok: false, error: result.error.message };
            }

            if (result.value.exitCode !== 0) {
                return { ok: false, error: `The folder ${env.cwd} is not there.` };
            }

            return { ok: true, ms: Date.now() - started, cwd: env.cwd };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    /** Close the kept connections: at shutdown. */
    async close(): Promise<void> {
        const targets = [...this.#masters.keys()];

        this.#masters.clear();
        this.#envs.clear();
        await Promise.all(
            targets.map((target) =>
                run(this.#ssh, [...this.#options(), "-O", "exit", "--", target], 3000),
            ),
        );
    }
}
