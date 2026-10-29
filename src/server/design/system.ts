/**
 * The project's design system (stream D of design mode): a Markdown file at `<session folder>/.pi/design-system.md`
 * that Pi writes after it reads the codebase or the brand files the person points at, and that guide.ts puts into the
 * prompt before Pi makes a design. The `design_system` tool reads and writes that file.
 *
 * The file is bounded UTF-8 text. A write never follows a symlink to the file itself and replaces it atomically: the
 * new bytes go to a temporary file next to it, and a rename puts them in place. A read never follows a symlink either.
 */
import { randomUUID } from "node:crypto";
import {
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";

/** The file's path, in the session's working directory. */
export const SYSTEM_FILE = join(".pi", "design-system.md");

/** The file's size limit, in bytes: tokens and rules stay short enough to sit in a prompt. */
export const MAX_BYTES = 16_384;

const file = (cwd: string) => join(cwd, SYSTEM_FILE);

function systemDirectory(cwd: string): boolean {
    try {
        const info = lstatSync(join(cwd, ".pi"));

        if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new Error("The project's .pi folder must be a directory, not a symlink.");
        }

        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return false;
        }

        throw error;
    }
}

/**
 * Where `end` leaves a whole UTF-8 sequence after it: it walks back over continuation bytes and then a lead byte whose
 * sequence the kept bytes complete. Text cut this way has no replacement character at its last character.
 */
export function utf8Cut(bytes: Buffer, end: number): number {
    let back = 0;

    if (end <= 0) {
        return 0;
    }

    while (back < 3 && end - back - 1 >= 0 && (bytes[end - back - 1]! & 0xc0) === 0x80) {
        back++;
    }

    const at = end - back - 1;

    // Only continuation bytes on the way back: the start of the text is one broken sequence, so keep none of it.
    if (at < 0) {
        return 0;
    }

    const lead = bytes[at]!;
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;

    return need <= back + 1 ? end : at;
}

/** The bounded text of bytes: at most `max` bytes, cut without a broken character at the end. */
export function boundedText(bytes: Buffer, max: number): { text: string; truncated: boolean } {
    const kept = bytes.length > max ? utf8Cut(bytes, max) : bytes.length;

    return {
        text: bytes.subarray(0, Math.max(0, kept)).toString("utf8"),
        truncated: bytes.length > kept,
    };
}

/** The file's text, bounded, or undefined when there is no file. It never follows a symlink to the file. */
export function readDesignSystemText(
    cwd: string,
): { text: string; truncated: boolean } | undefined {
    if (!systemDirectory(cwd)) {
        return undefined;
    }

    const path = file(cwd);
    let stats;

    try {
        stats = lstatSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }

        throw error;
    }

    if (!stats.isFile()) {
        throw new Error(
            `${SYSTEM_FILE} must be a regular file, not a directory, device, or symlink.`,
        );
    }

    // O_NOFOLLOW closes the window between the lstat and this open, where a symlink could appear.
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

    try {
        if (!fstatSync(fd).isFile()) {
            throw new Error(`${SYSTEM_FILE} must be a regular file.`);
        }

        // Read at most the limit, so a stray large file is no more work than a bounded one.
        const head = Buffer.alloc(MAX_BYTES + 4);
        let size = 0;

        while (size < head.length) {
            const read = readSync(fd, head, size, head.length - size, null);

            if (read <= 0) {
                break;
            }

            size += read;
        }

        if (size === 0) {
            return { text: "", truncated: false };
        }

        return boundedText(head.subarray(0, size), MAX_BYTES);
    } finally {
        closeSync(fd);
    }
}

/** Replaces the file with `content`, atomically, and returns its size in bytes. */
export function writeDesignSystemText(cwd: string, content: string): number {
    const bytes = Buffer.from(content, "utf8");

    if (bytes.length > MAX_BYTES) {
        throw new Error(
            `The design system is bounded text: ${MAX_BYTES} bytes at most (16 KB); the text is ${bytes.length}. Cut the design system down, or move components and rules into separate project files that the design system names.`,
        );
    }

    if (!systemDirectory(cwd)) {
        mkdirSync(join(cwd, ".pi"), { recursive: true });
    }

    systemDirectory(cwd);
    // A fresh name each time: only this write's temporary file, and none of an earlier one under the same name.
    const temp = join(cwd, ".pi", `.${randomUUID()}.tmp`);

    try {
        writeFileSync(temp, bytes, { flag: "wx" });
        // A rename replaces the final name whole on one file system: if the target was a symlink, the file takes its
        // place and no write ever follows the link.
        renameSync(temp, file(cwd));
    } finally {
        // The rename already removed it; a failed call may have left it there.
        rmSync(temp, { force: true });
    }

    return bytes.length;
}

/** The `design_system` tool: read the file, or replace it with `content`. */
export function designSystemTool(): ToolRegistration {
    return defineTool({
        name: "design_system",
        description: `The project's design system: ${SYSTEM_FILE} in the session's folder, with the design tokens as a fenced JSON block, then the components and rules for new designs. Use read before you make or change a design; use write (content replaces the file) after you read the codebase or the brand files the person points at.`,
        parameters: Type.Object({
            action: Type.Union([Type.Literal("read"), Type.Literal("write")], {
                description: "read the file, or write over it",
            }),
            content: Type.Optional(
                Type.String({
                    description: `write: the new file, up to ${MAX_BYTES} bytes`,
                }),
            ),
        }),
        // Not read-only: write changes the session's files. Not replay-safe either, on purpose: a call that a restart
        // stopped comes back interrupted instead of running and writing twice.
        execute: async (args, api, context) => {
            const { cwd } = await api.agent(context);

            if (cwd === undefined) {
                throw new Error(
                    "This session has no working directory, so the design system has no place.",
                );
            }

            if (args.action === "write") {
                if (args.content === undefined) {
                    throw new Error("write needs the new design system in content.");
                }

                const size = writeDesignSystemText(cwd, args.content);

                return {
                    output: [
                        {
                            type: "text" as const,
                            text: `Wrote ${SYSTEM_FILE} (${size} bytes). The next design request reads it.`,
                        },
                    ],
                };
            }

            const read = readDesignSystemText(cwd);

            if (read === undefined) {
                return {
                    output: [
                        {
                            type: "text" as const,
                            text: `There is no ${SYSTEM_FILE} in this session yet. Read the codebase or the brand files the person points at, then write the design system: the design tokens as a fenced JSON block, then the components and rules for new designs.`,
                        },
                    ],
                };
            }

            const size = Math.min(Buffer.byteLength(read.text, "utf8"), MAX_BYTES);

            return {
                output: [
                    {
                        type: "text" as const,
                        text: `Read ${SYSTEM_FILE} (${size} bytes${read.truncated ? `, cut at the ${MAX_BYTES}-byte limit` : ""}): the design system.\n\n${read.text}`,
                    },
                ],
            };
        },
    });
}
