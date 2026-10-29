// The workspace's state: one small store for the whole tab, made when the module loads. It lives outside the panel's
// component, so going back to the chat on a phone (which closes the panel) and coming again keeps the canvas as it was.

/** A store: `get()`, `set(patch or fn)`, and `subscribe(listener)`. */
export function createStore(initial) {
    let state = initial;
    const listeners = new Set();

    return {
        get: () => state,
        set(patch) {
            const next = typeof patch === "function" ? patch(state) : patch;

            state = { ...state, ...next };

            for (const listener of [...listeners]) {
                listener(state);
            }
        },
        subscribe(listener) {
            listeners.add(listener);

            return () => listeners.delete(listener);
        },
    };
}

/** The state of the store, drawn again when it changes. */
export function useStore(pocket, store) {
    const [, draw] = pocket.useState(0);

    pocket.useEffect(() => {
        const stop = store.subscribe(() => draw((count) => count + 1));

        draw((count) => count + 1);

        return stop;
    }, [store]);

    return store.get();
}

const PREFS = "x.design.prefs";
const PICK = "x.design.pick";

const read = (storage, key) => {
    try {
        return JSON.parse(storage.getItem(key) ?? "null");
    } catch {
        return null;
    }
};

const write = (storage, key, value) => {
    try {
        storage.setItem(key, JSON.stringify(value));
    } catch {
        // Private mode or a full store: the choice lasts until the page loads again.
    }
};

/** What a person chose for how the canvas looks: kept in this browser. */
export function loadPrefs() {
    const saved = read(localStorage, PREFS) ?? {};
    const small = typeof innerWidth === "number" && innerWidth < 700;

    return {
        device: ["mobile", "tablet", "desktop", "slide", "custom"].includes(saved.device)
            ? saved.device
            : small
              ? "mobile"
              : "desktop",
        custom: saved.custom ?? { w: 800, h: 600 },
        zoom: saved.zoom === "fit" || typeof saved.zoom === "number" ? saved.zoom : "fit",
        backdrop: ["auto", "light", "dark"].includes(saved.backdrop) ? saved.backdrop : "auto",
    };
}

export function savePrefs(state) {
    write(localStorage, PREFS, {
        device: state.device,
        custom: state.custom,
        zoom: state.zoom,
        backdrop: state.backdrop,
    });
}

/** The design last open in a session, kept for the tab: a reload goes back to it. */
export function loadPick(conversation) {
    const all = read(sessionStorage, PICK) ?? {};

    return all[conversation] ?? null;
}

export function savePick(conversation, pick) {
    const all = read(sessionStorage, PICK) ?? {};

    all[conversation] = pick;
    write(sessionStorage, PICK, all);
}

/** The parts of the state that belong to one session: all of it but how the canvas looks. */
export function sessionState() {
    return {
        /** The session's designs as the server lists them, with their group and kind: `null` until the first answer. */
        listed: null,
        /** The artifact open, and its version (`null` follows the newest). */
        artifact: null,
        version: null,
        /** What fills the canvas: the frame, two versions side by side, or the group's variations. */
        view: "canvas",
        compare: null,
        /** How the page answers a tap: not at all, a comment, or a text edit. */
        mode: "view",
        /** The side panel: `versions`, `comments`, `edits`, `tweaks`, or none. */
        dock: null,
        /** Comments and tweaks by artifact id, as the server has them. */
        notes: {},
        /** A pick not yet saved as a comment: the element and the version it was made on. */
        draft: null,
        /** The comments last put in the message box, by design: the ones "mark them done" is for. */
        sent: {},
        /** Text edits by `artifact@version`, not yet sent. */
        edits: {},
        /** The page's own tweak knobs, and what was set (by artifact id). */
        knobs: [],
        /** The frame (its address) the knobs came from. */
        knobsKey: "",
        tweaks: {},
        deck: null,
        /** The slide the deck was last on (0 first): a page that loads again goes back to it. */
        slide: 0,
        present: false,
        /** A request from outside to open an artifact (the viewer's button, the command): the panel takes it once. */
        wanted: null,
        /** Bumped to load the frame again. */
        reload: 0,
        /** Whether the frame's bridge can inspect, edit, and tweak (it is there when the bridge has `send`). */
        bridge: true,
    };
}

/** The state before anything is chosen. */
export function initialState() {
    return { ...loadPrefs(), width: 0, conversation: null, ...sessionState() };
}
