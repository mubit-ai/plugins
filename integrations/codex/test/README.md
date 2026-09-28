# Test suite — `mubit-memory` for Codex

**These tests were written before the implementation**, so the suite reads as a specification
rather than as a regression net. Every failure names the file that does not exist yet, or the
manifest key that drifted, and says what defines it.

The same house rules as `../../claude-code/test/README.md`: `// @ts-check`, a header comment
naming the claim each file defends, assertion messages that state the *consequence*, and
absences asserted explicitly (`server.assertNotCalled(...)`,
`assert.equal(server.requests.length, 0)`) rather than inferred from timing.

## Running

```bash
cd integrations/codex

node --test 'test/**/*.test.mjs'          # everything
node --test test/codex-payload.test.mjs   # one gate

npm run test:dist                         # everything, against the committed bundles
```

The six `codex-*-cli.test.mjs` files spawn the **committed** `bin/<name>.mjs` through
`test/helpers/codex-cli.mjs`, with an environment built from nothing — no `MUBIT_CC_HOST`,
no `CLAUDE_*` — because that is what a skill-run command gets. They never import the shared
`bin/*.src.mjs` in-process: that path cannot go red on a bundle that boots without the shim.

**Both suites are one change.** `lib/`, `hooks/src/` and `mcp/src/` live in
`../claude-code` and are shared, so anything touching them has to be green in both:

```bash
cd ../claude-code && npm test    # 2288
cd ../codex       && npm test    # 468
```

## The load-bearing trick

`test/fixtures/observed/payloads/*.json` are payloads **the host itself wrote**, into a
recorder hook, during a real session. `codex-payload.test.mjs` checks every fixture against
them, and every hook's stdout against the output contract.

The reason is worth stating, because it is why this suite is arranged differently from its
sibling: **a fixture written beside an implementation cannot falsify that implementation.**
Whatever shape the code reads, the fixture will have — the two are written by the same person
in the same hour, and they agree by construction. Nine tests can pass on a payload Codex would
never send. A payload the *host* wrote can say no.

What a recording cannot do is prove a field optional, or reject one the host would accept but
has not been seen sending. And four of the eleven registered events — `PreCompact`,
`PostCompact`, `SubagentStart`, `SubagentStop` — do not fire in any session the recorder
drives, so they have no recording at all. `codex-payload.test.mjs` names them rather than
passing over them, because a gap nothing states is indistinguishable from coverage.

It has already earned that twice. The first draft of `preCompact()` carried a
`permission_mode` — the two compaction events are the only turn-scoped events without one — and
`permissionRequest()` carried a `tool_use_id`, which it has none of, and which is precisely why
that event is treated as read-only.

Re-record with `node test/helpers/codex-record.mjs --update`, and a host verdict on one output
with `--update --probe <name>`. Each costs a model turn, which is why it is a script you run
deliberately rather than something the suite does. The two recordings only the interactive TUI
can reach — a message queued mid-turn, and Esc — are made by hand: `--tui-home` builds a
recorder home to drive, and `--import <file> --as <Event>[.<variant>]` files a capture from it.

## Gate map

| File | Covers |
|---|---|
| `codex-manifests.test.mjs` | manifests as data: exactly the eleven events, no `if:` predicates, no `args` exec form, every command naming a committed bundle, version lockstep with the Claude Code plugin, and the absences — no `hooks`, no `mcpServers`, no `userConfig`, no `agents/`, no status line |
| `codex-payload.test.mjs` | every fixture and every hook's stdout against the host's own extracted schemas |
| `codex-boot.test.mjs` | env-before-import: what the shim fills in, what it refuses to overwrite, and the ordering assertion over every entry point |
| `codex-hooks.test.mjs` | end to end, one per event: real subprocess, real Codex payload, the emitted `hookEventName`, and zero HTTP where the contract says zero |
| `codex-runid.test.mjs` | the cross-harness claim — one directory, two harnesses, one run — the four-value `source` table, and `turnKey` |
| `codex-transcript.test.mjs` | `checkpoint.mjs`'s reader on a rollout fixture: same rendering, redacted, a real tail, Stop-hook feedback (`<hook_prompt>`, one element or several in a block) and the host preamble never rendered as a user turn, a shell command the user ran and an interrupted turn kept, and the Claude Code envelope still working |
| `codex-classify.test.mjs` | `shell`, `apply_patch`, `update_plan`, `view_image`, `web_search`, `collaborationspawn_agent`, `mcp__mubit__*` → real intents, never `unclassified` |
| `codex-skills.test.mjs` | Codex frontmatter (`name`, `description`, and none of the keys Codex does not read), `mcp__mubit__` prefixes, and the content guards |
| `codex-mcp.test.mjs` | real stdio `tools/list` against the committed bundle, the `instructions` frame, and that the two copies of the vendored server are byte-identical |
| `codex-failure.test.mjs` | unparseable stdin, absent env, unwritable data dir, a misbehaving endpoint, hostile payloads, the three-second SessionEnd → exit 0, a JSON object on stdout, **never exit 2** |
| `codex-file-change.test.mjs` | the structured file-change lane on a real `apply_patch`: add/update/delete from the markers, the merged per-run index, a `.env` patch dropped whole, no `files` on a shell command, and the ingest body after `Stop` |
| `codex-handoff-cli.test.mjs` | the committed `bin/handoff.mjs`, spawned with no host in its environment: the sender is `codex`, the default action, the client-side open join, feedback, and the three refusals by name |
| `codex-import-cli.test.mjs` | the committed `bin/import.mjs`: the default source is the Codex rollouts, a dry run dials nothing, `--send` tags `tool:codex` with the live item id, a re-run sends nothing, both sources, and the reviewer thread, injected preamble and Stop-hook feedback skipped |
| `codex-pin-cli.test.mjs` | the committed `bin/pin.mjs`: the `variables/*` bodies, the cache the hooks read, a failed write leaving nothing, the run from the marker or `--run`, never the key, and the store setup pinned found with nothing on the command line |
| `codex-activity-cli.test.mjs` | the committed `bin/activity.mjs`: rows on stdout and the summary on stderr, `--jsonl`, an export that owns stdout and writes no file, `--run`, and never the key |
| `codex-admin-cli.test.mjs` | the committed `bin/admin.mjs`: the census through `/activity` and never the lessons route, a checkpoint verbatim, the SessionEnd reflect body, exit 2 without dialling, and an unconfigured install told to run `auth` |
| `codex-review.test.mjs` | the once-per-turn outcome review through the Codex Stop hook, end to end against the fake endpoint: one block per turn listing the lessons by short id, the recorded continuation printing the card while use stays measured on the first answer alone (the continuation and its review line are never measured or stored), exactly one block and one implicit outcome whatever `stop_hook_active` says, a later Stop of a reviewed turn read as its continuation, no block for nudge/off/outcomeMode off/capture off/subagents/nothing shown, `mubit_outcome` in the continuation never credited twice, a queued message joining the turn, and the next turn reviewed again |
| `codex-scorecard.test.mjs` | the session scorecard end to end, every hook a real subprocess in host order: the exact card, full and compact, as a Stop `systemMessage` the host takes; rows keyed by `turn_id`; a failure only the rollout records, joined by `tool_use_id`, and the last acting command deciding; read-only failures, another call's record and a missing or unreadable rollout never counting; a correction and what never is one (`/` or a `$skill` as the first word, a message typed mid-turn), while a `$` anywhere else is judged as usual; Interrupt, `/clear`, `/new` and SessionStart timing; the three no-card cases; subagents; pointer-only turns; the Stop after another hook blocked, whose use is both replies' |

## `codex-failure.test.mjs` is the important one

Codex reads a hook's exit code exactly as Claude Code does: 0 parses stdout, **2 blocks** and
turns stderr into the reason shown to the model, anything else is an error surfaced to the
user. So the dangerous value is the one a naive error handler picks — a memory layer that threw
would start denying tool calls, and the user would experience it as the agent refusing to work.

Two Codex-specific failures get their own tests because neither has a Claude Code counterpart
and both are silent:

- **A registered hook that is not trusted never runs**, with no prompt and no warning. Nothing
  a hook can defend against — but the plugin must not be confusable with "capture is off", so
  every path leaves a local marker and `mubit-memory:doctor` reads it.
- **`SessionEnd` gets three seconds**, clamped by the host whatever the registration says, where
  the same hook asks for eight under Claude Code. One case asserts the hook *returns* inside it
  and another that the detached child finishes the work after the hook process is killed.

## The harness

`helpers/codex-fixtures.mjs` — read it before writing a test.

It re-exports `../../claude-code/test/helpers/harness.mjs` wholesale, bound to this plugin's
root, and adds two things of its own: one builder per Codex event, and a small draft-07
validator plus the schemas to run it against. There is deliberately no second copy of
`makeDataDir` / `fakeMubit` / `runHook` / `assertHookContract` — the spawn protocol, the fake
server and the contract assertions are identical across the two hosts, and a fork of them would
be a second thing to keep true.

`rolloutJsonl()` builds a Codex rollout transcript, envelopes and all, for the checkpoint tests.
A `text` given as an array writes one content block per string on the one record.
An entry of `{hookPrompt: reason}` writes what a blocked Stop hook leaves in it instead: the
reason wrapped in `<hook_prompt>` on a `user` record, and the `HookPrompt` item beside it
(`rolloutHookPrompt()`, in the shape observed on codex-cli 0.154.0).
An entry of `{line}` is written verbatim, which is how a tool call gets in: the model's `exec`
script (`rolloutExecScript()`), the `item_completed` record of each command it ran
(`rolloutCommandCompleted()`, whose `item.id` is the hook's `tool_use_id`), and the script's
output (`rolloutExecScriptOutput()`). `{complete: false}` leaves off the turn's closing lines —
the file as a `PostToolUse` hook reads it, mid-turn.

## House rules, in addition to the sibling's

- **Assert against the fenced blocks when a skill must not *run* something, and against the
  prose when it must *say* something.** A string that must never be executed is very often a
  string the prose ought to name explicitly and warn about; a flat substring search cannot tell
  "do not write `${X}`" from "write `${X}`", and pushes the skill towards saying nothing.
- **Say when a fixture was not observed.** `preCompact` and `postCompact` were never reached by
  the probe — a probe turn is far too small to compact — so they are built from the extracted
  schemas alone, and the builder's docblock says so. A fixture whose provenance is unstated
  reads as recorded when it was inferred.
