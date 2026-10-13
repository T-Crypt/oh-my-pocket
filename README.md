<div align="center">

# Oh-My-Pocket

**Pi Pocket, tuned for local models.**

A durable, multiplayer, mobile-first web app for Pi agents, built on [Pi Durable](https://earendil.com/posts/pi-durable/).<br>
Runs on your own machine or directly on your phone. No cloud VM.<br>
A fork of [TannerMidd/pi-pocket](https://github.com/TannerMidd/pi-pocket) with the context batteries from [oh-my-pi](https://github.com/can1357/oh-my-pi) ported in.

[![Release](https://img.shields.io/github/v/release/TannerMidd/pi-pocket?color=7aa2f7)](https://github.com/TannerMidd/pi-pocket/releases)
[![Node.js 22.19+](https://img.shields.io/badge/node-%E2%89%A5%2022.19-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![MIT license](https://img.shields.io/badge/license-MIT-ff9e64)](LICENSE)

[Website](https://tannermidd.github.io/pi-pocket/) · [Quick start](#quick-start) · [Features](#features) · [Remote access](#remote-access)

<img src="docs/showcase-0.12.1.png" alt="Pi Pocket in the Tokyo Night theme, on a desktop and a phone. On the desktop, the session list beside a conversation where Pi has fixed a sign-in redirect loop, its edits and a passing run of 48 tests folded into a timeline. On the phone, the same session after a teammate, Alex, asks for the push: Lancet Guard waits for approval before git push." width="100%">

</div>

## What this fork adds

Oh-My-Pocket keeps Pi Pocket whole and adds what a self-hosted model on one GPU needs: a small, stable prompt prefix, no
surprise model swaps, and a plan mode that can read the project board. Each change ships with tests, and each one that
touches the prompt is measured against oh-my-pi (OMP) on the same task, model, and server.

`oh-my-pocket` is the default branch. `main` mirrors Pi Pocket: upstream changes land there first, get reviewed, and
only then merge into `oh-my-pocket`.

### Batteries

| Battery                         | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                     | Measured                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Agent definitions               | `subagent` spawn takes `agent: <name>` and loads `~/.pi-pocket/agents/<name>.md`: role instructions, model, thinking level, and tools. Pipelines (plan, implement, review) run each stage as its own role.                                                                                                                                                                                                                                       | 5 tests                                                                        |
| Background compaction off       | `compaction.backgroundTokens` in Pi's settings now reaches Pi Durable; `0` turns it off. A local server answers one request at a time, so a background summary only queues behind the turn it was meant to overlap.                                                                                                                                                                                                                              | 3 tests                                                                        |
| Titles on the session's model   | A session's own model writes its title, never a cheaper one picked on the side: nobody chose that one, and it may cost what nobody agreed to. It started as a free-model carve-out (on a one-GPU server, a `*-mini` load pushed the session's model out of VRAM for a six-word title); upstream's 0.13.1 made it the rule for every session.                                                                                                     | no model swap before the first turn (about 40 s each way here)                 |
| Plan mode reads the board       | Tools can mark which calls only read (`host.readOnlyCalls`), and plan mode lets those through: listing and reading board tickets, say. `git -C <dir>`, `git branch -a`, and output sent to `/dev/null` count as reads too.                                                                                                                                                                                                                       | 19 new test cases; the 4 calls a real plan session got blocked on now pass     |
| Per-role skill catalog (recipe) | A drop-in wraps the `skills` section (Pi Durable's `wrapSection`) and renders it from the session role's own list. Pi otherwise sends its whole catalog on every request.                                                                                                                                                                                                                                                                        | router start context 19,395 to 13,133 tokens                                   |
| Context meter                   | `/context`, a tap on the status-line meter, or `GET /api/c/:id/context`: the context split into prompt sections, tool schemas, and history by kind, scaled to the newest measured prompt. Every A/B reads its own numbers.                                                                                                                                                                                                                       | within 0.1% of the measured prompt; 3 tests                                    |
| Waiting subagents               | `subagent` spawn and send take `wait: true` and return the answer as the call's result. The parent writes nothing while a stage runs, so on a one-slot server the stage keeps its cache. A stopped waiting call still gets its answer as a report.                                                                                                                                                                                               | cached share 60% to 90%; 2 tests                                               |
| Prune before summarising        | Compaction first replaces its range with a note that costs no model call: old tool output masked to one line each, the newest results kept in full, stale re-reads and loops dropped; the LLM summary runs only when the note would still leave the context over its limit. `compaction.pruneToolOutput` and `pruneKeepLast` in Pi's settings.                                                                                                   | 9 tests; no second model call in the common case                               |
| Loop guard                      | The third identical tool call in one turn is blocked (the block says so when the earlier runs failed), and the system prompt says the same in one line; a file edit re-arms reads and shell checks, so test, fix, test is not a loop; a restart-interrupted call is not a failure, and a fresh person's message re-arms it. Call arguments a model wrote slightly wrong (a JSON string where the object belongs) are repaired before validation. | 10 tests; research measured 30K to 8.9K prompt tokens, under 20% to 100% solve |
| Read economy                    | A read without an explicit limit returns at most five hundred lines, and the result carries a structural map of the part it did not read: how many lines remain and where the sections sit. To see more, the model reads on with an offset and a limit.                                                                                                                                                                                          | 6 tests; keeps whole-file dumps out of a small model's context                 |
| KV-prefix discipline            | The system prompt is byte-stable and append-friendly: the one line that changes on its own (the day) sits in the last section of each pack, behind drop-ins' sections too, so a cache hit stays a hit through the day instead of re-prefilling the tail. Pinned by test for sessions, PiP, and drop-ins.                                                                                                                                         | the date's flip re-prefills one short line, not the pack                       |
| Context baseline                | `/context baseline` (or a tap on the status line) takes a meter of where the context goes; the next `/context` lines it up against that and names the rows a change touched, before and after, biggest moves first. `/context clear` puts the meter back on its own.                                                                                                                                                                             | 4 tests; names the row a prompt, tool, or skill change lands on                |

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

## Quick start

Requires Node.js 22.19 or newer. Runs on Linux, macOS, Windows, and Android (Termux); Linux is the most tested. Sign in to a provider with Pi first (`pi`, then `/login`), or later from the app's Providers sheet.

```bash
git clone -b oh-my-pocket https://github.com/T-Crypt/oh-my-pocket.git
cd oh-my-pocket
npm install
npm start
```

The launcher asks how your devices should connect, then prints the address, a sign-in link, and a QR code. Open the link once per browser; the cookie lasts a year. The link is the owner's key, so keep it private. `--rotate-token` replaces it and signs out every device that used the old link; people you invited stay signed in until you remove them under Menu → People.

While it runs: **q** quit · **r** restart server · **a** change access · **o** open in browser · **s** show QR code.

## Features

- **Durable.** Every model call, tool call, and subagent is stored as it happens. Restart the server mid-run and the work continues; a cut-off tool call reruns only if that is safe.
- **Multiplayer.** Share a live session: presence, a side chat Pi does not see, @mentions, pins, reactions, shared notes, and take turns.
- **Steer or queue.** Redirect Pi while it works, queue follow-ups, or stop it.
- **PiP, your assistant.** Alt+A opens "Pi in Pocket" over any screen: it lists, reads, starts, and messages your other sessions, follows their runs, and tells you what came of them. What sessions and GitHub say reaches it as data, never as instructions.
- **Watches and webhooks.** Tell PiP to watch a GitHub repository ("when CI fails on main, fix it and tell me"), or watch a pull request from a session until it merges; webhooks bring other services' posts to Pi. Only the repository's own people count, unless you say anyone.
- **Memory.** Lessons Pi keeps across sessions, per project or everywhere. Pi proposes them; the owner approves what it saw.
- **Dictation.** Speak into the message box, or PiP's, with the browser's own speech recognition.
- **Forks.** Fork from any reply, edit a message and send it again, or retry it with another model. Each fork is a session of its own, optionally in a git worktree of its own.
- **Works while you're away.** Schedule messages to Pi (`/schedule every weekday 8:00 summarize CI`), and `/until npm test` keeps Pi going until the check passes.
- **Plan mode.** Pi reads and proposes a plan; nothing changes until someone approves it.
- **Any provider, any model.** Uses Pi's own model runtime and sign-ins, skills, and prompt templates, with the model and thinking level chosen per session, and the models a provider offers the pickers chosen (and switched one by one) in the Providers sheet.
- **Omarchy themes.** Every Omarchy theme, or follow your desktop's live; tiled Hyprland-style windows, a Walker-style launcher (Ctrl/⌘+K) with live theme previews, and Hyprland's motion.
- **Peek tiles.** One click (or Alt+P) shows your other sessions working beside the one you are in: approve their calls from there, and swap between them with a click. Only the tiles on screen stay live, so a long list scrolls cheaply.
- **Built for phones.** Streaming answers, Pi's tool calls folded into a timeline with diffs and live output, push notifications you can allow or deny from, sharing into Pi from other apps, and a home-screen app.
- **Files and review.** The Files tile (Alt+E) shows the session's folder beside the conversation, and Changes reviews every uncommitted change: word-level diffs, split or unified, and files you mark viewed. Code in Pi's replies is colored, and an HTML block previews inline, running on a tap in a sandbox.
- **Branches.** The git branch shows in the top bar, under the session's title, and follows any switch; tap it to switch to another branch, follow a remote one, or make a new one.
- **A built-in browser.** Pi opens, reads, clicks through, and screenshots pages in a real Chromium on the server, and you watch and use the same page in the Browser panel, from a phone too: your dev server on `localhost` included.
- **Artifacts and subagents.** Sandboxed HTML, Markdown, and SVG artifacts, and background subagents you can open and talk to. The Subagents chip in the message box, or `/subagents`, sets which models they may run on besides the session's own.
- **Routers.** A router checks each task and runs it through its stages, each a fresh subagent on the model and effort you choose. The rail's **Routers** button (Menu → Routers, and the Routers place on a phone) opens the editor: a stage is a card with its template, its words, the skills it reads first, its model, and its effort, and the router's prompt is written from them. Pi Pocket ships **Standard** (Plan, Implement, Review, Fix, Ship), saved routers live in `~/.pi-pocket/routers/<id>.json`, routers already on this machine show read-only under **From this machine**, and **Use in this session** or the model picker's **Routers** group runs a session on the router's model until a plain model is picked.
- **Codemode.** On by default: Pi writes short scripts that call its tools, and every call still goes through the same checks.
- **Lancet Guard.** Off by default; turn it on in Menu → Extensions. With the [specpi-lancet-guard](https://github.com/TannerMidd/SpecPi) Pi package installed and on, risky bash, write, and edit calls wait for someone in the session to approve.
- **Roles, invites, and limits.** Steer or view-only access, to every session or just one, through one-time links and QR codes, with spend limits per person and per session.
- **Live-editable.** No build step: edit the web app or an extension and it reloads in place. Add your own extensions in `~/.pi-pocket/extensions/`.

The full tour is in [docs/features.md](docs/features.md).

## Remote access

Choose a mode in the launcher, or pass `--access`:

| Mode         | Who can connect      | Notes                                                                                                                                                                                                       |
| ------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`      | This machine         | Listens on `127.0.0.1`                                                                                                                                                                                      |
| `lan`        | Your local network   | All addresses, plain http                                                                                                                                                                                   |
| `cloudflare` | Anyone with the link | Free quick tunnel with https, no account needed (Cloudflare offers quick tunnels for testing and development). The address changes each time the launcher starts but stays the same across server restarts. |
| `tailscale`  | Your tailnet         | Tailscale address only, encrypted by the tailnet                                                                                                                                                            |

Cloudflare mode needs `cloudflared`. On Linux the launcher can download the official release into `~/.pi-pocket/bin`. To use another tunnel (ngrok, `tailscale serve`), choose `local` and point the tunnel at port 8787.

> [!WARNING]
> Anyone with steering rights can make the agent run commands on this machine, as you. That reaches everything you can: your files, Pi Pocket's own settings and sign-in tokens, and its code. A single-session invite limits what someone sees in the app, not what Pi can reach, and Lancet Guard approvals can come from anyone who can steer, including the person who asked. People who can steer every session can also invite others. Invite only people you would trust at your keyboard. View-only users cannot make Pi act.

## Android (Termux)

```bash
pkg update && pkg upgrade
pkg install nodejs git
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi                      # /login, then quit
# copy or clone pi-pocket to the phone, then:
cd pi-pocket && npm install --ignore-scripts && npm start
```

Open the link in Chrome and choose **Add to Home screen**. Run `termux-wake-lock` so Android does not stop Termux.

Lancet Guard needs ONNX Runtime, which may not load on Android. If the guard is on but cannot load, Pi Pocket blocks bash, write, and edit calls (the status line shows "guard failed"). Turn it off in the app (Menu → Extensions), in `~/.pi/lancet-guard.json`, or by starting with `PI_POCKET_GUARD=off`.

## Configuration

| Option            | Default        | Purpose                                                           |
| ----------------- | -------------- | ----------------------------------------------------------------- |
| `--access <mode>` | last choice    | Skip the access menu                                              |
| `-y`              |                | Reuse the last access choice                                      |
| `--port`          | `8787`         | Port to listen on                                                 |
| `--cwd`           | current folder | Default folder for new sessions                                   |
| `--data`          | `~/.pi-pocket` | Database, settings, uploads, and push keys                        |
| `--host`          |                | Listen on a specific address instead of choosing access           |
| `--rotate-token`  |                | Issue a new owner link and sign out devices that used the old one |

Environment variables: `PI_POCKET_ACCESS`, `PI_POCKET_DIR`, `PI_POCKET_HOST`, `PI_POCKET_PORT`, `PI_POCKET_GUARD=off`, `PI_POCKET_BROWSER` (the browser to run, when Chromium or Chrome is not found by itself), and `PI_POCKET_BROWSER_ARGS` (extra flags for it, such as `--no-sandbox` where sandboxes are unavailable). Without a terminal (under systemd, for example), the launcher uses `--access` or the last choice.

## Architecture

| Path                                                                                           | Role                                                                                                                                        |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/pi-pocket.js`                                                                             | Entry point: checks the Node version, starts the launcher                                                                                   |
| `src/launcher/`                                                                                | Access menu, server supervisor, Cloudflare tunnel, keys, QR code                                                                            |
| `src/server/app.ts`                                                                            | The core: the durable harness over `pocket.sqlite`, the coordinator every commit goes through, connected tabs, access, and the session list |
| `src/server/attribution.ts`, `workspace.ts`, `transcripts.ts`                                  | Who Pi works for; a conversation's folder and its stored history, as people reach them                                                      |
| `src/server/room.ts`                                                                           | One conversation's shared live view, sent to every tab watching it                                                                          |
| `src/server/commands.ts`                                                                       | What people ask of Pi: messages, forks, models, plan mode, goals, schedules, worktrees                                                      |
| `src/server/collab.ts`                                                                         | The people's side: chat, activity lines, reactions, pins, notes, take turns                                                                 |
| `src/server/http.ts`, `http/`                                                                  | Web files, JSON API, server-sent events, uploads, artifacts, invites, the Browser panel's frames and input                                  |
| `src/server/browser.ts`, `browser/`                                                            | The built-in browser: one headless Chromium over the DevTools protocol, a page per conversation                                             |
| `src/server/projection.ts`                                                                     | Turns committed conversation state into compact JSON for browsers                                                                           |
| `src/server/docs.ts`                                                                           | Durable documents: sessions, chat, pins, notes, artifacts, subagents, schedules, goals, spend                                               |
| `src/server/schedules.ts`, `goals.ts`, `spend.ts`, `changes.ts`, `branches.ts`, `worktrees.ts` | One feature each, with its durable tasks or git calls                                                                                       |
| `src/server/push.ts`, `alerts.ts`                                                              | Dependency-free Web Push (RFC 8291 and RFC 8292), and who gets which notification                                                           |
| `src/server/extensions/`                                                                       | Live-reloaded extensions: system prompt, artifacts, browser, subagents, schedules, goals, plan mode, Lancet Guard, codemode                 |
| `web/`                                                                                         | The app: Preact and htm as plain ES modules                                                                                                 |

Browsers render only committed state. Each session's Pi Durable view is coalesced and sent as small updates over server-sent events, so a device that reconnects or joins late sees exactly what everyone else sees. The [engineering page](https://tannermidd.github.io/pi-pocket/engineering.html) explains the design; [docs/map.md](docs/map.md) is a short map of the code.

## Development

```bash
npm run check       # type-check
npm test            # server tests with a scripted model
npm run check:web   # type-check web/; the files marked clean must stay clean
npm run coverage    # the tests with line coverage, held at 60%
npm run format      # ESLint's layout fixes, then Prettier
npm run lint        # check the layout rules
```

Changes to `web/` reload every open browser. Changes to `src/server/extensions/` are reinstalled into the running server. Other server changes need **Restart server** from the menu, and running work resumes afterward. [AGENTS.md](AGENTS.md) covers editing Pi Pocket safely from inside itself, and `node test/serve.ts` runs a throwaway copy, with its own data and a scripted model, to check a change on.

Pi knows where Pi Pocket's own documentation is: [docs/index.md](docs/index.md) starts it, for agents and people who change how Pi works without code ([customizing](docs/customizing.md)), write extensions ([extensions](docs/extensions.md), with [tested examples](docs/examples/)), or change Pi Pocket itself while it runs ([self-editing](docs/self-editing.md)).

## Limitations

- Pi Durable is experimental, and its API can change between releases. Versions are pinned in `package.json`.
- Only one server process can use the database at a time.
- Forks are separate sessions; there is no branch tree to switch between inside one session.
- Pi's own extensions are not supported: Pi Pocket runs its own extensions on Pi Durable, and drop-ins from `~/.pi-pocket/extensions/`. Pi's prompt templates work as slash commands.
- A git worktree keeps a session's files apart; it is not a sandbox. Pi can still reach everything you can.
- Artifacts run in an opaque-origin sandbox, so `localStorage` and cookies are unavailable inside them.
- The browser needs Chromium, Chrome, Brave, or Edge on the server. Its pages live in memory: a restart opens each one again at its last address, but not what was typed into it. Each session's cookies are its own and last until the page closes. A browser installed as a snap (Ubuntu's Chromium) is used only when there is no other; it cannot open files outside your home folder. The list of servers running on the machine is Linux-only.

## Credits

Inspired by [Mario Zechner's demo](https://x.com/badlogicgames/status/2106452296087302173) of his own Pi app. Pi Pocket is an independent project, not affiliated with Earendil. JetBrains Mono is bundled under the [SIL Open Font License](web/fonts/OFL.txt).

## License

[MIT](LICENSE). To report a security problem, see [SECURITY.md](SECURITY.md).
