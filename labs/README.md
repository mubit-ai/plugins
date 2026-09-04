# Mubit memory, end to end

A hands-on walkthrough of one thread through the `mubit-memory` plugin: a session opens, a
prompt arrives, memory is recalled, tools run, the turn ends, work is sent, the session ends
and a lesson is extracted. You drive every step by hand and watch both sides of the wire.

Nothing here talks to a real Mubit instance. `labs/fake-mubit.mjs` stands up all twelve routes
the plugin knows how to call and prints every request, so "what actually leaves the machine"
is something you read, not something you take on faith.

> The labs need no `npm install` — every hook, every lib module and both MCP entry points
> import only Node built-ins, and the bundles are committed. Run everything from the repo
> root; the labs keep all of their state in `labs/.work/`, and `node labs/setup.mjs --reset`
> removes it.

---

## The model in 60 seconds

Two surfaces, one memory.

```
                         ┌─────────────────────────── Claude Code ───────────────────────────┐
                         │                                                                   │
  involuntary  ─────────►│  hook events → 15 node processes, stdin JSON in, stdout JSON out  │
  (you never ask)        │  SessionStart · CwdChanged · UserPromptSubmit ×2 · PreToolUse ×2  │
                         │  SubagentStart · PostToolUse · Failure ×2 · Stop · SubagentStop   │
                         │  PreCompact · PostCompact · SessionEnd                            │
                         │                                                                   │
  deliberate   ─────────►│  MCP server → 7 tools the model calls on purpose                  │
  (the model asks)       │  mubit_recall · mubit_learned · mubit_outcome · mubit_diagnose · …│
                         └───────────────────────────────────────────────────────────────────┘
                                       │                                    │
                                       ▼                                    ▼
                        ${CLAUDE_PLUGIN_DATA}  (all local state)      HTTPS → your Mubit
                        spool/ turns/ status/ breaker/ policy/        12 REST routes
```

Five facts that explain most of the design:

1. **A hook is a process.** Claude Code spawns `node hooks/dist/<name>.mjs`, writes a JSON
   payload to its stdin, reads JSON from its stdout, and enforces a timeout. That is the whole
   API. You can run any hook by hand — which is what these labs do.
2. **Every hook exits 0, always.** A dead server, an unwritable data dir, a corrupt state file
   — each costs a memory, never a turn. (`hooks/src/*.mjs`, and `lib/hook.mjs` which wraps
   them all.)
3. **The hot path never touches the network.** Capture writes one file per item into a spool.
   A separate, detached `drain.mjs` batches the spool and posts it. That split is why capture
   can run on every tool call.
4. **Local state is the whole database, and it is all JSON.** `peek` prints it.
5. **The run id is the join key.** Hook captures and MCP-tool writes must derive the *same*
   run id or one query can never see both. Lab 1 and Lab 7 are the two halves of this.

The thread you will follow:

```
SessionStart ─► UserPromptSubmit ─► PostToolUse × 4 ─► Stop ─► SessionEnd
    │                 │  │                 │             │  │        │
 health          recall  stage         spool 2 of 4   turn  drain  drain
 register        (ladder) turn         (2 dropped)    file  ──► POST /ingest
 lessons         ──► POST /query                            ──► POST /outcome
                                                                      │
                                                            POST /reflect ◄─┘
```

---

## Setup

Two terminals, both at the repo root.

**Terminal A — the instance:**

```bash
node labs/setup.mjs        # creates labs/.work/{data,demo-app}; --reset starts over
node labs/fake-mubit.mjs   # leave this running; it prints every request
```

**Terminal B — the hooks:**

```bash
source labs/env.sh
```

That exports exactly what Claude Code exports for a real install (`CLAUDE_PLUGIN_ROOT`,
`CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR`) plus the plugin's own settings, and defines six
helpers:

| Helper | What it does |
| --- | --- |
| `hook <name> <payload.json> [args]` | runs `hooks/src/<name>.mjs` the way Claude Code does |
| `mcp <tool> ['<args>'] [--routes] [--session <id>]` | calls one MCP tool as one conversation, or as none; `--routes` shows where it went |
| `admin <command> [args]` | runs `bin/admin.mjs` against the lab store, the way the skills do |
| `wire <command…>` | runs any command and prints the routes it dialled |
| `peek [section]` | prints the plugin's local state — `peek --help` lists sections |
| `runid ['<payload json>']` | derives the run id without running a hook |

It also exports `LAB_RUN_ID`. The fake instance reads it to decide which of its lessons belong
to *your* run — it cannot work that out on its own, because the request that reads the lesson
feed names no run at all, and the id is a hash of the project path that differs per worktree.
Start the fake instance from a shell that has sourced `env.sh`, or Lab 11b will show you one
row fewer than it should.

Nothing touches your real `~/.claude` data. To wipe and start again:
`node labs/setup.mjs --reset && node labs/setup.mjs`.

---

## Lab 1 — Identity: which run does this session write to?

Everything else is keyed on the answer, so it comes first.

```bash
runid
```

```
strategy    per-directory
projectDir  …/labs/.work/demo-app
run_id      cc-demo-app-1ede9c0e
agent_id    claude-code-2f183a4e
```

`cc-<slug>-<hash8>` — the slug is the directory name, the hash covers the **git toplevel**. Two
terminals in one repo share a run; two repos that happen to share a directory name do not. Your
hash will not match the one printed above, and that is exactly the point: it is a function of
the absolute path, so this checkout and a copy of it elsewhere are different runs.

Now try the other three strategies:

```bash
MUBIT_CC_RUN_STRATEGY=git-branch       runid '{"session_id":"s2"}'
MUBIT_CC_RUN_STRATEGY=per-conversation runid '{"session_id":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"}'
MUBIT_CC_RUN_STRATEGY=static           runid '{"session_id":"s3"}'
```

```
cc-demo-app-main-6a4f0336                      ← branch is in the name AND the hash
cc-1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d        ← one conversation, one run
REFUSED: MUBIT_CC_RUN_STRATEGY=static requires MUBIT_CC_RUN_ID…
```

That refusal is the point of the module. A run id the plugin did not derive is not one it will
use: `lib/runid.mjs` throws rather than emit a fallback, and `lib/http.mjs` refuses to put one
on the wire even if something else produced it. Two layers for one rule, because the identity
is the join key for everything stored — Lab 7 is where the second layer earns its keep.

`/clear` is the other interesting source — it must start a *new* run:

```bash
runid '{"session_id":"clear-demo","source":"clear"}'   # → …-c1
runid '{"session_id":"clear-demo","source":"clear"}'   # → …-c2
peek sessions
```

The counter lives in `sessions/<host_session_id>.json`, which is why `deriveRunId` is
deliberately not a pure function.

**Read:** `lib/runid.mjs` — the source table is in the doc comment at the top.

**Break it:** `MUBIT_CC_RUN_ID=default MUBIT_CC_RUN_STRATEGY=static runid`. Why is a refusal
better than a fallback here?

---

## Lab 2 — SessionStart: the session opens

```bash
hook session-start 01-session-start.json
```

Terminal A shows three calls in order: `GET /v2/core/health`, then
`POST /v2/control/agents/register`, then `POST /v2/control/activity` — the standing-lessons
read goes to the activity feed, not the route named after lessons, for the reason Lab 11a
demonstrates: the lessons route pages before it filters. A fourth call, `POST
/v2/control/context`, lands a beat later from a **detached child** — session start prefetches
the resume block Lab 3 will inject, so the first prompt does not pay for its assembly.
Terminal B prints what the model will see:

```json
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"# Mubit memory is active\n\nRun: cc-demo-app-1ede9c0e (hosted)\nRelevant memory is injected automatically before each of your turns — do not search for it preemptively.\n…"},
 "systemMessage":"mubit: hosted · run cc-demo-app-1ede9c0e · 2 global lessons"}
```

Three things worth stopping on:

- **`additionalContext` is the injection channel.** Whatever a hook puts there is prepended to
  the model's context. This is the entire mechanism behind "memory is active".
- **"do not search for it preemptively"** is load-bearing. Without that sentence the model
  helpfully calls the recall tool on turn one of every session and pays for it every time.
- **Sub-budgets.** 2500 ms total, split 400/600/900 across health/register/lessons. A slow
  lesson list costs the lesson list, not the steer block — the one thing this hook may never do
  is fail to speak.

Note the standing-lessons read carries **no `run_id`**: absent means all runs, which is
exactly what "global lessons" wants.

```bash
peek marker
```

`status/<run_id>.json` is the only file the status line reads. Render it:

```bash
echo '{"session_id":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"}' | node "$CLAUDE_PLUGIN_ROOT/bin/statusline.mjs"
# ● mubit: cc-demo-app-1ede9c0e · hosted · recall 3/60 tok · lessons 2g
```

**Read:** `hooks/src/session-start.mjs`.

---

## Lab 3 — UserPromptSubmit: recall, and the ladder

One event, **two** registered hooks. They run as separate processes with no ordering
guarantee, and they write to the same file — how they avoid clobbering each other is the lesson.

```bash
hook prompt-recall 02-prompt.json
hook stage-prompt  02-prompt.json
```

`prompt-recall` returns the block that gets injected in front of the prompt — and on the
**first** prompt of a session, two blocks: the `<mubit-resume>` briefing that session start
prefetched (where earlier work on this project left off), then the recall proper:

```
<mubit-resume run="cc-demo-app-1ede9c0e" sources="1" tokens="21">
Assembled from memory at the start of this session …
## Active rules
- Poll the ingest job; "queued" is not "stored".
</mubit-resume>
<mubit-memory run="cc-demo-app-1ede9c0e" sources="3" tokens="60">
Recalled from memory of earlier work — it may be incomplete or out of date, …
## Active rules
- Ingest returns when queued, not when stored; poll the job id.
## Lessons
- A job stays queued until indexing completes — waiting is the fix, not retrying.
## Facts
- IngestAccepted.status is always "queued" on success.
</mubit-memory>
```

In Terminal A, look at the request that produced it:

```
POST /v2/control/query   mode=direct_bypass  lane=semantic_search  evidence_only=true
```

**The ladder is the most important design decision in the plugin.** The obvious implementation
— ask the server for a ready-made context block — costs **two LLM calls per prompt**, in front
of every keystroke, forever. So:

| Rung | Request | LLM calls | Entered when |
| --- | --- | --- | --- |
| 1 | `query{mode:"direct_bypass", evidence_only:true}` | **0** | always — the primary path |
| 2 | `query{mode:"agent_routed"}` | 1 | rung 1 returned **403** (policy, not fault) **and** you opted in with `MUBIT_CC_RECALL_FALLBACK=agent_routed` — by default a denial goes dark instead, because rung 2's LLM call would run per prompt |
| 3 | `context{mode:"sections"}` | **2** | only if you opt in with `recallAssemble: server` |

Rung 1 returns raw `evidence[]`; `lib/assemble.mjs` renders it into sections client-side, in the
server's own order, for free. That is why the block above has `## Active rules` before
`## Lessons` even though the lesson could score higher — section order outranks score, because
the server does it that way and the two must be indistinguishable.

Now the state both hooks touched:

```bash
peek turns
```

```
prompt          the ingest job stays queued after the batch was accepted — is that a bug in enqueue()?
recalled        [ref_rule_1, ref_lesson_1, ref_fact_1]   ← becomes RecordOutcome.entry_ids
```

`stage-prompt` wrote `prompt` (the `Stop` payload carries the *answer* but not the question —
without this file every captured turn would be half a conversation). `prompt-recall` wrote
`recalled`. Both do read-modify-write and rename into place, and each preserves the other's
key. Order does not matter; that is the design.

**Questions:**
- Why does `prompt-recall` emit `{"suppressOutput":true}` and inject *nothing* when recall
  comes back empty? (Hint: what does "I found nothing" teach the model about this channel?)
- Why is a prompt shorter than 8 characters skipped entirely? Why are `/slash` commands?

**Break it:** `MUBIT_CC_RECALL=0 hook prompt-recall 02-prompt.json` — dials nothing.

Then squeeze the budget and watch the trim:

```bash
MUBIT_CC_RECALL_TOKENS=40 hook prompt-recall 02-prompt.json
peek marker
# recall  sources=2 tokens=37 dropped=1 …
```

Three memories became two — and note *which* two. The long `## Lessons` line did not fit, but
the shorter `## Facts` line after it still did. An item that does not fit is skipped and
counted, never treated as a stop signal.

One thing you did *not* see: from the second prompt of a conversation on, a memory it has
already been shown is normally repeated as a pointer rather than in full. These three are one
short sentence each, and a pointer longer than its entry is never used — Lab 12 is where it shows.

**Read:** `hooks/src/prompt-recall.mjs` (the ladder), `lib/assemble.mjs` (the rendering).

---

## Lab 4 — PostToolUse: capture, redaction, and the two drops

Four tool calls. Two are captured, two are dropped, and the drops are the interesting half.

```bash
hook capture 03-edit.json            # Edit src/queue.js
hook capture 04-read-env.json        # Read .env
hook capture 05-read-ignored.json    # Read build/bundle.js
hook capture 06-bash-failure.json --failure
peek spool
```

Terminal A stays silent through all four: **capture never touches the network.** It writes one
file per item into `runs/<run_id>/spool/` and stops.

```
cc-demo-app-1ede9c0e   2 item(s) pending
  item_id   cc-toolu_lab_0001
  intent    trace   importance medium
  env_tags  tool:claude-code repo:demo-app branch:main
  text      Edit(file_path=src/queue.js, old_string=…) -> Applied 1 edit to src/queue.js

  item_id   cc-toolu_lab_0004
  intent    trace   importance high
  text      Bash(…) FAILED: connect ECONNREFUSED 127.0.0.1:3000 export [REDACTED:assignment]
            Authorization: Bearer [REDACTED:github-token] aws key [REDACTED:aws-access-key]
            built from 9f2a11c4e5d6a7b8c9d0e1f2a3b4c5d6e7f8a9b0
```

Six things happened there:

1. **`.env` was dropped, not scrubbed.** A redacted `.env` is still a map of which secrets the
   project holds. Denylisted subjects never reach the spool at all.
2. **`build/bundle.js` was dropped too** — it is git-ignored, and the denylist honours
   `.gitignore` for free. You already declared those paths not-for-sharing.
3. **Three secret shapes were replaced**, each naming the rule that fired.
4. **The 40-hex git SHA survived.** Entropy over a 16-symbol alphabet is bounded by exactly
   4.0 and the threshold is `>= 4.0`, so a SHA can never trip the generic entropy rule. That is
   a property of the threshold, not a lucky fixture.
5. **The failure is graded `high`** while the successful edit is `medium`. A failed approach is
   the highest-value thing a coding agent can remember — it is the one class of knowledge the
   model cannot re-derive by reading the code.
6. **Every item carries an `intent`.** Items arriving without one cost the server an LLM call
   *per item* to classify. At tool-call frequency, that is the difference between a plugin you
   leave on and one you uninstall.

**Break it:** try to capture the plugin talking to itself —

```bash
echo '{"hook_event_name":"PostToolUse","session_id":"x","tool_name":"Bash","tool_use_id":"t9","tool_input":{"command":"curl $MUBIT_ENDPOINT/v2/core/health"},"tool_output":"OK"}' \
  | node "$HOOKS/capture.mjs"
peek spool     # unchanged
```

Self-reference suppression. Without it the plugin records its own traffic, recalls it, then
records the recall.

**Find the gap** (a real one, worth understanding):

```bash
node --input-type=module -e "
import { redactText } from '$CLAUDE_PLUGIN_ROOT/lib/redact.mjs';
for (const s of ['DATABASE_PASSWORD=hunter2', 'export DATABASE_PASSWORD=hunter2', 'env: DATABASE_PASSWORD=hunter2'])
  console.log(JSON.stringify(s), '->', JSON.stringify(redactText(s, {redact:true}, 'output').text));
"
```

The first two redact; the third does not. Read `ASSIGNMENT_RE` in `lib/redact.mjs` and work out
why a preceding `name:` swallows the assignment behind it. This is why stage 2 (drop whole
paths) exists rather than trusting stage 1 to catch everything.

**Read:** `hooks/src/capture.mjs`, `lib/redact.mjs`, `lib/classify.mjs`, `lib/spool.mjs`.

---

## Lab 5 — Stop: the turn closes, the drain flies, the outcome lands

```bash
hook capture 07-stop.json --stop
sleep 1
peek spool turns jobs
```

Terminal A now shows the two calls that matter most:

```
POST /v2/control/ingest
    idempotency_key=cc-p_lab_0001-0-06b7b1a469a8
    items=3
      · cc-toolu_lab_0001    trace        medium  "Edit(file_path=src/queue.js, …"
      · cc-toolu_lab_0004    trace        high    "Bash(…) FAILED: …"
      · cc-stop-p_lab_0001   task_result  medium  "Q: the ingest job stays queued … A: Not a bug in enqueue()…"
    replied job_id=job_lab_1 status=queued deduplicated=false

POST /v2/control/outcome
    outcome=success  signal=0.2  reference_id=global
    entry_ids=[les_g2, les_g1, ref_rule_1, ref_lesson_1, ref_fact_1]
    idempotency_key=cc-outcome-cc-demo-app-1ede9c0e-p_lab_0001
```

Five ids, not three: the turn reinforces the **injected standing lessons** (`les_g2`,
`les_g1` — the two session start put in front of the model) as well as what rung 1
recalled for this prompt. A lesson the model worked under is a lesson the outcome should
move, whether or not this particular prompt re-recalled it.

Walk the chain backwards and the whole point of the plugin appears: those `entry_ids`
are the reference ids of the memories **injected at session start and returned by rung 1
in Lab 3**, which `prompt-recall`
staged into the turn file, which the drain read when the turn ended. Recall feeds attribution;
attribution improves the next recall. That loop is the product.

Details worth noticing:

- **The third item is the turn itself** — `Q: … / A: …`, assembled from the staged prompt plus
  `last_assistant_message`. Neither half exists in one payload.
- **`signal: 0.2`, not 1.0.** A turn completing is weak positive evidence that the recalled
  memory helped, not proof. A failed turn is `-0.3`.
- **`status: "queued"` means accepted, not stored.** The spool files are unlinked anyway — the
  alternative is holding every item until a poll no hot path can afford. `jobs.json` keeps the
  last 20 job ids so the doctor skill can go back and ask.
- **Two idempotency keys, both derived, neither random.** Batch keys cover
  `(run, prompt, sequence, item ids)`; the outcome key covers `(run, prompt)`. A retry after a
  transport timeout is a server-side no-op — which is what makes it safe to abandon a detached
  drain and safe to have two drainers race.

Run the drain by hand to see the lock work:

```bash
node "$HOOKS/drain.mjs" < labs/payloads/02-prompt.json     # nothing left to send
```

**Read:** `hooks/src/capture.mjs` (`--stop` mode), `hooks/src/drain.mjs`, `lib/spool.mjs`
(the `link(2)` lock — the comment there explains a real race that was measured, not imagined).

---

## Lab 6 — SessionEnd: the only path that widens a lesson's scope

```bash
hook session-end 08-session-end.json
peek marker
```

```
POST /v2/control/reflect     run=… last_n_items=200 include_step_outcomes=true
    replied lessons_stored=1
POST /v2/control/agents/heartbeat   status=idle
```

Order is the design: **drain inline → flush pending outcomes → reflect → heartbeat idle.**

- The drain commits *before* reflect is attempted, because a failing reflect may never cost
  captures that were already accepted.
- Outcomes go out *before* reflect, because `include_step_outcomes` folds those signals into
  the evidence and the negative ones produce the best lessons.
- The flush runs in a **detached child** — the hook process answers the host immediately and
  the child finishes the sends on its own clock, so a host that tears the session down the
  moment the hook returns cannot kill the flush mid-send. (Earlier builds ran it inline for
  the opposite fear — that a detached child would be reaped — and lost reflects to impatient
  teardowns; `test/session-end-detach.test.mjs` in the main suite pins the current answer.)

Why reflect matters: Mubit extracts lessons on its own as it ingests, but those keep the scope
they were extracted at, and a `run`-scoped lesson is invisible to your next session.
`POST /v2/control/reflect` is the only call that can widen that. `reflectOnEnd: false` is not a
latency knob — it is opting out of cross-session memory.

**Break it:** run it a second time.

```bash
hook session-end 08-session-end.json    # stands down; no reflect
```

`claimOnce` wrote `flushed-<session_id>.marker`. SessionEnd can fire more than once (an `exit`
after a `clear`, a wrapper re-running the hook) and a double flush is a double reflect. Note it
returns *true* when it cannot write the marker: losing a session's captures is worse than
sending them twice, and the idempotency key already absorbs the double send.

**Read:** `hooks/src/session-end.mjs`.

---

## Lab 7 — The MCP server: what the model can call on purpose

The hooks are involuntary. The MCP server is the surface the model reaches for deliberately —
`/mubit-memory:recall`, `/mubit-memory:remember`, and the `mubit_*` tools behind them.

```bash
cd integrations/claude-code
node scripts/mcp-probe.mjs --call mubit_status --args '{}'
cd -
```

The probe speaks real stdio MCP: spawn, `initialize`, `notifications/initialized`,
`tools/list`, `tools/call` — exactly what Claude Code does.

```
server    mubit-memory 0.13.0
tools     7
  · mubit_dereference
  · mubit_diagnose
  · mubit_learned
  · mubit_memory_health
  · mubit_outcome
  · mubit_recall
  · mubit_status
mubit_status →
{ "status": "connected", "endpoint": "http://127.0.0.1:8787",
  "default_session": "cc-demo-app-1ede9c0e" }
```

**`default_session` is the same run id Lab 1 derived.** That is the whole job of
`mcp/src/launch.mjs`. The upstream server reads its config at *module scope*:

```js
const DEFAULT_SESSION_ID = process.env.MUBIT_DEFAULT_SESSION_ID || "default";
```

So the launcher resolves config, derives the run id with the **same** `lib/runid.mjs` the hooks
use, writes five env vars, and *only then* does `await import('./server.js')`. Setting any of
them one line later is indistinguishable from not setting them at all. Ordering is a
correctness property here, not a style preference.

If the two derivations ever diverged, `/mubit-memory:remember` would write into a run that
pre-prompt recall never reads — which is exactly what happens under
`runStrategy: per-conversation`, because an MCP server starts once per session and is never
handed a `session_id`. It falls back to `per-directory` and says so on stderr.

Note the tool count: **7**, not the 21 the upstream server has. Since 0.13.0 a blank `mcpTools`
means this curated set — the tools a model reaches for mid-task — and never "all": every tool
name costs schema tokens in every session whether or not it is ever called. The catalogue and
admin verbs (`mubit_lessons`, `mubit_reflect`, `mubit_checkpoint`, …) did not disappear; they
moved to `bin/admin.mjs`, which is what `/mubit-memory:remember` and its siblings run, and
Lab 11 drives them there. A list you supply is used verbatim, not unioned with the default:

```bash
MUBIT_MCP_TOOLS=mubit_lessons,mubit_status node labs/mcp-drive.mjs --list    # exactly those two
```

An older committed `mcp/dist/server.js` came from a published package that predated the
allowlist patch, so `MUBIT_MCP_TOOLS` was inert and the probe printed every tool the server
had. The lesson outlived the bug: a shipped artefact can disagree with its own README, and
probing is the only way you find out.

**Read:** `mcp/src/launch.mjs`, `.mcp.json`, `scripts/mcp-probe.mjs`.

---

## Lab 8 — Failure drills

Restart the fake instance with a scenario each time (Ctrl-C in Terminal A first).

### 8a — The operator disabled `direct_bypass`

```bash
node labs/fake-mubit.mjs --scenario deny-direct     # terminal A
hook prompt-recall 02-prompt.json                   # terminal B
hook prompt-recall 02-prompt.json
peek policy
```

First prompt: `403` on `direct_bypass` — and **nothing else**. `{"suppressOutput":true}`,
no injection, and the verdict cached to `policy/<endpoint_hash>.json` with a 24 h TTL; the
second prompt does not even probe. The descent the ladder table shows is **opt-in**: rung 2
costs one LLM call per prompt, so the plugin will not walk down to it on its own. Watch it
with the fallback enabled:

```bash
rm -f labs/.work/data/policy/*.json
MUBIT_CC_RECALL_FALLBACK=agent_routed hook prompt-recall 02-prompt.json
MUBIT_CC_RECALL_FALLBACK=agent_routed hook prompt-recall 02-prompt.json
```

Now the first prompt descends — `403` then `agent_routed`, one rung down, never two — and the
second goes **straight to `agent_routed`**: the cached 403 costs one wasted round trip per
day instead of one per prompt.

A 403 must also not touch the circuit breaker or the `auth_failed` state — an operator turning
a lane off is not a broken instance. A **401** on the same call is the opposite: give up, never
cache it, because a cached 401 would hide a revoked key for a day.

The cache outlives this drill by 24 hours, so before going back to the earlier labs:

```bash
rm -f labs/.work/data/policy/*.json     # rung 1 is probed again on the next prompt
```

### 8b — The server refuses the payload

```bash
node labs/fake-mubit.mjs --scenario reject-ingest
hook capture 03-edit.json
node "$HOOKS/drain.mjs" < labs/payloads/02-prompt.json
peek spool rejected
```

422 → the batch moves to `spool/rejected/`, quarantined and never retried. The three-way split
is the entire design of the drain:

| Response | Meaning | Action |
| --- | --- | --- |
| 2xx | accepted | unlink the spool files |
| 5xx, network, timeout | the server's problem, batch still good | leave every file, stop, retry next time |
| other 4xx (422, 400, 413…) | *this payload* is bad | quarantine — retrying forever is how a spool becomes unbounded |

401/403/404/408/429 stay retryable on purpose: nobody's memory gets deleted because they had
not pasted an API key yet.

Try `--scenario fail-ingest` (503) and watch the same batch stay put instead.

### 8c — Nothing is listening

```bash
# Ctrl-C the server, then:
rm -f labs/.work/data/status/health.json     # the 30 s readiness cache
hook session-start 01-session-start.json
hook capture 03-edit.json
peek marker breaker health
```

The steer block flips to **"Mubit memory is offline"** — the model is told, in the same channel
it would have received memory in, that there is none this session, *and* that its work is still
being kept. Capture keeps spooling; the next successful drain sends it.

The marker says `warming`, not `unreachable`, because the cold-start grace window (20 s) is
still open — an instance that is still starting is not broken, merely slow. `auth_failed` is
never masked this way, because a server still warming up does not answer 401.

Keep firing hooks with the server down and watch `breaker/<hash>.json` accumulate failures.
Five within 300 s opens the circuit for a 120 s cooldown; exactly one half-open probe dials when
it ends. The status line then reads `· paused 94s`, which tells you "it recovers in 94 seconds"
rather than "this thing is dead".

### 8d — Everything is slow

```bash
node labs/fake-mubit.mjs --scenario slow      # 2.5 s on every route
rm -f labs/.work/data/status/health.json      # bypass the 30 s readiness cache
time hook prompt-recall 02-prompt.json
time hook session-start 01-session-start.json
```

`prompt-recall` returns `{"suppressOutput":true}` at ~1.5 s — its internal budget, well inside
the 3 s hook timeout — and injects nothing rather than making the user wait. `session-start`
returns in **under half a second**: health is the gate and gets only 400 ms of the 2500 ms
budget, so a server that will not answer produces the offline steer block (state
`not_responding`, not `unreachable` — three consecutive timeouts is a different fact from a
refused connection) instead of spending the whole budget finding out.

**Read:** `lib/breaker.mjs`, `lib/http.mjs` (the five pre-flight guards at the top are worth
the read on their own).

---

## Lab 9 — Bonus: PreCompact, the one blocking network call

```bash
node labs/fake-mubit.mjs                    # healthy again
hook checkpoint 10-precompact.json --pre    # run from the repo root: the transcript path is relative
peek spool
node "$HOOKS/checkpoint.mjs" --post < labs/payloads/10-precompact.json
```

Every other hook would rather lose a memory than cost you a millisecond, because what it wanted
to capture is still on disk afterwards. `PreCompact` is the one event where that is false: once
the host compacts, the transcript is gone. So this hook blocks — and it spools its summary item
*before* it posts, so the anchor survives even a call that hangs.

The transcript is also the densest secret surface the plugin ever touches. Check the spooled
item: the `DATABASE_PASSWORD=` line in `labs/payloads/transcript.jsonl` never reaches the wire.

---

## Lab 10 — The tests are the real spec

```bash
cd integrations/claude-code && npm test        # ~40 s, ~1650 tests, no network, no Docker
```

The labs have a suite of their own, which is what keeps this walkthrough honest: it drives
the same hooks, payloads, CLI and MCP driver you just ran by hand and asserts the outcomes
each lab documents — so when the plugin moves, the walkthrough breaks loudly here instead of
silently on you. `labs/test/hooks.test.mjs` is Labs 1–6 and 9, `labs/test/failure-drills.test.mjs`
is Lab 8, `labs/test/mcp-routes.test.mjs` is Labs 7 and 11, `labs/test/seen-set.test.mjs` is
Lab 12, and `labs/test/readme-drift.test.mjs` checks that everything this file names still exists.

```bash
node --test labs/test/*.test.mjs      # from the repo root; needs nothing but Node
```

`test/helpers/harness.mjs` is worth reading before any of the test files: `fakeMubit()` is a
richer version of `labs/fake-mubit.mjs` (per-route replies, delays, hangs, request assertions),
and `runHook()` spawns hooks exactly as Claude Code does. Every design decision described above
has a test that pins it — `prompt-recall`'s test asserts rung 3 is *never* reached by default,
because it is the first thing a well-meaning maintainer would "simplify" into place at two LLM
calls per prompt.

Pick one behaviour you found surprising in Labs 1–9 and find the test that pins it. Then change
the implementation to break it and watch which test fails. (One timing-sensitive test can flake
under load; re-run before believing a single failure.)

---

## Lab 11 — Watching the wire: what an MCP tool actually dials

Lab 7 asked the server what it exposes. This one asks a harder question: when the model calls
a tool, **where does the request go?** A tool's answer tells you what came back. It does not
tell you which route produced it — and for several of the plugin's guarantees, the route is
the guarantee.

```bash
node labs/fake-mubit.mjs        # terminal A
source labs/env.sh              # terminal B, from the repo root
wire admin lessons
```

Since 0.13.0 the catalogue is not an MCP tool by default (Lab 7): `mubit_lessons` and the other
admin verbs moved to `bin/admin.mjs`, which is what `/mubit-memory:remember` and its siblings
run. `admin` is that script pointed at the lab store, and `wire` diffs
`labs/.work/requests.ndjson` across whatever it wraps — so the question above can be asked of
a shell command as easily as of a tool call. The script has no session to derive a run from,
so it acts on the run the hooks last wrote a status marker for (Lab 2's), exactly as it does
under a skill; `--run <id>` names another.

`mcp` is `labs/mcp-drive.mjs`. It differs from `scripts/mcp-probe.mjs` in exactly two ways,
both of which matter here.

**It never needs the key.** The probe reads `MUBIT_ENDPOINT` / `MUBIT_API_KEY` from the
environment, so pointing it at a real instance means exporting a real credential into a shell.
This driver sets `MUBIT_CC_DATA_DIR` and stops, and lets the launcher's own `loadConfig()`
resolve the stored credential the way it does in a real session. Nothing reads the key,
nothing prints it. That is what makes Drill E safe.

**It shows the routes.** `--routes` is the same diff, for a tool call.

### 11a — The catalogue does not read the lessons route

```
routes dialled by that call:
  POST /v2/control/activity → 200
```

Not `/v2/control/lessons` — the route whose name matches the verb. The reason is paging order.
The lessons route pages *before* it filters, so `{scope:'global', limit:5}` asks for five rows
and then keeps whichever of those five happen to be global: on an account with any history,
reliably none. The activity feed collects and sorts *before* it pages, so a small limit costs
you the oldest rows and never the newest.

That is a false negative rather than an error, which is the dangerous kind. Both routes answer
`200`. Only the wire tells you which one you were on.

### 11b — Where the run boundary actually falls

The fake instance holds five lessons. Four come back:

| id | scope | wrote it | in a default read? |
| --- | --- | --- | --- |
| `les_r1` | `run` | you | yes — it is yours |
| `les_s1` | `session` | you | yes |
| `les_g1` | `global` | another run | yes — global reaches |
| `les_g2` | `global` | another run | yes |
| `les_r2` | `run` | another run | **no** |

`les_r2` is the whole test. A run-scoped lesson belongs to the run that wrote it, and a
catalogue that shows you someone else's is not confined. Ask for a scope explicitly and the
boundary moves on purpose:

```bash
wire admin lessons --scope global    # 2 rows, both from the other run
```

Note what rides above the rows: `showing:` names the boundary that was applied and `matched:`
counts what was inside it. A catalogue that cannot say what it excluded is not one you can act
on. The tool form of the same read — `MUBIT_MCP_TOOLS=mubit_lessons mcp mubit_lessons '{}'` —
prints the same two lines above its rows, because both go through one renderer (Lab 12).

**The trap worth knowing.** Rows carry a run id in two spellings — bare on `run_id`, and
namespaced inside the metadata's `source_run_id`. "Is this mine?" has to be the union of both.
Compare against one and you drop half your own rows, and the failure looks like an empty
account rather than a bug.

### 11c — A partial answer that says so

```bash
pkill -f labs/fake-mubit.mjs
node labs/fake-mubit.mjs --scenario truncate    # pages at 2, corpus padded past a census
MUBIT_MCP_TOOLS=mubit_lessons mcp mubit_lessons '{}'
```

```json
"mubit_lessons_guard": {
  "shown": 0,
  "partial": true,
  "note": "This catalogue is partial: the listing was cut short (max_pages) … No total is available."
}
```

**There is no `matched` key.** That absence is deliberate. A count printed next to an
admission of partiality is the number a reader acts on, and it would be wrong. Notice also
that `shown` is legitimately `0` here — a partial listing can honestly show nothing, which is
precisely why it must not also print a total that implies it found nothing.

Now the same read through the shell command:

```bash
admin lessons
# run_id: cc-demo-app-…
# showing: this run, plus every lesson stored at a scope that reaches past the run that wrote it
# partial: true
# note: This catalogue is partial: the listing was cut short (max_pages), so these are some of
#       the lessons that matched and not all of them. No total is available; --scope narrows
#       the request.
```

Two surfaces, one rule. 0.13.0 printed `No lessons matched.` here — a claim where the tool made
an admission, because the empty branch was written for a healthy feed that found nothing and
never asked whether the feed was whole. `--json` carries the same keys, and `matched` is absent
from both forms whenever `partial` is present.

The same discipline is visible at session start:

```bash
hook session-start 01-session-start.json
# mubit: hosted · run … · global lessons: partial listing
```

Not "0 global lessons". Zero is a claim; this is a listing that ran out.

### 11d — The write path reaches the widening authority

Reflect is the only call that can widen a lesson's scope past `run`, and session end decides
whether to make it. That decision used to read the hook-side spool alone — so a session whose
only memory activity went through the MCP looked, from session end, like a session that did
nothing.

Drive it: a session that opens, writes one lesson through the MCP, and captures nothing.

```bash
node labs/setup.mjs --reset && node labs/setup.mjs
# restart the fake instance, then:
hook session-start 01-session-start.json
mcp mubit_learned '{"text":"The demo app listens on 3000, not 8080."}'
peek marker            # captured ingested=0  ·  mcp ingested=1
hook session-end 08-session-end.json
```

```
  POST /v2/control/activity   ← session start read standing lessons
  POST /v2/control/ingest     ← the MCP write
  POST /v2/control/reflect    ← session end reflected anyway
```

Zero hook captures, and it still reflected. The link is one term in the run marker: the egress
guard records a successful MCP ingest, and session end counts it. Delete `mcp.ingested` from
the marker between the two commands and the reflect disappears — worth doing once, because it
is the shortest proof that the two surfaces are joined by that one field and nothing else.

**`mubit_learned` takes `text`, not `content`.** Easy hours to lose. A rejected write can also
land a malformed lesson that renders in every later session's steer block, so check what you
wrote rather than only whether the call returned.

### 11e — The same commands against a real instance

```bash
MUBIT_MCP_TOOLS=mubit_lessons node labs/mcp-drive.mjs --live \
  --data-dir ~/.claude/plugins/data/mubit-memory-mubit \
  --tool mubit_lessons --args '{}'
```

`--live` deletes the lab's endpoint and key from the child environment so the stored
credential decides both. Deleting rather than blanking is the trick: an empty string is still
a value, and config resolution would take it.

Two things only a real instance shows. Its lessons carry promotion metadata, or — more
usefully — visibly do not, which is a different fact from "no candidates" and is what
`scripts/scope-audit.mjs` exists to distinguish. And the run-id spelling above is genuinely
two-valued in stored data, where a fixture only has whatever spelling its author typed.

**Why not the test harness?** `test/helpers/harness.mjs` overrides `MUBIT_API_KEY` with a
fixture and `HOME` with a temp directory, which is correct for tests and fatal for a live
drive: the calls go out with the wrong key and come back as a generic failure. That is the gap
this driver fills, and the reason it is a lab tool rather than a test helper.

## Lab 12 — Repeats: what this conversation has already been shown

Recall injection is the plugin's largest recurring cost — up to 1500 tokens on **every**
prompt, against 356 tokens once for the whole MCP tool surface — and a lesson that stays
relevant for twenty prompts used to be rendered twenty times. So the plugin keeps a
**seen-set**: the reference ids one conversation has already been handed in full. A repeat is
degraded to a pointer — the id plus its first clause, about 20 tokens against 200 — and
`mubit_dereference` expands it on demand.

The unit of that promise is the conversation. "You were shown this earlier" is only true of
the transcript the entry was injected into, so the set is keyed by the host session id as
well as the run: `runs/<run_id>/seen/<session_id>.json`. It was keyed by the run alone until
0.13.0, and the run is the wrong unit: under `per-directory` a run id is the path, so every
session opened in a directory shared one set for six hours — session B was handed pointers for
what session A had seen, A's compaction wiped B's record, and a shell command that rendered
the catalogue marked the set too, with no way of knowing whether its stdout ever reached a
model.

Start clean, so the set is empty:

```bash
node labs/setup.mjs --reset && node labs/setup.mjs
# restart the fake instance in terminal A, then:
hook session-start 01-session-start.json
```

### 12a — A second prompt in the same conversation

The two payloads carry the same session id and the same question; only `prompt_id` differs.

```bash
hook prompt-recall 11-prompt-retry.json
hook prompt-recall 12-prompt-retry-again.json
peek seen
```

The first block renders three two-sentence memories in full, 176 tokens. The second:

```
<mubit-memory run="cc-demo-app-…" sources="3" tokens="85">
Recalled from memory of earlier work — it may be incomplete or out of date, …
A line marked "(seen earlier)" was injected in full earlier in this conversation and is repeated here only as a reference; ask mubit_dereference for its text.

## Active rules
- (seen earlier) ref_retry_rule — Never retry an ingest batch that answered "queued": the job is a…

## Lessons
- (seen earlier) ref_retry_lesson — A batch that stayed queued for four minutes was waiting on the i…

## Facts
- (seen earlier) ref_retry_fact — GET /v2/control/ingest/jobs/<id> answers done:true once indexing…
</mubit-memory>
```

```
runs/<run_id>/seen/<session_id>.json  — what one conversation has already been shown in full (6 h TTL from the last sighting)
  cc-demo-app-…/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.json   4 ref(s)   updated 12:54:14.754
    ref_rule_1         ×1   …        ← the resume block's one source (Lab 3)
    ref_retry_rule     ×2   …
    ref_retry_lesson   ×2   …
    ref_retry_fact     ×2   …
```

Three things to notice.

- **A pointer is cheaper to read, not cheaper to credit.** `peek turns` shows `p_lab_0012`
  recalled the same three ids, so `Stop` reinforces them exactly as it would a full line.
- **Why Lab 3 never did this.** Its three memories are one short sentence each, and a pointer
  longer than the entry it replaces is never used — `- (seen earlier) ref_rule_1 — …` would cost
  more than the line it stands in for. Real lessons run to a sentence or two, which is why this
  lab has an evidence set of its own.
- **The file is a roll-up, not a source of truth.** Every id in it is already in a turn file.
  Losing it costs one expensive turn and cannot cost correctness — which is what makes every
  failure below cheap. An entry expires 6 h after its last sighting, and the sweep in
  `lib/state.mjs` prunes the directory.

### 12b — Another conversation in the same directory

```bash
hook prompt-recall 13-prompt-retry-session-b.json
peek seen
```

Session B — same run, same directory, same minute — gets all three in full and a file of its
own; A's file is byte-for-byte what it was (compare `updated`). Before 0.13.0 B would have been
handed A's pointers, with nothing in its own transcript to dereference them against.

### 12c — No session at all

```bash
hook prompt-recall 14-prompt-retry-no-session.json
peek seen          # still two files
```

A payload with no usable session id — absent, blank, or a placeholder like `default` — renders
in full and marks nothing. That is the fail-safe direction: a caller that cannot say which
conversation it is in cannot claim anything was shown to it, and the worst outcome of every
failure in this module is "render it in full again".

### 12d — The MCP tools are one conversation too

The launcher reads the host session id from `CLAUDE_CODE_SESSION_ID`, which Claude Code exports
to the MCP servers it starts, and keys the same file by it. `mcp --session` sets it; without
the flag the driver *removes* it, because a lab shell running inside a Claude Code session
would otherwise inherit the host's own id.

```bash
mcp mubit_recall '{"query":"retry when the ingest job stays queued"}' --session 1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d
mcp mubit_recall '{"query":"retry when the ingest job stays queued"}'
```

```
Memories (3, 3 seen earlier):
- (seen earlier) ref_retry_rule — Never retry an ingest batch that answered "queued": the job is a…
- (seen earlier) ref_retry_lesson — A batch that stayed queued for four minutes was waiting on the i…
- (seen earlier) ref_retry_fact — GET /v2/control/ingest/jobs/<id> answers done:true once indexing…
Raw result: …/runs/cc-demo-app-…/spill/…-evidence-0.json
A line marked "(seen earlier)" was shown in full earlier in this conversation; mubit_dereference returns its text.
```

Session A's tool call points at what the *hooks* showed A: one set, two surfaces, one pointer
convention — the model meets one rendering whichever way it asked. The anonymous call renders
in full and writes nothing (`peek seen` again). Codex hands its MCP server no session id at
all, so on that host every tool result renders in full and marks nothing; the hooks there carry
`session_id` and behave as above.

### 12e — The shell is not a conversation

```bash
wire admin lessons
peek seen          # unchanged
```

`bin/admin.mjs` — what `/mubit-memory:remember`, `:reflect`, `:strategies`, `:checkpoint` and
`:forget` run — never reads or writes the set: it has no session, and a shell has no way of
knowing whether its stdout reached a model. Every lesson prints in full, always. In 0.12.x it
marked the set, and one verification run from a plain terminal is what turned the next
conversation's whole catalogue into fragments.

The `--data-dir` the `admin` helper appends is the other half of that fix. A Bash tool call
inside Claude Code does not inherit `CLAUDE_PLUGIN_DATA`, so without the flag the script
searches `~/.claude/plugins/data/` for a store and can pick one the hooks are not writing to —
a session started with `--plugin-dir` writes to `mubit-memory-inline`, an installed one to
`mubit-memory-mubit`. With it the run is picked from the store you named:

```bash
env -u MUBIT_CC_DATA_DIR -u CLAUDE_PLUGIN_DATA \
  node "$CLAUDE_PLUGIN_ROOT/bin/admin.mjs" lessons --data-dir "$CLAUDE_PLUGIN_DATA"
# run_id: cc-demo-app-…   ← this run, from a shell whose environment names no store
```

### 12f — Compaction clears one conversation's file

```bash
hook checkpoint 10-precompact.json --post
peek seen          # A's file is gone; B's remains
```

After a compaction the model has seen none of it, so A starts over — and only A. Before
0.13.0 this wiped the run's single file, which was B's record too.

### 12g — Opting out

```bash
MUBIT_CC_RECALL_REPEAT_MODE=full hook prompt-recall 13-prompt-retry-session-b.json
MUBIT_CC_RECALL_REPEAT_MODE=full mcp mubit_recall '{"query":"retry when the ingest job stays queued"}' \
  --session 7a0b3c2d-9e8f-4a1b-8c2d-3e4f5a6b7c8d
```

`recallRepeatMode: full` re-sends every entry in full, every time, on both surfaces — what
releases before 0.10 did on the hook path, and what MCP results did regardless of the setting
until 0.13.0.

**Read:** `lib/seen.mjs` (the header explains why the run was the wrong key),
`mcp/src/results.mjs` (the results guard), `hooks/src/prompt-recall.mjs` (`readSeen` before the
block is assembled, `markSeen` after).

**Pinned by:** `labs/test/seen-set.test.mjs`.

---

## File map

| Path | What lives there |
| --- | --- |
| `hooks/hooks.json` | the fifteen registrations, matchers and timeouts — start here |
| `hooks/src/session-start.mjs` | health, register, global lessons, the steer block |
| `hooks/src/prompt-recall.mjs` | the recall ladder, the policy cache |
| `hooks/src/stage-prompt.mjs` | stages the prompt, triggers the drain. Zero network |
| `hooks/src/capture.mjs` | four modes: tool, `--failure`, `--stop`, `--subagent` |
| `hooks/src/drain.mjs` | the only outbound path in the write direction |
| `hooks/src/checkpoint.mjs` | `--pre` blocks; `--post` is a file read |
| `hooks/src/session-end.mjs` | drain → outcomes → reflect → idle |
| `lib/config.mjs` | five-level precedence resolution |
| `lib/runid.mjs` | run and agent identity — the join key |
| `lib/http.mjs` | the only network primitive; never throws |
| `lib/spool.mjs` | file-per-item buffer, drain lock, `claimOnce` |
| `lib/redact.mjs` | the three sanitisation stages |
| `lib/classify.mjs` | tool → intent/importance |
| `lib/assemble.mjs` | client-side section rendering (rung 1's payoff) |
| `lib/breaker.mjs` | connection states, failure classification, cooldown |
| `mcp/src/launch.mjs` | env ordering + run-id agreement before importing the server |
| `mcp/src/results.mjs` | the results guard: one line per item, a repeat as a pointer, keyed by the host session |
| `lib/seen.mjs` | what one conversation has been shown — `runs/<run>/seen/<session_id>.json` |
| `bin/admin.mjs` | the catalogue and admin verbs the skills run — always in full, never in the seen-set |
| `bin/statusline.mjs` | reads two JSON files, renders one line, never dials |
| `skills/*/SKILL.md` | the thirteen slash commands; the admin ones run `bin/admin.mjs` |
| `test/helpers/harness.mjs` | fake Mubit, hook runner, fixtures |
| `labs/fake-mubit.mjs` | the instance you can watch; `--scenario` picks how it misbehaves |
| `labs/mcp-drive.mjs` | call one MCP tool as one conversation or none, show the routes it dialled, never touch the key |
| `labs/peek.mjs` | what the hooks left on disk |
| `labs/runid.mjs` | the run id these settings derive, without running a hook |
| `labs/test/*.test.mjs` | the labs as a suite — Lab 10 |

---

## Cleanup

```bash
node labs/setup.mjs --reset     # removes labs/.work entirely
pkill -f labs/fake-mubit.mjs
```
