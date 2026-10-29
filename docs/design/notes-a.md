# Stream A: artifact bundles

Status: bundle implementation and core published-route wiring are complete on `design/bundles`.

## Built interfaces

- Both artifact tools accept `assets`, `removeAssets`, `group`, and `kind`.
- `assets` accepts up to 200 entries, each with `name` and exactly one of `path` or `content`.
- Paths copy regular local files. The final path cannot be a symbolic link. Binary files are allowed.
- Asset names have up to 200 ASCII characters, with safe relative path segments.
- Each version inherits previous assets. New entries replace matching names. Removals apply before additions.
- Limits are 5,000,000 bytes per asset and 20,000,000 bytes per version. A version keeps at most 200 assets.
- `ArtifactVersion.assets` maps names to `{ hash, size, type }`.
- `pocket.artifact-asset` is a session-scoped document family. SHA-256 keys hold immutable base64 bytes.
- The asset documents, version manifest, index, and main body commit together. Replays find their original version before reading local files.
- `ArtifactMeta` has optional `group` and `kind: "page" | "deck"` fields.
- `PocketApp.artifactBundle(conversation, artifact, version?)` returns `{ meta, version, content, assets: { name, type, bytes }[] }`.
- `PocketApp.artifactAsset(conversation, artifact, version, name)` reads only one manifest asset.
- Both readers require the caller to check conversation access.
- `http/artifact-assets.ts` exports `ASSET_TYPES`, the frozen extension-to-MIME table, and `assetName(name)`, the safe path check.
- That module also exports `assetType(name)` with the binary fallback and `ARTIFACT_CSP` for isolated renderers.
- `zip(entries: { name: string; bytes: Buffer }[]): Buffer` writes ZIP32, with CRC32, UTF-8 names, and deflate when smaller.

## Serving choice and security

The server injects a `<base href>` before the page content when a version has assets.
The base is absolute, so inline source documents and run frames resolve URLs correctly.
An HTML asset gets its own directory as its base. Nested pages can use `../` links within the bundle.
The server injects the existing bridge into HTML assets under the existing frame rules.
Each asset response has the artifact sandbox CSP, `nosniff`, and `no-referrer`.
The file extension selects the MIME type. An unknown extension is `application/octet-stream`.
CORS allows opaque-origin module scripts and fonts. It does not grant access to any API.

Sandbox subrequests have no SameSite sign-in cookie.
Authenticated pages therefore receive a signed, version-scoped asset base: `/a/:conversation/:artifact/:version~person~expiry~signature/`.
The capability lasts 12 hours. It permits only manifest assets, not the main page, APIs, or arbitrary hashes.
HMAC-SHA256 signs the conversation, artifact, version, expiry, person, and person's token hash.
The existing persistent `ConfigStore.ownerToken` supplies the server key. No new data file is needed.
The signature input has a purpose label. `timingSafeEqual` compares the fixed-length signature bytes.
Every request rechecks the person's current session access. Removing the person or rotating a token revokes access.
A capability-authenticated HTML asset preserves the original expiry. It cannot renew its capability.
The usual authenticated `/a/:conversation/:artifact/:version/<name>` also works.
A page open for more than 12 hours loads new assets only after a reload.
The server creates capabilities only in HTTP responses. It does not store them in documents, tool results, or transcripts.
`artifactBody` and `artifactBundle` return raw content without injected capabilities, so normal agent readers do not receive them.
The capability code does not log URLs. Its errors use fixed messages and never include the capability.
Pages and assets send `Referrer-Policy: no-referrer`, so CDN requests do not receive the capability through `Referer`.

## Published routes

The integrator approved stream A's ownership of the serving changes in `src/server/http.ts` and `src/server/http/public.ts`.
`http.ts` now routes `/pub/:token/<name>` through `publicArtifact()` to the shared bundle responder.
`http/artifact-assets.ts` exports `publicArtifactBundle(app, request, response, token, name = "", query = new URLSearchParams())`.
The route passes `parts[1]` as the token and `parts.slice(2).join("/")` as the name.
The responder checks the share on every request and uses the share's pinned or latest version.
It gives public HTML no bridge. The same name check, MIME table, sandbox CSP, and `nosniff` protect public and private assets.
A latest-version link follows asset replacements, additions, and removals. A pinned link keeps its own manifest.
Ending or expiring a link closes its main page and every asset.
Tests use the real core HTTP handler, not an isolated route adapter.
Chromium also loads the bundle's fonts, images, CSS, and imported modules through a published link.

## Integration still needed

`room.ts:601` also needs to project `meta.group` and `meta.kind` for the workspace picker.
Stream A stores these fields but does not own `room.ts`.

Inline Run loads bundle assets correctly. Static Preview keeps its existing restrictive security boundary.
`web/rich.js:previewDocument()` removes base tags and stylesheet links, and its CSP permits only data images and fonts.
If static Preview must show bundle assets before Run, the integrator must add a safe preview path in `web/rich.js`.
Stream A does not own that file. The browser tests check inline Run, not static Preview.

The capability code does not send capabilities to Pi or logs, but generic output paths need an integration review.
`browser/page.ts` can log a signed URL after navigation to a bundled HTML asset.
An artifact can also explicitly include its base URI in a follow-up or saved value.
Absolute exclusion from all agent context, transcripts, and logs needs redaction in those browser and bridge paths.
Stream A does not own those files. The integrator received this limitation.

`npm run format` also fixes an existing unbraced `if` in `src/server/extensions/prompt.ts`.
This unrelated formatting change stays uncommitted in this worktree. The integrator must keep the brace fix for lint.
The reported full format and lint checks include that local brace fix.

## Documentation updates for the integrator

- `features.md`: artifacts can bundle files, inherit or replace assets, and group design variations.
- `features.md`: mention binary local assets, relative page links, and the per-version limits.
- `map.md`: add `http/artifact-assets.ts`, the bundle readers on `PocketApp`, and `zip.ts`.
- Release notes: designs can carry images, fonts, modules, styles, data, and extra HTML pages.
- Release notes: old single-file artifacts remain compatible. No stored kind changes semantics.

## Checks

- `npm run format`, `npm run check`, and `npm run lint` passed.
- The final complete `npm test` run passed after the 12-hour capability change: 762 tests, 0 failures, 0 skips, about 90 seconds.
- The bundle and ZIP tests passed together, including a real Chromium test.
- Tests cover inheritance, replacement, removal, hash storage, replay, unsafe sources, limits, capability scope, expiry, and revocation.
- Capability tests reject reuse across conversations, artifacts, and versions. They reject changed signatures and verify the 12-hour boundary.
- Restart tests verify that the existing signing key stays valid. Raw readers and tool results contain no injected capabilities.
- Tests cover sandbox headers, MIME types, public route revocation and expiry, pinned and latest manifests, nested pages, fonts, images, CSS, module imports, inline RunFrame, own-tab rendering, and published rendering.
- The focused bundle and share suites passed after the routing change: 19 tests, 0 failures.
- A fresh security review of the core routing changes found no concrete bugs.
- Fork and restart tests confirm that manifests and global asset bytes survive.
- `unzip -t` accepted an archive with a deflated HTML entry and a binary entry.
- A fresh, strong-model security review found no remaining concrete bugs after 3 fixes.
- The throwaway server ran with `node test/serve.ts 8901 127.0.0.2`.
- The mobile session loaded correctly, with no browser console errors. The server was stopped afterward.
- Manual checks did not seed an artifact in the echo-only throwaway model. Automated Chromium tests checked the actual bundle rendering.
