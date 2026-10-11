/**
 * Today: the one line of the system prompt that changes on its own, so it has its own extension, installed last,
 * behind every stable section. A provider caches the prompt byte for byte from its start; with the day behind
 * everything, the once-a-day flip re-prefills that one short line, not the pack. Sessions take the `today`
 * section; PiP, in its own time zone, takes `pip_today`. The other renders nothing in a conversation that is not
 * its own.
 */
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export default function createToday(host: PocketHost) {
    return defineExtension({
        name: "pocket-today",
        sections: [
            section(
                "today",
                (input) =>
                    host.pip.ownerOf(input.conversationId) === undefined
                        ? `Today: ${new Date().toISOString().slice(0, 10)}`
                        : undefined,
            ),
            section(
                "pip_today",
                (input) =>
                    host.pip.ownerOf(input.conversationId) === undefined
                        ? undefined
                        : `Today: ${new Date().toLocaleDateString("en-CA", { timeZone: zone })}`,
            ),
        ],
    });
}
