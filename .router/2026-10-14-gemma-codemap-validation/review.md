# Review: gemma-codemap validation run (2026-10-14)

Scope: `plan.md` vs `git diff` + `implement.md` + `evidence.md`. Method: reran the battery/app unit tests, parsed all three run-folder JSON artifacts, read the two loader files the claims depend on (`src/server/routers.ts`, `hq-router.ts`), and tried the inputs most likely to break (malformed candidate, stale/self-hit index, fast router id without block, skill-list mismatch).

Global: **clean on safety.** `git diff` is empty (zero tracked-file modifications); `git status --short` shows only untracked `.router/` and `.zvec-grep/`. No live config/skill/router/src edit, no restart, no model load, no VM250 contact, no secret values in any run file I read. Tests rerun here: battery suites (`read-economy`, `loop-guard`, `pruner`) **33/33 pass**, `app.test.ts` **32/32 pass**. The transparency is good: every unverified item is stated as such in `evidence.md`, and the `hq-router.ts` id-matching constraint was correctly caught, not glossed over.

Findings (all in run-folder drafts/samples or rating wording — nothing in production to fix):

## 1. `muse-router-fast.json`: `dispatcher` object is silently dropped by the loader (minor, draft-only)
- File: `.router/2026-10-14-gemma-codemap-validation/muse-router-fast.json` (top-level `"dispatcher"` key)
- Breaks against: `src/server/routers.ts:59` (`dispatcher?: boolean`) and `:541` (`...(raw.dispatcher === true ? { dispatcher: true } : {})`)
- Input that breaks it: register this exact JSON as a custom router. `raw.dispatcher` is an object, never `=== true`, so the loader strips it without error. The `blockedTools: [bash, edit, write]` + width-1 note would be documented intent only — zero enforcement.
- What goes wrong: nothing today (file is explicitly unregistered, parses fine — confirmed `json.load` ok, pipeline plan→implement→review→fix→ship matches live shape). But if the implement stage copies this file into `~/.pi-pocket/routers/` expecting the block, the dispatcher would run unblocked on its cloud model (`opencode-go/muse-spark-1.3-contributor`, same as live — not `router-fast`), compounding finding 2. Fix (later, not here): either `"dispatcher": true` plus enforcement keyed off router id, or keep the object as a comment-sidecar and name the real enforcement point (`hq-router.ts` model-id match or a `routers.ts` schema extension).

## 2. Fast-path tool block confirmed absent for the new id — plus the skill side is safe (confirms evidence §4, sharpens it)
- Files: candidate `muse-router-fast.json` (`"id": "muse-router-fast"`, `"model": "opencode-go/muse-spark-1.3-contributor"`); `/home/tcrypt/.pi-pocket/extensions/hq-router.ts:117-130` (`fastRouters` set), `:172-180` (`id === "router-fast"` adds; block keyed by conversation in that set)
- Input that breaks it: run router id `muse-router-fast` on any model other than `router-fast` (exactly what the candidate specifies) and attempt `edit` on the dispatcher conversation.
- What goes wrong: no block fires — `fastRouters` only ever contains conversations whose last rendered router model id was literally `router-fast`. Evidence already states this; I verified the code path, so this is a confirmed constraint, not just UNCLEAR. Counterpoint (good news, not in evidence): the skill-trim side does NOT break — `hqRole` (`hq-router.ts:~91-104`) returns `"router"` for any router-editor session on any model, and `"router"` exists in `skills.json` (21 skills). So the new id gets the router skill list, just no tool block. Recommendation for implement: either run the fast router on model id `router-fast`, or extend `PROMPTS`/`routerModel()` id matching before claiming width-1/dispatcher behavior.

## 3. `handoff.sample.json`: `file:line` claims don't point at what they claim (minor, exemplar-quality)
- File: `.router/2026-10-14-gemma-codemap-validation/handoff.sample.json` (single-line JSON; findings array)
- Input that breaks it: follow the sample's own contract ("every claim carries file:line") — finding 1 claims `src/server/reload.ts:42` = "Loop-guard ORDER position". Actual `reload.ts:42` is `"triggers.ts",` (loop-guard is at line 44; read-economy at 43). Finding 2 claims `loop-guard.ts:1` for third-call-block behavior; line 1 is the `/**` opener of a ~10-line doc comment (accurate only in the loosest sense).
- What goes wrong: as a throwaway sample, nothing executes, so no behavior breaks. As the schema's exemplar for future stages, it teaches "approximate line numbers are fine," which defeats typed handoffs. Suggested correction (implement stage): point at `reload.ts:44` and `loop-guard.ts:2-3` (the actual behavior sentence), and validate the sample against the schema with a real validator — `json.load` parsing (the only check run) accepts a finding missing `line` entirely, so the "required" contract is currently untested. I confirmed a `{"file","claim"}`-without-`line` object parses fine while violating `handoff.schema.json` required `["file","line","claim"]`.

## 4. Copy-DB retrieval hit is partly self-referential (weakens, doesn't void, the embed2 VALIDATED)
- File: `evidence.md` §1 (`VALIDATED: same 3 queries on copy-DB hit sane files`)
- Input that breaks it: query 1 ("loop guard…") top-hit `handoff.sample.json` — a file this run itself wrote, indexed as part of the 273-file copy (run folder was inside the indexed tree).
- What goes wrong: 1 of 3 validation queries is circular (query terms match the sample text the run authored). Queries 2–3 hit real product files (`test/read-economy.test.ts`, `src/server/routers.ts`), and dims (768/768) plus the 2334-chunk reindex are solid, so VALIDATED-on-copy still stands on balance — but the report should mark Q1 as contaminated and, for the production cutover decision, re-run Q1 with `.router/` excluded (or quote a product-file hit). Also still open per evidence: mixed nomic+gemma vector comparability (copy reindexed from scratch), correctly left as UNCLEAR.

## 5. `batteries VALIDATED` overstates against the plan's own bar (wording only)
- Files: `implement.md` (Ratings line), `evidence.md` §3, vs `plan.md` step 3 (`VALIDATED = steps 2–4 all pass on the copy`, where step 3 is the four per-behavior exercises: 500-line map, malformed-call repair, triple-call block, prune note)
- What goes wrong: the per-behavior exercises were explicitly NOT run (no browser/scripted-model UI run — openly stated in "What not verified"). What did pass: copy-server boot ×2, loader-name presence 1/1, unit tests 33/33 + 32/32 (all rerun green here). That is genuine substance, and nothing is hidden — but by the plan's written criterion the rating should read **TESTED + unit-VALIDATED** (or VALIDATED-pending-behavior), not unqualified VALIDATED. One-line fix in the implement/evidence ratings; no rework needed if the implement stage runs the four behaviors on the copy.

## 6. Non-findings (checked, clean)
- Malformed-JSON robustness: candidate files parse; a loader receiving `'{bad json'` fails closed (`ValueError`), and minimal `'{"id":"x"}'`/`'[]'` inputs parse but carry no pipeline — no crash path introduced, since nothing loads these drafts.
- Skill-list mismatch: no mismatch exists. Candidate stage `skills` (`poteto-mode`, `blast-radius`, `unslop`) mirror the live router's; `skills.json` role lookup falls back safely (finding 2). `router-fast` absence from `skills.json` roles is expected (it's a model id, not a role).
- Stale-index handling: evidence correctly attributes the live-DB "read economy" miss to coverage (oh-my-pocket unindexed; only `homelab` in `list_repos`), not to the embedder — the right call, with timestamps recorded.
- Gemma4: read-only posture held (git log + entry/member-line presence); prior-run load figures labeled as such, not re-proven. Correct.
- `.zvec-grep/` untracked dir: present in `git status` alongside `.router/`; implement.md disclaims it. I did not verify ownership — taking the disclaimer at face value, no action.

## Verdict
**Suitable to proceed to production proposal with the five notes above addressed in passing** (dispatcher shape, fast-id block code change, handoff line numbers + real schema validation, Q1 re-query minus `.router/`, batteries rating wording). No re-validation run needed: no production file changed, tests are green on rerun, constraints were found rather than missed, and every gap is already written down as a gap.
