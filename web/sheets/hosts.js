// The owner's SSH hosts: other machines Pi may work on (bash, read, write and edit with `host`).
import { useState } from "preact/hooks";
import { api, attempt, closeSheet, notify, store } from "../store.js";
import { html, Sheet } from "../ui.js";

const MODES = [
    ["allow", "Allow", "Pi's calls there run."],
    ["ask", "Ask", "Each call waits for someone here to allow it."],
    ["off", "Off", "Pi is not offered this host."],
];

const blank = { name: "", target: "", cwd: "", shell: "", note: "", mode: "allow" };

/** One host being added or changed: its fields, then Save or Cancel. */
function HostForm({ initial, onSave, onCancel }) {
    const [host, setHost] = useState({ ...blank, ...initial });
    const set = (key) => (event) => setHost({ ...host, [key]: event.currentTarget.value });
    const field = (key, label, placeholder, hint) => html`<div class="field">
        <div class="label">${label}</div>
        <input
            class=${key === "note" ? "" : "mono"}
            placeholder=${placeholder}
            value=${host[key]}
            autocapitalize="off"
            spellcheck=${false}
            onInput=${set(key)}
        />
        ${hint && html`<div class="muted small">${hint}</div>`}
    </div>`;

    return html`<div class="host-form">
        ${field("name", "Name", "gpu", "What Pi passes as host: lowercase letters, digits and dashes.")}
        ${field("target", "SSH destination", "user@10.0.0.20", "An address, user@address, or a Host from ~/.ssh/config. Its key must already work without a password.")}
        ${field("cwd", "Folder", "the SSH user's home", "Where relative paths and commands start.")}
        ${field("shell", "Shell", "sh -c", "How commands run there. bash -lc gives them the login PATH.")}
        ${field("note", "Note for Pi", "GPU box: llama-swap and the model files")}
        <div class="field">
            <div class="label">Pi's calls</div>
            <div class="segmented">
                ${MODES.map(
                    ([mode, label]) => html`<button
                        class=${host.mode === mode ? "on" : ""}
                        aria-pressed=${host.mode === mode}
                        onClick=${() => setHost({ ...host, mode })}
                    >
                        ${label}
                    </button>`,
                )}
            </div>
            <div class="muted small">${MODES.find(([mode]) => mode === host.mode)?.[2]}</div>
        </div>
        <div class="row">
            <button class="button ghost" onClick=${onCancel}>Cancel</button>
            <button
                class="button primary"
                disabled=${host.name.trim() === "" || host.target.trim() === ""}
                onClick=${() => onSave({ ...host, name: host.name.trim(), target: host.target.trim() })}
            >
                Save
            </button>
        </div>
    </div>`;
}

/** The hosts, a Test button each, and adding, changing and removing them. */
export function HostsSheet() {
    const hosts = store.state.server?.hosts ?? [];
    const [editing, setEditing] = useState(undefined);
    const [tests, setTests] = useState({});
    const save = (next) =>
        attempt(async () => {
            const answer = await api("hosts", { hosts: next });

            store.set((state) => ({ server: { ...state.server, hosts: answer.hosts } }));
            setEditing(undefined);
        });
    const test = (name) =>
        attempt(async () => {
            setTests((all) => ({ ...all, [name]: { running: true } }));

            const answer = await api("hosts/test", { name });

            setTests((all) => ({ ...all, [name]: answer }));

            if (!answer.ok) {
                notify("error", answer.error);
            }
        });

    const status = (name) => {
        const result = tests[name];

        if (result === undefined) {
            return "";
        }

        if (result.running) {
            return "connecting…";
        }

        return result.ok ? `answered in ${result.ms} ms` : "did not answer";
    };

    if (editing !== undefined) {
        const others = hosts.filter((_, index) => index !== editing);

        return html`<${Sheet} title=${editing === -1 ? "Add a host" : "Change the host"} onClose=${closeSheet}>
            <${HostForm}
                initial=${editing === -1 ? undefined : hosts[editing]}
                onCancel=${() => setEditing(undefined)}
                onSave=${(host) =>
                    save(
                        editing === -1
                            ? [...hosts, host]
                            : hosts.map((each, index) => (index === editing ? host : each)),
                    )}
            />
            ${others.length > 0 && html`<p class="muted small">Other hosts: ${others.map((each) => each.name).join(", ")}</p>`}
        <//>`;
    }

    return html`<${Sheet} title="Hosts" onClose=${closeSheet}>
        <p class="muted small">
            Other machines Pi can work on over SSH. With a host here, Pi's bash, read, write and edit take its name and
            run there, over one connection kept open, so Pi never types ssh itself. Anyone who can steer a session can
            then run commands on the host as its SSH user.
        </p>
        ${hosts.length === 0 && html`<p class="muted">No hosts yet.</p>`}
        ${hosts.map(
            (host, index) => html`<div class="schedule" key=${host.name}>
                <div class="grow">
                    <div>
                        <span class="mono">${host.name}</span>
                        <span class="muted small"> · ${MODES.find(([mode]) => mode === host.mode)?.[1]}</span>
                    </div>
                    <div class="muted small mono">${host.target}${host.cwd ? ` · ${host.cwd}` : ""}</div>
                    ${host.note && html`<div class="muted small">${host.note}</div>`}
                    ${status(host.name) && html`<div class="small">${status(host.name)}</div>`}
                </div>
                <button class="button small ghost" onClick=${() => test(host.name)}>Test</button>
                <button class="button small ghost" onClick=${() => setEditing(index)}>Change</button>
                <button
                    class="button small ghost"
                    onClick=${() => save(hosts.filter((_, at) => at !== index))}
                >
                    Remove
                </button>
            </div>`,
        )}
        <button class="button wide" onClick=${() => setEditing(-1)}>Add a host</button>
    <//>`;
}
