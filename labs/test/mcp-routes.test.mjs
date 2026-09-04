// @ts-check
/**
 * The deliberate surface, pinned: Lab 7 (what the server exposes) and Lab 11 (where a
 * read actually goes). For several guarantees the route IS the guarantee - both the
 * lessons route and the activity feed answer 200 for the same question, and only one of
 * them is confined - so these tests read the wire, not the answers alone.
 *
 * Since 0.13.0 the catalogue is not an MCP tool by default: `mubit_lessons` and the other
 * admin verbs moved to `bin/admin.mjs`, which is what the skills run. Lab 11 therefore
 * drives the CLI, and drives the tool only where the README shows the opt-in.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { labState, startFake, runHook, driveMcp, runAdmin, deriveLabRunId, marker, eventually } from './helpers.mjs';

/** @type {ReturnType<typeof labState>} */ let st;
/** @type {Awaited<ReturnType<typeof startFake>>} */ let fake;
/** @type {string} */ let RUN;

const DEFAULT_SEVEN = [
  'mubit_dereference', 'mubit_diagnose', 'mubit_learned', 'mubit_memory_health',
  'mubit_outcome', 'mubit_recall', 'mubit_status',
];

before(async () => {
  st = labState();
  // Derive the run id BEFORE the fake starts: it reads LAB_RUN_ID at spawn to know which
  // corpus rows are "yours" - env.sh carries the same warning for the hand-run labs.
  RUN = deriveLabRunId(st.env);
  st.env.LAB_RUN_ID = RUN;
  fake = await startFake(st);
  // The CLI has no session to derive a run from: it picks the run the hooks last wrote a
  // status marker for, exactly as it does under a skill. So a session has to have opened.
  runHook(st, 'session-start', '01-session-start.json');
  await eventually(() => fake.requests().some((q) => q.key === 'POST /v2/control/context'));
});
after(async () => { await fake.stop(); st.cleanup(); });

const listed = (out) => [...out.matchAll(/^ {2}· (\S+)/gm)].map((m) => m[1]);

// ---------------------------------------------------------------------------------------
// Lab 7 - what the server exposes, and the identity agreement
// ---------------------------------------------------------------------------------------

test('lab 7: the launcher serves the curated seven, and its session is the hooks\' run id', () => {
  const list = driveMcp(st, '--list');
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /^server\s+mubit-memory 0\.13\./m);
  assert.deepEqual(listed(list.stdout), DEFAULT_SEVEN,
    'seven of the upstream server\'s twenty-one: a blank mcpTools means this set, never all');

  const status = driveMcp(st, 'mubit_status');
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /"connected"/);
  assert.ok(status.stdout.includes(RUN),
    'default_session equals the run id the hooks derive - the whole job of launch.mjs');
});

test('lab 7: MUBIT_MCP_TOOLS is used verbatim - the way to get a retired tool back, or only one', () => {
  const list = driveMcp({ ...st, env: { ...st.env, MUBIT_MCP_TOOLS: 'mubit_lessons,mubit_status' } }, '--list');
  assert.equal(list.code, 0, list.stderr);
  assert.deepEqual(listed(list.stdout), ['mubit_lessons', 'mubit_status'], 'not unioned with the default');
});

// ---------------------------------------------------------------------------------------
// Lab 11a - the catalogue reads the activity feed, not the route named after it
// ---------------------------------------------------------------------------------------

test('lab 11a: admin lessons dials the activity feed and never the lessons route', () => {
  const m = fake.mark();
  const r = runAdmin(st, ['lessons']);
  assert.equal(r.code, 0, r.stderr);
  const keys = fake.since(m).map((q) => q.key);
  assert.ok(keys.includes('POST /v2/control/activity'), `dialled: ${keys.join(', ')}`);
  assert.ok(!keys.includes('POST /v2/control/lessons'),
    'the lessons route pages before it filters - a scoped read there answers zero on a busy account');
  const activity = fake.since(m).find((q) => q.key === 'POST /v2/control/activity');
  assert.equal(activity?.body?.projection, 'full', 'scope lives in metadata_json, so the read asks for it');
});

// ---------------------------------------------------------------------------------------
// Lab 11b - where the run boundary falls
// ---------------------------------------------------------------------------------------

test('lab 11b: a default read shows your rows and global rows - never another run\'s run-scoped lesson', () => {
  const r = runAdmin(st, ['lessons']);
  assert.equal(r.code, 0, r.stderr);
  for (const id of ['les_r1', 'les_s1', 'les_g1', 'les_g2']) {
    assert.ok(r.stdout.includes(id), `${id} is in a default read`);
  }
  assert.ok(!r.stdout.includes('les_r2'),
    'les_r2 is the whole test: run scope is the boundary, and this row is the far side');
  assert.match(r.stdout, /^showing: /m, 'the read says which boundary it applied');
  assert.match(r.stdout, /^matched: 4$/m, 'and how many rows were inside it');
});

test('lab 11b: asking for global moves the boundary on purpose', () => {
  const r = runAdmin(st, ['lessons', '--scope', 'global']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('les_g1') && r.stdout.includes('les_g2'), 'both global rows');
  for (const id of ['les_r1', 'les_r2', 'les_s1']) {
    assert.ok(!r.stdout.includes(id), `${id} is not global and stays out`);
  }
  assert.match(r.stdout, /^matched: 2$/m);
});

test('lab 11b: the opt-in tool form renders the same boundary lines - one renderer for both', () => {
  const opt = { ...st, env: { ...st.env, MUBIT_MCP_TOOLS: 'mubit_lessons' } };
  const r = driveMcp(opt, 'mubit_lessons');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^showing: this run, plus every lesson/m, 'the guard object\'s fields become head lines');
  assert.match(r.stdout, /^matched: 4$/m);
  assert.match(r.stdout, /Lessons \(4\):/);
  assert.ok(!r.stdout.includes('les_r2'));
});

// ---------------------------------------------------------------------------------------
// Lab 11c - a partial answer that says so
// ---------------------------------------------------------------------------------------

test('lab 11c: a truncated feed yields partial:true and no total to act on (tool form)', async () => {
  const truncSt = labState();
  truncSt.env.LAB_RUN_ID = deriveLabRunId(truncSt.env);
  truncSt.env.MUBIT_MCP_TOOLS = 'mubit_lessons';
  const truncFake = await startFake(truncSt, { scenario: 'truncate' });
  try {
    const r = driveMcp(truncSt, 'mubit_lessons');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /"partial":\s*true/);
    assert.ok(!/"matched"\s*:/.test(r.stdout),
      'no matched count beside an admission of partiality - the absence is deliberate');
  } finally {
    await truncFake.stop();
    truncSt.cleanup();
  }
});

// Observed on 0.13.0: the CLI's empty branch prints "No lessons matched." and drops the
// partial admission the tool form keeps (`--json` still carries `partial: true`). Zero is a
// claim; this is a listing that ran out. Recorded as a todo rather than pinned, because the
// direction of trust runs the other way here: the discipline is right and the script is not.
test('lab 11c: the CLI says partial too when a truncated listing comes back empty', { todo: 'admin lessons drops `partial` on the empty branch in 0.13.0' }, async () => {
  const truncSt = labState();
  truncSt.env.LAB_RUN_ID = deriveLabRunId(truncSt.env);
  const truncFake = await startFake(truncSt, { scenario: 'truncate' });
  try {
    runHook(truncSt, 'session-start', '01-session-start.json');
    const r = runAdmin(truncSt, ['lessons']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /partial/i, `the rendered form must admit the cut:\n${r.stdout}`);
  } finally {
    await truncFake.stop();
    truncSt.cleanup();
  }
});

// ---------------------------------------------------------------------------------------
// Lab 11d - the write path reaches the widening authority
// ---------------------------------------------------------------------------------------

test('lab 11d: an MCP-only session still reflects at session end', async () => {
  const s2 = labState();
  const run2 = deriveLabRunId(s2.env);
  s2.env.LAB_RUN_ID = run2;
  const f2 = await startFake(s2);
  try {
    runHook(s2, 'session-start', '01-session-start.json');
    await eventually(() => f2.requests().some((q) => q.key === 'POST /v2/control/context'));

    const w = driveMcp(s2, 'mubit_learned', { text: 'The demo app listens on 3000, not 8080.' });
    assert.equal(w.code, 0, w.stderr);
    assert.ok(f2.requests().some((q) => q.key === 'POST /v2/control/ingest'), 'the MCP write went out');

    const mk = await eventually(() => {
      const v = marker(s2, run2);
      return v?.mcp?.ingested >= 1 ? v : null;
    });
    assert.ok(mk?.mcp?.ingested >= 1,
      'the egress guard recorded the MCP ingest on the run marker - the one field joining the two surfaces');
    assert.equal(mk.captured.tools, 0, 'zero hook captures, on purpose');

    const m = f2.mark();
    runHook(s2, 'session-end', '08-session-end.json');
    const reflect = await eventually(() => f2.since(m).find((q) => q.key === 'POST /v2/control/reflect'));
    assert.ok(reflect, 'session end counted the MCP ingest and reflected anyway');
  } finally {
    await f2.stop();
    s2.cleanup();
  }
});

// ---------------------------------------------------------------------------------------
// The strategies route - new in 0.13.0, dialled by admin strategies
// ---------------------------------------------------------------------------------------

test('admin strategies dials the strategies route and renders one line per strategy', () => {
  const m = fake.mark();
  const r = runAdmin(st, ['strategies', '--max', '3']);
  assert.equal(r.code, 0, r.stderr);
  const call = fake.since(m).find((q) => q.key === 'POST /v2/control/strategies');
  assert.ok(call, 'the route is dialled');
  assert.equal(call.body.run_id, RUN);
  assert.equal(call.body.max_strategies, 3);
  assert.match(r.stdout, /Strategies \(1\):/);
  assert.match(r.stdout, /strat_lab_1 — .*\(from 2 lessons: les_g1, les_g2\)/);
});
