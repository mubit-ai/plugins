// @ts-check
/**
 * Memory ids, through the Codex MCP bundle.
 *
 * Every memory line the hooks inject starts with a short id, `[m7k2q]`, hashed from the entry's
 * reference id, because a full id on every line costs the model about 20 tokens. The model
 * credits memory by passing those short ids to `mubit_outcome`, and the plugin's MCP launcher
 * turns them back into reference ids on the way out. It looks them up in the session log the
 * hooks wrote, `<dataDir>/scorecard/<session_id>.jsonl`.
 *
 * The claim defended here: **through the committed `integrations/codex/mcp/dist/index.js`,
 * over stdio, a short id reaches the wire as the reference id of the entry it names, and never
 * as itself.** The server gets no session id in its environment, because Codex never gives it
 * one.
 *
 * This cannot be answered from source. The Claude Code suite covers the resolver in-process
 * (`../../claude-code/test/mcp-egress.test.mjs`, `handles.test.mjs`) and its own bundle with a
 * session id set. Codex runs a separately built bundle, and `codex mcp add` registers it with
 * `MUBIT_CC_DATA_DIR` and `MUBIT_CC_PLUGIN_ROOT` and nothing else. So the resolver has to work
 * out which session it is serving from the turn records under `runs/<run>/turns/`, and no
 * other test drives that fallback through a bundle. If a Codex model credits memory by short
 * id against a bundle that sends the short id, the tool reports success and the outcome names
 * no entry the plugin was ever shown. Nothing anywhere reports it.
 *
 * Where the server looks, so that a seeded file is the file it reads:
 *   - the data dir is `MUBIT_CC_DATA_DIR`. Setup pins it into the Codex registration, and it is
 *     the only name here that points at the test's data dir: the Claude Code names the shared
 *     harness also fills in are blanked, for the server and for the hooks, as Codex leaves them;
 *   - a session log is `<dataDir>/scorecard/<session_id>.jsonl`, keyed by session and not by
 *     run, and every log younger than a week is read;
 *   - the run is the launcher's derived run id. It is pinned `static` here, as everywhere else
 *     in this suite (`codex-runid.test.mjs` owns the derivation). The run matters only to the
 *     fallback: the session whose turn in *this* run started last is read last, so its entries
 *     win when two entries share a short id.
 *
 * The seeded rows have the shape the Codex `stage-prompt` and `prompt-recall` hooks write. The
 * last test has those hooks write them for real and credits the id the model was shown.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CODEX_ROOT, baseEnv, evidence, fakeMubit, lib, makeDataDir, makeProjectDir, queryResponse,
  runHook, userPromptSubmit,
} from './helpers/codex-fixtures.mjs';
import { mcpCallTool } from '../../claude-code/test/helpers/harness.mjs';

const { handleFor } = await lib('handles.mjs');

/** Pinned, so "which run's turns does the fallback read" is never a derivation question. */
const RUN = 'codex-handles-run';

const REF_A = '0a0a0a0a-0000-4000-8000-000000000001';
const REF_B = '0b0b0b0b-0000-4000-8000-000000000002';
const REF_C = '0c0c0c0c-0000-4000-8000-000000000003';

/** An entry no log in any test shows. */
const NEVER_SHOWN = '0e0e0e0e-0000-4000-8000-00000000000e';

/**
 * Two reference ids with the same short id. A short id is four characters from a
 * 31-character alphabet, so collisions are rare but real. A collision is the only way to see
 * over the wire which log the resolver reads last, because every recent log is read and an id
 * shown in any of them resolves. `the twins share a short id` checks the pair.
 */
const TWIN_OLDER = '0a0a0a0a-0000-4000-8000-000000001183';
const TWIN_NEWER = '0a0a0a0a-0000-4000-8000-0000000016d8';

const SESSION = '0a0a0a0a-0000-4000-8000-0000000000aa';
const SESSION_OLDER = '0a0a0a0a-0000-4000-8000-0000000000a1';
const SESSION_NEWER = '0a0a0a0a-0000-4000-8000-0000000000b2';

const MINUTE = 60_000;

// ===========================================================================
// Seeding and calling
// ===========================================================================

/**
 * One session log in the shape the hooks write it: a `prompt` row from `stage-prompt`, then a
 * `shown` row from `prompt-recall` naming every reference id the turn rendered.
 *
 * @param {string} dataDir
 * @param {string} sessionId
 * @param {string[]} refs
 * @param {{mtimeMs?: number, tail?: string}} [o]  `tail` is appended raw, with no newline
 * @returns {string} the log's path
 */
function writeLog(dataDir, sessionId, refs, o = {}) {
  const dir = join(dataDir, 'scorecard');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${sessionId}.jsonl`);
  const at = Date.now();
  const promptId = `${sessionId.slice(0, 8)}-turn`;
  const rows = [
    { v: 1, at, kind: 'prompt', prompt_id: promptId, correction: false, slash: false },
    { v: 1, at, kind: 'shown', prompt_id: promptId, lessons: {}, refs, tokens: 19 },
  ];
  writeFileSync(p, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n${o.tail ?? ''}`);
  if (o.mtimeMs) utimesSync(p, o.mtimeMs / 1000, o.mtimeMs / 1000);
  return p;
}

/**
 * One turn record in the shape `stage-prompt` writes under `runs/<run>/turns/`. The fallback
 * reads `session_id` and `started_at` from it and nothing else.
 *
 * @param {string} dataDir
 * @param {string} runId
 * @param {{turnId: string, sessionId: string, startedAt: number}} turn
 */
function writeTurn(dataDir, runId, turn) {
  const dir = join(dataDir, 'runs', runId, 'turns');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${turn.turnId}.json`), JSON.stringify({
    prompt: 'Rebuild the Codex bundle and run its suite.',
    prompt_id: turn.turnId,
    session_id: turn.sessionId,
    started_at: turn.startedAt,
    recalled: [],
    turn_number: 1,
  }));
}

/**
 * The names Codex never gives a plugin process. The shared harness fills them in for Claude
 * Code; blanking them leaves `MUBIT_CC_DATA_DIR` as the only road to the data dir, which is
 * the one Codex has.
 */
const NOT_ON_CODEX = /** @type {const} */ (['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR']);

/**
 * Call one tool on the committed Codex bundle against a live fake, the way `codex mcp add`
 * registers it: `MUBIT_CC_DATA_DIR` and `MUBIT_CC_PLUGIN_ROOT`, and no session id.
 *
 * `CLAUDE_CODE_SESSION_ID` is blanked rather than left to the harness, which inherits nothing
 * but `PATH`. If the harness ever inherited the developer's own environment, a session id
 * from the terminal running the suite would skip the fallback these tests exist for.
 *
 * @param {any} t
 * @param {string} name
 * @param {Record<string, any>} args
 * @param {{dataDir?: string, server?: any}} [o]
 */
async function callCodex(t, name, args, o = {}) {
  const server = o.server ?? await fakeMubit();
  if (!o.server) t.after(() => server.close());
  const out = await mcpCallTool(name, args, {
    root: CODEX_ROOT,
    endpoint: server.url,
    dataDir: o.dataDir ?? makeDataDir(),
    runId: RUN,
    extra: {
      ...Object.fromEntries(NOT_ON_CODEX.map((k) => [k, ''])),
      MUBIT_CC_PLUGIN_ROOT: CODEX_ROOT,
      CLAUDE_CODE_SESSION_ID: '',
    },
  });
  return { server, out };
}

/**
 * The environment a Codex hook runs with: what setup pins into its registration, and none of
 * the Claude Code names, which `lib/boot.mjs` has to synthesise.
 *
 * @param {{dataDir: string, projectDir: string, endpoint: string}} o
 * @returns {Record<string, string>}
 */
function codexHookEnv(o) {
  const env = baseEnv({
    ...o, extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: RUN },
  });
  for (const k of NOT_ON_CODEX) delete env[k];
  return env;
}

/**
 * `mubit_outcome`, and the one outcome body it put on the wire.
 *
 * @param {any} t
 * @param {Record<string, any>} args
 * @param {{dataDir?: string, server?: any}} [o]
 */
async function outcome(t, args, o = {}) {
  const { server, out } = await callCodex(t, 'mubit_outcome', args, o);
  assert.equal(out.isError, false,
    `mubit_outcome failed, so the model is told its credit did not land:\n${out.text}`);
  const sent = server.calls('POST', '/v2/control/outcome');
  assert.equal(sent.length, 1,
    `expected exactly one outcome on the wire; saw: ${server.summary()}`);
  return { server, out, wire: sent[0].body, note: out.json?.mubit_handles };
}

/**
 * No request the server made carries this short id, in any field.
 *
 * @param {any} server
 * @param {string} handle  bare, e.g. `m7m9y`
 */
function assertNeverSent(server, handle) {
  for (const r of server.requests) {
    assert.ok(!String(r.raw ?? '').includes(handle),
      `the short id ${handle} reached the wire on ${r.method} ${r.path}. It is only a label on `
      + `an injected line and is nobody's reference id, so the outcome named no entry:\n${r.raw}`);
  }
}

/** A short id with or without its brackets, as the bare form. @param {any} v */
const bare = (v) => String(v ?? '').replace(/^\[(.*)\]$/, '$1');

// ===========================================================================
// Resolution
// ===========================================================================

test('the twins share a short id, and the other fixtures do not', () => {
  // Every test below that uses the twins assumes this. If the hash ever changes, this fails
  // here and names the reason, rather than the latest-session tests passing for nothing.
  assert.equal(handleFor(TWIN_OLDER), handleFor(TWIN_NEWER),
    'the twin fixtures no longer share a short id, so the latest-session tests can no longer '
    + 'see which log was read last. Search for a new colliding pair.');
  const distinct = new Set([REF_A, REF_B, REF_C, NEVER_SHOWN, TWIN_OLDER].map(handleFor));
  assert.equal(distinct.size, 5,
    'two of the ordinary fixtures share a short id, so a test could pass by resolving the wrong one.');
});

test('a bracketed short id reaches the wire as the entry id it names', async (t) => {
  const dataDir = makeDataDir();
  writeLog(dataDir, SESSION, [REF_A, REF_B]);
  const hA = handleFor(REF_A);
  const hB = handleFor(REF_B);

  const { server, wire, note } = await outcome(t,
    { reference_id: 'global', outcome: 'success', entry_ids: [`[${hA}]`, `[${hB}]`] }, { dataDir });

  // The brackets are how the model is shown the id, `- [m7k2q] Rebuild ...`, so the
  // bracketed form is the one most likely to be copied into the call.
  assert.deepEqual(wire.entry_ids, [REF_A, REF_B],
    'the Codex bundle did not turn a bracketed short id back into the entry id it names. The '
    + `model's credit goes out naming no entry.\n  sent: ${JSON.stringify(wire.entry_ids)}`);
  assert.equal(wire.reference_id, 'global',
    '"global" is not a short id and must reach the wire exactly as the model sent it.');
  assertNeverSent(server, hA);
  assertNeverSent(server, hB);
  assert.equal(note, undefined,
    'a note that ids went unresolved was attached to a call whose ids all resolved. The model '
    + 'would retry a credit that had already landed.');
});

test('a bare short id reaches the wire as the entry id it names', async (t) => {
  const dataDir = makeDataDir();
  writeLog(dataDir, SESSION, [REF_A, REF_B]);
  const hA = handleFor(REF_A);
  const hB = handleFor(REF_B);

  const { server, wire, note } = await outcome(t,
    { reference_id: 'global', outcome: 'failure', entry_ids: [hA, hB] }, { dataDir });

  assert.deepEqual(wire.entry_ids, [REF_A, REF_B],
    'the Codex bundle did not resolve a short id written without its brackets. Models drop '
    + `them often, and each dropped pair is a credit that names no entry.\n  sent: ${JSON.stringify(wire.entry_ids)}`);
  assertNeverSent(server, hA);
  assertNeverSent(server, hB);
  assert.equal(note, undefined, 'every id resolved, so no unresolved note may ride back.');
});

test('a short id in reference_id resolves too', async (t) => {
  const dataDir = makeDataDir();
  writeLog(dataDir, SESSION, [REF_A]);
  const hA = handleFor(REF_A);

  const { server, wire } = await outcome(t,
    { reference_id: `[${hA}]`, outcome: 'failure' }, { dataDir });

  // `reference_id` is the primary entry an outcome is about. A model that credits one entry
  // puts the short id here and nowhere else.
  assert.equal(wire.reference_id, REF_A,
    'a short id in reference_id went out unresolved, so a single-entry verdict names nothing.');
  assertNeverSent(server, hA);
});

test('whitespace around a short id, inside or outside its brackets, does not stop it resolving', async (t) => {
  const dataDir = makeDataDir();
  writeLog(dataDir, SESSION, [REF_A, REF_B]);
  const hA = handleFor(REF_A);
  const hB = handleFor(REF_B);

  const { server, wire, note } = await outcome(t, {
    reference_id: 'global', outcome: 'success', entry_ids: [` [${hA}] `, `[ ${hB} ]`, ` ${hA}`],
  }, { dataDir });

  assert.deepEqual(wire.entry_ids, [REF_A, REF_B, REF_A],
    'a short id with a stray space around it went out unresolved. The model copied the right '
    + `id and the credit named no entry.\n  sent: ${JSON.stringify(wire.entry_ids)}`);
  assertNeverSent(server, hA);
  assertNeverSent(server, hB);
  assert.equal(note, undefined, 'every id resolved, so no unresolved note may ride back.');
});

test('an upper-case short id is not a short id, and is sent as typed rather than guessed at', async (t) => {
  const dataDir = makeDataDir();
  writeLog(dataDir, SESSION, [REF_A]);
  const upper = `[${handleFor(REF_A).toUpperCase()}]`;

  // Short ids are lower case by definition (`handles.test.mjs` pins `M…` as not one), so
  // this is any other string the model typed. What must not happen is a case-folded match
  // that credits an entry on a guess the shared resolver does not make.
  const { server, wire } = await outcome(t,
    { reference_id: 'global', outcome: 'success', entry_ids: [upper] }, { dataDir });

  assert.deepEqual(wire.entry_ids, [upper],
    'the Codex bundle treated an upper-case id differently from the shared definition of a '
    + `short id.\n  sent: ${JSON.stringify(wire.entry_ids)}`);
  assert.ok(!server.requests.some((r) => String(r.raw ?? '').includes(REF_A)),
    'an upper-case id was folded into the entry its lower-case twin names.');
});

// ===========================================================================
// No session id: the run's latest session
// ===========================================================================

test('with no session id, the session that last started a turn in this run is read last', async (t) => {
  const dataDir = makeDataDir();
  const now = Date.now();
  // Two sessions of one run, each shown a different entry and one twin. The older session's
  // log is deliberately the most recently written file, so that ordering logs by age alone
  // would pick its twin. Only the turn records say which session is live.
  writeLog(dataDir, SESSION_OLDER, [REF_A, TWIN_OLDER], { mtimeMs: now - MINUTE });
  writeLog(dataDir, SESSION_NEWER, [REF_B, TWIN_NEWER], { mtimeMs: now - 5 * MINUTE });
  writeTurn(dataDir, RUN, { turnId: 'turn-older', sessionId: SESSION_OLDER, startedAt: now - 10 * MINUTE });
  writeTurn(dataDir, RUN, { turnId: 'turn-newer', sessionId: SESSION_NEWER, startedAt: now - 2 * MINUTE });
  const twin = handleFor(TWIN_NEWER);

  const { server, wire, note } = await outcome(t, {
    reference_id: 'global', outcome: 'success',
    entry_ids: [`[${twin}]`, handleFor(REF_B), handleFor(REF_A)],
  }, { dataDir });

  assert.equal(wire.entry_ids[0], TWIN_NEWER,
    'with no session id the Codex bundle resolved a shared short id from a session other than '
    + "the run's latest. The model credited the line it was shown in this session; the credit "
    + `went to a different entry that happens to share its short id.\n  sent: ${JSON.stringify(wire.entry_ids)}`);
  assert.equal(wire.entry_ids[1], REF_B,
    "an entry shown in the run's latest session did not resolve with no session id in the "
    + 'environment. That is every Codex session.');
  // The older session is still read. It is only read first. An entry shown before a restart
  // in the same run can still be credited.
  assert.equal(wire.entry_ids[2], REF_A,
    'an entry shown in an earlier session of this run no longer resolves. The fallback is '
    + 'meant to order the recent logs, not to drop all but one.');
  assertNeverSent(server, twin);
  assert.equal(note, undefined, 'every id resolved, so no unresolved note may ride back.');
});

test('it is the turn record that picks the session, not the age of its log', async (t) => {
  const dataDir = makeDataDir();
  const now = Date.now();
  // The previous test with the turns swapped, and the log ages swapped with them so they still
  // disagree with the turns. If the resolver were ordering by anything other than the turn
  // records, this test and the one above could not both pass.
  writeLog(dataDir, SESSION_OLDER, [TWIN_OLDER], { mtimeMs: now - 5 * MINUTE });
  writeLog(dataDir, SESSION_NEWER, [TWIN_NEWER], { mtimeMs: now - MINUTE });
  writeTurn(dataDir, RUN, { turnId: 'turn-older', sessionId: SESSION_OLDER, startedAt: now - 2 * MINUTE });
  writeTurn(dataDir, RUN, { turnId: 'turn-newer', sessionId: SESSION_NEWER, startedAt: now - 10 * MINUTE });

  const { wire } = await outcome(t,
    { reference_id: 'global', outcome: 'success', entry_ids: [`[${handleFor(TWIN_OLDER)}]`] }, { dataDir });

  assert.deepEqual(wire.entry_ids, [TWIN_OLDER],
    'the Codex bundle chose which session to read last by something other than the latest turn '
    + 'in its run, so a shared short id resolved to the entry this session was not shown.');
});

test('a turn in another run does not choose the session', async (t) => {
  const dataDir = makeDataDir();
  const now = Date.now();
  // The server's run has no turns at all. The only turn record belongs to another run in the
  // same data dir, which happens with two projects on one machine. The newest log is all
  // that is left to go on.
  writeLog(dataDir, SESSION_OLDER, [TWIN_OLDER], { mtimeMs: now - MINUTE });
  writeLog(dataDir, SESSION_NEWER, [TWIN_NEWER], { mtimeMs: now - 5 * MINUTE });
  writeTurn(dataDir, 'codex-handles-other-run',
    { turnId: 'turn-elsewhere', sessionId: SESSION_NEWER, startedAt: now });

  const { wire } = await outcome(t,
    { reference_id: 'global', outcome: 'success', entry_ids: [handleFor(TWIN_NEWER)] }, { dataDir });

  assert.deepEqual(wire.entry_ids, [TWIN_OLDER],
    "a turn in another project's run chose which session this server reads last. Credit "
    + 'given in one project resolved against what a different project was shown.');
});

test("a newer session in another run does not outrank this run's own", async (t) => {
  const dataDir = makeDataDir();
  const now = Date.now();
  // This run's session showed one twin. Another project's session in the same data dir showed
  // the other twin later: its log is the newer file and its turn started last. Logs are kept
  // by session, not run, so the other log is still read; it may not be read last.
  writeLog(dataDir, SESSION_OLDER, [TWIN_OLDER], { mtimeMs: now - 5 * MINUTE });
  writeLog(dataDir, SESSION_NEWER, [TWIN_NEWER], { mtimeMs: now - MINUTE });
  writeTurn(dataDir, RUN, { turnId: 'turn-here', sessionId: SESSION_OLDER, startedAt: now - 10 * MINUTE });
  writeTurn(dataDir, 'codex-handles-other-run',
    { turnId: 'turn-elsewhere', sessionId: SESSION_NEWER, startedAt: now - MINUTE });

  const { wire } = await outcome(t,
    { reference_id: 'global', outcome: 'success', entry_ids: [`[${handleFor(TWIN_OLDER)}]`] }, { dataDir });

  assert.deepEqual(wire.entry_ids, [TWIN_OLDER],
    "another project's more recent session won a shared short id over the session this run "
    + 'is serving, so the credit went to an entry this model was never shown.');
});

// ===========================================================================
// What does not resolve
// ===========================================================================

test('an unknown short id is sent as typed, and the tool result says so', async (t) => {
  const dataDir = makeDataDir();
  writeLog(dataDir, SESSION, [REF_A]);
  const stranger = handleFor(NEVER_SHOWN);

  const { wire, out, note } = await outcome(t,
    { reference_id: 'global', outcome: 'success', entry_ids: [stranger] }, { dataDir });

  // The Claude Code suite pins the same three things in-process (mcp-egress.test.mjs): left
  // as typed, the endpoint's own answer intact, and the id named in `mubit_handles`.
  assert.deepEqual(wire.entry_ids, [stranger],
    'an unknown short id must go out exactly as typed. Dropping it or guessing at it hides the '
    + `mistake from the model.\n  sent: ${JSON.stringify(wire.entry_ids)}`);
  assert.equal(out.json?.success, true,
    `the endpoint's own answer was lost from the tool result:\n${out.text}`);
  assert.deepEqual(note?.unresolved, [stranger],
    'the tool result does not name the short id that matched nothing, so the model believes '
    + `its credit landed and never corrects it:\n${out.text}`);
  assert.ok(typeof note?.hint === 'string' && /reference_id/.test(note.hint),
    'the unresolved note has no hint naming the way out (a full reference_id). The model is '
    + `told it is wrong and not what to do instead:\n${out.text}`);
});

test('a mixed list resolves what it can, keeps what it cannot, and names only that', async (t) => {
  const dataDir = makeDataDir();
  writeLog(dataDir, SESSION, [REF_A, REF_B]);
  const hA = handleFor(REF_A);
  const hB = handleFor(REF_B);
  const stranger = handleFor(NEVER_SHOWN);

  const { server, wire, note } = await outcome(t, {
    reference_id: 'global', outcome: 'partial',
    entry_ids: [`[${hA}]`, stranger, REF_C, hB],
  }, { dataDir });

  assert.deepEqual(wire.entry_ids, [REF_A, stranger, REF_C, REF_B],
    'one unknown short id cost the rest of the list, or a full id was touched. Each entry is '
    + `resolved on its own, in place.\n  sent: ${JSON.stringify(wire.entry_ids)}`);
  assert.deepEqual(note?.unresolved, [stranger],
    'the unresolved note must name exactly the ids that failed. Naming a resolved one, or a '
    + 'full reference_id, sends the model to fix a credit that already landed.');
  assertNeverSent(server, hA);
  assertNeverSent(server, hB);
});

test('a short id named twice resolves at every position', async (t) => {
  const dataDir = makeDataDir();
  writeLog(dataDir, SESSION, [REF_A]);
  const hA = handleFor(REF_A);

  const { server, wire, note } = await outcome(t,
    { reference_id: 'global', outcome: 'success', entry_ids: [`[${hA}]`, hA, `[${hA}]`] }, { dataDir });

  assert.ok(Array.isArray(wire.entry_ids) && wire.entry_ids.length > 0
    && wire.entry_ids.every((id) => id === REF_A),
  'a repeated short id resolved at its first position only. The later copies went out as a '
  + `label that names no entry.\n  sent: ${JSON.stringify(wire.entry_ids)}`);
  assertNeverSent(server, hA);
  assert.equal(note, undefined, 'every copy names a shown entry, so nothing is unresolved.');
});

test('an empty entry_ids credits nothing, even with a session log to hand', async (t) => {
  const dataDir = makeDataDir();
  writeLog(dataDir, SESSION, [REF_A]);

  const { server, wire, note } = await outcome(t,
    { reference_id: 'global', outcome: 'neutral', entry_ids: [] }, { dataDir });

  assert.deepEqual(wire.entry_ids ?? [], [],
    'an empty entry_ids went out non-empty. Nothing the model named may be credited on its '
    + `behalf.\n  sent: ${JSON.stringify(wire.entry_ids)}`);
  assert.equal(wire.reference_id, 'global', 'a run-level verdict changed what it is about.');
  assert.ok(!server.requests.some((r) => String(r.raw ?? '').includes(REF_A)),
    'an entry from the session log reached the wire though the model named none.');
  assert.equal(note, undefined, 'there was nothing to resolve, so nothing may be reported.');
});

test('with no session log at all, a bracketed short id goes out bare and is reported', async (t) => {
  // A fresh install, or a session whose hooks never ran because they were never trusted.
  const dataDir = makeDataDir();
  const hA = handleFor(REF_A);

  const { wire, note, out } = await outcome(t,
    { reference_id: 'global', outcome: 'success', entry_ids: [`[${hA}]`] }, { dataDir });

  // The brackets are how the id is displayed, not part of it. An unknown id goes out as the
  // bare short id, the same string the note names, so the model can match one to the other
  // (`resolveHandles` in the shared `lib/handles.mjs`).
  assert.deepEqual(wire.entry_ids, [hA],
    'with nothing to resolve against, the short id must go out as the bare id the model typed, '
    + `neither dropped nor guessed at.\n  sent: ${JSON.stringify(wire.entry_ids)}`);
  assert.deepEqual(note?.unresolved, [hA],
    'no session log means nothing resolved, and the model must be told so, naming the id as it '
    + `went out. Silence reads as a credit that landed:\n${out.text}`);
});

test('a torn last line in the session log costs only itself', async (t) => {
  // A writer killed mid-append leaves a partial row with no newline. The rows before it are
  // whole and must still resolve.
  const dataDir = makeDataDir();
  const torn = `{"v":1,"at":${Date.now()},"kind":"shown","prompt_id":"torn-turn","lessons":{},`
    + `"refs":["${REF_B.slice(0, 20)}`;
  writeLog(dataDir, SESSION, [REF_A], { tail: torn });
  const hA = handleFor(REF_A);
  const hB = handleFor(REF_B);

  const { server, wire, note } = await outcome(t,
    { reference_id: 'global', outcome: 'success', entry_ids: [`[${hA}]`, `[${hB}]`] }, { dataDir });

  assert.equal(wire.entry_ids?.[0], REF_A,
    'one torn line made the whole session log unreadable, so every id the session was shown '
    + `stopped resolving.\n  sent: ${JSON.stringify(wire.entry_ids)}`);
  assert.equal(wire.entry_ids?.[1], hB,
    'an entry named only by the torn line resolved to something. A partial row cannot say '
    + `which entry it named.\n  sent: ${JSON.stringify(wire.entry_ids)}`);
  assert.deepEqual(note?.unresolved, [hB],
    'the id only the torn line knew must be reported unresolved, and the one before it must not.');
  assertNeverSent(server, hA);
});

// ===========================================================================
// mubit_dereference
// ===========================================================================

test('mubit_dereference resolves a short id too, and reports one that matches nothing', async (t) => {
  const dataDir = makeDataDir();
  writeLog(dataDir, SESSION, [REF_A]);
  const hA = handleFor(REF_A);
  const stranger = handleFor(NEVER_SHOWN);
  const server = await fakeMubit({
    'POST /v2/control/dereference': { json: { reference_id: REF_A, content: 'the entry' } },
  });
  t.after(() => server.close());

  // Fetching the full text behind an injected line is the other call a model makes with the
  // short id it was shown.
  const known = await callCodex(t, 'mubit_dereference', { reference_id: `[${hA}]` }, { dataDir, server });
  assert.equal(known.out.isError, false, `mubit_dereference failed:\n${known.out.text}`);
  const sent = server.calls('POST', '/v2/control/dereference');
  assert.equal(sent.length, 1, `expected exactly one dereference on the wire; saw: ${server.summary()}`);
  assert.equal(sent[0].body?.reference_id, REF_A,
    'the Codex bundle sent a dereference for the short id rather than the entry it names, so '
    + 'the model cannot open a line it was shown.');
  assertNeverSent(server, hA);
  assert.equal(known.out.json?.mubit_handles, undefined, 'the id resolved, so nothing may be reported.');

  server.reset();
  const unknown = await callCodex(t, 'mubit_dereference', { reference_id: `[${stranger}]` }, { dataDir, server });
  assert.equal(server.lastCall('POST', '/v2/control/dereference')?.body?.reference_id, stranger,
    'an unknown short id on a dereference must go out as the bare id, not dropped or guessed at.');
  assert.deepEqual(unknown.out.json?.mubit_handles?.unresolved, [stranger],
    `a dereference by an unknown short id came back without saying so:\n${unknown.out.text}`);
});

// ===========================================================================
// What is left alone
// ===========================================================================

test('a full entry id and reference_id pass through unchanged', async (t) => {
  const dataDir = makeDataDir();
  writeLog(dataDir, SESSION, [REF_A]);
  const server = await fakeMubit();
  t.after(() => server.close());

  // Full ids alone: nothing to resolve. REF_C was never shown, and it is still no business of
  // the resolver's.
  const plain = await outcome(t,
    { reference_id: REF_B, outcome: 'failure', entry_ids: [REF_A, REF_C] }, { dataDir, server });
  assert.equal(plain.wire.reference_id, REF_B,
    'a full reference_id was rewritten on its way out, so the verdict lands on another entry.');
  assert.deepEqual(plain.wire.entry_ids, [REF_A, REF_C],
    `full entry ids were rewritten on their way out.\n  sent: ${JSON.stringify(plain.wire.entry_ids)}`);
  assert.equal(plain.note, undefined,
    'a full id is not a short id, and must never be reported as one that failed to resolve.');

  server.reset();
  // Full ids beside a short id. This is when the resolver is actually working on the body.
  const mixed = await outcome(t, {
    reference_id: REF_B, outcome: 'success', entry_ids: [REF_C, `[${handleFor(REF_A)}]`],
  }, { dataDir, server });
  assert.equal(mixed.wire.reference_id, REF_B,
    'resolving a short id in entry_ids disturbed the full reference_id beside it.');
  assert.deepEqual(mixed.wire.entry_ids, [REF_C, REF_A],
    'resolving one short id disturbed the full ids around it.\n'
    + `  sent: ${JSON.stringify(mixed.wire.entry_ids)}`);
  assert.equal(mixed.note, undefined, 'nothing failed to resolve, so nothing may be reported.');
});

test('mubit_learned is unaffected: a short id in lesson text is text', async (t) => {
  const dataDir = makeDataDir();
  writeLog(dataDir, SESSION, [REF_A]);
  const hA = handleFor(REF_A);
  const text = `Rebuild the Codex bundle after editing the shared launcher; [${hA}] was right about it.`;

  const { server, out } = await callCodex(t, 'mubit_learned', { text }, { dataDir });

  assert.equal(out.isError, false, `mubit_learned failed:\n${out.text}`);
  const ingest = server.lastCall('POST', '/v2/control/ingest');
  assert.ok(ingest, `the lesson was never sent; saw: ${server.summary()}`);
  const item = ingest.body?.items?.[0];
  // A lesson is prose that will be shown to a later session word for word. Rewriting a label
  // inside it into a 36-character id changes what the lesson says. The resolver owns the
  // outcome route only.
  assert.equal(item?.text, text,
    `a lesson's text was rewritten on its way out:\n  wrote: ${text}\n  sent:  ${item?.text}`);
  assert.ok(!ingest.raw.includes(REF_A),
    'the entry id a short id names was written into a lesson that never mentioned it.');
  assert.equal(out.json?.mubit_handles, undefined,
    'a lesson write came back with an unresolved-id note. A lesson has no ids to resolve.');
  server.assertNotCalled('POST', '/v2/control/outcome');
});

// ===========================================================================
// The whole loop, on Codex
// ===========================================================================

test('the id a Codex hook shows the model resolves through the Codex bundle', async (t) => {
  // Nothing here is seeded by hand. The Codex `stage-prompt` and `prompt-recall` hooks write
  // the turn record and the session log, the model is shown a line with a short id on it,
  // and that exact id, copied off the injected text, is what the model credits.
  const server = await fakeMubit({
    'POST /v2/control/query': {
      json: queryResponse({
        evidence: [evidence({
          id: 'e1', reference_id: REF_A, entry_type: 'lesson', score: 0.9,
          content: 'Rebuild the Codex bundle after editing the shared launcher.',
        })],
      }),
    },
  });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();
  const env = codexHookEnv({ dataDir, projectDir, endpoint: server.url });
  const prompt = userPromptSubmit({ session_id: SESSION, cwd: projectDir });

  await runHook('stage-prompt', prompt, { env });
  const recall = await runHook('prompt-recall', prompt, { env });
  const shown = String(recall.json?.hookSpecificOutput?.additionalContext ?? '');
  const tag = shown.match(/\[m[a-z0-9]{4}\]/)?.[0];
  assert.ok(tag,
    `prompt-recall showed the model no short id, so there is nothing it could credit:\n${shown}`);

  server.reset();
  const { wire, note } = await outcome(t,
    { reference_id: 'global', outcome: 'success', entry_ids: [tag] }, { dataDir, server });

  assert.deepEqual(wire.entry_ids, [REF_A],
    'the short id a Codex hook printed did not resolve through the Codex MCP bundle. The hooks '
    + 'and the server disagree about where the session log is or what it says, and every '
    + `credit a Codex model gives names nothing.\n  shown: ${tag}\n  sent:  ${JSON.stringify(wire.entry_ids)}`);
  assertNeverSent(server, bare(tag));
  assert.equal(note, undefined, 'the id was shown this session, so it cannot be unresolved.');
});

test('an id shown only on a "(seen earlier)" pointer resolves through the Codex bundle', async (t) => {
  // A lesson the conversation was already given renders as a one-line pointer: the mark, the
  // short id, and the first clause. The model can credit that line like any other, so the
  // turn that showed only the pointer has to have logged the entry behind it. Here nothing
  // else in the session log names it: the seen-set says it was shown, and no row does.
  const server = await fakeMubit({
    'POST /v2/control/query': {
      json: queryResponse({
        evidence: [evidence({
          id: 'e1', reference_id: REF_A, entry_type: 'lesson', score: 0.9,
          content: 'Rebuild the Codex bundle after editing the shared launcher. The committed '
            + 'bundle is what Codex runs, so a stale one quietly ignores the fix.',
        })],
      }),
    },
  });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();
  const { markSeen } = await lib('seen.mjs');
  assert.ok(markSeen({ dataDir }, RUN, [REF_A], SESSION),
    'could not mark the entry as already shown, so this test would render it in full.');
  const env = codexHookEnv({ dataDir, projectDir, endpoint: server.url });
  const prompt = userPromptSubmit({ session_id: SESSION, cwd: projectDir });

  await runHook('stage-prompt', prompt, { env });
  const recall = await runHook('prompt-recall', prompt, { env });
  const shown = String(recall.json?.hookSpecificOutput?.additionalContext ?? '');
  const tag = shown.match(/\(seen earlier\) \[(m[a-z0-9]{4})\]/)?.[1];
  assert.equal(tag, handleFor(REF_A),
    `prompt-recall did not render the entry as a pointer carrying its short id:\n${shown}`);

  server.reset();
  const { wire, note } = await outcome(t,
    { reference_id: 'global', outcome: 'success', entry_ids: [`[${tag}]`] }, { dataDir, server });

  assert.deepEqual(wire.entry_ids, [REF_A],
    'the short id on a "(seen earlier)" line did not resolve. The pointer turn did not log the '
    + `entry it pointed at, so a pointer is a line the model can read but never credit.\n  sent: ${JSON.stringify(wire.entry_ids)}`);
  assertNeverSent(server, tag);
  assert.equal(note, undefined, 'the id was shown this session, so it cannot be unresolved.');
});
