"""Generate docs/parity.md for the HADAL interface rebuild: every user-reachable feature, pulled from the code itself,
so a redesign PR can be checked row by row. Run from the repo root; prints nothing but the file path."""
import re, pathlib, sys
R = pathlib.Path(sys.argv[1]); out = R / "docs/parity.md"
rd = lambda p: (R / p).read_text()

def block(src, start, opener="{", closer="}"):
    i = src.index(start); j = src.index(opener, i); d = 0
    for k in range(j, len(src)):
        d += src[k] == opener; d -= src[k] == closer
        if d == 0: return src[j:k + 1]

rows = []  # (area, feature, how to reach)
# shortcuts: split by group heading, then every [keys, what] pair (Prettier wraps the long ones over lines)
sc = rd("web/sheets/shortcuts.js"); s = sc.index("const SHORTCUTS"); body = sc[s: sc.index("\n];", s)]
heads = list(re.finditer(r'^\s{4}\[\s*\n\s*"([^"]+)",', body, re.M))
for k, h in enumerate(heads):
    part = body[h.end(): heads[k + 1].start() if k + 1 < len(heads) else len(body)]
    for keys, what in re.findall(r'\[\s*"([^"]+)",\s*"([^"]+)",?\s*\]', part):
        rows.append(("Shortcut · " + h.group(1), what, f"`{keys}`"))
# slash commands
cm = rd("web/commands.js")
for m in re.finditer(r'name:\s*"([a-z0-9-]+)"(?:,\s*args:\s*"([^"]*)")?[^}]*?description:\s*\n?\s*"([^"]+)"', cm, re.S):
    rows.append(("Slash command", m.group(3), f"`/{m.group(1)}{(' ' + m.group(2)) if m.group(2) else ''}`"))
# sheets
sh = rd("web/sheets.js")
for name in dict.fromkeys(re.findall(r'case "([a-z0-9-]+)":', sh)):
    rows.append(("Sheet", f"The {name} sheet renders and closes (Esc, back, ×)", f'`openSheet({{ type: "{name}" }})`'))
# menu rows
mn = rd("web/sheets/menu.js")
for name in dict.fromkeys(re.findall(r'item\(\s*"([^"]+)"', mn)):
    rows.append(("Menu row", name, "Menu → " + name))
# launcher actions
ln = rd("web/launcher.js")
for name in dict.fromkeys(re.findall(r'label:\s*"([^"]+)"', ln)):
    rows.append(("Launcher action", name, "Mod K → " + name))
# rail buttons
ss = rd("web/sessions.js"); rail = ss[re.search(r"^(export )?function Rail\(", ss, re.M).start():]
rail = rail[: rail.index("\nexport ", 10)] if "\nexport " in rail[10:] else rail
for name in dict.fromkeys(re.findall(r'aria-label="([^"$]+)"', rail)):
    rows.append(("Rail button", name, "Rail → " + name))
# built-in modules (Extensions sheet)
rl = rd("src/server/reload.ts")
titles = dict(re.findall(r'"([a-z0-9-]+\.ts)":\s*"([^"]+)"', rl))
i = rl.index('    "prompt.ts",\n'); arr = rl[rl.rindex("[", 0, i): rl.index("]", i)]
for f in re.findall(r'"([a-z0-9-]+\.ts)"', arr):
    rows.append(("Built-in module", titles.get(f, f), f"Menu → Extensions → {titles.get(f, f)} (`extensions/{f}`)"))
# phone gestures (web/app.js startSwipes) and fork features (README)
rows += [("Phone gesture", "Swipe right: back to the session list, or the session before", "On a conversation, phone width"),
         ("Phone gesture", "Swipe left: the Files tile", "On a conversation, phone width"),
         ("Phone gesture", "Swipe up from the message box: the places", "On a conversation, phone width"),
         ("Phone gesture", "Swipe right on the subagents board or Files tile: back", "Board or Files open, phone width")]
rd_me = rd("README.md"); fa = rd_me[rd_me.index("### Batteries"): rd_me.index("### Building a router on it")]
# The first table only: the batteries. The tables after it are measurements, not features.
fa = fa[fa.index("\n|"):]; fa = fa[: fa.index("\n\n", 1)]
for name in re.findall(r"^\|\s*([A-Z][^|]{2,40}?)\s*\|", fa, re.M):
    if name.strip() not in ("Battery", "What", "Feature"):
        rows.append(("Fork battery (README)", name.strip(), "README → What this fork adds"))

seen = set(); uniq = []
for r in rows:
    if r not in seen: seen.add(r); uniq.append(r)
lines = ["# Parity: what the interface rebuild must keep", "",
         "Generated from the code by `scripts/gen-parity.py` for the HADAL interface rebuild (plan: homelab",
         "`projects/active/hadal/PLAN.md`, F0). Every row must still work after each interface PR, at 1440, 1100, 960,",
         "700 and 390 px wide, by keyboard as well as by pointer. A row that moves (a new place, a new name) says where in",
         "the PR. Regenerate after a change that adds or removes a feature (`python3 scripts/gen-parity.py .`, then",
         "`npx prettier --write docs/parity.md`); do not edit the rows by hand.", "",
         f"{len(uniq)} rows.", "", "| Area | Feature | How to reach it | Checked |", "| --- | --- | --- | --- |"]
lines += [f"| {a} | {f.replace('|', '/')} | {h.replace('|', '/')} | |" for a, f, h in uniq]
out.write_text("\n".join(lines) + "\n"); print(out, len(uniq))
