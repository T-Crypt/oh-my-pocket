# Stream C: the workspace

Branch `design/workspace`. The Design module: a wide panel beside the chat with the canvas, versions, comments, text edits, tweaks, variations, decks, export, and share.

## What is built

Server (`src/server/extensions/design.ts`, built in, on by default, title "Design"):

- Routes under `/api/x/design/` (all through `web.conversationRoute`, so Pi Pocket checks that the person sees the session, and for a write that they steer):
    - `GET c/:conversation/artifacts`: the session's HTML designs with `group`, `kind`, and each version's `restoredFrom`.
    - `GET c/:conversation/designs/:artifact`: all comments and this person's tweaks.
    - `POST …/comments`, `POST …/comments/:id` (words, resolved), `DELETE …/comments/:id`, `POST …/resolve` (many ids): comments. Everyone who sees the session reads them; people who steer write them. Only the author or the owner changes the words or deletes.
    - `POST …/tweaks`: this person's tweak values for the design, replaced as a whole (`values: null` clears).
    - `POST …/restore` (`{ version, key }`): "Go back to this one", see below.
    - `POST export` (stream D's route, registered by `designRoutes`): see "Export".
- The `/design-open [artifact]` command. It is `design-open`, not `design`: a command's name must have a dash (`COMMAND_NAME` in `extension-web.ts`). It sends `open` to the tab of the person who ran it, which opens the panel.
- Events to browsers: `comments` (`{ conversation, artifact }`, after any comment change) and `open`.
- Registered in `reload.ts`: `ORDER`, `TITLES`, and `design_preview`, `design_export`, `design_system` in `BUILT_IN_TOOLS`.
- Tools, the prompt guide, and the export route come from `../design/index.ts` (stream D), by a static import.

Document (`src/server/docs.ts`, appended at the end): `pocket.design-comments`, scope `conversation`, history `latest`, fork `current`. By artifact id: `comments[]`, `tweaks` (by person id), `restores` (new version → copied version). It is one kind for comments, tweaks, and restores; the name is the plan's.

Browser module (`src/server/extensions/design/`, folder served with `web.client("design", { access: "view" })`):

- `index.js` sets up a panel (`wide`), a rail button, a launcher action, and listeners. It keeps the workspace state in one store made at load (`state.js`), outside the panel's component, so going back to the chat on a phone and coming again leaves the canvas as it was.
- `workspace.js` (picker, toolbar, tabs, menu, layout), `canvas.js` (the frame, the page side of every mode through the bridge), `docks.js` (versions, comments, text edits, tweaks), `views.js` (compare, variations grid, slide strip, present mode), `data.js` (what it asks of the server), `parts.js`, `style.css`.
- Pure helpers with tests: `devices.js`, `tweaks.js`, `edits.js`, `messages.js`, `comments.js`.

In `web/sheets/viewers.js`: an "Open in Design" button in the artifact viewer (only when the Design module is ready in this tab), and, in the share sheet, "close goes back to where it was opened from" (a prop `back: "design"` in the sheet state: closing goes to the canvas, not to the viewer). The second is a small step past "a button only"; it is 3 lines.

## How it looks and behaves

- Panel: on a screen ≥ 1100 px it is beside the chat. Its width is `max(480px, min(58%, 100% - 760px))` (`style.css`), so the chat keeps 440 px. Under 1100 px it covers the chat, with the app's back button.
- Bars: the picker (designs newest first, a group kept together), a size choice (phone 390×844, tablet 820×1180, desktop 1280×800, custom; a deck has 1280×720 in place of desktop), "…" menu (backdrop, reload, compare, variations, present, export, share, open in tab). Tabs: Preview, Comment, Edit text, Tweaks, Versions; icon buttons for compare, variations (a group of 2 or more), present (a deck).
- The side panel (the dock) sits beside the canvas on a wide panel (≥ 900 px), or on a narrower one that shows a tall page (phone, tablet); under the canvas otherwise (and always below 560 px).
- Canvas: fit (never past 100%) or zoom steps, size readout, light/dark/theme backdrop. What a person chose (size, zoom, backdrop) is kept in this browser (`localStorage`); the design last open is kept in the tab for each session.
- A new design that appears while the panel is open opens, unless the person is in a mode, has a draft or edits, or it is a variation of the open design (it shows in the grid).

## What the workspace says to the bridge (stream B)

Uses `useArtifactBridge(ref, { artifact, source, enabled, onMessage, onReady })` returning `{ send }`, as stream B built it (`attachBridge`). If the hook returns nothing (a copy without stream B), the canvas still works and says "needs the frame's inspector" in the mode hints.

- `pocket-inspect` / `pocket-edit-text` on or off with the mode. `pocket-highlight` with `{ pid, selector, label }`, where `label` is the pin's number (the order of open comments made on the version shown). `pocket-tweak-set`: only what differs from what the page was last told (a fresh page has been told nothing), and the page's default again for a knob that returns to it. For a name starting with `--` that has a `unit`, the value goes as text with the unit (`"20px"`); a toggle for such a name goes as `"1"` or `"0"`. Any other name gets the raw value. `pocket-goto` with a 0-based slide (the strip shows it plus 1).
- Takes `pocket-picked`, `pocket-text-edited`, `pocket-tweaks`, `pocket-deck`. It cleans them again (shape and length) before use, and the server cuts a comment's target to a fixed shape.

## Choices where the plan let me choose

- "Go back to this one" writes the version directly, in one commit of the route (`request.commit`): a copy of the old version's record (assets included, as the record carries them) and of its body, with the same `taskId` and a new `callId` (`design-restore:<key>`), which no real tool call matches. A repeated tap with the same `key` finds its version. It also notes `restores[new] = old` so the timeline says "from v1". It never asks Pi.
- Everything that goes to Pi goes into the message box with `pocket.insertText`: the module has no way to send. Comments ("Send N to Pi"), text edits ("Apply N with Pi"), tweaks ("Keep these N"), a chosen variation ("Use this one"). Each text starts with a letter (never a command), and puts element data as JSON in a fence longer than any run of backticks inside it. On a phone the panel closes after it, so the box shows.
- Comments are shared. Tweaks are per person (the plan allowed this module's own storage or the new kind: it is the new kind).
- The design list is the app's own live one (`view.artifacts`), merged with the server's list for `group`, `kind`, `restoredFrom`. This is why the module imports `/store.js`. It also imports `/artifact-bridge.js`: the same frame and bridge as the viewer.
- Viewers see the canvas, versions, and comments, and have no Edit text or Tweaks tab, no comment actions, no send buttons, and no "Go back". The server enforces it: the write routes are for those who steer, so a viewer gets the 404 that any person gets for a route that is not theirs.
- Download of an export: see below.

## Export

Stream D's route is `POST /api/x/design/export` with `{ conversation, id, version?, format, viewport }`; it writes the file in the session's `exports/` folder and answers `{ path, relative, name, size }`. The buttons POST it, then save the file through core's `GET /api/c/<conversation>/download?path=<relative>` (a link with `download`; no header needed), and say where it is saved.

## What the docs must say

`features.md`:

- Design mode: a canvas panel; versions with compare and "go back to this one"; comments shared with the session, pinned to elements, sent to Pi as one message; edit text and apply; tweaks kept per person and kept into the design by Pi; variations as a grid ("use this one"); decks with a slide strip and present mode; export (PNG, PDF, PPTX, HTML zip); share; "Open in Design" in the artifact viewer; `/design-open`.
- Who: everyone who sees every session loads it; people who steer write; viewers read; people invited to one session never load it (a module is for the whole app). While "take turns" is on, only the driver comments (core checks it for routes bound to a session).

`map.md`: `extensions/design.ts` (routes, document, command; installs `../design/index.ts`'s tools, guide, and export route), `extensions/design/` (the folder, what each file does), `docs.ts`' `DesignCommentsDoc`, `reload.ts`' entries, `viewers.js` (the button and `back`). Mention that the module imports `/store.js` and `/artifact-bridge.js`.

Release notes: Design mode; "go back to this one" makes a copy as a new version; comments are shared and durable; tweaks stay with the person.

`docs/extensions/built-in.md` or `architecture.md`: the module's document and its use of `../design/index.ts`.

## Tests

`test/design-routes.test.ts` (HTTP: access, shape cutting, limits, restore, tweaks, export), `test/design-parts.test.ts` (the pure helpers), `test/design-ui.test.ts` (a real Chromium: panel, sizes, picker and groups, grid, versions, restore, compare, comments and the message, viewer button, `/design-open`, share, viewer role, phone layout; pointing, tweaks, and decks run when this copy has stream B's bridge). `test/design-fixtures.ts` makes the designs (a landing page in three versions, a deck, three variations) and is also what I used to look at it by hand.

## Changes to files outside my stream

- `test/extension-commands.test.ts`: one assertion expected no commands at all after a drop-in went; the built-in `design-open` command is now always there, so it filters that name out.
- `web/sheets/viewers.js`: see above.

## Open problems

- A page inside the frame that goes on to another page (`about.html`) has no bridge, so comment, edit, pins, and tweaks go quiet on it with no message.
- While Pi makes a new version, the person in a mode, with a draft, or with text edits stays on the version they work on and sees "Version N of M" with a way to the newest. Otherwise the canvas follows the newest.

- `/design` itself cannot be a command (names need a dash); core could add a one-word client command in `web/commands.js` that calls `openExtPanel("design", "design")`.
- Comments are tied to the version they were made on. A comment's pin shows only on that version. Nothing moves a comment to a newer version when Pi makes one: "mark them done" is manual (a button after "Send to Pi").
- Writes to a design's notes need the turn when "take turns" is on, because core checks it for any route bound to a session.
- On a phone, a 1280 px page at "fit" is about 28% (a deck slide too). Zoom and custom sizes are there; there is no pinch zoom.
- The present mode uses the browser's full screen when it can; inside it Esc is the browser's and ends it.
- The module imports two app files (`/store.js`, `/artifact-bridge.js`). Both are served by the same server; if either moves, the module fails to load (and the Extensions sheet says so).
- `npm run format` also rewrites `src/server/extensions/prompt.ts` on `release/0.26.0` (a missing brace). I left it alone.
