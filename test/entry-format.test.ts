// The names stored entries and the web app depend on: the entry kinds and the markers written into message text. The
// first test is a contract, not a behavior check: it pins values that already-stored data cannot change. The other two
// run the code that reads those names back, so a changed value fails there too.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
    ATTACHMENTS_HEADING,
    FILE_BLOCK,
    FROM_PI_ENTRY,
    FROM_PREFIX,
    NOTE_ENTRY,
    SHELL_ENTRY,
} from "../src/server/entry-format.ts";

test("the entry kinds stored data depends on are these names", () => {
    assert.equal(NOTE_ENTRY, "pocket.note");
    assert.equal(SHELL_ENTRY, "pocket.shell");
    assert.equal(FROM_PI_ENTRY, "pocket.from-pi");
    assert.equal(FILE_BLOCK, '<file name="');
    assert.equal(ATTACHMENTS_HEADING, "\n\nAttached files (saved on the server):\n");
});

test("the [from: …] prefix reads a person's name from a message line", () => {
    assert.equal(FROM_PREFIX.exec("[from: Ada] read the file")?.[1], "Ada");
    assert.equal(FROM_PREFIX.exec("[from: Ada] read the file")?.[0], "[from: Ada] ");
    assert.equal(FROM_PREFIX.exec("[from: Ada]read the file"), null);
    assert.equal(FROM_PREFIX.exec("[from: ] Ada"), null);
    assert.equal(FROM_PREFIX.exec("[from: A]da] hi"), null);
    assert.equal(FROM_PREFIX.exec("[from: Ada]\nhi"), null);
    assert.equal(FROM_PREFIX.exec("hello [from: Ada] there"), null);
    assert.equal(FROM_PREFIX.exec(`[from: ${"a".repeat(60)}] hi`)?.[1], "a".repeat(60));
    assert.equal(FROM_PREFIX.exec(`[from: ${"a".repeat(61)}] hi`), null);
    assert.equal("[from: Ada] read the file".replace(FROM_PREFIX, ""), "read the file");
});

test("a message with attached files splits into what was written and the file list", () => {
    const message = "hello\n\nAttached files (saved on the server):\nnotes.md";
    const parts = message.split(ATTACHMENTS_HEADING);

    assert.equal(parts[0], "hello");
    assert.equal(parts[1], "notes.md");
    assert.equal("hello".split(ATTACHMENTS_HEADING).length, 1);

    const block = '<file name="notes.md">\nthe file\n</file>';

    assert.equal(block.startsWith(FILE_BLOCK), true);
    assert.equal(block.slice(FILE_BLOCK.length, block.indexOf('">')), "notes.md");
});
