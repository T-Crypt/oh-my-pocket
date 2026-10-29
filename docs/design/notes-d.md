# Stream D: Design agent tools

## Built

- `src/server/design/index.ts` exports `designTools(host)`, `designGuide(host)`, and `designRoutes(web, host)`.
- `design_preview` returns PNG image blocks and bounded console/request diagnostics. It defaults to mobile and desktop. Optional slide numbers start at 1. Deck previews show slide 1 by default and fit the requested device size.
- `design_export` and the POST export route both call `saveDesignExport` in `export.ts`. That function renders and writes the file, then returns `{ path, name, size }`. It writes PNG, PDF, PPTX, or an HTML ZIP inside the session folder. The default is `exports/<id>-v<version>.<ext>`. Existing files are replaced atomically. Directory links and outside paths are refused.
- Deck slides use B's 1920×1080 layout by default. A `pocket-slide-size` meta overrides it within the renderer's supported 320–3840 bounds. Preview, PNG, PDF, and PPTX override slide margins, min/max dimensions, and overflow to match B's canvas layout.
- PPTX contains full-bleed slide images and searchable speaker notes. Default slides remain 16:9. Custom sizes preserve their aspect ratio. It includes the OPC relationships, theme, masters, layout, and content types. It has no external dependencies.
- PNG exports the full page, up to 2560 × 16000 pixels. A deck PNG shows slide 1 at its slide size, up to 3840 pixels wide. PDF exports every slide on a separate page at the deck's size.
- Hidden deck slides retain their authored flex/grid display. CDP matched styles recover the base display below hiding rules.
- HTML ZIP contains the original page and binary assets. Its entry page is `index.html`. If an asset uses that name, the entry becomes `pocket-design.html`, with a numeric suffix if needed.
- `design_system` reads and writes `<session folder>/.pi/design-system.md`. It bounds text to 16 KB. Reads reject nonregular files and final links. Reads and writes reject a linked `.pi` folder. Writes use an adjacent exclusive temporary file and atomic rename.
- `designGuide` gives the complete authoring workflow. It includes existing design-system text as fenced, defanged, untrusted project data.
- The read-only preview tool is replay-safe. File-writing tools do not claim replay safety or read-only access.

## Rendering and access

Each render launches a separate headless Chromium process with its own temporary profile. It never uses the browser that people watch.

A temporary HTTP server binds only to `127.0.0.1`. A random 256-bit bearer path serves only the selected committed bundle. Relative assets resolve below that path. The endpoint closes after the render. Chromium receives no session cookie, user token, or app URL.

This deliberately replaces the plan's proposed authenticated `/a/...` request to the live server. It avoids granting untrusted page scripts an app credential. The private endpoint sends the exact `/a/` sandbox CSP, plus a second stricter render-only CSP. The browser enforces both policies together. Every bundle response also sends `X-Content-Type-Options: nosniff`. It serves raw HTML without the interactive app bridge or saved state.

External document navigation is refused before any public fetch. A page cannot replace its render CSP with a public document. Other nonbundle requests must use HTTPS and pass through `host.fetchPublic`. Public HTTP resources are refused. Its connection-time DNS and redirect checks refuse private network addresses. Only GET and HEAD requests pass. Chromium cannot open frames, workers, popups, or sockets through the render CSP. A pre-document script removes RTC and WebTransport APIs with immutable properties. Chromium also disables nonproxied WebRTC UDP. This closes a WebRTC bypass that the fresh review reproduced.

Limits: 2 concurrent renders, 90 seconds per render, 400 requests, 20 concurrent external requests, 5 MB per external resource, and 50 MB external resources total. Console and request diagnostics each keep at most 100 entries of 2000 characters. PPTX accepts 1–100 deck slides and at most 100 MB of slide images.

The renderer closes Chromium and the endpoint on success, failure, or cancellation. It removes the profile with retries and always releases its concurrency slot.

## Interfaces for integration

### Stream A

The coordinator's later integration contract replaces the earlier injected reader. `bundle.ts` reads `ArtifactsDoc`, the selected `ArtifactBodyDoc`, and each manifest asset from the session-scoped `ArtifactAssetDoc` by hash. It returns `{ meta, version: number, content, assets: { name, type, bytes: Buffer }[] }` with raw content.

Tools use the tool API snapshot reader. The route uses the host snapshot reader after checking session visibility. The reader validates the artifact ID, selected version, and HTML type. No optional host capability or asset-free fallback is necessary.

After merging `feat/design`, both `pptx.ts` and `export.ts` use A's real `src/server/zip.ts`. The temporary `src/server/design/zip.ts` adapter is removed. The shared signature is `zip(entries: { name: string; bytes: Buffer }[]): Buffer`.

The merge preserves the integrator's document-backed reader and verifies stored binary assets byte for byte.

### Stream C and the HTTP layer

Register the returned tools and prompt section in C's `design.ts` module.

`designRoutes(web, host)` registers `POST /api/x/design/export` with steer access. JSON body fields:

- `conversation`: a session ID in the signed-in person's current session list.
- `id`: the artifact's kebab-case ID.
- `version`: an optional positive integer.
- `format`: `png`, `pdf`, `pptx`, or `html`.
- `viewport`: optional `mobile`, `tablet`, `desktop`, or `WIDTHxHEIGHT`. Width is 320–2560; height is 240–2560.

The route writes `exports/<id>-v<version>.<ext>` in the visible session's authoritative working folder. It returns JSON `{ path, relative, name, size }`, where `path` is absolute, `relative` is `exports/<name>`, and `size` is bytes. It ignores any supplied output path, so browsers cannot select arbitrary files to replace.

Extension routes remain JSON-only. C imports D's real tools and routes directly. It posts the export request, then uses core's `GET /api/c/:conversation/download?path=...` route with the returned relative path. Core checks session access and file bounds.

## Documentation to merge

- `features.md`: describe private previews; PNG, PDF, image-slide PPTX with text notes, HTML ZIP; project design systems; and the preview-before-reply workflow. Explain that PPTX slides are images, not editable vector shapes. Canva export is not included.
- `map.md`: list the new `src/server/design/` tools, prompt guide, private renderer, document-backed bundle reader, and PPTX writer. Document the Design module's imports and export route.
- Release notes: include design previews at phone and desktop sizes, portable exports, deck presentations, and reusable project design systems.

## Checks and remaining work

- Focused D tests: 45 pass after the deck alignment changes; the 2 shared ZIP checks also pass, including real Chromium, token-scoped assets, allowed public HTTPS, blocked public HTTP, private HTTPS/metadata ranges, private UDP, external navigation, preserved hidden-slide layout, device fitting, cancellation cleanup, file bounds, links, FIFO rejection, prompt fencing, ZIP structure, document-backed readers, and JSON POST export contracts. New regressions cover a captured bottom-right pixel at 1920×1080, conflicting size constraints, uncropped 3840×2160 PNG, PDF page sizes/counts, custom PPTX proportions, and every requested guide fact.
- `npm run format`: passed.
- After merging `feat/design`, `npm run check` and `npm run lint` pass without local baseline changes. The committed brace fix in `prompt.ts` came from the integrator's branch. The earlier local check-only fix is gone.
- The deck alignment checks passed all 47 focused tests. The complete updated suite passed with `node --test --test-concurrency=4 test/*.test.ts`: 894 passed, 0 failed, 0 skipped, exit 0.
- A fresh strong-model review reproduced and checked the remaining deck constraints, wide-image cropping, custom PPTX proportions, and obsolete API tests. The fixes and regressions address each finding. The final review independently checked Chromium corner pixels and the complete square PPTX export path. It found no remaining task blocker.
- Before the deck alignment merge, the complete suite ran with concurrency 4: 853 of 855 tests passed. `artifact-bridge-ui.test.ts:347` timed out on saved-state reopening. `design-bridge-ui.test.ts:577` timed out on slide fitting. No D test failed. A serial retry of both complete UI test files passed all 26 tests.
- Before the final contract changes, full `npm test` passed all 788 tests twice. Later unbounded runs had changing timing failures in existing UI and background tests outside D. The isolated mobile, extension UI, and artifact bridge retries passed. The final complete suite passed with `node --test --test-concurrency=4 test/*.test.ts`: 789 passed, 0 failed, 0 skipped, exit 0.
- The throwaway copy ran with `node test/serve.ts 8904 127.0.0.2`. The mobile page loaded without console errors. The copy was stopped. C's canvas was not present in this isolated branch.
- Generated and visually inspected a deck PNG. Chromium PDF has 2 widescreen pages with searchable text. After the deck alignment changes, LibreOffice 26.8 opened fresh default and square PPTX exports. It produced 2 pages at 960×540 points for the default and 960×960 points for the square. `unzip -t` passed. PowerPoint and Keynote were not available for direct checks.
- A strong-model read-only review found 3 defects. The implementation and regression tests address all 3. A follow-up review reproduced a navigation-based TURN-over-TCP bypass. The final review repeated that probe after the fix: 0 public document fetches, 0 private TCP connections, and 0 bytes. It found no remaining blocker. A further review of the injected reader, JSON POST export, public HTTPS restriction, and combined CSP policies also found no blocker. The final shared-export refactor passed another read-only review and all 4 tool-contract tests.

The document-backed reader, shared ZIP, core download route, and C's module registration are now present after the merge. The earlier host-reader integration gap is gone. No npm dependencies, live-server changes, restart, push, or pull request are part of this stream.
