/**
 * Pi's compaction settings for Pi Durable, with each model's own thresholds: Pi's `compaction.modelOverrides`, keyed
 * by `provider/modelId`, resolved by Pi itself (its checks, project over user settings).
 *
 * `compaction.pruneToolOutput` (default on) turns the pruner on and off: when compaction selects the messages to
 * summarise, they are first replaced by a deterministic note in which old tool results are masked, and the LLM
 * summary runs only if that note would still leave the context over its limit (`pruner.ts`).
 * `compaction.pruneKeepLast` (default 2) is how many of the range's tool results the note keeps in full.
 */
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { CompactionPolicy, CompactionSettings } from "@earendil-works/pi-durable";
import { describe } from "./errors.ts";

/** The model names that Pi's settings (user and project, merged) give compaction values of their own. */
function overridden(settings: SettingsManager): string[] {
    return Object.keys(settings.getSettings().compaction?.modelOverrides ?? {});
}

const FIELDS = ["reserveTokens", "keepRecentTokens"] as const;

const whole = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Pi's general values; one that Pi refuses is left out, not all of them. */
function readGeneral(
    settings: SettingsManager,
    once: (message: string) => void,
): Partial<CompactionPolicy> {
    try {
        return settings.getCompactionSettings();
    } catch {
        const general: Partial<CompactionPolicy> = { enabled: settings.getCompactionEnabled() };

        for (const field of FIELDS) {
            try {
                general[field] =
                    field === "reserveTokens"
                        ? settings.getCompactionReserveTokens()
                        : settings.getCompactionKeepRecentTokens();
            } catch (error) {
                once(`Pi's compaction.${field} is left out: ${describe(error)}`);
            }
        }

        return general;
    }
}

/**
 * What Pi Durable compacts by, read afresh at each call: Pi's settings, and for each model with values of its own,
 * those. A value Pi refuses is left out and reported once through `warn`, so the others still count: a general value
 * falls back to Pi Durable's own, and an override that is refused (not a whole number, or a name with no provider) goes
 * whole.
 */
export function compactionReader(
    settings: SettingsManager,
    warn: (message: string) => void,
): () => CompactionSettings {
    const warned = new Set<string>();

    const once = (message: string) => {
        if (!warned.has(message)) {
            warned.add(message);
            warn(message);
        }
    };

    return () => {
        const general = readGeneral(settings, once);
        const modelOverrides: Record<string, Partial<CompactionPolicy>> = {};

        for (const name of overridden(settings)) {
            try {
                const slash = name.indexOf("/");
                const entry = settings.getSettings().compaction?.modelOverrides?.[name];

                if (slash <= 0) {
                    throw new Error("the name must be provider/modelId");
                }

                if (typeof entry !== "object" || entry === null) {
                    throw new Error("expected an object");
                }

                const own: Partial<CompactionPolicy> = {};

                for (const field of FIELDS) {
                    const value = entry[field] ?? general[field];

                    if (value === undefined) {
                        continue;
                    }

                    if (!whole(value)) {
                        throw new Error(
                            `${field} ${JSON.stringify(value)} is not a non-negative integer`,
                        );
                    }

                    own[field] = value;
                }

                modelOverrides[name] = own;
            } catch (error) {
                once(
                    `Pi's compaction.modelOverrides[${JSON.stringify(name)}] is left out: ${describe(error)}`,
                );
            }
        }

        return Object.keys(modelOverrides).length === 0 ? general : { ...general, modelOverrides };
    };
}

/**
 * Pi's settings reader has no key for Pi Durable's background compaction, so it would always start 32768 tokens before
 * the limit. `compaction.backgroundTokens` in Pi's settings sets it; 0 turns it off, which suits a local model that
 * serves one request at a time (a background summary only waits behind the turn it was meant to overlap).
 */
export function withBackground<T extends object>(
    base: T,
    settings: Pick<SettingsManager, "getSettings">,
): T & { backgroundTokens?: number } {
    let background: unknown;

    try {
        background = (settings.getSettings() as { compaction?: { backgroundTokens?: unknown } })
            .compaction?.backgroundTokens;
    } catch {
        return base;
    }

    return whole(background) ? { ...base, backgroundTokens: background } : base;
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
