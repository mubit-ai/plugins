# Observed host behaviour

Everything here was produced by running the real `codex` binary and writing down what it did.
Nothing here was read out of it.

| | |
| --- | --- |
| host | `codex-cli 0.154.0` |
| recorded | 2026-09-28 |
| regenerate | `node test/helpers/codex-record.mjs --update --probe <name>` — see below |

## `payloads/`

What the host wrote to a hook's stdin, exactly, with the values that differ per run replaced
by `{{PLACEHOLDER}}` tokens — ids, the transcript path and the working directory. Every field
name and every nested shape is verbatim.

`<Event>.json` is the plain case of an event. `<Event>.<variant>.json` is the same event in a
shape the plain one does not show, and the session scorecard and the outcome review read
exactly these:

| File | What it shows |
| --- | --- |
| `PostToolUse.mcp.json` | a call to the `mubit` MCP server: `tool_input` is the arguments, and `tool_response` is the MCP result object — `{"content":[{"type":"text",…}]}` — where a shell call's is a bare string |
| `Stop.continuation.json` | the Stop after a hook answered `{"decision":"block","reason":…}`: `stop_hook_active` is `true`, the turn is the same one, and `last_assistant_message` holds only what the model said after the block |
| `UserPromptSubmit.queued.json` | a message typed while a turn was running: the running turn's `turn_id`, and nothing else that marks it |

These are the oracle for `codex-payload.test.mjs`. The point of having one at all is that a
fixture written beside an implementation cannot falsify that implementation: whatever shape
the code reads, the fixture will have. A recording can, because the host wrote it.

### Re-recording with `codex exec`

```bash
node test/helpers/codex-record.mjs --update --probe suppressOutput
node test/helpers/codex-record.mjs --update --probe systemMessage
node test/helpers/codex-record.mjs --update --probe block-once
```

Each run is one `codex exec` session in a throwaway `CODEX_HOME`: a recorder on every event,
a tiny stdio MCP server named `mubit` exposing `mubit_outcome`, and a prompt to run one shell
command and make one call to that tool. The recorder answers the MCP call's permission ask
with an allow, so the call runs and both its ask and its result are recorded. The real
`~/.codex` is only read, for the credential, which is copied in and deleted with the home.

Run `block-once` last. It is the only session that blocks a Stop, so the only one that reaches
the continuation, and a `suppressOutput` session answers the permission ask with its probe,
so the call is refused there and records no MCP result.

## Recorded by hand in the TUI

Two recordings come from interactive TUI sessions, because `codex exec` can neither type
while a turn is running nor press Esc. `--update` never regenerates them:

- `UserPromptSubmit.queued.json` — a second message typed while the first turn was still
  running. The host fired UserPromptSubmit again with the running turn's `turn_id`, and the
  turn ended in a single Stop.
- `Interrupt.json` — Esc pressed while a tool call was running. No Stop fired for that turn;
  Interrupt did, with the running turn's `turn_id` and no reply.

Both were captured on `codex-cli 0.154.0` in a throwaway `CODEX_HOME` carrying a recorder on
every event, Interrupt included, and then put through the recorder's own placeholder
substitution (`normalizePayload()`) on the way in — the same substitution `--update` applies —
so they carry placeholders, not the session's ids and paths. To re-record them:

```bash
node test/helpers/codex-record.mjs --tui-home      # prints the CODEX_HOME to start the TUI in
node test/helpers/codex-record.mjs --import <capture> --as UserPromptSubmit.queued
node test/helpers/codex-record.mjs --import <capture> --as Interrupt
```

Delete the printed home afterwards: it holds a copy of the credential.

## `output-acceptance.json`

What the host did with an output a hook returned, per event. `codex exec` reports
`hook: <Event> Completed`, `… Blocked` or `… Failed`, which is the verdict: `Failed` is the
host refusing the output.

- `suppressOutput` answers every event with `{"suppressOutput": true}`.
- `systemMessage` answers the first Stop with a multi-line `systemMessage` string, the shape a
  scorecard would be delivered in. The host takes it; the TUI shows it under the reply with
  its line breaks kept, and `codex exec` never prints it.
- `block-once` answers the first Stop with `decision:block` and a reason. The host takes it
  (`hook: Stop Blocked`) and the model continues the same turn.

This is the externally-verified subset of `../codex-output-rules.json`. That file states the
constraints this plugin holds its own output to; this one records the ones a real session has
confirmed, and `codex-payload.test.mjs` cross-checks them so the two cannot drift apart
silently.

On 0.154.0 `codex exec` runs the SessionEnd hook — its payload is recorded — but prints no
verdict line for it, so there is no SessionEnd verdict here. On 0.149.0 there was one, and it
was an accept.

## What is not covered

Four of the eleven events the plugin registers do not fire in any session the recorder
drives, so there is no recording of them:

| Event | What it would take |
| --- | --- |
| `PreCompact`, `PostCompact` | a context window full enough to compact |
| `SubagentStart`, `SubagentStop` | a spawned subagent |

Their builders in `test/helpers/codex-fixtures.mjs` are still the plugin's best record of what
those payloads look like — they are simply not falsifiable by anything in this directory, and
`codex-payload.test.mjs` says so by name rather than passing over it. Closing one of these
gaps means extending `codex-record.mjs` to drive a session that reaches the event, not
hand-writing a file here.

## Why this and not the host's own schemas

The previous oracle was twenty-one schema documents that came out of the host's own build
rather than off its wire. They were a stronger instrument than this one — closed schemas, both
directions, all eleven events, able to reject a field as well as require one — and they were
the vendor's, republished here along with enough detail to obtain more of them. That is not
ours to publish, however useful it was.

A recording pins the fields an event was *seen* to carry rather than the fields it *may*
carry. It cannot prove a field optional and it cannot reject one the host would accept. It
still catches the failure that matters: a builder that invents a field the host has never
sent, or drops one it always sends.
