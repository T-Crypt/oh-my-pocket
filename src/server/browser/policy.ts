/**
 * What Pi may do in the browser without asking a person first (`extensions/browser.ts`), decided from the owner's
 * settings and the sites a person allowed in the session. Pure: the tool asks and acts on what these say.
 */
import type { SettingField, SettingValue } from "../extension-settings.ts";

export type BrowserPolicy = {
    /** A public site the session has not been allowed yet. */
    sites: "ask" | "allow";
    /** Signing in, submitting a form, sending, buying, deleting. */
    actions: "ask" | "allow";
    /** Running JavaScript in the page. */
    scripts: "ask" | "never";
    /** This machine, the local network, the tailnet, and files. */
    local: "ask" | "allow" | "never";
    /** Never opened, whatever was allowed. */
    blocked: readonly string[];
    /** Opened without asking. */
    allowed: readonly string[];
};

export const POLICY_SETTINGS: readonly SettingField[] = [
    {
        name: "sites",
        label: "New websites",
        description:
            "Whether Pi asks before it opens a site that no one allowed in the session yet.",
        type: "choice",
        default: "ask",
        choices: [
            { value: "ask", label: "Ask first" },
            { value: "allow", label: "Allow" },
        ],
    },
    {
        name: "actions",
        label: "Sign-ins, forms, sending, buying, deleting",
        description:
            "Whether Pi asks before it clicks something that signs in, submits, sends, buys, or deletes, or presses Enter in such a form.",
        type: "choice",
        default: "ask",
        choices: [
            { value: "ask", label: "Ask first" },
            { value: "allow", label: "Allow" },
        ],
    },
    {
        name: "scripts",
        label: "Run JavaScript in pages",
        description: "Pi shows the script and asks each time, or may not run scripts at all.",
        type: "choice",
        default: "ask",
        choices: [
            { value: "ask", label: "Ask each time" },
            { value: "never", label: "Never" },
        ],
    },
    {
        name: "local",
        label: "This machine, the local network, and files",
        description:
            "localhost, private addresses (10.x, 192.168.x, 100.64.x), .local, .lan and tailnet names, and file paths: dev servers, but also routers and admin pages.",
        type: "choice",
        default: "ask",
        choices: [
            { value: "ask", label: "Ask first, per site" },
            { value: "allow", label: "Allow" },
            { value: "never", label: "Never" },
        ],
    },
    {
        name: "blocked",
        label: "Blocked sites",
        description: "Never opened. Comma-separated hosts; example.com covers its subdomains.",
        type: "text",
        default: "",
        placeholder: "bank.example, mail.example.com",
    },
    {
        name: "allowed",
        label: "Always allowed sites",
        description:
            "Opened without asking. Comma-separated hosts; example.com covers its subdomains.",
        type: "text",
        default: "",
        placeholder: "docs.example.com, localhost",
    },
];

const hosts = (value: SettingValue | undefined) =>
    typeof value === "string"
        ? value
              .split(/[\s,]+/)
              .map((host) => host.trim().toLowerCase().replace(/^\*\./, ""))
              .filter((host) => host !== "")
        : [];

const choice = <T extends string>(
    value: SettingValue | undefined,
    values: readonly T[],
    fallback: T,
) => (values.includes(value as T) ? (value as T) : fallback);

/** The owner's settings, each one that is missing or unknown at its default. */
export function policyFrom(setting: (name: string) => SettingValue | undefined): BrowserPolicy {
    return {
        sites: choice(setting("sites"), ["ask", "allow"], "ask"),
        actions: choice(setting("actions"), ["ask", "allow"], "ask"),
        scripts: choice(setting("scripts"), ["ask", "never"], "ask"),
        local: choice(setting("local"), ["ask", "allow", "never"], "ask"),
        blocked: hosts(setting("blocked")),
        allowed: hosts(setting("allowed")),
    };
}

/** An address as a site to allow: its host without `www.`, or `file` for files; undefined for a page Pi writes. */
export function siteOf(url: string): { site: string; local: boolean } | undefined {
    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        return undefined;
    }

    if (parsed.protocol === "file:") {
        return { site: "file", local: true };
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return undefined;
    }

    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

    return { site: host.replace(/^www\./, ""), local: isLocal(host) };
}

/** This machine, a private or link-local address, the tailnet, or a name only a local resolver knows. */
export function isLocal(host: string): boolean {
    // A name with no dot (proxmox, router) is one only a local resolver knows; an IPv6 address has colons instead.
    if (
        host === "localhost" ||
        (!host.includes(".") && !host.includes(":")) ||
        /\.(localhost|local|lan|home|internal|intranet|corp|ts\.net)$/.test(host)
    ) {
        return true;
    }

    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);

    if (v4 !== null) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];

        return (
            a === 10 ||
            a === 127 ||
            a === 0 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 169 && b === 254) ||
            (a === 100 && b >= 64 && b <= 127)
        );
    }

    // IPv6: loopback, unique local (fc00::/7), link-local (fe80::/10), and IPv4 mapped into it.
    return host.includes(":") && /^(::1$|f[cd]|fe[89ab]|::ffff:)/.test(host);
}

/** Whether a site is on a list: the same host, or one under a listed one. */
export function listed(site: string, list: readonly string[]): boolean {
    return list.some((entry) => {
        const host = entry.replace(/^www\./, "");

        return site === host || site.endsWith(`.${host}`);
    });
}

export type Verdict = { go: true } | { go: false; refuse: string } | { go: false; ask: string };

/** Whether Pi may work on a page at `url` now: go, ask a person first, or refuse. */
export function siteVerdict(
    url: string,
    policy: BrowserPolicy,
    allowedHere: readonly string[],
): Verdict {
    const found = siteOf(url);

    if (found === undefined) {
        return { go: true };
    }

    const { site, local } = found;

    if (listed(site, policy.blocked)) {
        return { go: false, refuse: `${site} is blocked in the browser's settings.` };
    }

    if (listed(site, policy.allowed) || allowedHere.includes(site)) {
        return { go: true };
    }

    if (local) {
        return policy.local === "allow"
            ? { go: true }
            : policy.local === "never"
              ? {
                    go: false,
                    refuse: `${site} is on this machine or the local network, which the browser's settings keep Pi from opening.`,
                }
              : { go: false, ask: site };
    }

    return policy.sites === "allow" ? { go: true } : { go: false, ask: site };
}

const RISKY =
    /\b(sign[\s-]?(in|up|on)|log[\s-]?(in|on)|register|submit|send|post|publish|buy|pay|purchase|order|check[\s-]?out|subscribe|delete|remove|erase|destroy|confirm|transfer|withdraw|book|reserve|donate|add to (cart|basket)|install|authori[sz]e|grant|accept)\b/i;

/** The word that makes a control's label one to ask about (sign in, submit, buy, delete, …), or undefined. */
export function riskyWord(label: string): string | undefined {
    return RISKY.exec(label)?.[0];
}

/**
 * For the page: whether Enter in the focused field would send a form worth asking about (one with a password field, or
 * whose submit control has a risky label), and whether that field is a password or payment field. A JSON string:
 * `page.evaluate` hands strings back as they are.
 */
export const FOCUS_SCRIPT = String.raw`(() => {
	const el = document.activeElement;
	if (!el) return JSON.stringify({});
	const secret = (field) => field && field.tagName === "INPUT" && (field.type === "password" || /^cc-/.test(field.autocomplete || ""));
	const form = el.form || el.closest?.("form");
	const submit = form ? [...form.querySelectorAll("button, input[type=submit]")].map((b) => (b.textContent || b.value || "").trim()).join(" ") : "";
	return JSON.stringify({ secret: secret(el), form: !!form, password: !!form?.querySelector("input[type=password]"), submit });
})()`;
