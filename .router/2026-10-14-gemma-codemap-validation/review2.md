# Review2: gemma-codemap fix verification (2026-10-14)

Scope: `review.md` 5 findings vs `fix.md` + current run-folder files + `evidence.md` + `implement.md`. Method: re-read fixed files, re-evaluated loader expression, re-checked cited source lines, re-validated schema/sample, reran battery + app suites, checked `git diff` / `status`. Edit: none (this file only).

Global: **safety clean.** `git diff --stat` empty (zero tracked-file modifications); `git status --short` shows only untracked `.router/` + `.zvec-grep/`. No live config/skill/router/src edit, no restart, no model load, no VM250 contact, no secret values seen. Tests rerun here: battery suites (`loop-guard`, `pruner`, `read-economy`) **33/33 pass**, `app.test.ts` **32/32 pass**.

## Finding 1 — dispatcher shape: FIXED
- File: `muse-router-fast.json` now has top-level `"dispatcher": true` (was object) + `_dispatcherNote` string sidecar.
- Proof: `node` eval of `src/server/routers.ts:541` expression against the fixed file → `loader keeps dispatcher: {"dispatcher":true}` (object form would have been stripped by `=== true`). Stages still plan→implement→review→fix→ship; sidecar is `string` (dropped on registration, no loader impact).
- Remaining: none in the draft. The sidecar correctly points at `hq-router.ts` `fastRouters`/model-id enforcement so a future copy into `~/.pi-pocket/routers/` carries the warning.

## Finding 2 — fast-id block constraint: FIXED (wording + warning)
- File: `evidence.md` §4 now reads CONFIRMED CONSTRAINT (was UNCLEAR), citing `hq-router.ts` ll.117-130 + 172-180; candidate `_dispatcherNote` names the same enforcement point.
- Proof: re-read the code path here — `fastRouters` set keyed by rendered router model id literally `router-fast`; `id === "router-fast"` adds, else deletes; block fires only for conversations in that set. New id `muse-router-fast` on cloud model gets the router skill list (`hqRole` → `"router"`, exists in `skills.json`) but no tool block without (a) running on model `router-fast` or (b) extending `PROMPTS`/`routerModel()` id matching. Correctly stated.
- Remaining: none. Code change itself is correctly deferred to implement.

## Finding 3 — handoff line refs: FIXED
- File: `handoff.sample.json` finding 1 now `reload.ts:44`, finding 2 `loop-guard.ts:2` (claim notes behavior spans 2-3; schema requires int `line`).
- Proof: `sed -n '43,45p' src/server/reload.ts` → line 44 is `"loop-guard.ts",`; `sed -n '1,5p' .../loop-guard.ts` → behavior sentence ("third exactly identical…blocked") starts line 2. Schema check: required top keys + per-finding `file,line,claim` present with int `line`; a `{"file","claim"}`-without-`line` object correctly fails (closes the "parses fine while violating required" gap).
- Remaining: none.

## Finding 4 — embed2 Q1 contamination: FIXED (wording + follow-up)
- File: `evidence.md` §1 now carries explicit CONTAMINATED note (Q1 top-hit `handoff.sample.json`, self-authored inside the 273-file copy tree → circular) and rests VALIDATED-on-copy on Q2+Q3 (real product files: `test/read-economy.test.ts`, `src/server/routers.ts`) + 768/768 dims + 2334-chunk reindex.
- Required follow-up is stated, not runnable from here without reindexing a copy: re-run Q1 with `.router/` excluded before any production cutover. Mixed nomic+gemma comparability still UNCLEAR — correctly left so.
- Remaining: none for this stage. Do not claim production cutover readiness until the Q1 re-query lands.

## Finding 5 — batteries rating wording: FIXED
- Files: `evidence.md` §3 heading/rating → **TESTED + unit-VALIDATED (per-behavior exercises pending)**; same correction in `implement.md` Ratings line.
- Proof: rating now matches plan step 3's bar (four per-behavior exercises: 500-line map, malformed-call repair, triple-call block, prune note — explicitly not run). Substance stands: copy boot ×2, loader names 1/1, 33/33 + 32/32 green on rerun here.
- Remaining: none for wording. The four behavior exercises remain the implement stage's job on the copy.

## Verdict
**Clean — all 5 findings fixed, no remaining issues.** No re-validation run needed: drafts corrected in the run folder only, ratings match the plan's bar, constraints are stated as constraints, tests green on rerun (33/33 + 32/32), `git diff` empty.
