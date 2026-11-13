/** One process per data directory, with a pid-only lock and a separate process identity. */
import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const INCOMPLETE_LOCK_GRACE_MS = 10_000;
const PROCESS_START_MARGIN_MS = 5_000;
let clockTicksPerSecond: number | undefined;

interface Lock {
    pid: number;
    fileId: string;
    mtimeMs: number;
}

interface Identity {
    version: 1;
    pid: number;
    fileId: string;
    startTime?: string;
    bootId?: string;
}

/** Read one file handle so a replaced path cannot combine one lock's pid with another lock's inode. */
function readLock(lockFile: string): Lock | undefined {
    let fd: number;

    try {
        fd = openSync(lockFile, "r");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }

        throw error;
    }

    try {
        const stat = fstatSync(fd, { bigint: true });
        const pid = Number(readFileSync(fd, "utf8").trim());

        return {
            pid,
            fileId: `${stat.dev}:${stat.ino}:${stat.ctimeNs}`,
            mtimeMs: Number(stat.mtimeMs),
        };
    } finally {
        closeSync(fd);
    }
}

/** Linux stat's comm field can contain spaces and parentheses. Fields after its final ')' start at field 3. */
function processIdentity(pid: number): Pick<Identity, "startTime" | "bootId"> {
    const identity: Pick<Identity, "startTime" | "bootId"> = {};

    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const end = stat.lastIndexOf(")");
        const startTime =
            end === -1
                ? undefined
                : stat
                      .slice(end + 2)
                      .trim()
                      .split(/\s+/)[19];

        if (startTime !== undefined && /^\d+$/.test(startTime)) {
            identity.startTime = startTime;
        }
    } catch {
        // Without readable process evidence, a live pid must remain occupied.
    }

    try {
        identity.bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
        // Non-Linux systems do not have /proc. They retain the live-pid fallback.
    }

    return identity;
}

/** getconf supplies USER_HZ, which need not equal the kernel timer rate. Use the usual 100 only as a fallback. */
function ticksPerSecond(): number {
    if (clockTicksPerSecond === undefined) {
        clockTicksPerSecond = 100;

        try {
            const value = Number(
                execFileSync("getconf", ["CLK_TCK"], {
                    encoding: "utf8",
                    timeout: 1000,
                    stdio: ["ignore", "pipe", "ignore"],
                }).trim(),
            );

            if (Number.isSafeInteger(value) && value > 0) {
                clockTicksPerSecond = value;
            }
        } catch {
            // getconf is not installed on every host.
        }
    }

    return clockTicksPerSecond;
}

/** Estimate a Linux process's wall-clock start. Unreadable or inconsistent evidence cannot permit takeover. */
function processStartMs(startTime: string | undefined): number | undefined {
    if (startTime === undefined) {
        return undefined;
    }

    try {
        const boot = /^btime[ \t]+(\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1];
        const ticks = Number(startTime);
        const bootSeconds = Number(boot);

        if (
            boot === undefined ||
            !Number.isSafeInteger(ticks) ||
            !Number.isSafeInteger(bootSeconds)
        ) {
            return undefined;
        }

        const started = (bootSeconds + ticks / ticksPerSecond()) * 1000;

        // A future estimate can indicate a clock change or an incorrect fallback tick rate.
        return Number.isFinite(started) && started <= Date.now() ? started : undefined;
    } catch {
        return undefined;
    }
}

function readIdentity(lockFile: string, lock: Lock): Identity | undefined {
    try {
        const value = JSON.parse(readFileSync(`${lockFile}.identity`, "utf8")) as Identity;

        if (
            value?.version === 1 &&
            value.pid === lock.pid &&
            value.fileId === lock.fileId &&
            (value.startTime === undefined ||
                (typeof value.startTime === "string" && /^\d+$/.test(value.startTime))) &&
            (value.bootId === undefined ||
                (typeof value.bootId === "string" &&
                    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.bootId)))
        ) {
            return value;
        }
    } catch {
        // Missing, damaged, or old metadata cannot establish that a live holder is stale.
    }

    return undefined;
}

function lockHolder(lockFile: string, lock: Lock): boolean {
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) {
        // Protect exclusive creation's short publication window, but recover old damage after an unattended crash.
        if (Date.now() - lock.mtimeMs < INCOMPLETE_LOCK_GRACE_MS) {
            throw new Error(
                `Pi Pocket's lock is incomplete or damaged and still recent: ${lockFile}. Try again shortly.`,
            );
        }

        return false;
    }

    try {
        process.kill(lock.pid, 0);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            return false;
        }

        // EPERM and other uncertain failures are not evidence that the holder has stopped.
    }

    const saved = readIdentity(lockFile, lock);
    const current = processIdentity(lock.pid);

    if (saved !== undefined) {
        if (
            (saved.startTime !== undefined &&
                current.startTime !== undefined &&
                saved.startTime !== current.startTime) ||
            (saved.bootId !== undefined &&
                current.bootId !== undefined &&
                saved.bootId !== current.bootId)
        ) {
            return false;
        }
    }

    if (saved?.startTime === undefined) {
        const started = processStartMs(current.startTime);

        if (started !== undefined && started > lock.mtimeMs + PROCESS_START_MARGIN_MS) {
            // A process that began clearly after this lock was written cannot be its holder.
            return false;
        }
    }

    // Keep live holders when evidence is missing or too close in time, regardless of their executable name.
    return true;
}

/** Check the file generation before cleanup. This is not an atomic compare-and-unlink operation. */
function release(lockFile: string, owned: Lock): void {
    const current = readLock(lockFile);

    if (
        current === undefined ||
        !Object.is(current.pid, owned.pid) ||
        current.fileId !== owned.fileId
    ) {
        return;
    }

    try {
        rmSync(`${lockFile}.identity`, { force: true });
    } finally {
        rmSync(lockFile, { force: true });
    }
}

/**
 * Keep the lock pid-only for older readers. Linux identity is in a sidecar bound to this lock file, so metadata
 * left by an older release cannot falsely identify a new lock after pid reuse. Return this acquisition's cleanup.
 */
export function takeLock(lockFile: string): () => void {
    const previous = readLock(lockFile);

    if (previous !== undefined) {
        if (lockHolder(lockFile, previous)) {
            throw new Error(
                `Pi Pocket is already running on this data directory (pid ${previous.pid}). If it is not, delete ${lockFile}.`,
            );
        }

        release(lockFile, previous);
    }

    try {
        writeFileSync(lockFile, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
        }

        throw new Error(
            "Pi Pocket is already running on this data directory: another one started at the same moment.",
        );
    }

    const owned = readLock(lockFile)!;

    try {
        const identity: Identity = {
            version: 1,
            pid: owned.pid,
            fileId: owned.fileId,
            ...processIdentity(process.pid),
        };

        writeFileSync(`${lockFile}.identity`, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
    } catch (error) {
        release(lockFile, owned);

        throw error;
    }

    return () => release(lockFile, owned);
}
