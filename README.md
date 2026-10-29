<div align="center">

# Oh-My-Pocket

**Pi Pocket, tuned for local models.**

A durable, multiplayer, mobile-first web app for Pi agents, built on [Pi Durable](https://earendil.com/posts/pi-durable/).<br>
Runs on your own machine or directly on your phone. No cloud VM.<br>
A fork of [TannerMidd/pi-pocket](https://github.com/TannerMidd/pi-pocket) with the context batteries from [oh-my-pi](https://github.com/can1357/oh-my-pi) ported in.

[![Release](https://img.shields.io/github/v/release/TannerMidd/pi-pocket?color=7aa2f7)](https://github.com/TannerMidd/pi-pocket/releases)
[![Node.js 22.19+](https://img.shields.io/badge/node-%E2%89%A5%2022.19-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![MIT license](https://img.shields.io/badge/license-MIT-ff9e64)](LICENSE)

[Website](https://tannermidd.github.io/pi-pocket/) · [Quick start](#quick-start) · [Feature tour](docs/features.md) · [Docs](https://tannermidd.github.io/pi-pocket/docs/)

<img src="docs/showcase-0.12.1.png" alt="Pi Pocket in the Tokyo Night theme, on a desktop and a phone. On the desktop, the session list beside a conversation where Pi has fixed a sign-in redirect loop, its edits and a passing run of 48 tests folded into a timeline. On the phone, the same session after a teammate, Alex, asks for the push: Lancet Guard waits for approval before git push." width="100%">

</div>

## What this fork adds

Oh-My-Pocket keeps Pi Pocket whole and adds what a self-hosted model on one GPU needs: a small, stable prompt prefix, no
surprise model swaps, and a plan mode that can read the project board. Each change ships with tests, and each one that
touches the prompt is measured against oh-my-pi (OMP) on the same task, model, and server.

`oh-my-pocket` is the default branch. `main` mirrors Pi Pocket: upstream changes land there first, get reviewed, and
only then merge into `oh-my-pocket`.

### Batteries

| Battery                         | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                     | Measured                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Agent definitions               | `subagent` spawn takes `agent: <name>` and loads `~/.pi-pocket/agents/<name>.md`: role instructions, model, thinking level, and tools; `skills: [...]` adds skills it reads first. Pipelines (plan, implement, review) run each stage as its own role.                                                                                                                                                                                           | 5 tests                                                                               |
| Background compaction off       | `compaction.backgroundTokens` in Pi's settings now reaches Pi Durable; `0` turns it off. A local server answers one request at a time, so a background summary only queues behind the turn it was meant to overlap.                                                                                                                                                                                                                              | 3 tests                                                                               |
| Titles on the session's model   | A session's own model writes its title, never a cheaper one picked on the side: nobody chose that one, and it may cost what nobody agreed to. It started as a free-model carve-out (on a one-GPU server, a `*-mini` load pushed the session's model out of VRAM for a six-word title); upstream's 0.13.1 made it the rule for every session.                                                                                                     | no model swap before the first turn (about 40 s each way here)                        |
| Plan mode reads the board       | Tools can mark which calls only read (`host.readOnlyCalls`), and plan mode lets those through: listing and reading board tickets, say. `git -C <dir>`, `git branch -a`, and output sent to `/dev/null` count as reads too.                                                                                                                                                                                                                       | 19 new test cases; the 4 calls a real plan session got blocked on now pass            |
| Per-role skill catalog (recipe) | A drop-in wraps the `skills` section (Pi Durable's `wrapSection`) and renders it from the session role's own list. Pi otherwise sends its whole catalog on every request.                                                                                                                                                                                                                                                                        | router start context 19,395 to 13,133 tokens                                          |
| Context meter                   | `/context`, a tap on the status-line meter, or `GET /api/c/:id/context`: the context split into prompt sections, tool schemas, and history by kind, scaled to the newest measured prompt. Every A/B reads its own numbers.                                                                                                                                                                                                                       | within 0.1% of the measured prompt; 3 tests                                           |
| Waiting subagents               | `subagent` spawn and send take `wait: true` and return the answer as the call's result. The parent writes nothing while a stage runs, so on a one-slot server the stage keeps its cache. A stopped waiting call still gets its answer as a report.                                                                                                                                                                                               | cached share 60% to 90%; 2 tests                                                      |
| Prune before summarising        | Compaction first replaces its range with a note that costs no model call: old tool output masked to one line each, the newest results kept in full, stale re-reads and loops dropped; the LLM summary runs only when the note would still leave the context over its limit. `compaction.pruneToolOutput` and `pruneKeepLast` in Pi's settings.                                                                                                   | 9 tests; no second model call in the common case                                      |
| Loop guard                      | The third identical tool call in one turn is blocked (the block says so when the earlier runs failed), and the system prompt says the same in one line; a file edit re-arms reads and shell checks, so test, fix, test is not a loop; a restart-interrupted call is not a failure, and a fresh person's message re-arms it. Call arguments a model wrote slightly wrong (a JSON string where the object belongs) are repaired before validation. | 10 tests; research measured 30K to 8.9K prompt tokens, under 20% to 100% solve        |
| Read economy                    | A read without an explicit limit returns at most five hundred lines, and the result carries a structural map of the part it did not read: how many lines remain and where the sections sit. To see more, the model reads on with an offset and a limit.                                                                                                                                                                                          | 6 tests; keeps whole-file dumps out of a small model's context                        |
| KV-prefix discipline            | The system prompt is byte-stable and append-friendly: the one line that changes on its own (the day) sits in the last section of each pack, behind drop-ins' sections too, so a cache hit stays a hit through the day instead of re-prefilling the tail. Pinned by test for sessions, PiP, and drop-ins.                                                                                                                                         | the date's flip re-prefills one short line, not the pack                              |
| Context baseline                | `/context baseline` (or a tap on the status line) takes a meter of where the context goes; the next `/context` lines it up against that and names the rows a change touched, before and after, biggest moves first. `/context clear` puts the meter back on its own.                                                                                                                                                                             | 4 tests; names the row a prompt, tool, or skill change lands on                       |
| Lean prompt                     | Seldom-used tools (artifacts, design, codemode, background, schedules, PR watches) are offered on request: a one-line list and `load_tools`, not their schemas and guides.                                                                                                                                                                                                                                                                       | 15,904 → 7,312 prompt tokens per request; tools that made 0.4% of 27,163 real calls   |
| One GPU, many sessions          | Requests to llama-swap take turns by model (role names resolved from `/v1/models`); a run keeps the card between its tool calls; the status line shows a model loading or waiting; a session's local model starts loading while you write.                                                                                                                                                                                                       | two agent runs on two models: 2 swaps instead of one per turn (test/gpu-lane.test.ts) |
| Browser use per session         | A Browser switch by the message box; off, the tool and its guide are not in the prompt. On, Pi asks before new sites, the local network, sign-ins, forms, purchases, deletions, and scripts, as the owner sets; it never types passwords.                                                                                                                                                                                                        | 4 tests (test/browser-use.test.ts)                                                    |
| Lighter server                  | Changes counts new files in-process instead of a git process per file; the server's young generation and old space are capped.                                                                                                                                                                                                                                                                                                                   | on a copy of real data: spawn time 548 → 136 ms, RSS 401 → 298 MB                     |

Router start context, the tokens sent before the first word of every request: Pi Pocket with a router prompt 22,726;
OMP 15,900; Oh-My-Pocket 13,226 (llama-swap `/api/metrics/activity`, probe "Reply with just: ok", 2026-10-11).

Same T2 job (add `subtract(a, b)` with a pytest test: plan, implement, review, one model, one GPU), 2026-10-11:

| Harness                     | Wall  | Requests | Prompt tokens | Cached | Prefilled | Output | Result                 |
| --------------------------- | ----- | -------- | ------------- | ------ | --------- | ------ | ---------------------- |
| OMP                         | 213 s | 41       | 685,014       | 81%    | 130K      | 20,009 | 2 passed, review clean |
| Oh-My-Pocket, before `wait` | 187 s | 34       | 468,160       | 60%    | 186K      | 13,880 | 2 passed, review clean |
| Oh-My-Pocket, `wait`        | 179 s | 36       | 470,091       | 90%    | 47K       | 14,252 | 2 passed, review ship  |
| Oh-My-Pocket, batteries     | 145 s | 31       | 397,605       | 75%    | 99K       | 13,395 | 3 passed, review clean |

The batteries row is the median of three runs on NInfer v3 (2026-10-11 evening; 136, 145 and 181 s), alternating with
the build before the batteries on the same engine: 166, 184 and 256 s, median 476K prompt, 104K prefilled, 18.4K
output. On a three-file repository the batteries barely fire, so the gap sits inside run-to-run noise: they cost
nothing here. With a 1,007-line file to edit, read economy fires (4 maps over two runs) and the median prefill falls
from 156K to 139K tokens (298 s against 307 s); two runs each, so a direction, not a result.

### Building a router on it

A router is made in the editor, and its prompt is written from its stages. Drop-ins in
`~/.pi-pocket/extensions/` add to that, so Oh-My-Pocket itself stays general:

- **Router prompt.** A `section` that adds the router's instructions when the session's model is the router model,
  and stays out of subagents.
- **Board tools.** One tool per MCP server (`ome {call, args}`) costs a fraction of one schema per call. The drop-in
  puts its read-only calls in `host.readOnlyCalls`, so plan mode can read the board.
- **Skills per role.** A `wrapSection("skills", ...)` that filters `host.skills(cwd)` to the role's list and renders it
  with Pi's `formatSkillsForPrompt`. `/skill:<name>` still loads any skill.
- **Stage roles.** Agent definitions, one per stage, each naming its model and tools, spawned with `wait: true`.

[docs/extensions.md](docs/extensions.md) covers the host members and hooks these use.

### Measuring a change

Run the same task in OMP and in Oh-My-Pocket against the same llama-swap server, then read
`/api/metrics/activity` (paged, newest first) for prompt tokens, cache hits, output, and wall time. A battery stays only
if it holds or improves those numbers without lowering the result.

### Next

Ported from OMP and DeepSeek Harness (both MIT), ranked by measured cost on local models: hash-anchored `edit`
(A/B only, never ported blind), LSP diagnostics after an edit, suppression of a file read a second time this turn,
and subagent handoff hygiene - the child gets file pointers and a typed result schema, nothing else.
[docs/RESEARCH.md](docs/RESEARCH.md) holds the full survey with its measurements.

## Highlights

- **Durable.** Every model call, tool call, and subagent is stored as it happens. Restart the server mid-run, and the work continues.
- **Multiplayer.** Share a live session with presence, a side chat Pi does not see, invites, and roles.
- **Made for phones.** Push notifications, dictation, sharing into Pi from other apps, and a home-screen app.
- **PiP.** An assistant that starts, follows, and reports on your other sessions, and watches GitHub for you.
- **Your models.** Pi's own providers, sign-ins, skills, and prompt templates, with the model chosen per session.
- **Live-editable.** No build step. Pi can change Pi Pocket while it runs, and you can add your own extensions.

The [feature tour](docs/features.md) covers everything else, from plan mode and peek tiles to the built-in browser.

## Quick start

Requires Node.js 22.19 or newer. Runs on Linux, macOS, Windows, and Android (Termux); Linux is the most tested. Sign in to a provider with Pi first (`pi`, then `/login`), or later from the app's Providers sheet.

```bash
git clone -b oh-my-pocket https://github.com/T-Crypt/oh-my-pocket.git
cd oh-my-pocket
npm install
npm start
```

The launcher asks how your devices should connect, then prints a sign-in link and a QR code. The link is the owner's key: keep it private. `--rotate-token` replaces it and signs out every device that used it.

While it runs: **q** quit · **r** restart server · **a** change access · **o** open in browser · **s** show QR code.

**Updating:** Menu → **Update Pi Pocket** updates a git checkout run with `npm start`, or a global npm install (`npm install -g pi-pocket`) that your user can write, and restarts. It goes back by itself if the new version does not start ([features](docs/features.md)). A local install (`npm install pi-pocket` in a project) and `npx pi-pocket` do not update from the app: the sheet says what to run, `npm install pi-pocket@latest` or `npx pi-pocket@latest`. By hand: stop the server, back up `~/.pi-pocket`, pull, run `npm install`, and start again; for a global install, run `npm install -g pi-pocket@latest`. If the machine stops at the very moment of the switch, `pi-pocket` may not start; `npm install -g pi-pocket` restores it. Read the [release notes](https://github.com/TannerMidd/pi-pocket/releases) first: 0.21.0 upgrades the database one way, so going back needs the backup.

### Other ways to run it

- **Any provider, any model.** Uses Pi's own model runtime and sign-ins, skills, and prompt templates, with the model and thinking level chosen per session, and the models a provider offers the pickers chosen (and switched one by one) in the Providers sheet.
- **Artifacts and subagents.** Sandboxed HTML, Markdown, and SVG artifacts, and background subagents you can open and talk to. The Subagents chip in the message box, or `/subagents`, sets which models they may run on besides the session's own.
- **Routers.** A router checks each task and runs it through its stages, each a fresh subagent on the model and effort you choose. The rail's **Routers** button (Menu → Routers, and the Routers place on a phone) opens the editor: a stage is a card with its template, its words, the skills it reads first, its model, and its effort, and the router's prompt is written from them. Pi Pocket ships **Standard** (Plan, Implement, Review, Fix, Ship), saved routers live in `~/.pi-pocket/routers/<id>.json`, routers already on this machine show read-only under **From this machine**, and **Use in this session** or the model picker's **Routers** group runs a session on the router's model until a plain model is picked.

- **Docker or Podman:** `docker compose up -d --build`. See [docs/docker.md](docs/docker.md).
- **Nix:** `nix run github:TannerMidd/pi-pocket`, or the NixOS module `services.pi-pocket.enable = true;` ([nix/module.nix](nix/module.nix)).
- **Android (Termux):**

    ```bash
    pkg update && pkg upgrade && pkg install nodejs git
    npm install -g --ignore-scripts @earendil-works/pi-coding-agent
    pi    # /login, then quit
    git clone https://github.com/TannerMidd/pi-pocket.git
    cd pi-pocket && npm install --ignore-scripts && termux-wake-lock && npm start
    ```

    Lancet Guard may not load on Android. If it is on but fails, start with `PI_POCKET_GUARD=off`.

## Remote access

Choose a mode in the launcher, or pass `--access`:

| Mode         | Who can connect      | Notes                                                    |
| ------------ | -------------------- | -------------------------------------------------------- |
| `local`      | This machine         | `127.0.0.1`; bring your own tunnel to port 8787          |
| `lan`        | Your local network   | Plain http                                               |
| `cloudflare` | Anyone with the link | Free https quick tunnel, no account; needs `cloudflared` |
| `tailscale`  | Your tailnet         | Tailscale address only                                   |

Other options: `--port` (8787), `--cwd`, `--data` (`~/.pi-pocket`), `--host`, and `-y` to reuse the last access choice. `npm start -- --help` lists them all. `PI_POCKET_BROWSER` and `PI_POCKET_BROWSER_ARGS` pick the built-in browser and its flags when Chromium or Chrome is not found by itself. `PI_POCKET_PROMPT_DATE=1` puts today's date in Pi's system prompt; it is left out by default, so the prompt cache does not start over when the date changes. `PI_POCKET_CACHE_KEEPER=off` turns off the prompt cache keeper, which keeps a model's prompt cache warm while a run waits on a tool call ([features](docs/features.md)).

> [!WARNING]
> Anyone who can steer a session can make Pi run commands on this machine, as you. That reaches your files, Pi Pocket's own settings and tokens, and its code. Invite only people you would trust at your keyboard. View-only users cannot make Pi act. [SECURITY.md](SECURITY.md) says what is protected and what is not.

## Documentation

- [Feature tour](docs/features.md): every feature, in full.
- [Docs site](https://tannermidd.github.io/pi-pocket/docs/): customizing Pi without code, and writing extensions.
- [Engineering](https://tannermidd.github.io/pi-pocket/engineering.html) and [code map](docs/map.md): how Pi Pocket is built.

## Development

```bash
npm run check       # type-check
npm test            # server tests with a scripted model
npm run check:web   # type-check web/; the files marked clean must stay clean
npm run coverage    # the tests with line coverage, held at 60%
npm run format      # ESLint's layout fixes, then Prettier
npm run lint        # check the layout rules
```

`web/` changes reload every open browser, and extensions reload into the running server. `node test/serve.ts` runs a throwaway copy to check a change on. [AGENTS.md](AGENTS.md) covers editing Pi Pocket safely from inside itself, and [CONTRIBUTING.md](CONTRIBUTING.md) how to send a change.

## Limitations

- Pi Durable is experimental, and its API can change between releases. Versions are pinned in `package.json`.
- Only one server process can use the database at a time.
- Pi's own extensions are not supported. Pi Pocket runs its own, on Pi Durable.
- A git worktree keeps a session's files apart; it is not a sandbox.
- The built-in browser needs Chromium, Chrome, Brave, or Edge on the server. It is tested on Linux and macOS.

The [full list](docs/features.md#limitations) has the details.

## Credits and license

Inspired by [Mario Zechner's demo](https://x.com/badlogicgames/status/2106452296087302173) of his own Pi app. Pi Pocket is an independent project, not affiliated with Earendil. The bundled fonts keep their own licenses, which are beside them in [web/fonts/](web/fonts/).

[MIT](LICENSE). To report a security problem, see [SECURITY.md](SECURITY.md).
