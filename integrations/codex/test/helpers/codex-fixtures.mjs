// @ts-check
/**
 * Test harness for the `mubit-memory` **Codex** plugin.
 *
 * Two things live here and nothing else:
 *
 *   1. **One builder per Codex hook event.** Each returns a payload shaped as `codex exec`
 *      writes it — observed, not invented.
 *   2. **The recordings to check them against.** This is the load-bearing part. A fixture
 *      written beside the implementation cannot falsify that implementation: whatever shape
 *      the code expects, the fixture will have. A fixture checked against
 *      `test/fixtures/observed/payloads/*.json` — written by the host itself, into a
 *      recorder hook, during a real session — can.
 *
 *      What a recording proves is one-sided: it pins the fields an event was *seen* to carry,
 *      not the fields it *may* carry. It cannot prove a field optional. It still catches the
 *      mistake a hand-written Codex fixture actually makes, which is inventing a field the
 *      host has never sent. See `test/fixtures/observed/README.md`, and
 *      `test/helpers/codex-record.mjs` for how to re-record.
 *
 * Everything else — `makeDataDir`, `fakeMubit`, `runHook`, `assertHookContract`,
 * `mcpListTools` — is the Claude Code suite's harness, re-exported. There is deliberately no
 * second copy: the spawn protocol, the fake server and the contract assertions are identical
 * across the two hosts, and a fork of them would be a second thing to keep true. The wrappers
 * below only bind the plugin root, so `runHook('capture', …)` here runs
 * `integrations/codex/hooks/{src,dist}/capture.mjs`.
 *
 * Node >= 20 built-ins only. No YAML, no JSON-Schema dependency, no framework.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as h from '../../../claude-code/test/helpers/harness.mjs';
import { recordingName } from './codex-record.mjs';

/** Absolute path to `integrations/codex/`. */
export const CODEX_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Absolute path to `integrations/claude-code/` — the plugin whose `lib/` both share. */
export const SHARED_ROOT = resolve(CODEX_ROOT, '..', 'claude-code');

/** Absolute path to the repo root. */
export const REPO_ROOT = resolve(CODEX_ROOT, '..', '..');

/** Where the recordings of what the host actually sent live. */
export const OBSERVED_DIR = join(CODEX_ROOT, 'test', 'fixtures', 'observed');

/**
 * The eleven events Codex 0.146.0 dispatches, in the order its own `HookEventsToml` lists
 * them. Claude Code has thirteen; `CwdChanged`, `PostToolUseFailure` and `StopFailure` have
 * no Codex counterpart, and `PermissionRequest` has no Claude Code one.
 */
export const CODEX_EVENTS = [
  'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact',
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop',
];

/** `PreToolUse` -> `pre-tool-use`, which is how the extracted schema files are named. */
export function schemaSlug(event) {
  return String(event).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

// ---------------------------------------------------------------------------
// Re-exports, bound to the Codex plugin root
// ---------------------------------------------------------------------------

export const {
  assert, tempDir, makeDataDir, makeProjectDir, withEnv, fakeMubit, defaultRoutes,
  queryResponse, evidence, contextResponse, assertHookContract, assertWithinBudget,
  readJsonFile, readJsonDir, spoolFiles, soleRunId, waitFor,
} = h;

/** `baseEnv`, with `CLAUDE_PLUGIN_ROOT` pointing at the Codex plugin. */
export function baseEnv(o) {
  return h.baseEnv({ ...o, pluginRoot: o.pluginRoot ?? CODEX_ROOT });
}

/** `runHook`, resolving `integrations/codex/hooks/{src,dist}/<name>.mjs`. */
export function runHook(name, payload, opts = {}) {
  return h.runHook(name, payload, { root: CODEX_ROOT, ...opts });
}

/** `mcpListTools`, launching `integrations/codex/mcp/dist/index.js`. */
export function mcpListTools(opts = {}) {
  return h.mcpListTools({ root: CODEX_ROOT, ...opts });
}

/** `mcpDrive`, launching the Codex plugin's server. */
export function mcpDrive(opts = {}) {
  return h.mcpDrive({ root: CODEX_ROOT, ...opts });
}

/** Import a shared `lib/` module fresh. The Codex plugin has no `lib/` of its own but one. */
export function lib(file) { return h.lib(file); }

let _bust = 0;

/** Import a module from **this** plugin (e.g. `lib/boot.mjs`), bypassing the ESM cache. */
export function codexMod(relPath) {
  const p = join(CODEX_ROOT, relPath);
  if (!existsSync(p)) {
    throw new Error(`integrations/codex/${relPath} does not exist yet — write it, then re-run.`);
  }
  return import(`${new URL(`file://${p}`).href}?fresh=${_bust++}`);
}

// ---------------------------------------------------------------------------
// What the host was recorded sending
// ---------------------------------------------------------------------------

/** @type {Map<string, any>} */
const _observed = new Map();

/** `'session-start.command.input'` → `'SessionStart'`. The inverse of `schemaSlug`. */
export function eventOfTitle(title) {
  const slug = String(title).replace(/\.command\.(input|output)$/, '');
  return CODEX_EVENTS.find((e) => schemaSlug(e) === slug) ?? '';
}

/** Whether a title names an output rather than an input. */
export function isOutputTitle(title) {
  return String(title).endsWith('.command.output');
}

/**
 * The recorded payload for one event, or `null` if that event has no recording.
 *
 * `null` is a real answer here rather than an error: four of the eleven registered events —
 * `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop` — do not fire in any session
 * the recorder drives, so their absence is expected and documented. What must never
 * happen is the whole corpus going missing and every check below passing vacuously — which is
 * why `codex-payload.test.mjs` asserts the covered set by name.
 */
export function observedPayload(event) {
  if (_observed.has(event)) return _observed.get(event);
  const p = join(OBSERVED_DIR, 'payloads', `${event}.json`);
  const parsed = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  _observed.set(event, parsed);
  return parsed;
}

/** Every event with a recording, sorted; `PostToolUse.mcp.json` counts as `PostToolUse`. */
export function observedEvents() {
  const dir = join(OBSERVED_DIR, 'payloads');
  if (!existsSync(dir)) return [];
  const events = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.split('.')[0]);
  return [...new Set(events)].sort();
}

/** The host's recorded verdicts on outputs a hook returned. */
export function outputAcceptance() {
  const p = join(OBSERVED_DIR, 'output-acceptance.json');
  if (!existsSync(p)) throw new Error(`no recorded output verdicts at ${p}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

/**
 * Every field in `value` the host has never been recorded sending for this event.
 *
 * This is the half of `additionalProperties: false` a recording can still do. It cannot say a
 * field is required — seeing one once does not make it mandatory — but it can say a field was
 * invented, and inventing one is the mistake a fixture written next to the implementation
 * actually makes. It caught `permission_mode` on the first draft of `preCompact()` and
 * `tool_use_id` on `permissionRequest()`.
 *
 * An event can have more than one recording: `PostToolUse.json` is a shell call and
 * `PostToolUse.mcp.json` an MCP one, whose arguments are other keys. A value is held to the
 * recording its own shape is filed under (`recordingName()`), so a shell call cannot pass by
 * borrowing an MCP call's arguments, or the reverse. Only a value the recorder files nowhere —
 * an MCP call's `PreToolUse`, say — falls back to **any** recording of its event, and then the
 * errors reported are those against the recording it comes closest to.
 *
 * Nested objects are walked one level, which is as deep as any Codex payload goes.
 *
 * @param {string} event
 * @param {any} value
 * @returns {string[]} empty when nothing was invented
 */
export function observedKeyErrors(event, value) {
  if (value === null || typeof value !== 'object') return [];
  const own = recordingName(value);
  const filed = own.split('.')[0] === event ? observedPayload(own) : null;
  const dir = join(OBSERVED_DIR, 'payloads');
  const variants = filed ? [filed] : (existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.json') && f.split('.')[0] === event).sort()
      .map((f) => observedPayload(f.slice(0, -'.json'.length)))
    : []);
  let best = null;
  for (const seen of variants) {
    const errs = [];
    for (const k of Object.keys(value)) {
      if (!(k in seen)) { errs.push(`$.${k}: the host has never been recorded sending this field`); continue; }
      const a = value[k];
      const b = seen[k];
      if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
        for (const k2 of Object.keys(a)) {
          if (!(k2 in b)) errs.push(`$.${k}.${k2}: the host has never been recorded sending this field`);
        }
      }
    }
    if (!errs.length) return [];
    if (!best || errs.length < best.length) best = errs;
  }
  return best ?? [];
}

/**
 * Which output channels an event has, from the plugin's own contract table.
 *
 * These used to be read off the host's output schemas. They are asserted rather than read
 * now — see `test/fixtures/codex-output-rules.json` for what that trade cost and what
 * `observed/output-acceptance.json` still verifies.
 */
export function outputCapabilities(event) {
  const caps = outputRules().capabilities ?? {};
  const c = caps[event];
  if (!c) throw new Error(`no output capabilities recorded for "${event}"`);
  return c;
}

/**
 * Assert a payload is one the host could have sent, or an output it would accept.
 *
 * Input titles check against the recording; output titles check against the contract, which
 * is what `assertOutputAccepted` does. The signature is unchanged from when both halves were
 * a schema, because every caller wants the same thing from it: "is this a shape the host
 * deals in, or did we make it up?"
 *
 * @param {any} value
 * @param {string} title  e.g. `'session-start.command.input'`
 * @param {string} what   what the caller is validating, for the message
 */
export function assertValid(value, title, what) {
  const event = eventOfTitle(title);
  assert.ok(event, `"${title}" does not name a Codex event`);

  if (isOutputTitle(title)) { assertOutputAccepted(event, value, what); return; }

  assert.equal(value?.hook_event_name, event,
    `${what} carries hook_event_name ${JSON.stringify(value?.hook_event_name)}, but it is `
    + `meant to be a ${event} payload. A hook that serves several events reads that field to `
    + 'know which one it was handed.');

  if (!observedPayload(event)) return;
  const errs = observedKeyErrors(event, value);
  assert.deepEqual(errs, [],
    `${what} carries fields the host has never been recorded sending on ${event}, so it is `
    + `not a payload Codex would send — a test built on it proves nothing:\n  ${errs.join('\n  ')}`);
}

// ---------------------------------------------------------------------------
// What a hook may answer with
// ---------------------------------------------------------------------------

/**
 * `test/fixtures/codex-output-rules.json` — the constraints this plugin holds its own hook
 * output to, and the channels each event has.
 *
 * It is a separate thing from the wire format, and that was learned the expensive way: an
 * output can be well-formed and still be refused. `suppressOutput` is the case that reached a
 * user — accepted on most events, refused on `PreToolUse` and `PostToolUse`, where a real
 * session prints `PostToolUse hook returned unsupported suppressOutput`. A check that looked
 * only at the shape went green on it.
 *
 * `observed/output-acceptance.json` is the recorded half: a real session's verdict on an
 * output a hook actually returned. `codex-payload.test.mjs` cross-checks the two.
 */
let _rules = null;

function outputRules() {
  if (_rules) return _rules;
  const p = join(CODEX_ROOT, 'test', 'fixtures', 'codex-output-rules.json');
  if (!existsSync(p)) throw new Error(`no output-rule table at ${p}`);
  _rules = JSON.parse(readFileSync(p, 'utf8'));
  return _rules;
}

/** Walk a dotted path, returning `{found, value}` so an explicit `undefined` is not a miss. */
function at(obj, path) {
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(key in cur)) return { found: false, value: undefined };
    cur = cur[key];
  }
  return { found: true, value: cur };
}

/**
 * Every rule this output breaks, as the sentences Codex itself would print. Empty is a pass.
 *
 * @param {string} event   e.g. `'PostToolUse'`
 * @param {any} value      the parsed stdout object
 * @returns {string[]}
 */
export function outputRuleErrors(event, value) {
  if (value === null || typeof value !== 'object') return [];
  const table = outputRules().rules ?? {};
  const rules = [...(table['*'] ?? []), ...(table[event] ?? [])];
  const broken = [];
  for (const rule of rules) {
    const self = at(value, rule.field);
    switch (rule.kind) {
      case 'forbidden':
        if (self.found) broken.push(`${rule.message} (we sent \`${rule.field}\`)`);
        break;
      case 'forbiddenValue':
        if (self.found && self.value === rule.value) {
          broken.push(`${rule.message} (we sent \`${rule.field}: ${JSON.stringify(rule.value)}\`)`);
        }
        break;
      case 'requiresField':
        if (self.found && !at(value, rule.needs).found) {
          broken.push(`${rule.message} (we sent \`${rule.field}\` and no \`${rule.needs}\`)`);
        }
        break;
      case 'requiresValue': {
        const needs = at(value, rule.needs);
        if (self.found && needs.value !== rule.value) {
          broken.push(`${rule.message} (we sent \`${rule.field}\` with \`${rule.needs}: `
            + `${JSON.stringify(needs.value)}\`)`);
        }
        break;
      }
      case 'nonEmptyWhen': {
        const when = at(value, rule.when);
        if (when.found && when.value === rule.equals
            && !(typeof self.value === 'string' && self.value.trim())) {
          broken.push(`${rule.message} (we sent \`${rule.when}: ${JSON.stringify(rule.equals)}\` `
            + `with \`${rule.field}: ${JSON.stringify(self.value)}\`)`);
        }
        break;
      }
      default:
        throw new Error(`codex-output-rules.json names a rule kind the checker does not `
          + `implement: "${rule.kind}". Teach outputRuleErrors() about it rather than `
          + 'dropping it, or the rule silently stops being enforced.');
    }
  }
  return broken;
}

/**
 * Assert Codex would accept this output. Complements `assertValid`, which only proves the
 * *schema* accepts it.
 *
 * @param {string} event
 * @param {any} value
 * @param {string} what   what produced it, for the message
 */
export function assertOutputAccepted(event, value, what) {
  const broken = outputRuleErrors(event, value);
  assert.deepEqual(broken, [],
    `${what} answered ${event} with output Codex rejects at parse time. The schema accepts `
    + 'it; the runtime does not, and the user sees the hook marked failed in their '
    + `transcript:\n  ${broken.join('\n  ')}`);
}

// ---------------------------------------------------------------------------
// One builder per event
// ---------------------------------------------------------------------------

/**
 * The fields every turn-scoped Codex payload carries. Recorded, not invented — see
 * `test/fixtures/observed/payloads/`.
 *
 * `session_id` and `turn_id` are UUIDv7s in the shape Codex actually emits, because the run
 * id and the turn file are both derived from them and a shape that sanitises differently
 * would move where state lands.
 */
const SESSION_ID = '01a0240c-7f5a-7de0-b4e4-caa34b796e11';
const TURN_ID = '01a0240c-7f97-7ca3-a641-cf8d141498a0';
const AGENT_ID = '01a02413-16ff-75b3-a2c0-b3e93f9cfa63';
const TOOL_USE_ID = 'exec-58fe245b-9bd8-4ba2-b4f7-c50964aa140c';
const MODEL = 'gpt-5.6-sol';
const TRANSCRIPT = '/tmp/codex/sessions/2026/08/21/rollout-2026-08-21T12-19-53-01a0240c-7f5a-7de0-b4e4-caa34b796e11.jsonl';

/** @param {Record<string, any>} [over] */
function base(over = {}) {
  return {
    session_id: SESSION_ID,
    transcript_path: TRANSCRIPT,
    cwd: '/tmp/codex/proj',
    model: MODEL,
    permission_mode: 'default',
    ...over,
  };
}

/**
 * `SessionStart`. `source` is one of **four** — `startup`, `resume`, `clear`, `compact`.
 * Claude Code has a fifth, `fork`, and Codex's schema does not list it.
 *
 * Alone among the turn-scoped events it has no `turn_id`: a session starts before a turn
 * does.
 */
export function sessionStart(over = {}) {
  return { ...base(), hook_event_name: 'SessionStart', source: 'startup', ...over };
}

/** `UserPromptSubmit`. The turn key is `turn_id`, where Claude Code sends `prompt_id`. */
export function userPromptSubmit(over = {}) {
  return {
    ...base(),
    turn_id: TURN_ID,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Read README.md with the shell tool, then reply with one short sentence.',
    ...over,
  };
}

/**
 * `UserPromptSubmit` for a message typed while a turn is still running.
 *
 * Observed in the interactive TUI on codex-cli 0.154.0: the host fires `UserPromptSubmit`
 * again, with the **running** turn's `turn_id`, and the turn still ends in a single `Stop`.
 * Nothing else in the payload marks it as queued — it is key-for-key a fresh prompt — so the
 * repeated `turn_id` is the only way a hook can tell. `codex exec` cannot type mid-turn, so
 * `observed/payloads/UserPromptSubmit.queued.json` was recorded by hand.
 *
 * @param {Record<string, any>} [over]
 * @returns {Record<string, any>}
 */
export function queuedPrompt(over = {}) {
  return userPromptSubmit({ prompt: 'Also append the word SECOND to your reply.', ...over });
}

/** `PreToolUse`. Codex renames its shell tool to `Bash`, with Claude Code's exact shape. */
export function preToolUse(over = {}) {
  return {
    ...base(),
    turn_id: TURN_ID,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: "sed -n '1,240p' README.md" },
    tool_use_id: TOOL_USE_ID,
    ...over,
  };
}

/**
 * `PermissionRequest` — the one event Claude Code has no counterpart for.
 *
 * Recorded on codex-cli 0.154.0 as the ask for a call to the plugin's own MCP tool, which is
 * the call `codex exec` puts to approval. It carries `tool_name` and the call's arguments in
 * `tool_input`, but **no `tool_use_id`**, which is the field that would let a capture
 * correlate it with the `PreToolUse` for the same call. That absence is why the plugin treats
 * this event as read-only: there is nothing here to attribute against that `PreToolUse` does
 * not already carry.
 */
export function permissionRequest(over = {}) {
  return {
    ...base(),
    turn_id: TURN_ID,
    hook_event_name: 'PermissionRequest',
    tool_name: 'mcp__mubit__mubit_outcome',
    tool_input: { reference_id: 'global', outcome: 'success', entry_ids: ['entry-1'] },
    ...over,
  };
}

/** `PostToolUse`. `tool_response` is a bare **string** for `Bash` and `apply_patch`. */
export function postToolUse(over = {}) {
  return {
    ...base(),
    turn_id: TURN_ID,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: "sed -n '1,240p' README.md" },
    tool_response: 'hello probe repo\n',
    tool_use_id: TOOL_USE_ID,
    ...over,
  };
}

/**
 * `PostToolUse` for a call to one of the plugin's own MCP tools.
 *
 * Observed on codex-cli 0.154.0: `tool_name` is `mcp__mubit__<tool>`, `tool_input` is the
 * arguments verbatim, there is a `tool_use_id`, and `tool_response` is the MCP result
 * **object** — `{content: [{type: 'text', text}]}` — where a shell call's is a bare string. A
 * call that is declined, or fails approval, produces no `PostToolUse` at all.
 *
 * @param {Record<string, any>} [over]
 * @returns {Record<string, any>}
 */
export function mcpPostToolUse(over = {}) {
  return {
    ...base(),
    turn_id: TURN_ID,
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__mubit__mubit_outcome',
    tool_input: { reference_id: 'global', outcome: 'success', entry_ids: ['entry-1'] },
    tool_response: { content: [{ type: 'text', text: 'Outcome recorded.' }] },
    // Codex gives an MCP call an `exec-` id like a shell call's, but not the same one: this is
    // a second call in the turn, and a join on the shell call's id must not find it.
    tool_use_id: 'exec-7c1e0a52-3d4b-4f6e-9a21-b8d5c0e4f713',
    ...over,
  };
}

/**
 * `PreCompact`. Never reached by the probe — a probe turn is far too small to compact — so
 * this one is built from the extracted schema alone, and `codex-payload.test.mjs` says so.
 *
 * Note what is **absent**: the two compaction events carry no `permission_mode`, alone among
 * the nine turn-scoped events. Adding one produces a payload Codex would never send, and the
 * host's `additionalProperties: false` is what catches it.
 */
export function preCompact(over = {}) {
  const { permission_mode: _pm, ...rest } = base();
  return { ...rest, turn_id: TURN_ID, hook_event_name: 'PreCompact', trigger: 'auto', ...over };
}

/** `PostCompact`. Same provenance, and the same missing `permission_mode`. */
export function postCompact(over = {}) {
  const { permission_mode: _pm, ...rest } = base();
  return { ...rest, turn_id: TURN_ID, hook_event_name: 'PostCompact', trigger: 'auto', ...over };
}

/** `SubagentStart`. `transcript_path` here is the **agent's** rollout, not the parent's. */
export function subagentStart(over = {}) {
  return {
    ...base(),
    turn_id: TURN_ID,
    hook_event_name: 'SubagentStart',
    agent_id: AGENT_ID,
    agent_type: 'default',
    ...over,
  };
}

/** `SubagentStop`. Carries both transcripts; `transcript_path` is the parent's. */
export function subagentStop(over = {}) {
  return {
    ...base(),
    turn_id: TURN_ID,
    hook_event_name: 'SubagentStop',
    agent_id: AGENT_ID,
    agent_type: 'default',
    agent_transcript_path:
      '/tmp/codex/sessions/2026/08/21/rollout-2026-08-21T12-27-05-01a02413-16ff-75b3-a2c0-b3e93f9cfa63.jsonl',
    stop_hook_active: false,
    last_assistant_message: 'There are 2 regular files directly in the current directory.',
    ...over,
  };
}

/** `Stop`. */
export function stop(over = {}) {
  return {
    ...base(),
    turn_id: TURN_ID,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'README.md says: "hello probe repo."',
    ...over,
  };
}

/**
 * The `Stop` that follows a `Stop` answered with `{"decision":"block","reason":…}`.
 *
 * Observed on codex-cli 0.154.0: the model carries on in the **same** turn. The next `Stop`
 * has `stop_hook_active: true`, the same `turn_id`, and a `last_assistant_message` holding only
 * the continuation. No `UserPromptSubmit` fires for the reason, and the host puts no cap on how
 * many times a hook may block.
 *
 * @param {Record<string, any>} [over]
 * @returns {Record<string, any>}
 */
export function stopContinuation(over = {}) {
  return stop({
    stop_hook_active: true,
    last_assistant_message: 'Done: the README is one line long.',
    ...over,
  });
}

/**
 * `Interrupt` — what the host sends when the user presses Esc mid-turn.
 *
 * Observed in the interactive TUI on codex-cli 0.154.0: `Stop` does not fire for an
 * interrupted turn; `Interrupt` does, carrying the running turn's `turn_id` and no reply.
 * `hooks.json` does not register it, which is why it is not in `CODEX_EVENTS`. `codex exec`
 * cannot press Esc, so `observed/payloads/Interrupt.json` was recorded by hand.
 *
 * @param {Record<string, any>} [over]
 * @returns {Record<string, any>}
 */
export function interrupt(over = {}) {
  return { ...base(), turn_id: TURN_ID, hook_event_name: 'Interrupt', ...over };
}

/**
 * `SessionEnd`. The thinnest payload of the eleven: no `turn_id`, no `model`, no
 * `permission_mode`, and `reason` is the constant `"other"` — Codex has no equivalent of
 * Claude Code's `clear` / `logout` / `prompt_input_exit` distinctions.
 */
export function sessionEnd(over = {}) {
  return {
    session_id: SESSION_ID,
    transcript_path: TRANSCRIPT,
    cwd: '/tmp/codex/proj',
    hook_event_name: 'SessionEnd',
    reason: 'other',
    ...over,
  };
}

/**
 * The rollout line Codex writes when a tool call finishes — recorded verbatim from a live
 * `codex exec` run, not invented.
 *
 * This is the only place the outcome of a shell call exists at `PostToolUse` time. The hook
 * payload carries `tool_response` and nothing else, and for `Bash` that is just the aggregated
 * output: a command exiting 9 with `out` on stdout sends `"out\n"`, byte-for-byte what the
 * same command would have sent had it succeeded. No exit code, no status, and no `Exit code:`
 * preamble — that preamble is an `apply_patch` shape, not a shell one. The transcript is where
 * the host records what actually happened:
 *
 *     {"type":"event_msg","payload":{"type":"item_completed","item":{
 *        "type":"CommandExecution","id":"<the payload's tool_use_id>",
 *        "status":"failed","exit_code":9,"stdout":"out\n","aggregated_output":"out\n",
 *        "duration":{"secs":0,"nanos":2375}}}}
 *
 * `item.id` is the `tool_use_id` the payload carries, which is what makes the two joinable.
 *
 * @param {{toolUseId: string, exitCode?: number, status?: string, secs?: number,
 *          nanos?: number, command?: string[], stdout?: string, stderr?: string}} o
 * @returns {string} one JSONL line, no trailing newline
 */
export function rolloutCommandCompleted(o) {
  const stdout = o.stdout ?? '';
  const exitCode = o.exitCode ?? 0;
  return JSON.stringify({
    timestamp: '2026-08-21T16:32:10.831Z',
    ordinal: 13,
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: SESSION_ID,
      turn_id: TURN_ID,
      item: {
        type: 'CommandExecution',
        id: o.toolUseId,
        process_id: '71027',
        command: o.command ?? ['/bin/zsh', '-c', 'sh -c "echo out; exit 9"'],
        cwd: 'file:///tmp/codex/proj',
        parsed_cmd: [{ type: 'unknown', cmd: 'sh -c "echo out; exit 9"' }],
        source: 'unified_exec_startup',
        status: o.status ?? (exitCode === 0 ? 'completed' : 'failed'),
        stdout,
        stderr: o.stderr ?? '',
        aggregated_output: stdout,
        exit_code: exitCode,
        duration: { secs: o.secs ?? 0, nanos: o.nanos ?? 2375 },
        formatted_output: stdout,
      },
      started_at_ms: 1787329930831,
      completed_at_ms: 1787329930831,
    },
  });
}

/** The `tool_use_id` the turn-scoped builders use, so a rollout line can be joined to them. */
export const FIXTURE_TOOL_USE_ID = TOOL_USE_ID;

/** Every builder, by event name — so a test can table-drive all eleven. */
export const BUILDERS = Object.freeze({
  SessionStart: sessionStart,
  UserPromptSubmit: userPromptSubmit,
  PreToolUse: preToolUse,
  PermissionRequest: permissionRequest,
  PostToolUse: postToolUse,
  PreCompact: preCompact,
  PostCompact: postCompact,
  SubagentStart: subagentStart,
  SubagentStop: subagentStop,
  Stop: stop,
  SessionEnd: sessionEnd,
});

// ---------------------------------------------------------------------------
// A rollout transcript, in Codex's own JSONL
// ---------------------------------------------------------------------------

/**
 * A Codex rollout file's worth of lines, as recorded from a live session.
 *
 * The envelope is `{"type":"response_item","payload":{"type":"message",role,content:[…]}}`,
 * where Claude Code's is `{"type":…,"message":{role,content:[…]}}`. The content item's own
 * `type` also differs — `input_text` / `output_text` against Claude Code's `text` — which is
 * why a reader has to key off the presence of `content[].text` rather than off the item type.
 *
 * The non-conversation envelopes (`session_meta`, `event_msg`, `world_state`, `turn_context`)
 * are included because they are most of a real rollout and a reader that renders them would
 * spend its window on machinery.
 *
 * An entry whose `text` is an array writes one content block per string, the way the host
 * puts its 0.149+ preamble beside a typed prompt on one record.
 *
 * An entry of `{hookPrompt: reason}` writes what a blocked Stop hook leaves instead — see
 * `rolloutHookPrompt`.
 *
 * @param {Array<{role: string, text: string | string[]} | HookPromptEntry>} [messages]
 * @returns {string}
 */
export function rolloutJsonl(messages = []) {
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { session_id: SESSION_ID, cwd: '/tmp/codex/proj', cli_version: '0.146.0' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: TURN_ID } }),
  ];
  for (const m of messages) {
    if ('hookPrompt' in m) {
      lines.push(...rolloutHookPrompt(m.hookPrompt, { lead: m.lead, attrs: m.attrs, id: m.id ?? `msg_${lines.length}` }));
      continue;
    }
    lines.push(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        id: `msg_${lines.length}`,
        role: m.role,
        content: (Array.isArray(m.text) ? m.text : [m.text])
          .map((text) => ({ type: m.role === 'assistant' ? 'output_text' : 'input_text', text })),
      },
    }));
    if (m.role === 'assistant') {
      const message = Array.isArray(m.text) ? m.text.join('\n') : m.text;
      lines.push(JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message } }));
    }
  }
  lines.push(JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAA…' } }));
  lines.push(JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: TURN_ID } }));
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Stop-hook feedback, as the rollout stores it
// ---------------------------------------------------------------------------

/**
 * @typedef {object} HookPromptEntry
 * @property {string} hookPrompt  the reason the Stop hook blocked with
 * @property {string} [lead]      text before the tag, for the whitespace cases
 * @property {string} [attrs]     the tag's attribute list, replacing the observed one
 * @property {string} [id]        the message id both lines share
 */

/**
 * A hook run id in the observed shape, `stop:<n>:<the hooks.json that registered the hook>`.
 * The path is a placeholder; the real one is wherever the host found the plugin.
 */
export const HOOK_RUN_ID = 'stop:0:/tmp/codex/plugins/mubit-memory/hooks.json';

/**
 * The text Codex puts on a `role: "user"` record when a Stop hook blocks with a reason.
 *
 * Observed on codex-cli 0.154.0: the reason is not stored as hook output but as a message in
 * the user's voice, wrapped whole in one `input_text` block —
 *
 *     <hook_prompt hook_run_id="stop:<n>:<path>">REASON</hook_prompt>
 *
 * — and no person typed it. A reader that takes every `user` record at its word reads the
 * outcome review as something the user asked.
 *
 * @param {string} reason
 * @param {{lead?: string, attrs?: string}} [o]
 * @returns {string}
 */
export function hookPromptText(reason, o = {}) {
  const attrs = o.attrs ?? `hook_run_id="${HOOK_RUN_ID}"`;
  return `${o.lead ?? ''}<hook_prompt ${attrs}>${reason}</hook_prompt>`;
}

/**
 * The two rollout lines a blocked Stop leaves, in the order and shape observed on 0.154.0:
 *
 *   1. `response_item/message` with `role: "user"` and the wrapper as its one `input_text`
 *      block, plus the `internal_chat_message_metadata_passthrough` the host adds;
 *   2. `event_msg/item_completed` carrying a `HookPrompt` item — the UI's copy, sharing the
 *      message id, with the bare reason under `fragments` and no wrapper.
 *
 * The real `UserMessage` item a typed prompt gets is a different `item.type`, so the second
 * line is what tells the two apart on the `event_msg` side.
 *
 * @param {string} reason
 * @param {{lead?: string, attrs?: string, id?: string}} [o]
 * @returns {string[]} two JSONL lines, no trailing newline
 */
export function rolloutHookPrompt(reason, o = {}) {
  const id = o.id ?? 'msg_0a0a0a0a-0000-4000-8000-000000000000';
  return [
    JSON.stringify({
      timestamp: '2026-08-21T16:32:11.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        id,
        role: 'user',
        content: [{ type: 'input_text', text: hookPromptText(reason, o) }],
        internal_chat_message_metadata_passthrough: {
          turn_id: TURN_ID, create_time: 1787329931.0, content_item_kinds: ['unknown'],
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-08-21T16:32:11.001Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: SESSION_ID,
        turn_id: TURN_ID,
        item: { type: 'HookPrompt', id, fragments: [{ text: reason, hookRunId: HOOK_RUN_ID }] },
        started_at_ms: 1787329931001,
        completed_at_ms: 1787329931001,
      },
    }),
  ];
}
