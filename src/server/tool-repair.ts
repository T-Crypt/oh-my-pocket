/**
 * Lenient tool-call JSON: before the harness validates a call's arguments, repair the shapes a small model gets
 * wrong - an object or an array sent as a JSON string, and one item sent where a list belongs. The repair is pure,
 * and the result is still validated: what it cannot fix fails validation as before. The model's own JSON is already
 * repaired as it is parsed; this mends the structure after.
 */
import { parseJsonWithRepair } from "@earendil-works/pi-ai";

/** The shape of a TypeBox schema, as far as the repair looks. */
type Schema = {
    type?: string | readonly string[];
    properties?: Record<string, Schema>;
    items?: Schema | readonly Schema[];
    anyOf?: readonly Schema[];
    oneOf?: readonly Schema[];
};

const asSchema = (schema: unknown): Schema => (schema ?? {}) as Schema;

/** The branch a value must match: the schema's own, or any of its union members. */
const members = (schema: Schema): Schema[] =>
    Array.isArray(schema.anyOf)
        ? (schema.anyOf as Schema[])
        : Array.isArray(schema.oneOf)
          ? (schema.oneOf as Schema[])
          : [schema];

const kinds = (schema: Schema): string[] => {
    const types = schema.type;

    return typeof types === "string" ? [types] : Array.isArray(types) ? types : [];
};

const expects = (schema: Schema, kind: string): boolean =>
    members(schema).some((member) => kinds(member).includes(kind));

const parsedKind = (value: unknown): "object" | "array" | undefined =>
    Array.isArray(value)
        ? "array"
        : value !== null && typeof value === "object"
          ? "object"
          : undefined;

/** JSON that a model wrote with small errors (broken escapes, control characters); undefined when it is not JSON. */
function tryParse(text: string): unknown {
    try {
        return parseJsonWithRepair(text);
    } catch {
        return undefined;
    }
}

/**
 * `args` repaired to the shape `schema` describes, unchanged when it is none of the shapes that need mending. Pure:
 * never mutates `args`, and runs again when the call is retried, as the harness requires of this repair.
 */
export function repairToolArguments(args: unknown, schema: unknown): unknown {
    const shape = asSchema(schema);

    if (typeof args === "string") {
        const trimmed = args.trim();

        // Not a JSON container: a string, a path, a number - leave it; validation says if it fits.
        if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
            return args;
        }

        for (const member of members(shape)) {
            if (!expects(member, "object") && !expects(member, "array")) {
                continue;
            }

            const parsed = tryParse(trimmed);
            const kind = parsedKind(parsed);

            if (parsed === undefined || kind === undefined || !expects(member, kind)) {
                continue;
            }

            return repairToolArguments(parsed, member);
        }

        return args;
    }

    if (Array.isArray(args)) {
        return shape.type === "array" && shape.items !== undefined && !Array.isArray(shape.items)
            ? args.map((item) => repairToolArguments(item, shape.items!))
            : args;
    }

    if (typeof args !== "object" || args === null) {
        return args;
    }

    // One item where a list belongs, unambiguous only when a list is the only shape offered.
    if (expects(shape, "array") && !expects(shape, "object") && members(shape).length === 1) {
        return [args];
    }

    const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
    let changed = false;

    for (const member of members(shape)) {
        if (member.properties === undefined) {
            continue;
        }

        for (const [key, property] of Object.entries(member.properties)) {
            if (!(key in out)) {
                continue;
            }

            const repaired = repairProperty(out[key], property);

            if (repaired !== out[key]) {
                out[key] = repaired;
                changed = true;
            }
        }
    }

    return changed ? out : args;
}

/** One property's value, repaired against the property's schema. */
function repairProperty(value: unknown, property: Schema): unknown {
    if (typeof value === "string") {
        const trimmed = value.trim();

        if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
            return value;
        }

        for (const member of members(property)) {
            if (!expects(member, "object") && !expects(member, "array")) {
                continue;
            }

            const parsed = tryParse(trimmed);
            const kind = parsedKind(parsed);

            if (parsed === undefined || kind === undefined || !expects(member, kind)) {
                continue;
            }

            return repairToolArguments(parsed, member);
        }

        return value;
    }

    if (typeof value === "object" && value !== null) {
        if (!Array.isArray(value)) {
            if (expects(property, "array") && !expects(property, "object")) {
                return repairToolArguments([value], property);
            }

            if (expects(property, "object")) {
                return repairToolArguments(value, property);
            }
        } else if (
            property.type === "array" &&
            property.items !== undefined &&
            !Array.isArray(property.items)
        ) {
            return value.map((item) => repairToolArguments(item, property.items!));
        }
    }

    return value;
}
