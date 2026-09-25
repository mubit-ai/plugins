// @ts-check
/**
 * `capture` and the session scorecard: the rows it appends to `scorecard/<session>.jsonl`,
 * the per-entry used-signal at Stop, the once-per-turn outcome review, and the card.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { baseEnv, fakeMubit, makeDataDir, readJsonFile, runHook, spoolFiles, tempDir } from './helpers/harness.mjs';
import { postToolUse, postToolUseFailure, stop, stopFailure, subagentStop, PROMPT_ID, SESSION_ID } from './helpers/fixtures.mjs';
import { handleFor } from '../lib/handles.mjs';

const RUN_ID = 'cc-score-0000';
const OWN = 'mcp__plugin_mubit-memory_mubit__';
const REF_A = '5f0c2a9e-1b7d-4c3e-9a51-7e2d8b6c4f10';
const REF_B = '9a3e6b1c-2d4f-4e8a-b7c9-1f5e3d2a6b80';
const REF_F = 'c1d2e3f4-0000-4000-8000-000000000fff';
const REF_S = 'aaaa1111-2222-4333-8444-555566667777';
const A_TERMS = ['vitest', 'forks', 'threads', 'native'];
const B_TERMS = ['migrations', 'seeding', 'database'];
const F_TERMS = ['postgres', 'listens'];
const S_TERMS = ['pnpm', 'workspace', 'hoisting'];
const ECHO_A = 'Run vitest with --pool=forks; the threads pool hangs on the native module.';

const SCRATCH = tempDir('mubit-cc-capture-card-');
const SPY = join(SCRATCH, 'spawn-spy.cjs');
writeFileSync(SPY, `const fs = require('node:fs');
const out = process.env.MUBIT_TEST_SPY_FILE;
if (out) { try { fs.appendFileSync(out, JSON.stringify({ argv: process.argv.slice(1) }) + '\\n'); } catch {} }
`);

function drainSpawnsNow(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((l) => basename(String(l.argv?.[0] ?? '')) === 'drain.mjs');
}

/** Detached drains land after the hook exits: wait for `n` of them, or settle and report. */
async function drainSpawns(file, n = 1, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (drainSpawnsNow(file).length >= n) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return drainSpawnsNow(file);
}

async function setup(t, extra = {}) {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  // A held lock makes every spawned drain stand down at once, so nothing dials after the test.
  mkdirSync(join(dataDir, 'runs', RUN_ID), { recursive: true });
  writeFileSync(join(dataDir, 'runs', RUN_ID, 'drain.lock'), JSON.stringify({ pid: process.pid, ts: Date.now() }));
  const spy = join(SCRATCH, `spy-${randomUUID()}.jsonl`);
  const env = baseEnv({
    dataDir, endpoint: server.url, projectDir: dataDir,
    extra: {
      MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: RUN_ID,
      NODE_OPTIONS: `--require ${SPY}`, MUBIT_TEST_SPY_FILE: spy,
      ...extra,
    },
  });
  return { server, dataDir, env, spy };
}

const logPath = (dataDir) => join(dataDir, 'scorecard', `${SESSION_ID}.jsonl`);
const turnFile = (dataDir) => join(dataDir, 'runs', RUN_ID, 'turns', `${PROMPT_ID}.json`);

function seedLog(dataDir, rows) {
  mkdirSync(join(dataDir, 'scorecard'), { recursive: true });
  writeFileSync(logPath(dataDir), rows.map((r) => JSON.stringify({ v: 1, at: Date.now(), ...r })).join('\n') + '\n');
}

function readLog(dataDir) {
  if (!existsSync(logPath(dataDir))) return [];
  return readFileSync(logPath(dataDir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const entry = (ref, type, terms, pointer = false) => ({ ref, handle: handleFor(ref), type, pointer, terms });
const shownLesson = (ref, title, terms, pointer = false) => [ref, { title, terms, handle: handleFor(ref), pointer }];

/** A turn as stage-prompt + prompt-recall leave it: lessons A and B and a fact were shown. */
function seedTurn(dataDir, over = {}) {
  const dir = join(dataDir, 'runs', RUN_ID, 'turns');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${PROMPT_ID}.json`), JSON.stringify({
    prompt: 'why does the test runner hang?',
    prompt_id: PROMPT_ID,
    session_id: SESSION_ID,
    started_at: Date.now(),
    recalled: [REF_A, REF_B, REF_F],
    recall: { at: Date.now(), rung: 1, sources: 3, tokens: 120, terms: [...A_TERMS, ...B_TERMS, ...F_TERMS] },
    shown: [entry(REF_A, 'lesson', A_TERMS), entry(REF_B, 'lesson', B_TERMS), entry(REF_F, 'fact', F_TERMS)],
    ...over,
  }));
}

/** The log as the hooks before Stop leave it for this turn. */
function seedTurnLog(dataDir, extraRows = [], { pointerA = false } = {}) {
  seedLog(dataDir, [
    { kind: 'start', source: 'startup', lessons: {}, refs: [], tokens: 0 },
    { kind: 'prompt', prompt_id: PROMPT_ID, correction: false, slash: false },
    {
      kind: 'shown', prompt_id: PROMPT_ID,
      lessons: Object.fromEntries([
        shownLesson(REF_A, 'run vitest with --pool=forks', A_TERMS, pointerA),
        shownLesson(REF_B, 'run migrations before seeding', B_TERMS),
      ]),
      refs: [REF_A, REF_B, REF_F], tokens: 120,
    },
    ...extraRows,
  ]);
}

// ---------------------------------------------------------------------------
// Tool rows
// ---------------------------------------------------------------------------

test('capture: a main-agent tool call appends a tool row with its intent', async (t) => {
  const { dataDir, env } = await setup(t);
  await runHook('capture', postToolUse({ tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok' } }), { env });
  await runHook('capture', postToolUse({ tool_name: 'Bash', tool_input: { command: 'grep -rn foo src' }, tool_response: { stdout: '' }, tool_use_id: 'toolu_2' }), { env });
  await runHook('capture', postToolUseFailure({ tool_name: 'Bash', tool_input: { command: 'npm run build' } }), { env, args: ['--failure'] });
  const tools = readLog(dataDir).filter((r) => r.kind === 'tool');
  assert.deepEqual(tools.map((r) => [r.prompt_id, r.intent, r.failed]), [
    [PROMPT_ID, 'exec', false], [PROMPT_ID, 'search', false], [PROMPT_ID, 'exec', true],
  ]);
});

test('capture: a subagent tool call, a skipped tool and the plugin\'s own tools append no tool row', async (t) => {
  const { dataDir, env } = await setup(t);
  await runHook('capture', postToolUse({ agent_id: 'sub-1', agent_type: 'Explore', tool_name: 'Bash', tool_input: { command: 'npm test' } }), { env });
  await runHook('capture', postToolUse({ tool_name: 'TodoWrite', tool_input: { todos: [] } }), { env });
  await runHook('capture', postToolUseFailure({ tool_name: `${OWN}mubit_learned`, tool_input: { text: 'x' } }), { env, args: ['--failure'] });
  assert.deepEqual(readLog(dataDir).filter((r) => r.kind === 'tool'), []);
});

test('capture: with capture off nothing is appended', async (t) => {
  const { dataDir, env } = await setup(t, { MUBIT_CC_CAPTURE: '0' });
  await runHook('capture', postToolUse({ tool_name: 'Bash', tool_input: { command: 'npm test' } }), { env });
  assert.equal(existsSync(logPath(dataDir)), false);
});

// ---------------------------------------------------------------------------
// The plugin's own mubit_outcome / mubit_learned
// ---------------------------------------------------------------------------

test('capture: mubit_outcome by handle is recorded as an explicit verdict on the resolved refs', async (t) => {
  const { dataDir, env } = await setup(t);
  seedTurn(dataDir);
  seedTurnLog(dataDir);
  const r = await runHook('capture', postToolUse({
    tool_name: `${OWN}mubit_outcome`,
    tool_input: { reference_id: 'global', outcome: 'success', entry_ids: [`[${handleFor(REF_A)}]`, handleFor(REF_B)] },
    tool_response: [{ type: 'text', text: '{"success":true}' }],
  }), { env });
  assert.equal(r.code, 0);
  const ex = readLog(dataDir).filter((row) => row.kind === 'explicit');
  assert.deepEqual(ex.map((row) => [row.prompt_id, row.ids, row.outcome]), [[PROMPT_ID, [REF_A, REF_B], 'success']]);
  const turn = readJsonFile(turnFile(dataDir));
  assert.deepEqual(turn.explicit_ids, [REF_A, REF_B]);
  assert.deepEqual(turn.explicit, { [REF_A]: 'success', [REF_B]: 'success' });
  assert.deepEqual(spoolFiles(dataDir, RUN_ID), [], 'the plugin\'s own call is still never captured');
});

test('capture: a real reference_id passes through, and "global" is never a verdict target', async (t) => {
  const { dataDir, env } = await setup(t);
  seedTurn(dataDir);
  seedTurnLog(dataDir);
  await runHook('capture', postToolUse({
    tool_name: `${OWN}mubit_outcome`,
    tool_input: { reference_id: REF_B, outcome: 'failure', rationale: 'wrong port' },
  }), { env });
  const ex = readLog(dataDir).filter((row) => row.kind === 'explicit');
  assert.deepEqual(ex.map((row) => [row.ids, row.outcome]), [[[REF_B], 'failure']]);
});

test('capture: a failed or error-result mubit_outcome records no verdict', async (t) => {
  const { dataDir, env } = await setup(t);
  seedTurn(dataDir);
  seedTurnLog(dataDir);
  await runHook('capture', postToolUse({
    tool_name: `${OWN}mubit_outcome`, tool_input: { reference_id: REF_A, outcome: 'success' },
    tool_response: { isError: true, content: [{ type: 'text', text: 'Error: 500' }] },
  }), { env });
  await runHook('capture', postToolUseFailure({
    tool_name: `${OWN}mubit_outcome`, tool_input: { reference_id: REF_A, outcome: 'success' },
  }), { env, args: ['--failure'] });
  assert.deepEqual(readLog(dataDir).filter((row) => row.kind === 'explicit'), []);
});

test('capture: a successful mubit_learned appends a learned row, from a subagent too', async (t) => {
  const { dataDir, env } = await setup(t);
  await runHook('capture', postToolUse({ tool_name: `${OWN}mubit_learned`, tool_input: { text: 'use pnpm' } }), { env });
  await runHook('capture', postToolUse({ agent_id: 'sub-1', tool_name: 'mcp__mubit__mubit_learned', tool_input: { text: 'x' }, tool_use_id: 't2' }), { env });
  assert.equal(readLog(dataDir).filter((r) => r.kind === 'learned').length, 2);
});

// ---------------------------------------------------------------------------
// Stop: per-entry use, verdict inputs, the turn row
// ---------------------------------------------------------------------------

test('capture --stop: each shown entry is checked on its own and the turn row carries the lessons', async (t) => {
  const { dataDir, env } = await setup(t, { MUBIT_CC_OUTCOME_REVIEW: 'nudge' });
  seedTurn(dataDir);
  seedTurnLog(dataDir);
  await runHook('capture', stop({ last_assistant_message: ECHO_A }), { env, args: ['--stop'] });
  const turn = readJsonFile(turnFile(dataDir));
  assert.equal(turn.used_evidence.entry_method, 'memory-term-echo/v2-entry');
  assert.equal(turn.used_evidence.entries[REF_A].used, true);
  assert.equal(turn.used_evidence.entries[REF_B].used, false);
  assert.equal(turn.used_evidence.entries[REF_F].used, false);
  assert.equal(turn.used_evidence.method, 'memory-term-echo/v1', 'the turn-level v1 signal is unchanged');
  const rows = readLog(dataDir).filter((r) => r.kind === 'turn');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].run_id, RUN_ID);
  assert.deepEqual(Object.keys(rows[0].lessons).sort(), [REF_A, REF_B].sort(), 'facts are not lessons');
  assert.equal(rows[0].lessons[REF_A].used, true);
  assert.equal(rows[0].lessons[REF_B].used, false);
  assert.deepEqual(rows[0].used_refs, [REF_A]);
  assert.equal(rows[0].ended_with_question, false);
});

test('capture --stop: a reply ending in a question is recorded as such', async (t) => {
  const { dataDir, env } = await setup(t, { MUBIT_CC_OUTCOME_REVIEW: 'nudge' });
  seedTurn(dataDir);
  seedTurnLog(dataDir);
  await runHook('capture', stop({ last_assistant_message: 'Should I also update the docs?  ' }), { env, args: ['--stop'] });
  assert.equal(readLog(dataDir).find((r) => r.kind === 'turn').ended_with_question, true);
});

test('capture --stop: standing lessons are checked on the first prompt after a session start', async (t) => {
  const { dataDir, env } = await setup(t, { MUBIT_CC_OUTCOME_REVIEW: 'nudge' });
  seedTurn(dataDir, { recalled: [], shown: [] });
  seedLog(dataDir, [
    { kind: 'start', source: 'startup', lessons: Object.fromEntries([[REF_S, { title: 'use pnpm workspaces', terms: S_TERMS, handle: handleFor(REF_S) }]]), refs: [REF_S], tokens: 30 },
    { kind: 'prompt', prompt_id: PROMPT_ID, correction: false, slash: false },
  ]);
  await runHook('capture', stop({ last_assistant_message: 'Use pnpm with a workspace so hoisting stays predictable.' }), { env, args: ['--stop'] });
  const row = readLog(dataDir).find((r) => r.kind === 'turn');
  assert.equal(row.lessons[REF_S].used, true);
  assert.equal(readJsonFile(turnFile(dataDir)).used_evidence.entries[REF_S].used, true);
});

test('capture --stop: a failed last non-read-only tool call marks the turn a tool failure', async (t) => {
  const { dataDir, env } = await setup(t, { MUBIT_CC_OUTCOME_REVIEW: 'nudge' });
  seedTurn(dataDir);
  seedTurnLog(dataDir, [
    { kind: 'tool', prompt_id: PROMPT_ID, intent: 'exec', failed: true },
    { kind: 'tool', prompt_id: PROMPT_ID, intent: 'search', failed: false },
  ]);
  await runHook('capture', stop({ last_assistant_message: ECHO_A }), { env, args: ['--stop'] });
  const turn = readJsonFile(turnFile(dataDir));
  assert.equal(turn.outcome, 'failure');
  assert.equal(turn.failure_reason, 'tool_failure');
});

test('capture --stop: a read that failed last does not', async (t) => {
  const { dataDir, env } = await setup(t, { MUBIT_CC_OUTCOME_REVIEW: 'nudge' });
  seedTurn(dataDir);
  seedTurnLog(dataDir, [
    { kind: 'tool', prompt_id: PROMPT_ID, intent: 'exec', failed: false },
    { kind: 'tool', prompt_id: PROMPT_ID, intent: 'search', failed: true },
  ]);
  await runHook('capture', stop({ last_assistant_message: ECHO_A }), { env, args: ['--stop'] });
  assert.equal(readJsonFile(turnFile(dataDir)).outcome, undefined);
});

test('capture --stop: entries Claude judged are left out of used_refs', async (t) => {
  const { dataDir, env } = await setup(t, { MUBIT_CC_OUTCOME_REVIEW: 'nudge' });
  seedTurn(dataDir, { explicit_ids: [REF_A], explicit: { [REF_A]: 'success' } });
  seedTurnLog(dataDir, [{ kind: 'explicit', prompt_id: PROMPT_ID, ids: [REF_A], outcome: 'success' }]);
  await runHook('capture', stop({ last_assistant_message: ECHO_A }), { env, args: ['--stop'] });
  assert.deepEqual(readLog(dataDir).find((r) => r.kind === 'turn').used_refs, []);
});

test('capture --stop-failure: appends a turn row with every lesson unknown', async (t) => {
  const { dataDir, env } = await setup(t);
  seedTurn(dataDir);
  seedTurnLog(dataDir);
  const r = await runHook('capture', stopFailure({ last_assistant_message: ECHO_A }), { env, args: ['--stop-failure'] });
  assert.deepEqual(r.json, { suppressOutput: true });
  const row = readLog(dataDir).find((x) => x.kind === 'turn');
  assert.equal(row.api_error, 'rate_limit');
  assert.deepEqual(Object.values(row.lessons).map((l) => l.used), [null, null]);
  assert.deepEqual(row.used_refs, []);
});

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

test('capture --stop: prints the scorecard under the reply when this turn showed a lesson', async (t) => {
  const { dataDir, env } = await setup(t, { MUBIT_CC_OUTCOME_REVIEW: 'nudge' });
  seedTurn(dataDir);
  seedTurnLog(dataDir);
  const r = await runHook('capture', stop({ last_assistant_message: ECHO_A }), { env, args: ['--stop'] });
  assert.equal(r.code, 0);
  assert.equal(r.json.systemMessage, [
    'mubit · this session · lessons on 1 of 1 prompt · memory added 120 tok',
    '  2 lessons shown',
    '  ├ 1 used      1 waiting on your reply',
    '  └ 1 not used',
    '  this turn: used "run vitest with --pool=forks"',
  ].join('\n'));
  assert.equal(r.json.decision, undefined);
});

test('capture --stop: compact prints one line, off prints nothing', async (t) => {
  for (const [mode, expect] of [['compact', 'mubit · this session · lessons on 1 of 1 prompt · 1 of 2 lessons used · 1 waiting · memory added 120 tok'], ['off', undefined]]) {
    const { dataDir, env } = await setup(t, { MUBIT_CC_OUTCOME_REVIEW: 'nudge', MUBIT_CC_SESSION_SCORE: mode });
    seedTurn(dataDir);
    seedTurnLog(dataDir);
    const r = await runHook('capture', stop({ last_assistant_message: ECHO_A }), { env, args: ['--stop'] });
    assert.equal(r.json.systemMessage, expect, mode);
    if (!expect) assert.deepEqual(r.json, { suppressOutput: true });
  }
});

test('capture --stop: no card on a turn that showed no lesson', async (t) => {
  const { dataDir, env } = await setup(t);
  seedTurn(dataDir, { shown: [entry(REF_F, 'fact', F_TERMS)] });
  seedLog(dataDir, [
    { kind: 'prompt', prompt_id: PROMPT_ID, correction: false, slash: false },
    { kind: 'shown', prompt_id: PROMPT_ID, lessons: {}, refs: [REF_F], tokens: 40 },
  ]);
  const r = await runHook('capture', stop({ last_assistant_message: 'postgres listens on 5433' }), { env, args: ['--stop'] });
  assert.deepEqual(r.json, { suppressOutput: true });
});

// ---------------------------------------------------------------------------
// The outcome review
// ---------------------------------------------------------------------------

test('capture --stop: new lessons this turn → one review request, and the outcome waits for it', async (t) => {
  const { dataDir, env, spy } = await setup(t);
  seedTurn(dataDir);
  seedTurnLog(dataDir);
  const r = await runHook('capture', stop({ last_assistant_message: ECHO_A, stop_hook_active: false }), { env, args: ['--stop'] });
  assert.equal(r.code, 0);
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, new RegExp(`\\[${handleFor(REF_A)}\\] run vitest with --pool=forks`));
  assert.match(r.json.reason, new RegExp(`\\[${handleFor(REF_B)}\\] run migrations before seeding`));
  assert.match(r.json.reason, /mubit_outcome/);
  assert.match(r.json.reason, /Memory review:/);
  assert.equal(r.json.systemMessage, undefined, 'the card waits for the reviewed turn');
  const turn = readJsonFile(turnFile(dataDir));
  assert.ok(turn.review_requested_at > 0);
  assert.deepEqual(turn.review_ids.sort(), [REF_A, REF_B].sort());
  assert.deepEqual(readLog(dataDir).filter((x) => x.kind === 'review').map((x) => x.ids.sort()), [[REF_A, REF_B].sort()]);
  assert.equal((await drainSpawns(spy, 1, 400)).filter((s) => s.argv.includes('--with-outcome')).length, 0);
});

test('capture --stop: the Stop after the review posts the outcome, prints the card, and keeps the first reply', async (t) => {
  const { dataDir, env, spy } = await setup(t);
  seedTurn(dataDir);
  seedTurnLog(dataDir);
  await runHook('capture', stop({ last_assistant_message: ECHO_A, stop_hook_active: false }), { env, args: ['--stop'] });
  // Claude credits A during the review.
  await runHook('capture', postToolUse({
    tool_name: `${OWN}mubit_outcome`, tool_input: { reference_id: 'global', outcome: 'success', entry_ids: [handleFor(REF_A)] },
    tool_use_id: 'toolu_review',
  }), { env });
  const r = await runHook('capture', stop({ last_assistant_message: `Memory review: credited [${handleFor(REF_A)}].`, stop_hook_active: true }), { env, args: ['--stop'] });
  assert.equal(r.json.decision, undefined);
  assert.match(r.json.systemMessage, /^mubit · this session/);
  assert.match(r.json.systemMessage, /this turn: used "run vitest with --pool=forks"/);
  const turn = readJsonFile(turnFile(dataDir));
  assert.equal(turn.used_evidence.entries[REF_A].used, true, 'not recomputed from the review line');
  assert.deepEqual(turn.explicit_ids, [REF_A]);
  const rows = readLog(dataDir).filter((x) => x.kind === 'turn');
  assert.deepEqual(rows.at(-1).used_refs, []);
  assert.equal((await drainSpawns(spy)).filter((s) => s.argv.includes('--with-outcome')).length, 1);
  const items = spoolFiles(dataDir, RUN_ID).map(readJsonFile).filter((i) => String(i.item_id).startsWith('cc-stop-'));
  assert.equal(items.length, 1);
  assert.match(items[0].text, /pool=forks/);
  assert.doesNotMatch(items[0].text, /Memory review/);
});

test('capture --stop: another hook\'s continuation is not treated as our review', async (t) => {
  const { dataDir, env, spy } = await setup(t);
  seedTurn(dataDir);
  seedTurnLog(dataDir);
  const r = await runHook('capture', stop({ last_assistant_message: ECHO_A, stop_hook_active: true }), { env, args: ['--stop'] });
  assert.equal(r.json.decision, undefined);
  assert.match(r.json.systemMessage, /^mubit · this session/);
  assert.equal((await drainSpawns(spy)).filter((s) => s.argv.includes('--with-outcome')).length, 1);
});

test('capture --stop: no review under nudge, under outcomeMode off, or with nothing new to review', async (t) => {
  const cases = [
    [{ MUBIT_CC_OUTCOME_REVIEW: 'nudge' }, {}],
    [{ MUBIT_CC_OUTCOME_MODE: 'off' }, {}],
    [{}, { pointerA: true, echo: 'nothing relevant here at all', onlyA: true }],
  ];
  for (const [extra, shape] of cases) {
    const { dataDir, env } = await setup(t, extra);
    if (shape.onlyA) {
      seedTurn(dataDir, { shown: [entry(REF_A, 'lesson', A_TERMS, true)] });
      seedLog(dataDir, [
        { kind: 'prompt', prompt_id: PROMPT_ID, correction: false, slash: false },
        { kind: 'shown', prompt_id: PROMPT_ID, lessons: Object.fromEntries([shownLesson(REF_A, 'run vitest with --pool=forks', A_TERMS, true)]), refs: [REF_A], tokens: 20 },
      ]);
    } else {
      seedTurn(dataDir);
      seedTurnLog(dataDir);
    }
    const r = await runHook('capture', stop({ last_assistant_message: shape.echo ?? ECHO_A }), { env, args: ['--stop'] });
    assert.equal(r.json.decision, undefined, JSON.stringify(extra));
  }
});

test('capture --stop: lessons Claude already judged this turn are not asked about again', async (t) => {
  const { dataDir, env } = await setup(t);
  seedTurn(dataDir, { explicit_ids: [REF_A, REF_B] });
  seedTurnLog(dataDir, [{ kind: 'explicit', prompt_id: PROMPT_ID, ids: [REF_A, REF_B], outcome: 'success' }]);
  const r = await runHook('capture', stop({ last_assistant_message: ECHO_A }), { env, args: ['--stop'] });
  assert.equal(r.json.decision, undefined);
  assert.match(r.json.systemMessage, /2 used/);
});

test('capture --subagent: never reviews and never prints a card', async (t) => {
  const { dataDir, env } = await setup(t);
  seedTurn(dataDir);
  seedTurnLog(dataDir);
  const r = await runHook('capture', subagentStop({ last_assistant_message: ECHO_A }), { env, args: ['--subagent'] });
  assert.deepEqual(r.json, { suppressOutput: true });
  assert.deepEqual(readLog(dataDir).filter((x) => x.kind === 'turn'), []);
});
