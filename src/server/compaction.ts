/**
 * Compaction settings for Pi Durable, from Pi's settings. Pi's settings reader has no key for Pi Durable's
 * background compaction, so it would always start 32768 tokens before the limit. `compaction.backgroundTokens` in
 * Pi's settings sets it; 0 turns it off, which suits a local model that serves one request at a time (a background
 * summary only waits behind the turn it was meant to overlap).
 */
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

type CompactionSettings = ReturnType<SettingsManager["getCompactionSettings"]> & {
    backgroundTokens?: number;
};

export function compactionSettings(
    settings: Pick<SettingsManager, "getCompactionSettings" | "getSettings">,
): Partial<CompactionSettings> {
    let base: Partial<CompactionSettings> = {};
    let background: unknown;

    try {
        base = settings.getCompactionSettings();
        background = (settings.getSettings() as { compaction?: { backgroundTokens?: unknown } })
            .compaction?.backgroundTokens;
    } catch {
        // Unreadable settings: Pi Durable's defaults.
    }

    return typeof background === "number" && Number.isSafeInteger(background) && background >= 0
        ? { ...base, backgroundTokens: background }
        : base;
}
