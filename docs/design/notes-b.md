# Stream B notes: the bridge

Branch `design/bridge`. Owner of: `web/artifact-bridge.js`, the bridge script in `src/server/http/artifacts.ts` (`ARTIFACT_BRIDGE`), new `src/server/http/artifact-inspect.ts`, new `test/design-bridge-ui.test.ts`.

Two edits outside those files, both small:

- `src/server/http/artifacts.ts`, `artifactResponse`: one line. A page that is a tab of its own, or a published link, gets `withDeck(content)` where it got `content`. Stream A edits this function too: keep that one line when merging.
- `test/artifact-inline.test.ts`: the test that runs the bridge script in a fake window now also passes a fake `document`.

## What it does

The page side lives in `ARTIFACT_INSPECT` (a function expression, as a string) in `artifact-inspect.ts`. `ARTIFACT_BRIDGE` calls it with the line to the app, and it also runs in the run frame (`RUN_FRAME`). It is inert until the app turns a mode on, and each mode removes all it added when it turns off. Two things work from the page's own markup, with no mode: it reads the tweaks manifest, and it shows a deck one slide at a time.

| Message (app → page)                    | What the page does                                                                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{ type: "pocket-inspect", on }`        | Outlines the element under the pointer. A click or tap picks it (the page's click, mouse, pointer-down/up, and submit handlers do not run; scrolling still works) and sends `pocket-picked`.                       |
| `{ type: "pocket-edit-text", on }`      | Text blocks become `contenteditable="plaintext-only"`, with a dashed hint. A block that loses focus with a change sends `pocket-text-edited`. Enter commits, Escape undoes. Clicks do not run the page's handlers. |
| `{ type: "pocket-tweak-set", values }`  | A `--name` sets that custom property on `:root`; every name fires `pocket:tweak` on `window`.                                                                                                                      |
| `{ type: "pocket-highlight", targets }` | Numbered pins (and a faint outline) on the targets. An empty list clears them.                                                                                                                                     |
| `{ type: "pocket-goto", slide }`        | In a deck, shows this slide.                                                                                                                                                                                       |

| Message (page → app)                                    | When                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------- |
| `{ type: "pocket-picked", target }`                     | A pick in inspect mode.                                                   |
| `{ type: "pocket-text-edited", target, before, after }` | An edited block loses focus, or edit mode turns off.                      |
| `{ type: "pocket-tweaks", knobs }`                      | At start (only if the manifest has knobs), and when the manifest changes. |
| `{ type: "pocket-deck", slides, current }`              | At start in a deck, and when the slide or the slide count changes.        |

Only the inspector can send those four: the stand-in `parent` in the page sends the page's own messages to the real parent window, where the app ignores them. A test proves a page cannot forge them.

### Choices where the plan let me choose

- **Slide numbers are 0-based**, in `pocket-goto` and `pocket-deck`. D: if `design_preview({ slide })` is 1-based for Pi, convert.
- **Modes are exclusive**: turning inspect on turns text edit off, and the other way round. Pins and tweaks are separate.
- **`rect` is in page coordinates** (viewport rect plus scroll), in CSS pixels after any transform (a deck's scale is in it).
- **`before` in `pocket-text-edited` is the first text** the block had (whitespace squashed), not the text before the last edit. The same block can be sent again; keep the last one for each `target.selector`. Putting the old text back is sent too (`after === before`), so a reverted edit can be dropped.
- **Text edit makes editable**: an element with its own text and no block element inside (inline tags only), not inside another editable, with a layout box, and up to 2,000 characters. `<li>Text <ul>…` is not editable. Inline markup inside a block stays; typing plain text.
- **Knob `options`** are strings (`["calm", "loud"]`). An option written `{ value, label }` becomes its `value`.
- **A number for a `--name` gets the knob's `unit`**: `--radius: 12` with `unit: "px"` sets `12px`. A string is set as it is. A boolean sets `1` or `0`.
- **Extras, optional**: `pocket-tweak-set` with a `null` value removes that custom property (a reset). A `pocket-highlight` target may have `label` (string up to 8 characters or a number) to show instead of its list position, so pins can match comment numbers. The page also fires `pocket:slide` (`{ index, count }`) on `window` when the slide changes.
- **Pins** find an element by `selector`, and if that finds nothing (a newer version), by the `pid`'s `[data-pid]` element. A pin with no element is hidden.
- **Decks** are laid out at 1920×1080 and scaled to fit (letterboxed in black unless the page paints its own ground). `<meta name="pocket-slide-size" content="1280x720">` changes the size. The page side adds a viewport meta when a deck has none (a phone would lay it out at 980 pixels). Keys: arrows, PageUp/Down, Home, End, Space (Shift+Space back). Swipes: horizontal, over 50 pixels. Keys and swipes are off while text edit is on.
- **A deck as a page of its own** (a tab, a published link: no bridge there) also shows one slide at a time with keys and swipes: `withDeck` puts in the same script with no line to an app. Printing it shows every slide, one for each page (`@page` is the slide size), so a PDF export of a deck needs nothing more.
- **The overlay** (outlines, pins) is a `<pocket-overlay>` element at the end of `<html>`, in a closed shadow root, `pointer-events: none`. It is in the page only while it shows something. Styles go in with CSSOM and constructable stylesheets, never markup, so a page's CSP or Trusted Types does not stop it.
- **The page-side listeners** of the modes (window, capture phase) are added when the page starts, with the native `addEventListener` kept before the page's scripts run, so they run before any the page adds, and a page that replaces `addEventListener` cannot get a handler and call it with invented events. Each does nothing until its mode is on. Inspect also stops the page's touch handlers (not scrolling).
- **Early messages**: the app may speak as soon as the page starts. Design messages that arrive before the page is parsed wait, and run when it is (so a unit finds its manifest, and text edit finds its body). In the run frame, whose document is replaced, the last modes, pins, and tweak values are given to the new document.
- **Limit on messages** from one page: 60 a second; the rest are dropped.

## The app side: for stream C

All in `web/artifact-bridge.js`.

```js
import {
    useArtifactBridge,
    sendToFrame,
    attachBridge,
    checkPageMessage,
    checkAppMessage,
} from "../artifact-bridge.js";

// In a component (the canvas):
const frame = useRef(null);
const bridge = useArtifactBridge(frame, {
    artifact: id, // as for the viewer: saved state, follow-ups
    source: `the design “${title}”`,
    enabled: artifact.type === "html",
    onMessage(message, frame) {
        // already checked and cleaned
        if (message.type === "pocket-picked") addPin(message.target);
        else if (message.type === "pocket-text-edited") addEdit(message);
        else if (message.type === "pocket-tweaks") setKnobs(message.knobs);
        else if (message.type === "pocket-deck") setSlide(message.slides, message.current);
    },
    onReady(frame) {
        // the page opened its line (it just started)
        bridge.send({ type: "pocket-highlight", targets: openComments.map(toPin) });
    },
});

bridge.send({ type: "pocket-inspect", on: true }); // true: sent or queued
bridge.send({ type: "pocket-tweak-set", values: { "--accent": "#f00", "--radius": 12 } });
bridge.send({ type: "pocket-goto", slide: 2 });
bridge.ready(); // has the page opened its line

html`<iframe ref=${frame} key=${`${id}/${version}`} src=${src} sandbox="allow-scripts …" />`;
```

- `useArtifactBridge(ref, settings)` returns the same `{ send, ready }` on each render. `onMessage` and `onReady` may change between renders; the bridge is made again only when `artifact`, `source`, or `enabled` change. `enabled: false` (SVG, Markdown) gives `send` that returns false.
- `send(message)` checks the message (`checkAppMessage`), then sends it down the line, or **queues** it (the newest of each type; tweak values merge) when the frame has not loaded a page yet, and sends the queue when the page opens its line. It returns false when the message is wrong, or the page has no line (it never had a bridge, or it went to another page). Turning inspect or text edit **on** also needs `canSteer()`: a viewer gets false. Viewers may still send pins, goto, and tweaks: C hides what they must not use.
- **One line for one page.** The frame's first page opens the line, and a page it goes on to gets none. To show another version or artifact, **make a new iframe** (`key` on the artifact and version), and use `onReady` to say again what the canvas needs (modes, pins, tweak values, slide).
- Without a component: `attachBridge(ref, settings)` returns `{ send, ready, detach }`. `sendToFrame(frame, message, { wait })` sends to a frame that a bridge covers.
- `checkPageMessage(data)` and `checkAppMessage(raw)` are exported (tests use them). `LIMITS` has the numbers.
- Message shapes, after the app checked them. `Target`: `{ pid?, selector, tag, text (≤200), html (≤1000), rect: { x, y, width, height }, styles }` with `styles` having only these keys that the page had: `color`, `background-color`, `font-family`, `font-size`, `font-weight`, `line-height`, `padding`, `margin`, `border-radius`, `gap`. `Knob`: `{ name, label?, type, value, min?, max?, step?, unit?, options? }`, at most 40, names once each. A selector over 500 characters, or a `before` or `after` over 2,000, makes the message be dropped.
- Keys go to the frame only when it has focus. When focus is in the app, C moves slides with `pocket-goto`.
- Moving between pins and the page: a pin shows `label` (or its place in the list); the page has no way to say a pin was tapped.

## For stream D (the guide, preview, export)

Pi needs to be told, in `designGuide`:

- **Pids**: `data-pid="hero"` on meaningful elements; a pick or a pin falls back to the nearest one.
- **Tweaks manifest**: `<script type="application/json" id="pocket-tweaks">[ { "name": "--accent", "label": "Accent", "type": "color", "value": "#3366ff" }, { "name": "--radius", "type": "range", "value": 12, "min": 0, "max": 32, "step": 1, "unit": "px" } ]</script>`. 3 to 8 knobs. Types: `range`, `color`, `select` (with `options`), `toggle`, `text`. The CSS must use the variables (`var(--accent)`). A knob that is not a `--name` is only an event: `addEventListener("pocket:tweak", (e) => e.detail.name / e.detail.value)`.
- **Decks**: `<meta name="pocket-kind" content="deck">`, slides as `<section class="slide">`, each authored at **1920×1080** (the page side sets that size and scales it), no own navigation script needed. Slide-by-slide work (`design_preview({ slide })`, PPTX images): load the page from `/a/…` as a page of its own (no bridge, deck script only), set the viewport to the slide size, press `ArrowRight` through CDP; the current slide has `data-pocket-current`. The print media rule shows all slides one on each page, with `@page` at the slide size.
- A page that is not a deck loaded from `/a/…` as a page of its own is as written (no script added).

## What the docs must say

- `docs/map.md`: `web/artifact-bridge.js` row: also the design messages (`sendToFrame`, `attachBridge`, `checkPageMessage`, `checkAppMessage`). New row, `src/server/http/artifact-inspect.ts`: the page side of Design mode (inspect, text edit, tweaks, pins, decks), `ARTIFACT_INSPECT`, `withDeck`. The "rules that are easy to break": the inspector script has no backtick, and it sits in a template string.
- `docs/features.md`: in Artifacts or Design mode: a deck is a page with the meta and `section.slide`; the tweaks manifest; the message list above (one line each) for people who write pages by hand.
- `docs/architecture.md` (if it lists the bridge): the line now also goes down from the app, and the page→app design messages come only from the inspector.
- Release notes: "Artifact pages can be inspected, edited in place, tweaked, pinned, and presented as decks (the bridge for Design mode). A deck opened as a page of its own, or published, shows one slide at a time."

## Open problems

- A deck's slides are forced to 1920×1080 (width, height, and the min and max of each). A page that already scales its own slides (100vw) gets the same result, but its own scaling script and this fight if it moves slides itself.
- Inspect and pins cannot reach inside an iframe or a closed shadow root in the page. A `<canvas>` is one element.
- A page that navigates itself (a link, `location`) loses the line: its next page is not heard. C must show a new version in a new iframe, as written above.
- Text edit does not reach text in an element that also has a block element inside it (`li` with a nested list), or text that is longer than 2,000 characters.
- The selector is `#id`, `[data-pid]`, or a short chain with `:nth-of-type`. It names the element in this version, not in a later one that moved it. Pins fall back to the pid.
- The pins take no pointer: a tap on a pin in inspect mode picks the element below. A pin cannot say it was tapped. If C needs that, add a message (`pocket-pin-tapped`) and a pointer-taking pin.
- `ARTIFACT_INSPECT` makes each HTML artifact's page about 36 KB longer. If this matters, serve it as a script from the server and load it from the bridge (the sandbox allows that to the app's own address).
- The shared Chromium test files run in parallel in `npm test`: under heavy load one of the older artifact bridge tests took over 30 seconds once. It passed on the next run.
