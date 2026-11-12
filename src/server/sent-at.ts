/**
 * The clock the model reads: today's date with the rules that go with it, and the time each person's message was sent.
 * A local model's training ends months before today, and a bare date at the top of a long prompt does not stop it
 * from offering last year's commands, versions, and keys as current; the time next to each message, and a rule saying
 * what to do with it, does. Both are rendered from stored facts (the server's day, each message's own timestamp), so
 * every request repeats the one before byte for byte and the provider's prompt cache stays warm.
 */
import type { Message } from "@earendil-works/pi-ai";

/** The server's time zone: dates and times the model sees are in it, and say so. */
export const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The stamp at the end of a message as the model gets it; never stored, so the web app never shows it. */
export const SENT_STAMP = /\n\n\[sent [^\]\n]{1,60}\]$/;

/** `2026-10-29 (Thursday)` in `zone`. */
export function dayOf(at: number, zone = ZONE): string {
    const date = new Date(at).toLocaleDateString("en-CA", { timeZone: zone });
    const weekday = new Date(at).toLocaleDateString("en-US", { timeZone: zone, weekday: "long" });

    return `${date} (${weekday})`;
}

/** `Thu 2026-10-29 14:05 MDT` in `zone`. */
export function momentOf(at: number, zone = ZONE): string {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
    }).formatToParts(new Date(at));
    const part = (type: string) => parts.find((each) => each.type === type)?.value ?? "";
    const date = new Date(at).toLocaleDateString("en-CA", { timeZone: zone });

    return `${part("weekday")} ${date} ${part("hour")}:${part("minute")} ${part("timeZoneName")}`;
}

/** The system prompt's last section: the date, and how to weigh what the model remembers against it. */
export function todayText(at: number, zone = ZONE): string {
    return `Today: ${dayOf(at, zone)}, ${zone}. Each person's message ends with [sent ...], the time it was sent; this clock is right.
Your training data ends well before today, so what you remember may be out of date: versions, commands, package names, signing keys, URLs, docs.
- Check those on this machine (--version, the package manager, man pages) or in a current source before relying on them.
- When you search, use the current year. Compare each result's date with today; when it is old, archived, or replaced, say so in one line and use the newer source.`;
}

/**
 * The messages of one request, each person's message ending with the time it was sent. Only user messages with a
 * timestamp get one; a message that already ends with a stamp is left as it is.
 */
export function stampMessages(messages: readonly Message[], zone = ZONE): Message[] {
    return messages.map((message) => {
        if (message.role !== "user" || !(message.timestamp > 0)) {
            return message;
        }

        const stamp = `\n\n[sent ${momentOf(message.timestamp, zone)}]`;

        if (typeof message.content === "string") {
            return SENT_STAMP.test(message.content)
                ? message
                : { ...message, content: message.content + stamp };
        }

        const last = message.content.at(-1);

        if (last?.type === "text") {
            return SENT_STAMP.test(last.text)
                ? message
                : {
                      ...message,
                      content: [
                          ...message.content.slice(0, -1),
                          { ...last, text: last.text + stamp },
                      ],
                  };
        }

        // A message that ends with an image: the stamp is a text part of its own.
        return { ...message, content: [...message.content, { type: "text", text: stamp }] };
    });
}
