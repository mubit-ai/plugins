// @ts-check
/**
 * Every fixture, and every hook's output, against what the host was recorded doing.
 *
 * This is the load-bearing file of the Codex suite, and the reason is worth stating plainly:
 * **a fixture written beside an implementation cannot falsify that implementation.** Whatever
 * shape the code reads, the fixture will have — the two are written by the same person in the
 * same hour, and they agree by construction. Nine tests can pass on a payload Codex would
 * never send.
 *
 * So the fixtures are checked against `test/fixtures/observed/payloads/*.json`: payloads the
 * host itself wrote to a recorder hook's stdin during a real session, with only the per-run
 * ids and paths replaced. They were written by the host, and that is the whole of their
 * authority. `test/helpers/codex-record.mjs --update` re-records them.
 *
 * That circle-breaking has already earned its keep twice: the first draft of `preCompact()`
 * carried a `permission_mode` (the two compaction events are the only turn-scoped events
 * without one) and `permissionRequest()` carried a `tool_use_id` (it has none — which is why
 * the plugin treats that event as read-only).
 *
 * **The shapes the session scorecard and the outcome review turn on.** A plain recording of
 * each event is not enough for them: they read an MCP call's result, the `Stop` that follows a
 * block, a message typed while a turn is running, and the `Interrupt` that Esc sends in place
 * of a `Stop`. Each has its own recording on codex-cli 0.154.0 — `<Event>.<variant>.json`
 * beside the plain `<Event>.json` — and its own builder, held to it field for field. Two of
 * them only the interactive TUI can reach, so they were recorded by hand, and
 * `observed/README.md` has to say which.
 *
 * **What a recording cannot do.** It pins the fields an event was *seen* to carry, not the
 * fields it *may* carry, so it cannot prove a field optional and it cannot reject one the host
 * would accept but has not sent yet. And four of the eleven registered events do not fire in
 * any session the recorder drives, so they have no recording at all. Both limits are asserted
 * below by name rather than passed over — a gap that nothing states is indistinguishable from
 * coverage.
 *
 * Both directions are still checked. The recordings say what a hook may be handed; the output
 * contract in `test/fixtures/codex-output-rules.json` says what it may answer, and an output
 * Codex cannot take is reported to the user as a hook error on every single event.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  BUILDERS, CODEX_EVENTS, OBSERVED_DIR, observedEvents, observedPayload,
  outputAcceptance, outputCapabilities, outputRuleErrors,
  assertOutputAccepted,
  runHook, baseEnv, makeDataDir, makeProjectDir, fakeMubit,
  sessionStart, userPromptSubmit, queuedPrompt, preToolUse, permissionRequest,
  postToolUse, mcpPostToolUse, stop, stopContinuation, sessionEnd, interrupt,
} from './helpers/codex-fixtures.mjs';
import { ALL_EVENTS as RECORDER_EVENTS, normalizePayload } from './helpers/codex-record.mjs';

/** The host build every recording in `observed/` was made against. */
const HOST_VERSION = 'codex-cli 0.154.0';

/**
 * Every recording, by file name: the event it is, the builder that has to reproduce it field
 * for field, and how it was made. A literal rather than a directory listing, so a corpus that
 * quietly lost a file cannot shrink this table and pass.
 *
 * `<Event>.json` is the plain case. `<Event>.<variant>.json` is the same event in a shape the
 * plain one does not show. `made: 'tui'` marks the two that only the interactive TUI reaches —
 * a message typed mid-turn, and Esc — which `codex exec` cannot drive and were recorded by hand.
 */
const RECORDINGS = [
  { file: 'Interrupt.json', event: 'Interrupt', build: interrupt, made: 'tui' },
  { file: 'PermissionRequest.json', event: 'PermissionRequest', build: permissionRequest, made: 'exec' },
  { file: 'PostToolUse.json', event: 'PostToolUse', build: postToolUse, made: 'exec' },
  { file: 'PostToolUse.mcp.json', event: 'PostToolUse', build: mcpPostToolUse, made: 'exec' },
  { file: 'PreToolUse.json', event: 'PreToolUse', build: preToolUse, made: 'exec' },
  { file: 'SessionEnd.json', event: 'SessionEnd', build: sessionEnd, made: 'exec' },
  { file: 'SessionStart.json', event: 'SessionStart', build: sessionStart, made: 'exec' },
  { file: 'Stop.json', event: 'Stop', build: stop, made: 'exec' },
  { file: 'Stop.continuation.json', event: 'Stop', build: stopContinuation, made: 'exec' },
  { file: 'UserPromptSubmit.json', event: 'UserPromptSubmit', build: userPromptSubmit, made: 'exec' },
  { file: 'UserPromptSubmit.queued.json', event: 'UserPromptSubmit', build: queuedPrompt, made: 'tui' },
];

/** The events with at least one recording. */
const RECORDED = [
  'Interrupt', 'PermissionRequest', 'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart',
  'Stop', 'UserPromptSubmit',
];

/** The rest, and what each would take to record. Documented in `observed/README.md`. */
const UNRECORDED = ['PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop'];

/**
 * Events the host dispatches that `hooks.json` does not register, and which are therefore not
 * in `CODEX_EVENTS`. Recorded all the same: what the host sends in place of a `Stop` is
 * something the plugin has to know about whether or not it listens.
 */
const UNREGISTERED = ['Interrupt'];

const PAYLOAD_DIR = join(OBSERVED_DIR, 'payloads');

/** A `{{PLACEHOLDER}}` token, as the recorder writes one in place of a per-run value. */
const PLACEHOLDER = /^\{\{[A-Z_]+\}\}$/;

/** Anything shaped like a real session, turn or call id. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Anything shaped like a path on the machine a recording was made on. */
const MACHINE_PATH = /\/(?:Users|home)\/[^/\s]+|\/private\/(?:var|tmp)\//;

/** The recording in `observed/payloads/<file>`, or `null` if there is none. */
function recordingOrNull(file) {
  const p = join(PAYLOAD_DIR, file);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

/** The recording in `observed/payloads/<file>`, failing the test by name when it is missing. */
function recording(file) {
  const seen = recordingOrNull(file);
  assert.ok(seen,
    `there is no observed/payloads/${file}, so the builder meant to reproduce it is checked `
    + `against nothing. Record it on ${HOST_VERSION}: \`node test/helpers/codex-record.mjs `
    + '--update` for what `codex exec` reaches, by hand in the TUI for the rest.');
  return seen;
}

/** Every `.json` file actually present in `observed/payloads/`, sorted. */
function recordingFiles() {
  if (!existsSync(PAYLOAD_DIR)) return [];
  return readdirSync(PAYLOAD_DIR).filter((f) => f.endsWith('.json')).sort();
}

/** A value's JSON type, with arrays and `null` told apart from objects. */
function kind(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Every place a builder's payload differs in shape from a recording: a key one side has and
 * the other lacks, or a value of another JSON type. Walks the whole tree, because an MCP
 * `tool_response` is three levels deep and a one-level check passes a string where the host
 * sent an object. Array elements are compared against the recording's first element — every
 * array a Codex payload carries is homogeneous.
 *
 * @returns {string[]} empty when the shapes agree
 */
function shapeDiff(built, seen, path = '$') {
  const a = kind(built);
  const b = kind(seen);
  if (a !== b) return [`${path}: the builder sends ${a}, the host sent ${b}`];
  if (a === 'array') {
    if (seen.length === 0) {
      return built.length ? [`${path}: the host sent an empty array, the builder does not`] : [];
    }
    if (built.length === 0) {
      return [`${path}: the builder sends an empty array, the host sent ${seen.length} element(s)`];
    }
    return built.flatMap((el, i) => shapeDiff(el, seen[0], `${path}[${i}]`));
  }
  if (a !== 'object') return [];
  const errs = [];
  for (const k of Object.keys(built)) {
    if (!(k in seen)) errs.push(`${path}.${k}: the host has never been recorded sending this field`);
  }
  for (const k of Object.keys(seen)) {
    if (!(k in built)) errs.push(`${path}.${k}: the host sent this field and the builder omits it`);
  }
  for (const k of Object.keys(built)) {
    if (k in seen) errs.push(...shapeDiff(built[k], seen[k], `${path}.${k}`));
  }
  return errs;
}

/** Every string anywhere in a JSON value. */
function stringsIn(v) {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(stringsIn);
  if (v && typeof v === 'object') return Object.values(v).flatMap(stringsIn);
  return [];
}

/** `observed/README.md`. */
function observedReadme() {
  const p = join(OBSERVED_DIR, 'README.md');
  assert.ok(existsSync(p), 'observed/README.md is missing, and with it every word on how the '
    + 'recordings were made.');
  return readFileSync(p, 'utf8');
}

/** A Markdown document cut at its `##` and `###` headings. */
function sections(md) {
  return md.split(/^(?=#{2,3} )/m).filter((s) => /^#{2,3} /.test(s)).map((s) => {
    const nl = s.indexOf('\n');
    const heading = (nl === -1 ? s : s.slice(0, nl)).replace(/^#{2,3} /, '');
    return { heading, body: nl === -1 ? '' : s.slice(nl + 1), text: s };
  });
}

/** The probes in `output-acceptance.json` whose output has exactly these keys. */
function probesWithKeys(keys) {
  const want = [...keys].sort().join(',');
  return (outputAcceptance().probes ?? [])
    .filter((p) => Object.keys(p.output ?? {}).sort().join(',') === want);
}

// ===========================================================================
// The corpus itself
// ===========================================================================

test('the recorded corpus is the one this file thinks it has', () => {
  // Recording is a deliberate act against a specific host build. If files go missing the rest
  // of this file passes vacuously, which is the failure mode the whole file exists to avoid.
  // And a file nobody listed is a recording no builder is held to — the same gap, from the
  // other side.
  assert.deepEqual(recordingFiles(), RECORDINGS.map((r) => r.file).sort(),
    'the recordings are the only artefact in this suite the implementation did not write. '
    + 'Without them every assertion below is the implementation agreeing with itself. '
    + 'Re-record with `node test/helpers/codex-record.mjs --update`.');

  assert.deepEqual(observedEvents(), [...RECORDED].sort(),
    'observedEvents() is the list of events with a recording, one name each. '
    + '`PostToolUse.mcp.json` is a PostToolUse recording, not an event called '
    + '`PostToolUse.mcp`; a caller asking which events are covered has to get event names back.');
});

test('every host event is either recorded or named as unrecorded', () => {
  assert.deepEqual([...RECORDED].sort(), [...new Set(RECORDINGS.map((r) => r.event))].sort(),
    'RECORDED and the RECORDINGS table disagree about which events have a recording.');

  for (const event of UNREGISTERED) {
    assert.ok(!CODEX_EVENTS.includes(event),
      `${event} is now in CODEX_EVENTS, so hooks.json registers it: drop it from UNREGISTERED `
      + 'here, or it is counted twice below.');
  }

  assert.deepEqual([...RECORDED, ...UNRECORDED].sort(), [...CODEX_EVENTS, ...UNREGISTERED].sort(),
    'every event is either recorded or listed as not recorded. An event in neither list is '
    + 'one nothing in this file has an opinion about.');
});

test('each recording carries the event it belongs to', () => {
  for (const { file, event } of RECORDINGS) {
    // The `hook_event_name` field is how a hook knows which event it was handed when one
    // script serves several — which is exactly how capture.mjs and checkpoint.mjs work.
    assert.equal(recording(file).hook_event_name, event,
      `observed/payloads/${file} does not name ${event}. The recorder files by that field, so `
      + 'a mismatch means the corpus was hand-edited or a recording was filed under the wrong '
      + 'name.');
  }
});

test('the events with no recording are the ones a scripted turn cannot reach', () => {
  // Stated as a test so the gap shrinks deliberately. Recording one of these means teaching
  // codex-record.mjs to drive a session that reaches it — a window full enough to compact, a
  // spawned subagent — not hand-writing a file.
  for (const event of UNRECORDED) {
    assert.equal(observedPayload(event), null,
      `${event} now has a recording, which is good news: move it into RECORDED and the `
      + 'builder below gains a real oracle.');
  }
});

test(`the recordings were made on ${HOST_VERSION}`, () => {
  // A recording is evidence about one build. The version has to be written down where a
  // reader will look, or a shape that changed between builds reads as a shape that never did.
  const host = observedReadme().match(/^\|\s*host\s*\|\s*`([^`]+)`\s*\|/m);
  assert.equal(host?.[1], HOST_VERSION,
    'the `host` row of observed/README.md must name the build the payloads were recorded on. '
    + 'The scorecard and review tickets build their tests on these recordings, and a reader '
    + 'has to know which host said so.');

  assert.equal(outputAcceptance()._provenance?.codex_version, HOST_VERSION,
    'output-acceptance.json must record the build its verdicts came from. A verdict is only '
    + 'true of the host that gave it.');
});

test('no recording carries a per-run id or a machine path', () => {
  // This repository is public. The recorder swaps ids and paths for placeholders on the way
  // in; a recording made by hand has to have had the same substitution applied, and a
  // recording that has not would publish a real session id and a real home directory.
  for (const file of recordingFiles()) {
    const seen = recordingOrNull(file);
    assert.deepEqual(seen, normalizePayload(seen),
      `observed/payloads/${file} holds a per-run value where the recorder writes a `
      + 'placeholder. Run it through normalizePayload() from codex-record.mjs before committing '
      + 'it — a hand recording included.');

    const leaks = stringsIn(seen).filter((s) => UUID.test(s) || MACHINE_PATH.test(s));
    assert.deepEqual(leaks, [],
      `observed/payloads/${file} carries a real id or a path on the recording machine. Replace `
      + `it with a placeholder or an obvious fake:\n  ${leaks.join('\n  ')}`);
  }
});

test('observed/README.md names the recordings made by hand in the TUI', () => {
  // A hand recording is only as good as the procedure behind it, and `--update` cannot
  // reproduce it. A reader re-recording the corpus has to be told which files the script will
  // not regenerate, and that they went through the same placeholder substitution.
  const section = sections(observedReadme()).find((s) => /by hand/i.test(s.heading));
  assert.ok(section,
    'observed/README.md has no section headed "... by hand ...". Two recordings could not be '
    + 'made by `codex exec`, and nothing tells a reader which.');

  assert.match(section.text, /\bTUI\b/,
    'the by-hand section must say the recordings came from the interactive TUI — that is the '
    + 'only reason they could not be scripted.');
  assert.match(section.text, /placeholder/i,
    'the by-hand section must say the recorder\'s placeholder substitution was applied to '
    + 'them, or a reader cannot tell a scrubbed hand recording from a raw one.');

  for (const { file } of RECORDINGS.filter((r) => r.made === 'tui')) {
    assert.ok(section.text.includes(file),
      `the by-hand section does not name ${file}. \`--update\` will not regenerate it, and `
      + 'the reader has to be told that before they try.');
  }
  for (const { file } of RECORDINGS.filter((r) => r.made !== 'tui')) {
    assert.ok(!section.text.includes(file),
      `the by-hand section names ${file}, which \`codex exec\` records. Listing it there `
      + 'claims it was made by hand, and a reader would skip re-recording it.');
  }
});

test('observed/README.md lists as not covered exactly the events with no recording', () => {
  const section = sections(observedReadme()).find((s) => /not covered/i.test(s.heading));
  assert.ok(section, 'observed/README.md has no "not covered" section, so the events with no '
    + 'recording are nowhere stated.');

  const hostEvents = [...CODEX_EVENTS, ...UNREGISTERED];
  const named = [...new Set([...section.body.matchAll(/`(\w+)`/g)].map((m) => m[1]))]
    .filter((w) => hostEvents.includes(w)).sort();
  assert.deepEqual(named, [...UNRECORDED].sort(),
    'the "not covered" section of observed/README.md has to name exactly the events with no '
    + 'recording. One it lists that now has a recording tells a reader a builder is unchecked '
    + 'when it is; one it leaves out is a gap nothing states.');
});

test('the recorder registers itself on Interrupt as well as the eleven', () => {
  // Interrupt.json came through the recorder's own hooks.json, driven by hand. A recorder
  // that does not register Interrupt cannot reproduce it, and the by-hand procedure in
  // observed/README.md stops working without anything saying so.
  assert.ok(RECORDER_EVENTS.includes('Interrupt'),
    'codex-record.mjs ALL_EVENTS does not include Interrupt, so a recorder home built from it '
    + 'never sees the event Esc sends.');
  for (const event of CODEX_EVENTS) {
    assert.ok(RECORDER_EVENTS.includes(event),
      `codex-record.mjs ALL_EVENTS lost ${event}; a re-record would silently drop it.`);
  }
});

// ===========================================================================
// Inputs
// ===========================================================================

for (const { file, event, build } of RECORDINGS) {
  // One test per recording: a failure names the builder that drifted, not "some fixture".
  const label = file.slice(0, -'.json'.length);
  test(`${label}: the fixture is the payload the host was recorded sending`, () => {
    const seen = recording(file);
    const payload = build();

    assert.equal(payload?.hook_event_name, event,
      `${build.name}() must build a ${event} payload; a hook that serves several events reads `
      + 'hook_event_name to know which one it was handed.');

    // Both directions, all the way down. A field the host never sent is a payload that has
    // never existed; a field it always sends and the builder drops leaves a hook exercised
    // against `undefined` for ever; and a string where the host sends an object is a hook
    // tested on the wrong type.
    const diff = shapeDiff(payload, seen);
    assert.deepEqual(diff, [],
      `${build.name}() does not have the shape of observed/payloads/${file}, so every test `
      + `built on it proves nothing:\n  ${diff.join('\n  ')}`);

    // Where the recording holds a placeholder, the builder holds a concrete value. The run id
    // and the turn file are derived from these, and a builder handing a hook `{{TURN_ID}}`
    // would stage every turn under a name no real session produces.
    for (const k of Object.keys(seen).filter((key) => PLACEHOLDER.test(String(seen[key])))) {
      assert.ok(typeof payload[k] === 'string' && payload[k] !== '' && !PLACEHOLDER.test(payload[k]),
        `${build.name}().${k} is ${JSON.stringify(payload[k])}. The recording has a placeholder `
        + 'there; the builder needs a concrete value of the shape the host sends.');
    }
  });
}

for (const event of UNRECORDED) {
  test(`${event}: the fixture names its own event, and nothing else checks it`, () => {
    // All that is left without a recording. Saying so is the point: the alternative is a
    // test that looks like the ones above and asserts nothing the builder did not decide.
    assert.equal(BUILDERS[event]().hook_event_name, event);
  });
}

// ---------------------------------------------------------------------------
// What the recordings say about the shapes the scorecard and review read
// ---------------------------------------------------------------------------

test('PostToolUse: a shell call answers with a string, an MCP call with the result object', () => {
  const shell = recording('PostToolUse.json');
  const mcp = recording('PostToolUse.mcp.json');

  // The recorder keeps the first PostToolUse of a session under the plain name. In a session
  // that also calls an MCP tool that has to stay the shell call, or postToolUse() is checked
  // against the MCP shape and the shell shape has no oracle at all.
  assert.equal(shell.tool_name, 'Bash',
    'PostToolUse.json must be the shell call; the MCP call belongs in PostToolUse.mcp.json.');
  assert.equal(typeof shell.tool_response, 'string',
    'a shell call\'s tool_response is its output as a bare string.');

  assert.match(String(mcp.tool_name), /^mcp__mubit__\w+$/,
    'PostToolUse.mcp.json must be a call to the plugin\'s own MCP server, named `mubit`. A call '
    + 'to any other server says nothing about the tools this plugin ships.');
  assert.equal(kind(mcp.tool_input), 'object', 'an MCP call\'s tool_input is its arguments.');
  assert.equal(mcp.tool_use_id, '{{TOOL_USE_ID}}',
    'an MCP PostToolUse carries a tool_use_id, which is what joins it to its PreToolUse.');

  assert.equal(kind(mcp.tool_response), 'object',
    'an MCP call\'s tool_response is the MCP result object, not a string. A reader that '
    + 'treats it as text reads "[object Object]".');
  const content = mcp.tool_response?.content;
  assert.ok(Array.isArray(content) && content.length > 0,
    'the MCP result carries its payload in a non-empty `content` array.');
  for (const item of content) {
    assert.equal(item.type, 'text', 'each content item the plugin\'s server returns is text.');
    assert.equal(typeof item.text, 'string', 'a text content item carries its text as a string.');
  }
});

test('Stop.continuation: the Stop after a block differs from a first Stop only in stop_hook_active', () => {
  const first = recording('Stop.json');
  const cont = recording('Stop.continuation.json');

  assert.equal(first.stop_hook_active, false,
    'Stop.json must be the first Stop of a turn; the one after a block is Stop.continuation.json.');
  assert.equal(cont.stop_hook_active, true,
    'the Stop after a decision:block carries stop_hook_active: true. It is the only thing that '
    + 'tells a hook it has already blocked this turn.');
  assert.deepEqual(Object.keys(cont).sort(), Object.keys(first).sort(),
    'a continuation Stop carries the same fields as a first one: nothing says which block it '
    + 'follows or how many came before. The host has no cap of its own, so a hook that blocks '
    + 'has to bound itself.');
  assert.equal(cont.turn_id, '{{TURN_ID}}', 'a continuation Stop still names its turn.');
});

test('UserPromptSubmit.queued: a message typed mid-turn is key for key a fresh prompt', () => {
  const fresh = recording('UserPromptSubmit.json');
  const queued = recording('UserPromptSubmit.queued.json');

  assert.deepEqual(Object.keys(queued).sort(), Object.keys(fresh).sort(),
    'nothing in the payload marks a prompt as typed mid-turn. The repeated turn_id is the only '
    + 'signal, so a hook that counts turns by UserPromptSubmit has to key on turn_id.');
  assert.equal(queued.turn_id, '{{TURN_ID}}', 'a queued prompt names the running turn.');
  assert.equal(typeof queued.prompt, 'string', 'a queued prompt carries its text.');
});

test('Interrupt: carries the running turn, and no reply to score', () => {
  const seen = recording('Interrupt.json');

  assert.equal(seen.turn_id, '{{TURN_ID}}',
    'Interrupt names the turn it cut short. Without it a hook cannot tell which turn ended '
    + 'with no Stop.');
  assert.ok(!('last_assistant_message' in seen),
    'Interrupt was recorded with a last_assistant_message. An interrupted turn has no final '
    + 'reply, and a scorecard built on one would score text the user never saw finished.');
  assert.ok(!('stop_hook_active' in seen),
    'Interrupt was recorded with stop_hook_active. It is not a Stop, and cannot be blocked.');
});

test('PermissionRequest: an MCP call asks, and the ask carries no tool_use_id', () => {
  const seen = recording('PermissionRequest.json');

  assert.match(String(seen.tool_name), /^mcp__mubit__\w+$/,
    'PermissionRequest.json must be the ask for a call to the plugin\'s own MCP server — that '
    + 'is the call `codex exec` puts to approval.');
  assert.ok(!('tool_use_id' in seen),
    'PermissionRequest was recorded with a tool_use_id. Its absence is why the plugin treats '
    + 'the event as read-only; if it is there now, capture --permission can attribute it.');
  assert.equal(seen.turn_id, '{{TURN_ID}}', 'a PermissionRequest names its turn.');
});

// ---------------------------------------------------------------------------
// What the builders have to reproduce beyond the shape
// ---------------------------------------------------------------------------

test('mcpPostToolUse(): the recorded MCP call, answered with a result object', () => {
  const p = mcpPostToolUse();
  const seen = recording('PostToolUse.mcp.json');

  assert.equal(p.hook_event_name, 'PostToolUse');
  assert.equal(p.tool_name, seen.tool_name,
    'mcpPostToolUse() must call the tool the recording called; the tool_input shape is that '
    + 'tool\'s arguments, and another tool\'s arguments would be checked against the wrong keys.');
  assert.ok(typeof p.tool_use_id === 'string' && p.tool_use_id !== '',
    'an MCP PostToolUse carries a tool_use_id.');

  assert.equal(kind(p.tool_response), 'object',
    'mcpPostToolUse().tool_response must be the MCP result object. A string here tests every '
    + 'reader on the shell shape, which is exactly the case this builder exists to avoid.');
  const content = p.tool_response.content;
  assert.ok(Array.isArray(content) && content.length > 0, 'the result carries a content array.');
  for (const item of content) {
    assert.equal(item.type, 'text');
    assert.equal(typeof item.text, 'string');
  }

  // Each call builds its own objects. A shared default would let one test's mutation leak
  // into the next test's payload.
  content.push({ type: 'text', text: 'mutated by the caller' });
  p.tool_input.mutated_by_the_caller = true;
  const again = mcpPostToolUse();
  assert.equal(again.tool_response.content.length, content.length - 1,
    'mcpPostToolUse() hands out a shared tool_response; build it fresh on every call.');
  assert.ok(!('mutated_by_the_caller' in again.tool_input),
    'mcpPostToolUse() hands out a shared tool_input; build it fresh on every call.');
});

test('permissionRequest(): the recorded MCP call, with no tool_use_id', () => {
  const p = permissionRequest();
  const seen = recording('PermissionRequest.json');

  assert.equal(p.tool_name, seen.tool_name,
    'permissionRequest() must ask for the tool the recording asked for; its tool_input shape '
    + 'is that tool\'s arguments.');
  assert.ok(!('tool_use_id' in p),
    'permissionRequest() must not carry a tool_use_id: the host sends none.');
});

test('stopContinuation(): the same turn as stop(), with stop_hook_active set', () => {
  const first = stop();
  const cont = stopContinuation();

  assert.equal(cont.hook_event_name, 'Stop');
  assert.equal(first.stop_hook_active, false, 'stop() is the first Stop of a turn.');
  assert.equal(cont.stop_hook_active, true,
    'stopContinuation() is the Stop after a block, which carries stop_hook_active: true.');
  assert.equal(cont.session_id, first.session_id, 'a continuation is the same session.');
  assert.equal(cont.turn_id, first.turn_id,
    'a continuation is the same turn: the host continues it rather than starting another. A '
    + 'builder with a fresh turn_id models a UserPromptSubmit that never fired.');
  assert.equal(typeof cont.last_assistant_message, 'string');
  assert.notEqual(cont.last_assistant_message, first.last_assistant_message,
    'a continuation\'s last_assistant_message holds only what the model said after the block, '
    + 'so it is not the first Stop\'s reply over again.');
});

test('queuedPrompt(): the running turn\'s turn_id, and a prompt of its own', () => {
  const running = userPromptSubmit();
  const q = queuedPrompt();

  assert.equal(q.hook_event_name, 'UserPromptSubmit');
  assert.equal(q.session_id, running.session_id, 'a queued prompt is the same session.');
  assert.equal(q.turn_id, running.turn_id,
    'a message typed mid-turn carries the running turn\'s turn_id. A builder with a fresh one '
    + 'models a second turn, which is the one thing the host does not do.');
  assert.ok(typeof q.prompt === 'string' && q.prompt !== '', 'a queued prompt carries its text.');
  assert.notEqual(q.prompt, running.prompt,
    'a queued prompt is a second message, not the first one again.');
  assert.deepEqual(Object.keys(q).sort(), Object.keys(running).sort(),
    'queuedPrompt() and userPromptSubmit() carry the same fields; nothing marks a prompt queued.');
});

test('interrupt(): the running turn, and nothing a Stop would carry', () => {
  const running = userPromptSubmit();
  const p = interrupt();

  assert.equal(p.hook_event_name, 'Interrupt');
  assert.equal(p.session_id, running.session_id, 'an interrupt is the same session.');
  assert.equal(p.turn_id, running.turn_id,
    'Esc interrupts the running turn, and Interrupt carries that turn\'s turn_id.');
  assert.ok(!('last_assistant_message' in p), 'an interrupted turn has no final reply.');
  assert.ok(!('stop_hook_active' in p), 'Interrupt is not a Stop.');
});

test('the new builders take overrides the way every other builder does', () => {
  for (const build of [mcpPostToolUse, stopContinuation, queuedPrompt, interrupt]) {
    const p = build({ turn_id: 'turn-override', session_id: 'session-override' });
    assert.equal(p.turn_id, 'turn-override',
      `${build.name}() ignored an override. Every builder merges \`over\` last, and a test that `
      + 'relies on that is silently testing the default.');
    assert.equal(p.session_id, 'session-override', `${build.name}() ignored an override.`);
    assert.ok(p.hook_event_name, `${build.name}() lost hook_event_name when given an override.`);
  }
});

/** The four sources Codex reports on `SessionStart`, which is a subset of Claude Code's five. */
const CODEX_SOURCES = ['startup', 'resume', 'clear', 'compact'];

test('SessionStart carries no `fork` source', () => {
  // Claude Code has five sources; Codex has four. lib/runid.mjs's SOURCES set is a superset
  // and normalises anything unknown to '' (reuse rather than reset), so a subset is safe —
  // but the subset has to be the *right* one, and this is where that is pinned.
  //
  // A recording shows one source, not the set, so the set is the plugin's own claim and the
  // recording is the part of it that is checked. codex-runid.test.mjs drives all four.
  assert.ok(!CODEX_SOURCES.includes('fork'),
    'if `fork` ever appears here, the run-id reuse branch has a fifth case to cover.');
  assert.ok(CODEX_SOURCES.includes(observedPayload('SessionStart').source),
    'the recorded SessionStart reports a source this table does not list.');
});

test('the turn key is `turn_id`, and `prompt_id` is not a field Codex has', () => {
  for (const { file, event } of RECORDINGS) {
    // A missing recording is the corpus test's failure, not this one's.
    const seen = recordingOrNull(file);
    if (!seen) continue;
    const props = Object.keys(seen);
    // This is the whole `prompt_id ?? turn_id` change in one assertion. Under Claude Code the
    // turn file is `runs/<run>/turns/<prompt_id>.json`; a hook that staged under `turn_id` and
    // read under `prompt_id` would stage every turn and find none of them, so recall would
    // inject and nothing would ever be attributed.
    assert.ok(!props.includes('prompt_id'),
      `${file} was recorded carrying prompt_id — the shared hooks could then read it directly `
      + 'and this port would not need turnKey() at all.');
    if (!['SessionStart', 'SessionEnd'].includes(event)) {
      assert.ok(props.includes('turn_id'),
        `${file} must carry turn_id: it is the only key the turn file can be named after.`);
    }
  }
});

// ===========================================================================
// Outputs
// ===========================================================================

/**
 * Which hook answers which event, and with what argv. This is the same table
 * `hooks.json` registers — kept here as data so the output check can drive every one.
 */
const HANDLERS = [
  { event: 'SessionStart', hook: 'session-start', args: [] },
  { event: 'UserPromptSubmit', hook: 'prompt-recall', args: [] },
  { event: 'UserPromptSubmit', hook: 'stage-prompt', args: [] },
  { event: 'PreToolUse', hook: 'pre-tool', args: [] },
  { event: 'PermissionRequest', hook: 'capture', args: ['--permission'] },
  { event: 'PostToolUse', hook: 'capture', args: [] },
  { event: 'PreCompact', hook: 'checkpoint', args: ['--pre'] },
  { event: 'PostCompact', hook: 'checkpoint', args: ['--post'] },
  { event: 'SubagentStart', hook: 'subagent-start', args: [] },
  { event: 'SubagentStop', hook: 'capture', args: ['--subagent'] },
  { event: 'Stop', hook: 'capture', args: ['--stop'] },
  { event: 'SessionEnd', hook: 'session-end', args: [] },
];

/**
 * The recorded variants, each handed to the handlers registered for its event. `Interrupt`
 * has no handler, so it has no row.
 */
const VARIANT_HANDLERS = [
  { variant: 'PostToolUse.mcp', event: 'PostToolUse', hook: 'capture', args: [], build: mcpPostToolUse },
  { variant: 'Stop.continuation', event: 'Stop', hook: 'capture', args: ['--stop'], build: stopContinuation },
  { variant: 'UserPromptSubmit.queued', event: 'UserPromptSubmit', hook: 'prompt-recall', args: [], build: queuedPrompt },
  { variant: 'UserPromptSubmit.queued', event: 'UserPromptSubmit', hook: 'stage-prompt', args: [], build: queuedPrompt },
];

/**
 * Run one hook on one payload and assert Codex could take what it wrote to stdout.
 *
 * @param {import('node:test').TestContext} t
 * @param {{event: string, hook: string, args: string[], payload: any, label: string}} o
 */
async function assertStdoutParses(t, { event, hook, args, payload, label }) {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir({ git: true });

  const r = await runHook(hook, payload, {
    args,
    env: baseEnv({
      dataDir,
      projectDir,
      endpoint: server.url,
      extra: {
        MUBIT_CC_RUN_STRATEGY: 'static',
        MUBIT_CC_RUN_ID: 'codex-payload-test',
        // The end-of-session flush must stay inside this process, or the assertion races a
        // detached child that outlives the test.
        MUBIT_CC_SESSION_END_DETACH: '0',
      },
    }),
  });

  assert.equal(r.code, 0, `hook must exit 0, got ${r.code}. stderr:\n${r.stderr}`);
  const out = r.stdout.trim();
  assert.ok(out, `${label} wrote nothing to stdout. lib/hook.mjs guarantees a JSON object on `
    + 'every path — Codex parsing empty stdout is not a documented behaviour.');

  let parsed;
  try { parsed = JSON.parse(out); } catch (err) {
    assert.fail(`${label} wrote unparseable stdout: ${err.message}\n${out.slice(0, 400)}`);
  }

  // Well-formed is not the same as accepted. `suppressOutput` is taken on most events and
  // refused on `PreToolUse` and `PostToolUse`, which is how `PostToolUse hook returned
  // unsupported suppressOutput` reached a real session: everything checking the *shape* of
  // that output was green.
  assertOutputAccepted(event, parsed, label);

  if (event === 'SessionEnd') {
    // SessionEnd is the one event that parses no output wire type at all. The universal
    // envelope is still the contract: a JSON object, and nothing that would steer anything.
    assert.equal(typeof parsed, 'object', 'SessionEnd must still answer with a JSON object.');
    assert.equal(parsed.decision, undefined, 'SessionEnd has no decision channel.');
  }
}

for (const { event, hook, args } of HANDLERS) {
  const label = `${hook}${args.length ? ` ${args.join(' ')}` : ''}`;
  test(`${event}: what ${label} writes to stdout is a payload Codex can parse`, async (t) => {
    await assertStdoutParses(t, { event, hook, args, payload: BUILDERS[event](), label });
  });
}

for (const { variant, event, hook, args, build } of VARIANT_HANDLERS) {
  const label = `${hook}${args.length ? ` ${args.join(' ')}` : ''}`;
  test(`${variant}: what ${label} writes to stdout is a payload Codex can parse`, async (t) => {
    // The handler is the one already registered for the event; what is new is the payload. A
    // hook that reads tool_response as a string, or treats a second Stop as a first, answers
    // these with something the host has not seen it answer before.
    await assertStdoutParses(t, { event, hook, args, payload: build(), label });
  });
}

// ===========================================================================
// The absences the output contract makes possible
// ===========================================================================

/** The five events that can put text in front of the model at all. */
const CAN_EMIT_CONTEXT = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SubagentStart', 'UserPromptSubmit'];

test('the five events that can emit context are the five the contract lists', () => {
  for (const event of CODEX_EVENTS) {
    assert.equal(outputCapabilities(event).emitsAdditionalContext, CAN_EMIT_CONTEXT.includes(event),
      `${event}: the contract and the list in this file disagree about additionalContext. `
      + 'One of them is wrong, and a handler somewhere is built on whichever it was.');
  }
});

test('the compaction events have no additionalContext channel at all', () => {
  for (const event of ['PreCompact', 'PostCompact']) {
    // checkpoint.mjs already knows this for PostCompact under Claude Code ("PostCompact has
    // no hookSpecificOutput channel, so the only shapes available are a top-level field or
    // silence"). Codex extends it to PreCompact as well, which makes `systemMessage` the only
    // way a failed checkpoint can tell anyone.
    assert.equal(outputCapabilities(event).hasHookSpecificOutput, false,
      `${event} has no hookSpecificOutput under Codex. Emitting one is an output the host `
      + 'rejects, and the failure lands on the user as a hook error during compaction.');
    assert.equal(outputCapabilities(event).emitsAdditionalContext, false,
      `${event} must have no additionalContext channel — systemMessage is the only one left `
      + 'for a checkpoint that failed to save, which is the one outcome the user needs.');
  }
});

test('PermissionRequest can decide but cannot inform', () => {
  const caps = outputCapabilities('PermissionRequest');
  // This is what settled the design of the PermissionRequest handler. Its only structured
  // channel is a verdict: there is no `additionalContext`, so a stored Mubit rule cannot be
  // shown to the model here at all. What is left is either deciding — which this plugin never
  // does — or observing. It observes: `capture --permission` records that a gated call was
  // attempted, which is the only record that survives when the user denies it and no
  // PostToolUse ever fires.
  assert.equal(caps.decisionOnly, true, 'PermissionRequest decides; that is its whole channel.');
  assert.equal(caps.emitsAdditionalContext, false,
    'PermissionRequest has no additionalContext. If that changes, the pre-tool warning path '
    + 'gains a second home and this test should be the thing that says so.');
});

// ===========================================================================
// The contract against the recorded verdicts
// ===========================================================================

test('what the contract forbids is what a real session was seen refusing', () => {
  // The claim this whole file rests on, stated as a test because it cost a user-visible
  // failure to learn: an output can be well-formed and still be refused, so nothing that
  // checks only the shape is checking the contract.
  //
  // `output-acceptance.json` is a recording of the host's verdict on an output a hook
  // actually returned — `hook: <Event> Completed` against `hook: <Event> Failed`. Every
  // verdict in it must agree with the rule table, in both directions. Events the probe
  // session never reached are absent from it and are not asserted here; the rule table is
  // still the plugin's contract for them, it is simply not one a recording has confirmed.
  const probes = outputAcceptance().probes ?? [];
  assert.ok(probes.length, 'no recorded verdicts — the cross-check below would pass vacuously.');

  for (const probe of probes) {
    for (const [event, verdict] of Object.entries(probe.verdict)) {
      const errs = outputRuleErrors(event, probe.output);
      const forbids = errs.length > 0;
      assert.equal(forbids, verdict === 'rejected',
        `${event}: a real session ${verdict} ${JSON.stringify(probe.output)}, and the rule `
        + `table ${forbids ? 'forbids' : 'permits'} it. Whichever is wrong, something in this `
        + 'suite is green on output the host would refuse — or strips a field for nothing.');
    }
  }
});

test('suppressOutput is refused where it is refused, and taken everywhere else', () => {
  // The specific case that reached a user, kept as its own test so a regression names it.
  const rejecting = ['PreToolUse', 'PostToolUse', 'PermissionRequest'];
  for (const event of rejecting) {
    assert.deepEqual(outputRuleErrors(event, { suppressOutput: true }),
      [`${event} hook returned unsupported suppressOutput (we sent \`suppressOutput\`)`],
      `the rule table must refuse suppressOutput on ${event}. Without that row nothing in `
      + 'this suite can see the failure, because the output is perfectly well-formed.');
  }

  // The mirror image: on every other event the field is genuinely accepted, and stripping it
  // there would be a behaviour change bought for nothing.
  for (const event of CODEX_EVENTS.filter((e) => !rejecting.includes(e))) {
    assert.deepEqual(outputRuleErrors(event, { suppressOutput: true }), [],
      `${event} accepts suppressOutput. Forbidding it everywhere would make the hooks noisier `
      + 'in the transcript than they need to be.');
  }
});

test('the host takes a multi-line systemMessage string from Stop', () => {
  // A Stop systemMessage is the channel a session scorecard can reach the user on, and a
  // scorecard is several lines long. The TUI shows it under the reply with its line breaks
  // kept; `codex exec` never prints it, so the verdict is the only thing a scripted session can
  // confirm about it.
  const found = probesWithKeys(['systemMessage'])
    .filter((p) => typeof p.output.systemMessage === 'string');
  assert.ok(found.length > 0,
    'output-acceptance.json has no probe answering Stop with a bare `systemMessage` string, so '
    + 'nothing recorded says the host takes the channel a scorecard would be delivered on.');
  assert.ok(found.some((p) => p.output.systemMessage.includes('\n')),
    'no systemMessage probe carries a line break. A scorecard is several lines, and a verdict '
    + 'on a one-line string says nothing about whether a multi-line one is taken.');

  for (const probe of found) {
    // A Stop-only probe answers every other event with `{}`. A verdict recorded for one of them
    // is a verdict on `{}`, filed against this output, and the cross-check above would read it
    // as the host accepting systemMessage on an event that was never sent one.
    assert.deepEqual(probe.verdict, { Stop: 'accepted' },
      'the systemMessage probe must carry a verdict for Stop and for nothing else, and the host '
      + 'took it.');
  }
});

test('the host takes decision:block with a reason from Stop', () => {
  // A Stop hook that blocks with a reason keeps the turn going: the model continues the same
  // turn with the reason in front of it. The rule table already refuses a block with no
  // reason; what has to be recorded is that the host takes one that has a reason.
  assert.notDeepEqual(outputRuleErrors('Stop', { decision: 'block', reason: '' }), [],
    'the rule table must still refuse decision:block with an empty reason on Stop — the '
    + 'accepted verdict below is for a block that has one.');

  const found = probesWithKeys(['decision', 'reason'])
    .filter((p) => p.output.decision === 'block');
  assert.ok(found.length > 0,
    'output-acceptance.json has no probe answering Stop with `{"decision":"block","reason":…}`, '
    + 'so nothing recorded says the host continues a turn a Stop hook blocked.');

  for (const probe of found) {
    assert.ok(typeof probe.output.reason === 'string' && probe.output.reason.trim() !== '',
      'the block probe must carry a non-empty reason; a verdict on an empty one is a verdict on '
      + 'an output the rule table already refuses.');
    assert.deepEqual(probe.verdict, { Stop: 'accepted' },
      'the block probe must carry a verdict for Stop and for nothing else, and the host took it.');
  }
});
