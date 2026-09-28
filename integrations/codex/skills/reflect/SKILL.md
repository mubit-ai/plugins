---
name: reflect
description: Extract lessons from this session's activity now; use when the user wants them banked before session end or asks what memory holds.
---

## Step 0 — resolve the binary

No environment variable carries this plugin's path under Codex. Codex lists each skill with the
absolute path of its `SKILL.md`; **this file** is at `<plugin-root>/skills/reflect/SKILL.md`, so
the binary is two directories above it:

```
<plugin-root>/bin/admin.mjs
```

Resolve that to an absolute path from this file's own location and use it in every command
below. Do not write `${CLAUDE_PLUGIN_ROOT}`: Codex sets no plugin-root variable of any
spelling, so the shell expands it to nothing and `node /bin/admin.mjs` fails with ENOENT.

Reflect over the current run with the bundled script — `POST /v2/control/reflect {run_id}`
behind it — and relay what it prints: one line per extracted lesson, with the lesson's id,
type, importance and scope on the line.

```bash
node <plugin-root>/bin/admin.mjs reflect
```

If it reports no lessons, say so plainly; an empty reflect is a real answer, not an error.
Neither command here is an MCP tool: `mubit_reflect` and `mubit_lessons` left the default
tool surface so that a session pays nothing to list them, and this script reaches the same
two routes.

## The standing catalogue

When the user wants what memory holds rather than what this run just produced:

```bash
node <plugin-root>/bin/admin.mjs lessons                    # this run, plus what travelled
node <plugin-root>/bin/admin.mjs lessons --scope run        # this run alone
node <plugin-root>/bin/admin.mjs lessons --scope global     # only what has travelled
node <plugin-root>/bin/admin.mjs lessons --importance high --limit 10
```

The three scopes answer three different questions, and asking the wrong one is how a healthy
store reads as empty:

- **no `--scope`** — this run's lessons, plus every lesson stored above `run` scope by any
  run. The honest default, and the right one for "what do we know here".
- **`--scope run`** — this run alone. What this session has banked so far.
- **`--scope session` / `global`** — only the lessons that have travelled, from every run
  the key can see. Read a zero here as a real zero rather than as a fault.

The listing says what it is showing and how many matched. A lesson this conversation has
already been shown is printed as its id and first clause, marked `(seen earlier)`;
`mcp__mubit__mubit_dereference` returns the text. `--json` is the whole catalogue with its metadata.

## Why the explicit call exists at all

A lesson drawn from a run's activity starts at `run` scope, and **a `run`-scoped lesson is
invisible to the next session**. (A `mcp__mubit__mubit_learned` write is different: it takes the
`mcpLessonScope` setting, `session` by default.) Lessons drawn from activity reach later
sessions only after an explicit reflect — this skill, or the one `SessionEnd` issues. Without
one, the store can look busy, lessons accumulating steadily, while nothing reaches a future
session.

Even then it is gradual: expect lessons to reach later sessions over several sessions, not on
the first reflect.

## When to invoke it

`session-end.mjs` already reflects once per session, on the way out, with the same run id.
That covers routine hygiene. Invoke this skill for a **mid-session checkpoint** — a long
session that has just finished a real chunk of work, a debugging arc that ended in something
worth keeping, or the point where the user is about to compact and wants the lessons banked
first. Do not call it every few turns: it is slow, and calling it on a run that has barely
changed costs time and returns the same lessons.

One timing detail worth knowing before you read a zero as a failure: reflection only sees
items that are already **searchable**. A reflect fired immediately after a burst of
captures or an explicit `mubit-memory:remember` can honestly report `lessons_stored: 0`
where the same run reflected about a minute later returns them. If you have just written
something you expect to be reflected on, give ingest a moment rather than reflecting twice.
