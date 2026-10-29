/**
 * Today: the date, how to weigh what the model remembers against it, and the time on each message. The date is the
 * one part of the system prompt that changes on its own, so it has its own extension, installed last, behind every
 * stable section. A provider caches the prompt byte for byte from its start; with the day behind everything, the
 * once-a-day flip re-prefills that one short section, not the pack. Sessions take the `today` section; PiP takes
 * `pip_today`. The other renders nothing in a conversation that is not its own. Both are in the server's time zone,
 * which they name. The time on each message comes from its own timestamp (`sent-at.ts`), so it is the same on every
 * request.
 */
import { defineExtension, GenerationTask, hook, section } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";
import { stampMessages, todayText } from "../sent-at.ts";

export default function createToday(host: PocketHost) {
    return defineExtension({
        name: "pocket-today",
        sections: [
            section("today", (input) =>
                host.pip.ownerOf(input.conversationId) === undefined
                    ? todayText(Date.now())
                    : undefined,
            ),
            section("pip_today", (input) =>
                host.pip.ownerOf(input.conversationId) === undefined
                    ? undefined
                    : todayText(Date.now()),
            ),
        ],
        hooks: [
            hook(GenerationTask, {
                beforeRequest: (request) => ({ messages: stampMessages(request.messages) }),
            }),
        ],
    });
}
