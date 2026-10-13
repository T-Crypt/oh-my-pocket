/**
 * Compaction settings for Pi Durable, from Pi's settings. Pi's settings reader has no key for Pi Durable's
 * background compaction, so it would always start 32768 tokens before the limit. `compaction.backgroundTokens` in
 * Pi's settings sets it; 0 turns it off, which suits a local model that serves one request at a time (a background
 * summary only waits behind the turn it was meant to overlap.
 *
 * `compaction.pruneToolOutput` (default on) turns the pruner on and off: when compaction selects the messages to
 * summarise, they are first replaced by a deterministic note in which old tool results are masked, and the LLM
 * summary runs only if that note would still leave the context over its limit (`pruner.ts`).
 * `compaction.pruneKeepLast` (default 2) is how many of the range's tool results the note keeps in full.
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

/** How the pruner behaves when Pi's settings say nothing, or say something invalid. */
export const PRUNE_DEFAULTS = { pruneToolOutput: true, pruneKeepLast: 2 } as const;

/** The most tool results the note may keep in full: more is a summary, not a prune. */
export const PRUNE_KEEP_LAST_MAX = 10;

export type PruneSettings = { pruneToolOutput: boolean; pruneKeepLast: number };

/** `compaction.pruneToolOutput` and `compaction.pruneKeepLast` from Pi's settings, with the defaults. */
export function pruneSettings(settings: Pick<SettingsManager, "getSettings">): PruneSettings {
    let compaction: unknown;

    try {
        compaction = (settings.getSettings() as { compaction?: unknown }).compaction;
    } catch {
        return { ...PRUNE_DEFAULTS };
    }

    const block = (compaction ?? {}) as { pruneToolOutput?: unknown; pruneKeepLast?: unknown };
    const enabled =
        typeof block.pruneToolOutput === "boolean"
            ? block.pruneToolOutput
            : PRUNE_DEFAULTS.pruneToolOutput;
    const keepLast =
        typeof block.pruneKeepLast === "number" &&
        Number.isSafeInteger(block.pruneKeepLast) &&
        block.pruneKeepLast >= 0 &&
        block.pruneKeepLast <= PRUNE_KEEP_LAST_MAX
            ? block.pruneKeepLast
            : PRUNE_DEFAULTS.pruneKeepLast;

    return { pruneToolOutput: enabled, pruneKeepLast: keepLast };
}
