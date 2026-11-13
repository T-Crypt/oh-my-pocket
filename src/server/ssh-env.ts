/**
 * An `ExecutionEnv` on another machine, reached over SSH: the same files and shell Pi's tools use on this machine,
 * there. Every operation is one small POSIX `sh` script run through a transport, an argv prefix that takes the
 * script's launcher as its last argument (`ssh … host`, or `sh -c` in tests). The script travels base64-encoded, so
 * the remote login shell (zsh, fish, …) never parses the agent's command. A command runs in its own process group
 * beside a watcher that kills the group when the channel's stdin closes, so a timeout, a Stop, or a dead connection
 * leaves nothing running on the host. Output beyond the spill thresholds goes to a file on this machine.
 */
import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import {
    type BinaryReader,
    type DirReader,
    err,
    ExecutionError,
    type ExecutionEnv,
    FileError,
    type FileErrorCode,
    type FileInfo,
    type FileKind,
    type FileWatcher,
    LineScanner,
    type LineScan,
    ok,
    type Result,
    type ShellExecOptions,
    type ShellExecResult,
    StreamDecoder,
    type TextLine,
    type TextLineReader,
    type FileChange,
    type WatchTarget,
} from "@earendil-works/pi-durable/env";

/** A string as one POSIX shell word. */
export function shellQuote(text: string): string {
    return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** What the transport runs: a launcher every common login shell reads the same way, around the base64 script. */
export function launcher(script: string): string {
    const encoded = Buffer.from(script, "utf8").toString("base64");

    return `exec sh -c 'eval "$(printf %s ${encoded} | base64 -d)"'`;
}

/** ssh's own failure, as opposed to a remote command that exited 255. */
const SSH_FAILURE =
    /^ssh: |Permission denied \(|Connection (timed out|refused|closed)|Could not resolve hostname|Host key verification failed|kex_exchange_identification|No route to host|Network is unreachable/m;

export function sshFailure(code: number | null, stderr: string): string | undefined {
    if (code !== 255) {
        return undefined;
    }

    const line = stderr.split("\n").find((each) => SSH_FAILURE.test(each));

    return line?.trim();
}

function fileErrorOf(stderr: string, path: string): FileError {
    const message = stderr.trim().split("\n").at(-1) ?? "failed";
    let code: FileErrorCode = "unknown";

    if (/No such file or directory/.test(stderr)) {
        code = "not_found";
    } else if (/Permission denied/.test(stderr)) {
        code = "permission_denied";
    } else if (/Is a directory/.test(stderr)) {
        code = "is_directory";
    } else if (/Not a directory/.test(stderr)) {
        code = "not_directory";
    } else if (/Not a regular file|Invalid/.test(stderr)) {
        code = "invalid";
    }

    return new FileError(code, message, path);
}

const KINDS: Record<string, FileKind> = { f: "file", d: "directory", l: "symlink" };
/** `stat` without following a final symbolic link: type letter, size, modification time in seconds. */
const STAT = `st() { if [ -L "$1" ]; then t=l; elif [ -d "$1" ]; then t=d; elif [ -f "$1" ]; then t=f; elif [ -e "$1" ]; then t=o; else echo "$1: No such file or directory" >&2; return 1; fi; m=$(stat -c %.3Y -- "$1" 2>/dev/null || stat -c %Y -- "$1" 2>/dev/null || stat -f %m -- "$1"); s=$(stat -c %s -- "$1" 2>/dev/null || stat -f %z -- "$1"); printf '%s\\0%s\\0%s\\0' "$t" "$s" "$m"; }`;
const PRELUDE = "export LC_ALL=C\n";
/** Files up to this size come back whole when a binary reader opens them: one round trip, and a stable copy. */
const SMALL_FILE = 8 * 1024 * 1024;

/** Entries as the listing scripts print them: name, type letter, size, seconds, each ended by a NUL. */
function parseEntries(dir: string, output: Buffer): FileInfo[] {
    const fields = output.toString("utf8").split("\0");
    const entries: FileInfo[] = [];

    for (let at = 0; at + 3 < fields.length; at += 4) {
        const kind = KINDS[fields[at + 1] ?? ""];

        if (kind === undefined) {
            continue;
        }

        const name = fields[at]!;

        entries.push({
            name,
            path: posix.join(dir, name),
            kind,
            size: Number(fields[at + 2]),
            mtimeMs: Math.round(Number(fields[at + 3]) * 1000),
        });
    }

    return entries;
}

/** What the command script prints, alone on stderr, when an argv program is not there to run. */
const NOT_FOUND = "pi-ssh-env: program not found: ";

export interface SshEnvOptions {
    /** Equal ids see the same files: one per host. */
    id: string;
    /** Absolute directory on the host that relative paths resolve against. */
    cwd: string;
    /** Argv prefix; the launcher is appended as one last argument. */
    transport: readonly string[];
    /** How a command string runs on the host: program and flag, `sh -c` by default (`bash -lc` for a login PATH). */
    shell?: string;
    /** Run once before each operation, such as opening an SSH control master. */
    ready?: () => Promise<void>;
}

interface RunResult {
    code: number | null;
    stdout: Buffer;
    stderr: string;
}

export class SshExecutionEnv implements ExecutionEnv {
    readonly id: string;
    cwd: string;
    readonly #transport: readonly string[];
    readonly #shell: string;
    readonly #ready: (() => Promise<void>) | undefined;
    readonly #children = new Set<import("node:child_process").ChildProcess>();

    constructor(options: SshEnvOptions) {
        this.id = options.id;
        this.cwd = options.cwd;
        this.#transport = options.transport;
        this.#shell = options.shell ?? "sh -c";
        this.#ready = options.ready;
    }

    // ─── Running scripts ────────────────────────────────────────────────────

    /** One script on the host, with its stdout collected (or streamed) and stdin given or empty. */
    async #run(
        script: string,
        context: Context,
        options: { stdin?: string | Uint8Array; onStdout?: (chunk: Buffer) => void } = {},
    ): Promise<RunResult> {
        await this.#ready?.();

        const [program, ...args] = this.#transport;

        return new Promise((resolve) => {
            const child = spawn(program!, [...args, launcher(PRELUDE + script)], {
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
                // Its own process group, as the remote session's tree has one over ssh.
                detached: true,
            });
            const out: Buffer[] = [];
            let stderr = "";
            const signal = context.abortSignal;
            const abort = () => child.kill("SIGKILL");

            this.#children.add(child);
            signal?.addEventListener("abort", abort, { once: true });
            child.stdout.on("data", (chunk: Buffer) =>
                options.onStdout === undefined ? out.push(chunk) : options.onStdout(chunk),
            );
            child.stderr.on("data", (chunk: Buffer) => {
                stderr += chunk.toString("utf8");
            });
            child.stdin.on("error", () => {});
            child.stdin.end(options.stdin ?? "");
            child.on("error", (error) => {
                stderr += error.message;
            });
            child.on("close", (code) => {
                this.#children.delete(child);
                signal?.removeEventListener("abort", abort);
                resolve({ code, stdout: Buffer.concat(out), stderr });
            });
        });
    }

    /** A file operation: its stdout, or a `FileError` from what the host printed. */
    async #file(
        script: string,
        path: string,
        context: Context,
        stdin?: string | Uint8Array,
    ): Promise<Result<Buffer, FileError>> {
        if (context.abortSignal?.aborted) {
            return err(new FileError("aborted", "aborted", path));
        }

        const run = await this.#run(script, context, stdin === undefined ? {} : { stdin });

        if (context.abortSignal?.aborted) {
            return err(new FileError("aborted", "aborted", path));
        }

        if (run.code !== 0) {
            const ssh = sshFailure(run.code, run.stderr);

            return err(
                ssh === undefined
                    ? fileErrorOf(run.stderr, path)
                    : new FileError("unknown", ssh, path),
            );
        }

        return ok(run.stdout);
    }

    // ─── Shell ──────────────────────────────────────────────────────────────

    async exec(
        command: string | readonly string[],
        options: ShellExecOptions | undefined,
        context: Context,
    ): Promise<Result<ShellExecResult, ExecutionError>> {
        const signal = context.abortSignal;

        if (signal?.aborted) {
            return err(new ExecutionError("aborted", "aborted"));
        }

        if (typeof command !== "string" && command.length === 0) {
            return err(new ExecutionError("spawn_error", "Empty argv: no program to run"));
        }

        const text = typeof command === "string" ? command : command.map(shellQuote).join(" ");
        // An argv program that is not on the host is a spawn error, as it is on this machine, not exit 127.
        const present =
            typeof command === "string"
                ? ""
                : `command -v -- ${shellQuote(command[0]!)} >/dev/null 2>&1 || { printf '%s\\n' ${shellQuote(NOT_FOUND + command[0]!)} >&2; exit 127; }`;
        const cwd = options?.cwd === undefined ? this.cwd : posix.resolve(this.cwd, options.cwd);
        const exports = Object.entries(options?.env ?? {})
            .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            .map(([key, value]) => `export ${key}=${shellQuote(value)}\n`)
            .join("");
        const run = typeof command === "string" ? `${this.#shell} ${shellQuote(text)}` : text;
        // stdin from nowhere; a watcher on the channel's stdin kills the command when the channel closes, and is
        // stopped itself when the command ends. No `set -m`: a shell without a tty (dash over ssh) turns job control
        // off, the command then sits in the script's own group, and the watcher kills that group too.
        const script = [
            `cd -- ${shellQuote(cwd)} || exit 1`,
            exports,
            present,
            "exec 3<&0",
            `${run} </dev/null &`,
            "pid=$!",
            // When the channel closes: the command's own group, if the shell gave it one; then the script's group,
            // where the command sits in shells without job control; the pid itself when `ps` is nowhere. The group
            // kill takes this watcher and the script with it, so it must come before the pid kill that lets the
            // script's wait return and stop the watcher.
            '{ cat <&3 >/dev/null 2>&1; kill -KILL -"$pid" 2>/dev/null; g=$(ps -o pgid= -p $$ 2>/dev/null | tr -d "[:space:]\n"); [ -n "$g" ] && kill -KILL -"$g" 2>/dev/null; kill -KILL "$pid" 2>/dev/null; } >/dev/null 2>&1 &',
            "w=$!",
            "exec 3<&-",
            'wait "$pid"; s=$?',
            'kill "$w" 2>/dev/null',
            'exit "$s"',
        ].join("\n");

        await this.#ready?.();

        const [program, ...args] = this.#transport;
        const timeoutMs =
            options?.timeout === undefined ? undefined : Math.max(0, options.timeout * 1000);

        return new Promise((resolve) => {
            // The launcher's own script runs `export LC_ALL=C` only for file operations; commands keep the host's locale.
            const child = spawn(program!, [...args, launcher(script)], {
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
                // Its own process group and session, as the command's tree has one in the remote session; the
                // watcher's group kill then reaches every descendant, and the test's `sh -c` stands in safely.
                detached: true,
            });
            const decoders = { stdout: new StreamDecoder(), stderr: new StreamDecoder() };
            let settled = false;
            let stopped: "timeout" | "aborted" | undefined;
            let callbackError: ExecutionError | undefined;
            let stderrText = "";
            let bytes = 0;
            let lines = 0;
            const prefix: string[] = [];
            let spill: WriteStream | undefined;
            let spillPath: string | undefined;
            let spillOpening: Promise<void> | undefined;
            let killTimer: NodeJS.Timeout | undefined;

            this.#children.add(child);

            const stop = (why: "timeout" | "aborted") => {
                if (stopped !== undefined) {
                    return;
                }

                stopped = why;
                // Closing stdin tells the host's watcher to kill the command; the local ssh goes soon after.
                child.stdin.end();
                killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
            };

            const onAbort = () => stop("aborted");
            const timer =
                timeoutMs === undefined ? undefined : setTimeout(() => stop("timeout"), timeoutMs);

            signal?.addEventListener("abort", onAbort, { once: true });

            const toSpill = (text: string) => {
                if (spill !== undefined) {
                    spill.write(text);

                    return;
                }

                prefix.push(text);

                if (spillOpening !== undefined) {
                    return;
                }

                const limits = options?.spill;

                if (
                    limits === undefined ||
                    (bytes <= limits.afterBytes && lines <= limits.afterLines)
                ) {
                    return;
                }

                spillOpening = mkdtemp(posix.join(tmpdir(), "pi-ssh-output-"))
                    .then((dir) => {
                        spillPath = posix.join(dir, "output.log");
                        spill = createWriteStream(spillPath, { flags: "a" });
                        spill.on("error", () => {});
                        spill.write(prefix.join(""));
                        prefix.length = 0;
                    })
                    .catch(() => {
                        spillPath = undefined;
                    });
            };

            const emit = (text: string, stream: "stdout" | "stderr") => {
                if (text === "" || settled) {
                    return;
                }

                bytes += Buffer.byteLength(text);

                for (const char of text) {
                    if (char === "\n") {
                        lines++;
                    }
                }

                if (options?.spill !== undefined) {
                    toSpill(text);
                }

                if (options?.onOutput === undefined || callbackError !== undefined) {
                    return;
                }

                try {
                    options.onOutput(text, context, { stream });
                } catch (error) {
                    callbackError = new ExecutionError(
                        "callback_error",
                        error instanceof Error ? error.message : String(error),
                    );
                    stop("aborted");
                }
            };

            child.stdout.on("data", (chunk: Buffer) =>
                emit(decoders.stdout.decode(chunk), "stdout"),
            );
            child.stderr.on("data", (chunk: Buffer) => {
                const text = decoders.stderr.decode(chunk);

                stderrText = (stderrText + text).slice(-4000);
                emit(text, "stderr");
            });
            child.stdin.on("error", () => {});
            child.on("error", (error) => {
                stderrText += error.message;
            });
            child.on("close", (code) => {
                emit(decoders.stdout.decode(), "stdout");
                emit(decoders.stderr.decode(), "stderr");
                settled = true;
                this.#children.delete(child);
                clearTimeout(timer);
                clearTimeout(killTimer);
                signal?.removeEventListener("abort", onAbort);

                const finish = async () => {
                    await spillOpening;
                    await new Promise<void>((done) =>
                        spill === undefined ? done() : spill.end(() => done()),
                    );

                    const spilled = spillPath === undefined ? {} : { spillPath };

                    if (callbackError !== undefined) {
                        return err<ShellExecResult, ExecutionError>(callbackError);
                    }

                    if (stopped === "timeout") {
                        const error = new ExecutionError("timeout", `timeout:${options?.timeout}`);

                        if (spillPath !== undefined) {
                            error.spillPath = spillPath;
                        }

                        return err<ShellExecResult, ExecutionError>(error);
                    }

                    if (stopped === "aborted") {
                        const error = new ExecutionError("aborted", "aborted");

                        if (spillPath !== undefined) {
                            error.spillPath = spillPath;
                        }

                        return err<ShellExecResult, ExecutionError>(error);
                    }

                    const missing = stderrText
                        .split("\n")
                        .find((line) => line.startsWith(NOT_FOUND));

                    if (code === 127 && missing !== undefined) {
                        return err<ShellExecResult, ExecutionError>(
                            new ExecutionError("spawn_error", missing.slice("pi-ssh-env: ".length)),
                        );
                    }

                    const ssh = sshFailure(code, stderrText);

                    if (ssh !== undefined) {
                        return err<ShellExecResult, ExecutionError>(
                            new ExecutionError("spawn_error", `${this.id}: ${ssh}`),
                        );
                    }

                    return ok<ShellExecResult, ExecutionError>({ exitCode: code ?? 1, ...spilled });
                };

                void finish().then(resolve);
            });
        });
    }

    async cleanup(_context: Context): Promise<void> {
        for (const child of this.#children) {
            child.stdin?.end();
            child.kill("SIGKILL");
        }

        this.#children.clear();
    }

    // ─── Paths ──────────────────────────────────────────────────────────────

    async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
        return ok(posix.resolve(this.cwd, path));
    }

    async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
        return ok(posix.join(...parts));
    }

    async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
        const abs = posix.resolve(this.cwd, path);
        const run = await this.#file(`realpath -- ${shellQuote(abs)}`, abs, context);

        return run.ok ? ok(run.value.toString("utf8").replace(/\n$/, "")) : run;
    }

    async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
        const abs = posix.resolve(this.cwd, path);
        const run = await this.#file(
            `if [ -e ${shellQuote(abs)} ] || [ -L ${shellQuote(abs)} ]; then echo y; else echo n; fi`,
            abs,
            context,
        );

        return run.ok ? ok(run.value.toString("utf8").trim() === "y") : run;
    }

    // ─── Metadata and directories ───────────────────────────────────────────

    async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
        const abs = posix.resolve(this.cwd, path);
        const run = await this.#file(`${STAT}\nst ${shellQuote(abs)}`, abs, context);

        if (!run.ok) {
            return run;
        }

        const [type, size, mtime] = run.value.toString("utf8").split("\0");
        const kind = KINDS[type ?? ""];

        if (kind === undefined) {
            return err(new FileError("invalid", `${abs}: unsupported file type`, abs));
        }

        return ok({
            name: posix.basename(abs),
            path: abs,
            kind,
            size: Number(size),
            mtimeMs: Math.round(Number(mtime) * 1000),
        });
    }

    async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
        const abs = posix.resolve(this.cwd, path);
        const quoted = shellQuote(abs);
        const run = await this.#file(
            [
                STAT,
                `[ -e ${quoted} ] || { echo "${abs}: No such file or directory" >&2; exit 1; }`,
                `[ -d ${quoted} ] || { echo "${abs}: Not a directory" >&2; exit 1; }`,
                `cd -- ${quoted} || exit 1`,
                `for n in * .[!.]* ..?*; do if [ -e "$n" ] || [ -L "$n" ]; then printf '%s\\0' "$n"; st "$n" || exit 1; fi; done`,
            ].join("\n"),
            abs,
            context,
        );

        if (!run.ok) {
            return run;
        }

        return ok(parseEntries(abs, run.value));
    }

    async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
        const abs = posix.resolve(this.cwd, path);
        const quoted = shellQuote(abs);
        // The names now; each page's metadata when it is read, so an entry removed since is skipped.
        const listed = await this.#file(
            [
                `[ -e ${quoted} ] || { echo "${abs}: No such file or directory" >&2; exit 1; }`,
                `[ -d ${quoted} ] || { echo "${abs}: Not a directory" >&2; exit 1; }`,
                `cd -- ${quoted} || exit 1`,
                `for n in * .[!.]* ..?*; do if [ -e "$n" ] || [ -L "$n" ]; then printf '%s\\0' "$n"; fi; done`,
            ].join("\n"),
            abs,
            context,
        );

        if (!listed.ok) {
            return listed;
        }

        const names = listed.value
            .toString("utf8")
            .split("\0")
            .filter((name) => name !== "");
        let at = 0;
        let closed = false;

        return ok({
            next: async (maxEntries: number, inner: Context) => {
                if (closed || !Number.isSafeInteger(maxEntries) || maxEntries < 1) {
                    return err(
                        new FileError(
                            "invalid",
                            closed
                                ? "The reader is closed."
                                : "maxEntries must be a positive integer.",
                            abs,
                        ),
                    );
                }

                if (inner.abortSignal?.aborted) {
                    return err(new FileError("aborted", "aborted", abs));
                }

                const page = names.slice(at, at + maxEntries);

                at += page.length;

                if (page.length === 0) {
                    return ok({ entries: [], done: true });
                }

                const run = await this.#file(
                    [
                        STAT,
                        `cd -- ${quoted} || exit 1`,
                        `for n in ${page.map(shellQuote).join(" ")}; do if [ -e "$n" ] || [ -L "$n" ]; then printf '%s\\0' "$n"; st "$n"; fi; done`,
                    ].join("\n"),
                    abs,
                    inner,
                );

                if (!run.ok) {
                    return run;
                }

                return ok({ entries: parseEntries(abs, run.value), done: at >= names.length });
            },
            close: async () => {
                closed = true;
            },
        });
    }

    async createDir(
        path: string,
        options: { recursive?: boolean } | undefined,
        context: Context,
    ): Promise<Result<void, FileError>> {
        const abs = posix.resolve(this.cwd, path);
        const run = await this.#file(
            `mkdir ${options?.recursive === true ? "-p " : ""}-- ${shellQuote(abs)}`,
            abs,
            context,
        );

        return run.ok ? ok(undefined) : run;
    }

    async remove(
        path: string,
        options: { recursive?: boolean; force?: boolean } | undefined,
        context: Context,
    ): Promise<Result<void, FileError>> {
        const abs = posix.resolve(this.cwd, path);
        const quoted = shellQuote(abs);
        const flags = `${options?.recursive === true ? "r" : ""}${options?.force === true ? "f" : ""}`;
        // Without `recursive`, a directory is refused, as Node's `rm` refuses it.
        const guard =
            options?.recursive === true
                ? ""
                : `if [ -d ${quoted} ] && [ ! -L ${quoted} ]; then echo "${abs}: Is a directory" >&2; exit 1; fi\n`;
        const run = await this.#file(
            `${guard}rm ${flags === "" ? "" : `-${flags} `}-- ${quoted}`,
            abs,
            context,
        );

        return run.ok ? ok(undefined) : run;
    }

    async renameFile(
        sourcePath: string,
        destinationPath: string,
        context: Context,
    ): Promise<Result<void, FileError>> {
        const from = posix.resolve(this.cwd, sourcePath);
        const to = posix.resolve(this.cwd, destinationPath);
        const run = await this.#file(
            `[ -e ${shellQuote(from)} ] || [ -L ${shellQuote(from)} ] || { echo "${from}: No such file or directory" >&2; exit 1; }\nmv -f -- ${shellQuote(from)} ${shellQuote(to)}`,
            from,
            context,
        );

        return run.ok ? ok(undefined) : run;
    }

    async createTempDir(
        prefix: string | undefined,
        context: Context,
    ): Promise<Result<string, FileError>> {
        const name = (prefix ?? "pi-").replace(/[^A-Za-z0-9._-]/g, "_");
        const run = await this.#file(`mktemp -d "\${TMPDIR:-/tmp}/${name}XXXXXX"`, "/tmp", context);

        return run.ok ? ok(run.value.toString("utf8").trim()) : run;
    }

    async createTempFile(
        options: { prefix?: string; suffix?: string } | undefined,
        context: Context,
    ): Promise<Result<string, FileError>> {
        const name = (options?.prefix ?? "pi-").replace(/[^A-Za-z0-9._-]/g, "_");
        const suffix = (options?.suffix ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
        const run = await this.#file(
            `d=$(mktemp -d "\${TMPDIR:-/tmp}/pi-tmp-XXXXXX") || exit 1\nf="$d/${name}file${suffix}"\n: > "$f" && printf %s "$f"`,
            "/tmp",
            context,
        );

        return run.ok ? ok(run.value.toString("utf8")) : run;
    }

    // ─── Reading ────────────────────────────────────────────────────────────

    /** `cat` a regular file (following links), with Node's errors for a directory or a missing file. */
    #catScript(abs: string, tail = ""): string {
        const quoted = shellQuote(abs);

        return [
            `[ -e ${quoted} ] || { echo "${abs}: No such file or directory" >&2; exit 1; }`,
            `[ -d ${quoted} ] && { echo "${abs}: Is a directory" >&2; exit 1; }`,
            `cat -- ${quoted}${tail}`,
        ].join("\n");
    }

    async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
        const abs = posix.resolve(this.cwd, path);
        const run = await this.#file(this.#catScript(abs), abs, context);

        return run.ok ? ok(new Uint8Array(run.value)) : run;
    }

    async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
        const read = await this.readBinaryFile(path, context);

        return read.ok ? ok(new TextDecoder().decode(read.value)) : read;
    }

    async readTextLines(
        path: string,
        options: { maxLines?: number } | undefined,
        context: Context,
    ): Promise<Result<string[], FileError>> {
        const abs = posix.resolve(this.cwd, path);
        const max = options?.maxLines;
        const run = await this.#file(
            this.#catScript(
                abs,
                max === undefined ? "" : ` | head -n ${Math.max(0, Math.floor(max))}`,
            ),
            abs,
            context,
        );

        if (!run.ok) {
            return run;
        }

        const text = new TextDecoder().decode(run.value);

        if (text === "") {
            return ok([]);
        }

        const lines = text.split("\n");

        if (text.endsWith("\n")) {
            lines.pop();
        }

        return ok(
            (max === undefined ? lines : lines.slice(0, max)).map((line) =>
                line.replace(/\r$/, ""),
            ),
        );
    }

    async openTextLineReader(
        path: string,
        context: Context,
    ): Promise<Result<TextLineReader, FileError>> {
        const read = await this.readTextFile(path, context);

        if (!read.ok) {
            return read;
        }

        const text = read.value;
        let at = 0;

        return ok({
            readLine: async () => {
                if (at >= text.length) {
                    return ok<TextLine | undefined, FileError>(undefined);
                }

                const end = text.indexOf("\n", at);
                const line: TextLine =
                    end === -1
                        ? { text: text.slice(at), terminated: false }
                        : { text: text.slice(at, end), terminated: true };

                at = end === -1 ? text.length : end + 1;

                return ok<TextLine | undefined, FileError>(line);
            },
            close: async () => {},
        });
    }

    async openBinaryReader(
        path: string,
        options: { noFollow?: boolean } | undefined,
        context: Context,
    ): Promise<Result<BinaryReader, FileError>> {
        const abs = posix.resolve(this.cwd, path);
        const quoted = shellQuote(abs);
        // One round trip: the checks, the file's metadata, and the whole file when it is small. A small file read from
        // that copy is the file as it was opened, as a local reader's open handle is; a big one is read by path.
        const opened = await this.#file(
            [
                STAT,
                options?.noFollow === true
                    ? `[ -L ${quoted} ] && { echo "${abs}: Invalid: symbolic link" >&2; exit 1; }`
                    : "",
                `[ -e ${quoted} ] || { echo "${abs}: No such file or directory" >&2; exit 1; }`,
                `[ -d ${quoted} ] && { echo "${abs}: Is a directory" >&2; exit 1; }`,
                `[ -f ${quoted} ] || { echo "${abs}: Not a regular file" >&2; exit 1; }`,
                `r=$(realpath -- ${quoted} 2>/dev/null || printf %s ${quoted})`,
                `printf '%s\\0' "$r"; st "$r" || exit 1`,
                `s=$(stat -c %s -- "$r" 2>/dev/null || stat -f %z -- "$r")`,
                `if [ "$s" -le ${SMALL_FILE} ]; then cat -- "$r"; fi`,
            ].join("\n"),
            abs,
            context,
        );

        if (!opened.ok) {
            return opened;
        }

        const raw = opened.value;
        const fields: string[] = [];
        let at = 0;

        for (let count = 0; count < 4; count++) {
            const end = raw.indexOf(0, at);

            fields.push(raw.subarray(at, end).toString("utf8"));
            at = end + 1;
        }

        const [real, , size, mtime] = fields as [string, string, string, string];
        const info: FileInfo = {
            name: posix.basename(real),
            path: real,
            kind: "file",
            size: Number(size),
            mtimeMs: Math.round(Number(mtime) * 1000),
        };
        const copy = info.size <= SMALL_FILE ? new Uint8Array(raw.subarray(at)) : undefined;
        let closed = false;
        const refuse = (inner: Context): FileError | undefined =>
            closed
                ? new FileError("invalid", "The reader is closed.", abs)
                : inner.abortSignal?.aborted
                  ? new FileError("aborted", "aborted", abs)
                  : undefined;

        return ok({
            info: async (inner: Context) => {
                const refused = refuse(inner);

                return refused === undefined ? ok({ ...info }) : err(refused);
            },
            read: async (offset: number, length: number, inner: Context) => {
                const refused = refuse(inner);

                if (refused !== undefined) {
                    return err(refused);
                }

                if (
                    !Number.isSafeInteger(offset) ||
                    offset < 0 ||
                    !Number.isSafeInteger(length) ||
                    length < 0
                ) {
                    return err(
                        new FileError(
                            "invalid",
                            "Offset and length must be non-negative integers.",
                            abs,
                        ),
                    );
                }

                if (copy !== undefined) {
                    return ok(copy.slice(offset, offset + length));
                }

                if (length === 0) {
                    return ok(new Uint8Array());
                }

                const run = await this.#file(
                    `tail -c +${offset + 1} -- ${shellQuote(real)} | head -c ${length}`,
                    abs,
                    inner,
                );

                return run.ok ? ok(new Uint8Array(run.value)) : run;
            },
            scanLines: async (
                range: { startLine: number; endLine?: number },
                inner: Context,
            ): Promise<Result<LineScan, FileError>> => {
                const refused = refuse(inner);

                if (refused !== undefined) {
                    return err(refused);
                }

                let scanner: LineScanner;

                try {
                    scanner = new LineScanner(range.startLine, range.endLine);
                } catch (error) {
                    return err(
                        new FileError(
                            "invalid",
                            error instanceof Error ? error.message : "Invalid line range",
                            abs,
                        ),
                    );
                }

                if (copy !== undefined) {
                    scanner.push(copy);

                    return ok(scanner.finish());
                }

                const run = await this.#run(this.#catScript(real), inner, {
                    onStdout: (chunk) => scanner.push(new Uint8Array(chunk)),
                });

                if (run.code !== 0) {
                    return err(fileErrorOf(run.stderr, abs));
                }

                return ok(scanner.finish());
            },
            close: async () => {
                closed = true;
            },
        });
    }

    // ─── Writing ────────────────────────────────────────────────────────────

    async writeFile(
        path: string,
        content: string | Uint8Array,
        context: Context,
    ): Promise<Result<void, FileError>> {
        const abs = posix.resolve(this.cwd, path);
        // Parent folders are made, as Pi's write tool promises; writing in place keeps the file's mode and owner.
        const run = await this.#file(
            `mkdir -p -- ${shellQuote(posix.dirname(abs))} && cat > ${shellQuote(abs)}`,
            abs,
            context,
            content,
        );

        return run.ok ? ok(undefined) : run;
    }

    async appendFile(
        path: string,
        content: string | Uint8Array,
        context: Context,
    ): Promise<Result<void, FileError>> {
        const abs = posix.resolve(this.cwd, path);
        const run = await this.#file(
            `mkdir -p -- ${shellQuote(posix.dirname(abs))} && cat >> ${shellQuote(abs)}`,
            abs,
            context,
            content,
        );

        return run.ok ? ok(undefined) : run;
    }

    async truncateFile(
        path: string,
        size: number,
        context: Context,
    ): Promise<Result<void, FileError>> {
        const abs = posix.resolve(this.cwd, path);
        const quoted = shellQuote(abs);
        const run = await this.#file(
            `[ -e ${quoted} ] || { echo "${abs}: No such file or directory" >&2; exit 1; }\ntruncate -s ${Math.max(0, Math.floor(size))} -- ${quoted}`,
            abs,
            context,
        );

        return run.ok ? ok(undefined) : run;
    }

    async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
        const abs = posix.resolve(this.cwd, path);
        const quoted = shellQuote(abs);
        const run = await this.#file(
            `[ -e ${quoted} ] || { echo "${abs}: No such file or directory" >&2; exit 1; }\nsync -- ${quoted} 2>/dev/null || sync`,
            abs,
            context,
        );

        return run.ok ? ok(undefined) : run;
    }

    // ─── Watching ───────────────────────────────────────────────────────────

    async watch(
        _targets: readonly WatchTarget[],
        _onChange: (change: FileChange) => void,
        _context: Context,
    ): Promise<Result<FileWatcher, FileError>> {
        return err(new FileError("not_supported", "A host over SSH cannot be watched."));
    }
}
