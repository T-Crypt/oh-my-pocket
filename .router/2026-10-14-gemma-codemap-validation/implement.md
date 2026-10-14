# Implement report: gemma-codemap validation (2026-10-14)

Validation-only. No production file changed: `git status --short` shows only untracked `.router/` (this run) and pre-existing untracked `.zvec-grep/`; zero modifications to tracked files. (`.zvec-grep/` is not mine — never wrote there.)

## What changed (run folder only, all new files)

- `.router/2026-10-14-gemma-codemap-validation/evidence.md` — per-improvement SEEN/TESTED/VALIDATED log (the full record; see it, not this file, for quotes and numbers).
- `.router/2026-10-14-gemma-codemap-validation/muse-router-fast.json` — fast-path candidate draft (parses; NOT registered).
- `.router/2026-10-14-gemma-codemap-validation/handoff.schema.json` + `handoff.sample.json` — typed-handoff schema + sample (both parse).
- `.router/2026-10-14-gemma-codemap-validation/plan.md` — input (pre-existing).
- This file.

## Commands + key output

- Baseline reads: ORDER/batteries headers quoted; live `enabledExtensions` = 10 drop-ins, four batteries absent; embed2 + Gemma4 config blocks quoted; `muse-router.json` pipeline plan→implement→review→fix→ship; `skills.json` 19 roles (coder=13 skills); `hq-router.ts` fast-block + skill-trim logic read.
- Embed dims (loopback :9090, resident CPU models, no load initiated): nomic **768**, gemma **768**.
- Copy-DB reindex under gemma (`CODEVEC_DB=/tmp/codevec-copy.db`, MCP stdio): 273 files, 2334 chunks. Same 3 queries hit `test/read-economy.test.ts`, `src/server/routers.ts` (+ own sample file). → embed2 VALIDATED on copy.
- `list_repos` (live): only `homelab` (1108 files, indexed today) — **oh-my-pocket unindexed, coverage gap**; live "read economy" query MISSED.
- Copy server `node test/serve.ts` booted clean twice on 127.0.0.2:8899 (sign-in links, no errors).
- Throwaway enable test (scripted model, temp data): all four batteries → loader names present, 1/1 pass. Deleted after.
- Unit tests: loop-guard+pruner+read-economy **33/33**; `app.test.ts` **32/32**.
- Fast-path constraint found: `hq-router.ts` block keys off model id `router-fast`, not router id — new `muse-router-fast` id gets no tool block without running on `router-fast` model or a code change.
- Gemma4: git log 5 entries + entry/member lines present (read-only); prior-run load figures recorded, not re-proven; no load/evict here.
- Cleanup: copy servers killed (temp data auto-deleted), `/tmp/codevec-copy.db` + temp req/test files removed.

## What not verified

- Nomic-vs-gemma vector comparability in a mixed DB (copy test re-indexed from scratch).
- Live `index_repo` for oh-my-pocket (deferred to operator: needs embedder choice).
- Per-behavior battery exercises (500-line map, malformed-call repair, triple-call block, prune note) — no browser/scripted-model UI run.
- Copy-server stage-dispatch dry run for fast path; skill-trim render on a cloud-model session + token delta; handoff consumption test by a plan-shaped stage.
- Gemma4 copy-server multi-turn + tool-call transcript (implement stage's first step; GPU shared).

## Ratings

embed2 VALIDATED (copy; Q1 marked contaminated, re-query with .router/ excluded required before cutover) · coverage TESTED (gap found) · batteries TESTED + unit-VALIDATED (per-behavior exercises pending) · fast-path TESTED (constraint confirmed: block keys off model id router-fast; skill-trim safe for new id) · skills TESTED · handoffs TESTED (sample line refs corrected) · gemma4 SEEN + prior TESTED.

SELF-CHECK: plan followed step by step; only throwaway copies touched (copy server temp dirs, CODEVEC_DB=/tmp/...); no live config/skill/router/src edit, no restart, no model load/evict, no VM250/proxmox contact, no secrets printed; proof commands run and outputs read; tests 33/33 + 32/32 + 1/1 green; git status confirms no tracked-file changes; evidence.md written with UNCLEAR items stated, not guessed.
