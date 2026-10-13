/**
 * Which models a session's subagents may run on, the session's own model aside: its person's choice, per session
 * (`SubagentPolicyDoc`), on top of the models the owner allows everywhere (`subagentModels`).
 *
 * - `auto`, the default: the models of the agent definitions on the session's own provider. A session on a local
 *   server starts its roles on their local models; a session on a cloud model runs them on its own model.
 * - `own`: none. Every subagent runs on the session's model.
 * - `local`: the models of every agent definition.
 * - `custom`: the models listed, as `provider/modelId`.
 *
 * A definition whose model is not allowed still starts, on the session's model: its role and tools, not its model.
 */
import type { ModelRef } from "@earendil-works/pi-durable";
import type { AgentDefinition } from "./agents.ts";

export const SUBAGENT_MODES = ["auto", "own", "local", "custom"] as const;
export type SubagentMode = (typeof SUBAGENT_MODES)[number];
export type SubagentPolicy = { mode: SubagentMode; models?: string[]; by?: string; at?: number };

/** `provider/modelId`. */
export const keyOf = (ref: ModelRef) => `${ref.provider}/${ref.modelId}`;

/** A definition's model as a reference: undefined when it names none, or one that cannot be resolved now. */
export function definitionModel(
    definition: AgentDefinition,
    resolve: (spec: string) => ModelRef,
): ModelRef | undefined {
    if (definition.model === undefined) {
        return undefined;
    }

    try {
        return resolve(definition.model);
    } catch {
        // Not signed in, or gone: a `provider/modelId` still says which provider it is on.
        const slash = definition.model.indexOf("/");

        return slash > 0
            ? {
                  provider: definition.model.slice(0, slash),
                  modelId: definition.model.slice(slash + 1),
              }
            : undefined;
    }
}

/** The models a policy allows besides the session's own and the owner's, as `provider/modelId`, each once. */
export function policyModels(
    policy: SubagentPolicy | undefined,
    own: ModelRef | undefined,
    definitions: readonly AgentDefinition[],
    resolve: (spec: string) => ModelRef,
): string[] {
    const mode = policy?.mode ?? "auto";

    if (mode === "own") {
        return [];
    }

    if (mode === "custom") {
        return [...new Set(policy?.models ?? [])];
    }

    const models = definitions
        .map((definition) => definitionModel(definition, resolve))
        .filter(
            (ref): ref is ModelRef =>
                ref !== undefined && (mode === "local" || ref.provider === own?.provider),
        );

    return [...new Set(models.map(keyOf))];
}

/** What a policy comes to in a word, for the message box's chip: `auto` says which way it went. */
export function policyLabel(mode: SubagentMode, allowed: readonly string[]): string {
    if (mode === "auto") {
        return allowed.length === 0 ? "auto · own" : "auto · local";
    }

    return mode;
}
