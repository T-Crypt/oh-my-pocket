// Design's browser module: a canvas beside the chat for interactive designs. It adds a wide panel (a rail button, the
// places, the launcher, and the artifact viewer's "Open in Design" button open it), and keeps the workspace's state in one
// store made here, so going back to the chat on a phone and coming again leaves the canvas as it was.
//
// Unlike most modules it imports two of the app's own files, `/store.js` (the session's artifacts, who the person is) and
// `/artifact-bridge.js` (the artifact frame's bridge, which the viewer uses too): it is built in, and both are served
// by the same server as this file.
import { openSheet, store as app } from "/store.js";
import { createData, designsOf } from "./data.js";
import { clampSize } from "./devices.js";
import { variationMessage } from "./messages.js";
import { createParts, PATHS } from "./parts.js";
import { createStore, initialState, loadPick, savePrefs, sessionState } from "./state.js";
import { createWorkspace } from "./workspace.js";

export const pocketApi = 1;

/** The most the message box takes (`insertText`). */
const BOX_LIMIT = 90_000;

export default function setup(pocket) {
    if (typeof pocket.panel !== "function") {
        // An app from before panels (0.19.0): nothing to add.
        return undefined;
    }

    const store = createStore(initialState());
    const data = createData(pocket, store);
    const parts = createParts(pocket);
    const canEdit = () => app.state.me?.role !== undefined && app.state.me.role !== "viewer";
    /** The mode goes off, so an editor's comments or edits dock goes too, or its tab stays lit. */
    const modeless = () =>
        canEdit() && ["comments", "edits"].includes(store.get().dock) ? { dock: null } : {};

    const env = {
        pocket,
        store,
        data,
        parts,
        app,
        /** The page's frame, for the parts that talk to it (the slide strip): `{ send, goto, supported }`, or null. */
        frame: { current: null },
        canEdit,
        darkTheme: () => document.documentElement.dataset.mode !== "light",
        sizeClass: (state) => {
            const width = state.width || 1000;

            return width < 560 ? "narrow" : width < 900 ? "medium" : "wide";
        },
        beside: () => matchMedia("(min-width: 1100px)").matches,
        designs: () => designsOf(app.state.view, store.get().listed),
        current: () => env.designs().find((each) => each.id === store.get().artifact) ?? null,
        /** The design a person means by a name: its id, else the start of an id, else words of its title. */
        find(designs, query) {
            const words = String(query ?? "")
                .trim()
                .toLowerCase();

            if (words === "") {
                return designs[0];
            }

            return (
                designs.find((each) => each.id === words) ??
                designs.find((each) => each.id.startsWith(words)) ??
                designs.find((each) => each.title.toLowerCase().includes(words))
            );
        },

        /** Put a message in the message box for the person to read and send. On a phone the chat comes back to show it. */
        sendToBox(text) {
            if (text.length > BOX_LIMIT) {
                pocket.notify(
                    "error",
                    "That is too much for one message. Mark some comments done, and send the rest.",
                );

                return;
            }

            pocket.insertText(text);
            pocket.notify("info", "In your message box: read it, then send it.");

            if (!env.beside()) {
                pocket.closePanel();
            }
        },

        open(id, version = null) {
            const same = store.get().artifact === id;

            // The page's own knobs and slides go when its frame does (`CanvasView`): the same design's frame stays.
            store.set({
                artifact: id,
                version,
                view: "canvas",
                compare: null,
                mode: "view",
                ...modeless(),
                draft: null,
                present: false,
                ...(same ? {} : { slide: 0 }),
            });
        },
        showVersion(version) {
            store.set({ version, view: "canvas", draft: null });
        },
        compare(a, b) {
            const design = env.current();
            const latest = design?.versions.at(-1)?.version ?? 1;

            store.set({
                view: "compare",
                compare: { a: a ?? Math.max(1, latest - 1), b: b ?? latest },
                mode: "view",
                ...modeless(),
                draft: null,
            });
        },
        setView(view) {
            // Variations fill the room: the side panel goes.
            store.set({
                view,
                mode: view === "canvas" ? store.get().mode : "view",
                draft: null,
                ...(view === "grid" ? { dock: null } : {}),
            });
        },
        setDock(dock) {
            store.set(dock === null ? { dock: null, mode: "view", draft: null } : { dock });
        },
        setTab(tab) {
            const s = store.get();
            const edit = canEdit();
            const tabs = {
                view: { mode: "view", dock: null },
                comment: { mode: edit ? "comment" : "view", dock: "comments" },
                edit: { mode: "edit", dock: "edits" },
                tweaks: { mode: "view", dock: "tweaks" },
                versions: { mode: "view", dock: "versions" },
            };
            const next = tabs[tab] ?? tabs.view;
            const same = s.mode === next.mode && s.dock === next.dock;
            const to = same ? tabs.view : next;

            store.set({
                ...to,
                draft: to.mode === "comment" ? s.draft : null,
                view: tab === "versions" || s.view === "canvas" ? s.view : "canvas",
            });

            // Others comment as this tab looks: read them when the list opens, as well as when they say so.
            if (to.dock === "comments" && s.artifact !== null) {
                void data.notes(s.artifact);
            }
        },
        setDevice(device) {
            store.set({ device });
        },
        setCustom(size) {
            const custom = { ...store.get().custom };

            for (const [key, value] of Object.entries(size)) {
                custom[key] = clampSize(value, custom[key]);
            }

            store.set({ custom, device: "custom" });
        },
        setZoom(zoom) {
            store.set({ zoom });
        },
        setBackdrop(backdrop) {
            store.set({ backdrop });
        },
        reloadFrame() {
            store.set((s) => ({ reload: s.reload + 1 }));
        },

        setTweak(artifact, knob, value) {
            const s = store.get();
            const values = { ...(s.tweaks[artifact] ?? {}), [knob.name]: value };

            if (value === knob.value) {
                delete values[knob.name];
            }

            store.set({ tweaks: { ...s.tweaks, [artifact]: values } });
            data.saveTweaks(artifact, values);
        },
        resetTweaks(artifact) {
            store.set((s) => ({ tweaks: { ...s.tweaks, [artifact]: {} } }));
            data.saveTweaks(artifact, null);
        },

        useVariation(each, others) {
            env.sendToBox(
                variationMessage({ title: each.title, id: each.id, group: each.group, others }),
            );
            env.open(each.id);
        },
        share(id, version) {
            openSheet({ type: "artifact-share", id, version, back: "design" });
        },
    };

    const { Workspace } = createWorkspace(env);

    function Panel() {
        return pocket.html`<${Workspace} />`;
    }

    // How the canvas looks is kept in this browser.
    let looks = "";

    store.subscribe((s) => {
        const next = JSON.stringify([s.device, s.custom, s.zoom, s.backdrop]);

        if (next !== looks) {
            looks = next;
            savePrefs(s);
        }
    });

    // The session the tab shows: its designs, and the one this tab had open there.
    const stopConversation = pocket.onConversation((id) => {
        if (id === store.get().conversation) {
            return;
        }

        const pick = id === null ? null : loadPick(id);

        store.set({
            ...sessionState(),
            conversation: id,
            artifact: pick?.artifact ?? null,
            version: pick?.version ?? null,
        });

        if (id !== null) {
            void data.list();
        }
    });

    // Pi published or changed something: the server's list (groups, kinds) is read again.
    let signature = "";
    let seen = null;
    let later = 0;
    const stopApp = app.subscribe((state) => {
        const list = state.view.artifacts;

        // The app tells this on every change while Pi writes: most leave the list as it was.
        if (!list || list === seen || state.conversationId !== store.get().conversation) {
            return;
        }

        seen = list;

        const next = list.map((each) => `${each.id}@${each.versions.at(-1)?.version}`).join();

        if (next !== signature) {
            signature = next;
            clearTimeout(later);
            later = setTimeout(() => void data.list(), 150);
        }
    });

    // Someone else commented: read the comments again.
    const stopComments = pocket.on("comments", (event) => {
        const s = store.get();

        if (event?.conversation === s.conversation && s.notes[event.artifact]?.loaded) {
            void data.notes(event.artifact);
        }
    });

    const ask = (artifact, version) => {
        store.set({ wanted: { artifact: String(artifact ?? ""), version: version ?? null } });
        pocket.openPanel("design");
    };

    // `/design-open [artifact]`, run on the server, asks this tab to open the panel.
    const stopOpen = pocket.on("open", (event) => {
        if (event?.conversation === store.get().conversation) {
            ask(event.artifact);
        }
    });

    // The artifact viewer's "Open in Design" button asks the same way (`web/sheets/viewers.js`).
    const onOpen = (event) => {
        store.set({
            wanted: {
                artifact: String(event.detail?.artifact ?? ""),
                version: event.detail?.version ?? null,
            },
        });
    };

    addEventListener("pocket:design-open", onOpen);

    pocket.style("style.css");
    pocket.panel({
        id: "design",
        title: "Design",
        iconPath: PATHS.design,
        component: Panel,
        wide: true,
    });
    pocket.rail({ id: "design", title: "Design", iconPath: PATHS.design, panel: "design" });
    pocket.launcher({
        id: "design",
        label: "Open Design",
        detail: "A canvas for prototypes, screens, and decks",
        iconPath: PATHS.design,
        keywords: ["design", "canvas", "prototype", "mockup", "deck", "slides"],
        panel: "design",
    });

    return () => {
        removeEventListener("pocket:design-open", onOpen);
        clearTimeout(later);
        stopConversation();
        stopApp();
        stopComments();
        stopOpen();
    };
}
