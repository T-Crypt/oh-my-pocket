/**
 * Settings that extension modules declare (`web.settings`, since 0.22.0, experimental): each module says what it can be
 * set to, core keeps the owner's values in config.json (`extensionSettings`) and shows them in the Extensions sheet, and
 * the module reads them with `web.setting`. A value the owner never set has the field's default. A secret field's value
 * stays on the server: browsers learn only whether it is set.
 */

type Base = { name: string; label: string; description?: string };

/** One setting a module declares. */
export type SettingField =
    | (Base & { type: "boolean"; default?: boolean })
    | (Base & { type: "text"; default?: string; placeholder?: string; secret?: boolean })
    | (Base & { type: "number"; default?: number; min?: number; max?: number })
    | (Base & { type: "choice"; default?: string; choices: { value: string; label: string }[] });

export type SettingValue = string | number | boolean;

/** The most settings one module declares, and the longest text value. */
export const MAX_SETTINGS = 30;
export const MAX_SETTING_TEXT = 4096;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

function line(value: unknown, what: string, max: number): string {
    if (
        typeof value !== "string" ||
        value.trim() === "" ||
        value.length > max ||
        /[\r\n]/.test(value)
    ) {
        throw new Error(`web.settings: ${what} is one line of 1 to ${max} characters`);
    }

    return value.trim();
}

/** What a module declares, checked: a mistake throws while the module loads, where its author sees it. */
export function checkSettings(fields: unknown): SettingField[] {
    if (!Array.isArray(fields) || fields.length === 0 || fields.length > MAX_SETTINGS) {
        throw new Error(`web.settings: give 1 to ${MAX_SETTINGS} settings`);
    }

    const out = fields.map((given: Record<string, unknown>): SettingField => {
        if (typeof given?.name !== "string" || !NAME.test(given.name)) {
            throw new Error(
                "web.settings: a name is letters, digits, and _, starting with a letter",
            );
        }

        const base: Base = {
            name: given.name,
            label: line(given.label, `${given.name}'s label`, 80),
            ...(given.description === undefined
                ? {}
                : { description: line(given.description, `${given.name}'s description`, 300) }),
        };

        // A secret is text: on another kind it would hide nothing, and the value would reach every browser.
        if (given.secret !== undefined && given.type !== "text") {
            throw new Error(`web.settings: ${given.name} is secret only as text`);
        }

        switch (given.type) {
            case "boolean":
                if (given.default !== undefined && typeof given.default !== "boolean") {
                    throw new Error(`web.settings: ${given.name}'s default is true or false`);
                }

                return {
                    ...base,
                    type: "boolean",
                    ...(given.default === undefined ? {} : { default: given.default }),
                };

            case "text":
                if (given.default !== undefined && typeof given.default !== "string") {
                    throw new Error(`web.settings: ${given.name}'s default is text`);
                }

                return {
                    ...base,
                    type: "text",
                    ...(given.default === undefined ? {} : { default: given.default }),
                    ...(given.placeholder === undefined
                        ? {}
                        : {
                              placeholder: line(
                                  given.placeholder,
                                  `${given.name}'s placeholder`,
                                  80,
                              ),
                          }),
                    ...(given.secret === true ? { secret: true } : {}),
                };

            case "number": {
                for (const key of ["default", "min", "max"] as const) {
                    if (given[key] !== undefined && !Number.isFinite(given[key])) {
                        throw new Error(`web.settings: ${given.name}'s ${key} is a number`);
                    }
                }

                const { min, max } = given as { min?: number; max?: number };
                const dflt = given.default as number | undefined;

                // A range no value fits, or a default outside it, would leave nothing the owner can save.
                if (min !== undefined && max !== undefined && min > max) {
                    throw new Error(`web.settings: ${given.name}'s min is more than its max`);
                }

                if (
                    dflt !== undefined &&
                    ((min !== undefined && dflt < min) || (max !== undefined && dflt > max))
                ) {
                    throw new Error(`web.settings: ${given.name}'s default is outside its range`);
                }

                return {
                    ...base,
                    type: "number",
                    ...(given.default === undefined ? {} : { default: given.default as number }),
                    ...(given.min === undefined ? {} : { min: given.min as number }),
                    ...(given.max === undefined ? {} : { max: given.max as number }),
                };
            }

            case "choice": {
                const choices = given.choices;

                if (!Array.isArray(choices) || choices.length === 0 || choices.length > 50) {
                    throw new Error(`web.settings: ${given.name} has 1 to 50 choices`);
                }

                const checked = choices.map((choice: { value?: unknown; label?: unknown }) => ({
                    value: line(choice?.value, `a choice of ${given.name}`, 80),
                    label: line(choice?.label, `a choice of ${given.name}'s label`, 80),
                }));

                if (
                    given.default !== undefined &&
                    !checked.some((choice) => choice.value === given.default)
                ) {
                    throw new Error(`web.settings: ${given.name}'s default is one of its choices`);
                }

                return {
                    ...base,
                    type: "choice",
                    choices: checked,
                    ...(given.default === undefined ? {} : { default: given.default as string }),
                };
            }

            default:
                throw new Error(
                    `web.settings: ${given.name}'s type is boolean, text, number, or choice`,
                );
        }
    });

    if (new Set(out.map((field) => field.name)).size !== out.length) {
        throw new Error("web.settings: two settings have the same name");
    }

    return out;
}

/** A setting's value: the owner's, when it still fits the field, else its default. */
export function settingValue(
    field: SettingField,
    stored: Record<string, SettingValue>,
): SettingValue | undefined {
    const value = stored[field.name];

    try {
        return value === undefined ? field.default : checkValue(field, value);
    } catch {
        // A value from an older version of the module that no longer fits: the default, until the owner sets it again.
        return field.default;
    }
}

function checkValue(field: SettingField, value: unknown): SettingValue {
    switch (field.type) {
        case "boolean":
            if (typeof value !== "boolean") {
                throw new Error(`${field.label} is on or off.`);
            }

            return value;

        case "text":
            if (
                typeof value !== "string" ||
                value.length > MAX_SETTING_TEXT ||
                value.includes("\0")
            ) {
                throw new Error(`${field.label} is text of up to ${MAX_SETTING_TEXT} characters.`);
            }

            return value;

        case "number":
            if (
                typeof value !== "number" ||
                !Number.isFinite(value) ||
                (field.min !== undefined && value < field.min) ||
                (field.max !== undefined && value > field.max)
            ) {
                throw new Error(
                    `${field.label} is a number${field.min === undefined ? "" : ` from ${field.min}`}${field.max === undefined ? "" : ` to ${field.max}`}.`,
                );
            }

            return value;

        case "choice":
            if (
                typeof value !== "string" ||
                !field.choices.some((choice) => choice.value === value)
            ) {
                throw new Error(`${field.label} is one of its choices.`);
            }

            return value;
    }
}

/**
 * The owner's change to a module's settings, checked: each named field set to a value that fits it, or to null to put
 * its default back. A secret left out keeps its value. What is not one of the fields is refused.
 */
export function changeSettings(
    fields: readonly SettingField[],
    stored: Record<string, SettingValue>,
    change: unknown,
): Record<string, SettingValue> {
    if (typeof change !== "object" || change === null || Array.isArray(change)) {
        throw new Error("Send the settings as an object.");
    }

    const next = { ...stored };

    for (const [name, value] of Object.entries(change)) {
        const field = fields.find((each) => each.name === name);

        if (field === undefined) {
            throw new Error(`${name} is not one of this module's settings.`);
        }

        if (value === null) {
            delete next[name];
        } else {
            next[name] = checkValue(field, value);
        }
    }

    // What the module no longer declares goes.
    for (const name of Object.keys(next)) {
        if (!fields.some((field) => field.name === name)) {
            delete next[name];
        }
    }

    return next;
}

/** The settings as a browser sees them: secrets only as whether they are set. */
export function shownSettings(
    fields: readonly SettingField[],
    stored: Record<string, SettingValue>,
    withSecrets: boolean,
): { fields: SettingField[]; values: Record<string, SettingValue | null>; set: string[] } {
    const values: Record<string, SettingValue | null> = {};
    const set: string[] = [];

    for (const field of fields) {
        if (stored[field.name] !== undefined) {
            set.push(field.name);
        }

        if (field.type === "text" && field.secret === true && !withSecrets) {
            continue;
        }

        values[field.name] = settingValue(field, stored) ?? null;
    }

    // A secret's default is a secret too (it may come from the server's environment): browsers get neither.
    const shown = fields.map((field) => {
        if (field.type === "text" && field.secret === true && !withSecrets) {
            const { default: _default, ...rest } = field;

            return rest;
        }

        return { ...field };
    });

    return { fields: shown, values, set };
}
