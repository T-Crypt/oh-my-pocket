# Fix report: gemma-codemap review findings (2026-10-14)

Run-folder only. No live config/skill/router/src edit, no restart, no model load, no VM250 contact, no secrets printed.

## Finding 1 — `muse-router-fast.json` dispatcher object dropped by loader
- Changed: top-level `"dispatcher": {blockedTools..., note...}` → `"dispatcher": true`, plus a `_dispatcherNote` sidecar string carrying the width-1 intent, blockedTools list, and the real enforcement pointer (`hq-router.ts` `fastRouters` keyed on model id `router-fast`).
- Proof: `node` eval of the exact loader expression from `src/server/routers.ts:541` (`...(raw.dispatcher === true ? { dispatcher: true } : {})`) against the fixed file → `loader keeps dispatcher: {"dispatcher":true}`. Before the fix the object form failed the `=== true` check and was stripped silently.

## Finding 2 — fast-id tool block absent, skill side safe
- Changed: `evidence.md` §4 rewritten from "UNCLEAR … finding" to **CONFIRMED CONSTRAINT** (code path `hq-router.ts` ll.117-130, 172-180 verified: `fastRouters` only contains conversations whose last rendered router model id was literally `router-fast`; new id `muse-router-fast` on a cloud model gets no tool block without running on model `router-fast` or extending `PROMPTS`/`routerModel()` id matching). Added the verified safe side: `hqRole` (~91-104) returns `"router"` for any router-editor session on any model and `"router"` exists in `skills.json` (21 skills) — new id gets the router skill list, just no tool block.
- Proof: code re-read at the cited lines during this fix; `muse-router-fast.json` `_dispatcherNote` now names the same enforcement point so a future copy-paste into `~/.pi-pocket/routers/` carries the warning.

## Finding 3 — `handoff.sample.json` line refs wrong
- Changed: finding 1 `src/server/reload.ts:42` → `:44`; finding 2 `loop-guard.ts:1` → `:2` with the claim text noting the behavior sentence spans lines 2-3 (schema requires integer `line`, so the range lives in the claim, not the number).
- Proof: `sed -n '43,45p' src/server/reload.ts` → line 44 is `"loop-guard.ts",`; `sed -n '2,3p' src/server/extensions/loop-guard.ts` → the third-identical-call-blocked sentence. Schema check passes: required keys (`goal, project, findings, nextSteps`; per-finding `file, line, claim`) present and `line` is int — a `{"file","claim"}`-without-`line` object would now fail this check, closing the "parses fine while violating required" gap the review demonstrated.

## Finding 4 — embed2 Q1 self-referential hit
- Changed: `evidence.md` §1 VALIDATED line qualified; added explicit CONTAMINATED note: Q1 ("loop guard…") top-hit `handoff.sample.json`, a file this run authored inside the indexed 273-file copy tree — 1 of 3 queries circular. VALIDATED-on-copy now rests on Q2+Q3 (real product files) + 768/768 dims + 2334-chunk reindex.
- Proof/required follow-up (stated in evidence, not runnable from here without reindexing a copy): re-run Q1 with `.router/` excluded from the indexed tree before any production cutover decision. Mixed nomic+gemma vector comparability remains UNCLEAR as before.

## Finding 5 — batteries VALIDATED overstates plan bar
- Changed: `evidence.md` §3 heading/rating → **TESTED + unit-VALIDATED (per-behavior exercises pending)** with the reasoning (plan step 3 requires the four per-behavior exercises: 500-line map, malformed-call repair, triple-call block, prune note — explicitly not run, no browser/scripted-model UI run). Same one-line correction applied to the Ratings line in `implement.md`.
- Proof: nothing hidden — the "not verified" list already said so; only the rating word changed.

## Tests rerun
- `node --test test/loop-guard.test.ts test/pruner.test.ts test/read-economy.test.ts` → **33/33 pass**.
- `node --test test/app.test.ts` → **32/32 pass**.
- `git status --short` → only untracked `.router/` + pre-existing untracked `.zvec-grep/`; `git diff --stat` empty (zero tracked-file modifications).

SELF-CHECK: each of the 5 review findings fixed in the run folder only (fast JSON dispatcher true, handoff line refs, evidence wording batteries TESTED+unit-VALIDATED, embed2 Q1 contamination + rerun note, fast-id confirmed-constraint + skill-safe note); proofs run and outputs read (loader expr, schema check, sed line verification, 33/33 + 32/32 tests, git status clean); no live config/skill/router/src edit, no restart, no model load/evict, no VM250/proxmox contact, no secrets printed.
