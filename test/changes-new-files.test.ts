// New files' counts in Changes are read in this process, not with a git command per file: they must match what
// `git diff --no-index --numstat /dev/null <file>` says for every kind of file git can list as untracked.
import "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { changesIn } from "../src/server/changes.ts";

const root = mkdtempSync(join(tmpdir(), "changes-new-"));
const git = (...args: string[]) =>
    execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
    });

after(() => rmSync(root, { recursive: true, force: true }));

git("init", "-q");
git("config", "user.name", "Test");
git("config", "user.email", "test@example.invalid");
writeFileSync(join(root, "tracked.txt"), "one\n");
writeFileSync(join(root, ".gitattributes"), "*.dat binary\n*.nodiff -diff\n*.forced diff\n");
git("add", ".");
git("commit", "-qm", "base");

const FILES: Record<string, string | Buffer> = {
    "plain.txt": "a\nb\nc\n",
    "no-final-newline.txt": "a\nb",
    "empty.txt": "",
    "one-newline.txt": "\n",
    "crlf.txt": "a\r\nb\r\n",
    "only-cr.txt": "a\rb\r",
    "unicode.md": "héllo\nwörld ✓\n",
    "nul-early.bin": Buffer.from([65, 0, 66, 10]),
    "nul-late.txt": Buffer.concat([Buffer.alloc(9000, 65), Buffer.from([0, 10])]),
    "attr.dat": "text\nbut binary by attribute\n",
    "attr.nodiff": "x\ny\n",
    "attr.forced": Buffer.from([65, 0, 10, 66, 10]),
    "deep/dir/nested.ts": "export const a = 1;\n",
    "tab\tname.txt": "t\n",
};

for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
}

symlinkSync("plain.txt", join(root, "link-to-file"));
symlinkSync("does/not/exist", join(root, "dangling-link"));

/** What git itself says for one new file. */
function gitSays(path: string): { added?: number; removed?: number } {
    // Exit 1 means "they differ", which a new file always does.
    const out = spawnSync(
        "git",
        ["diff", "--no-index", "--numstat", "--no-ext-diff", "--no-textconv", "--", devNull, path],
        { cwd: root, encoding: "utf8" },
    ).stdout.trim();
    const [added, removed] = out.split("\t");

    return added === "-" || added === undefined
        ? {}
        : { added: Number(added), removed: Number(removed) };
}

test("every kind of new file counts as git counts it", async () => {
    const changes = await changesIn(root, []);
    const paths = [...Object.keys(FILES), "link-to-file", "dangling-link"];

    for (const path of paths) {
        const file = changes.files.find((each) => each.path === path);

        assert.ok(file, `${path} is listed`);
        assert.deepEqual(
            { added: file.added, removed: file.removed },
            { added: undefined, removed: undefined, ...gitSays(path) },
            path,
        );
    }
});

test("a changed file is counted again; an unchanged one keeps its count", async () => {
    await changesIn(root, []);
    writeFileSync(join(root, "plain.txt"), "a\nb\nc\nd\ne\n");
    // The same size as before would still differ by time: make the time move for certain.
    utimesSync(join(root, "plain.txt"), new Date(), new Date(Date.now() + 5000));

    const changes = await changesIn(root, []);

    assert.equal(changes.files.find((each) => each.path === "plain.txt")?.added, 5);
    assert.equal(changes.files.find((each) => each.path === "empty.txt")?.added, 0);
});
