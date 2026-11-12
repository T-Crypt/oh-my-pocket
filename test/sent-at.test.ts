// The model's clock: the system prompt ends with today's date and the rule for weighing what the model remembers
// against it, and each person's message reaches the model ending with the time it was sent. The stamp comes from the
// message's own timestamp and is never stored, so a later request repeats the earlier messages byte for byte and the
// stored conversation (and the web app) never shows it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Context, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { dayOf, momentOf, SENT_STAMP, stampMessages, todayText } from "../src/server/sent-at.ts";
import {
    type App,
    cleanUp,
    lastText,
    modelTexts,
    newSession,
    openApp,
    say,
    scriptedModel,
} from "./helpers.ts";

// 2026-10-29 20:05 UTC: a Thursday afternoon in Denver.
const AT = Date.UTC(2026, 9, 29, 20, 5);

test("dates and times are the server's zone's, and name it", () => {
    assert.equal(dayOf(AT, "America/Denver"), "2026-10-29 (Thursday)");
    assert.equal(momentOf(AT, "America/Denver"), "Thu 2026-10-29 14:05 MDT");
    // Late in the evening in Denver it is already tomorrow in UTC: the date is Denver's.
    assert.equal(dayOf(Date.UTC(2026, 9, 30, 3, 0), "America/Denver"), "2026-10-29 (Thursday)");
    assert.match(
        todayText(AT, "America/Denver"),
        /^Today: 2026-10-29 \(Thursday\), America\/Denver\./,
    );
    assert.match(todayText(AT, "America/Denver"), /use the current year/);
});

test("each person's message ends with the time it was sent; other messages are left alone", () => {
    const messages: Message[] = [
        { role: "user", content: "hello", timestamp: AT },
        {
            role: "user",
            content: [{ type: "image", data: "", mimeType: "image/png" }],
            timestamp: AT,
        },
        { role: "user", content: [{ type: "text", text: "look" }], timestamp: AT },
        { role: "user", content: "no time", timestamp: 0 },
    ];
    const [text, image, parts, untimed] = stampMessages(messages, "America/Denver");

    assert.equal(text!.content, "hello\n\n[sent Thu 2026-10-29 14:05 MDT]");
    assert.deepEqual((image!.content as { type: string }[]).at(-1), {
        type: "text",
        text: "\n\n[sent Thu 2026-10-29 14:05 MDT]",
    });
    assert.deepEqual(parts!.content, [
        { type: "text", text: "look\n\n[sent Thu 2026-10-29 14:05 MDT]" },
    ]);
    assert.equal(untimed, messages[3]);
    // Stamping twice changes nothing.
    assert.deepEqual(stampMessages(stampMessages(messages, "America/Denver"), "America/Denver"), [
        text,
        image,
        parts,
        untimed,
    ]);
});

// --- In the app --------------------------------------------------------------------

const requests: Context[] = [];
let app: App;

before(async () => {
    app = await openApp(
        scriptedModel((context) => {
            requests.push(structuredClone(context));

            return fauxAssistantMessage([fauxText(`echo: ${lastText(context as never).text}`)]);
        }),
    );
});

after(async () => {
    await app.close();
    cleanUp();
});

test("the model gets the clock; the stored conversation does not", async () => {
    const id = await newSession(app);

    await say(app, id, "first");
    await say(app, id, "second");

    const [one, two] = requests
        .slice(-2)
        .map((request) => request.messages.filter((message) => message.role === "user"));
    const texts = (messages: Message[]) =>
        messages.map((message) => lastText({ messages: [message] }));

    assert.ok(one !== undefined && two !== undefined);
    assert.deepEqual(
        texts(two).map((each) => each.text),
        ["first", "second"],
    );

    for (const message of two) {
        assert.match(JSON.stringify(message.content), /\[sent [^\]]+\]"/);
    }

    // The first message is sent again exactly as it was the first time: the prompt cache holds.
    assert.deepEqual(two[0], one.at(-1));

    const system = getCurrentSystemMessage(requests.at(-1)!.messages);

    assert.match(JSON.stringify(system), /Today: \d{4}-\d{2}-\d{2} \(\w+day\)/);
    assert.ok(!(await modelTexts(app, id)).some((text) => SENT_STAMP.test(JSON.parse(text))));
});
