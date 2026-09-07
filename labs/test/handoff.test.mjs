// @ts-check
/**
 * Lab 15, pinned: a subagent's result is a handoff, and the handoff lane closes it.
 *
 * One fan-out, end to end: the parent stages a turn and pins a constraint, the subagent is
 * started and told the pin, its result is captured as a handoff note to the parent role with
 * zero network, the parent's drain ships it, the CLI lists it open, a verdict closes it, and a
 * note typed by hand goes out through the route. Real hooks, the built CLIs, one fake
 * instance whose request log is the evidence.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { REPO_ROOT, PLUGIN_ROOT, labState, startFake, runHook, deriveLabRunId, spoolItems, eventually } from './helpers.mjs';

/** @type {ReturnType<typeof labState>} */ let st;
/** @type {Awaited<ReturnType<typeof startFake>>} */ let fake;
/** @type {string} */ let RUN;
/** @type {string} */ let noteId;

const PIN = "don't touch the vendored server";

before(async () => {
  st = labState();
  RUN = deriveLabRunId(st.env);
  st.env.LAB_RUN_ID = RUN;
  fake = await startFake(st);
  runHook(st, 'session-start', '01-session-start.json');
  await eventually(() => fake.requests().some((q) => q.key === 'POST /v2/control/context'));
  runHook(st, 'prompt-recall', '02-prompt.json');
  runHook(st, 'stage-prompt', '02-prompt.json');
});
after(async () => { await fake.stop(); st.cleanup(); });

/** A bundled binary, as its skill runs it: `--data-dir` names the store, `--run` names the run. */
function cli(name, args) {
  const r = spawnSync('node', [join(PLUGIN_ROOT, 'bin', `${name}.mjs`), ...args, '--data-dir', st.dataDir, '--run', RUN, '--json'], {
    cwd: REPO_ROOT, env: st.env, encoding: 'utf8', timeout: 30_000,
  });
  let json = null;
  try { json = JSON.parse(r.stdout.trim()); } catch { /* asserted by callers */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const block = (r) => r.json?.hookSpecificOutput?.additionalContext ?? '';

// ---------------------------------------------------------------------------------------
// 15a - the parent pins a constraint
// ---------------------------------------------------------------------------------------

test('15a: the parent pins a constraint for the run', () => {
  const r = cli('pin', ['add', PIN]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.state, 'pinned');
  assert.equal(fake.requests().at(-1)?.key, 'POST /v2/control/variables/set');
});

// ---------------------------------------------------------------------------------------
// 15b - the subagent is told
// ---------------------------------------------------------------------------------------

test('15b: subagent-start puts the pin above its own recalled block, under a smaller budget', () => {
  const r = runHook(st, 'subagent-start', '20-subagent-start.json');
  assert.equal(r.code, 0);
  const b = block(r);
  assert.match(b, /pins="1"/, `the block says it carries a pin:\n${b}`);
  assert.ok(b.includes(PIN), 'the pin text, in full');
  assert.match(b, /## Pinned for this run\n- don't touch the vendored server/, 'under its own heading, so the subagent can tell the halves apart');
  const recalled = b.indexOf('## Active rules');
  assert.ok(recalled > 0 && b.indexOf(PIN) < recalled, 'the constraint is above the recalled sections, not buried in them');
});

// ---------------------------------------------------------------------------------------
// 15c - the result is a handoff note, spooled, not dialled
// ---------------------------------------------------------------------------------------

test('15c: capture --subagent spools one handoff to the parent role and dials nothing', () => {
  const m = fake.mark();
  const before = spoolItems(st, RUN).length;
  const r = runHook(st, 'capture', '21-subagent-stop.json', ['--subagent']);
  assert.equal(r.code, 0);
  assert.equal(fake.since(m).length, 0, 'zero HTTP from the hook');

  const items = spoolItems(st, RUN);
  assert.equal(items.length, before + 1, 'one item, under the PARENT run');
  const note = items.at(-1).item;
  const meta = JSON.parse(note.metadata_json);
  assert.equal(note.intent, 'handoff');
  assert.match(meta.from_agent_id, /^claude-code-sub-/, 'from the subagent\'s wire-level identity');
  assert.equal(meta.to_agent_id, 'claude-code', 'to the parent role — never a session, never a sub-run id');
  assert.equal(meta.requested_action, 'review');
  assert.equal(meta.task_id, 'p_lab_0001', 'the turn it was spawned in');
  assert.equal(meta.active, true);
  assert.match(note.text, /^Q: Find every call site of enqueue\(\)/, 'its own task, read from its own transcript, not the parent\'s prompt');
  assert.match(note.text, /A: Found three call sites/);
  noteId = note.item_id;
});

// ---------------------------------------------------------------------------------------
// 15d - the parent's drain ships it, and the CLI lists it open
// ---------------------------------------------------------------------------------------

test('15d: the Stop drains the note; handoff list --open shows it, joined client-side', async () => {
  const m = fake.mark();
  assert.equal(runHook(st, 'capture', '07-stop.json', ['--stop']).code, 0);
  const ingest = await eventually(() => fake.since(m).find((q) => q.key === 'POST /v2/control/ingest'
    && q.body.items.some((i) => i.item_id === noteId)));
  assert.ok(ingest, 'the handoff note rode the parent\'s drain');
  assert.equal(ingest.body.run_id, RUN);

  const r = cli('handoff', ['list', '--open']);
  assert.equal(r.code, 0, r.stdout);
  const open = r.json.handoffs.find((h) => h.id === noteId);
  assert.ok(open, `the note is listed under its item id:\n${r.stdout}`);
  assert.equal(open.open, true);
  assert.equal(open.to, 'claude-code');
  assert.equal(open.action, 'review');
  const listing = fake.requests().at(-1);
  assert.equal(listing.key, 'POST /v2/control/activity');
  assert.deepEqual([...listing.body.entry_types].sort(), ['feedback', 'handoff'], 'both types, one page, joined here');
});

// ---------------------------------------------------------------------------------------
// 15e - a verdict closes it
// ---------------------------------------------------------------------------------------

test('15e: feedback --verdict approve posts against the id, and the listing shows it closed', () => {
  const r = cli('handoff', ['feedback', noteId, '--verdict', 'approve', '--comments', 'all three call sites confirmed']);
  assert.equal(r.code, 0, r.stdout);
  const posted = fake.requests().findLast((q) => q.key === 'POST /v2/control/feedback');
  assert.equal(posted.body.handoff_id, noteId);
  assert.equal(posted.body.verdict, 'approve');
  assert.equal(posted.body.from_agent_id, 'claude-code');
  assert.equal(r.json.feedback_id, 'fb_lab_1');

  const listed = cli('handoff', ['list']);
  const h = listed.json.handoffs.find((x) => x.id === noteId);
  assert.equal(h.open, false, 'open means "no feedback names it", and now one does');
  assert.deepEqual(h.feedback.map((f) => [f.verdict, f.comments]), [['approve', 'all three call sites confirmed']]);
  assert.equal(cli('handoff', ['list', '--open']).json.handoffs.some((x) => x.id === noteId), false);
});

// ---------------------------------------------------------------------------------------
// 15f - a note typed by hand
// ---------------------------------------------------------------------------------------

test('15f: send --to codex goes out through the route, and is open until answered', () => {
  const r = cli('handoff', ['send', '--to', 'codex', '--action', 'review', 'the queue change is ready for a second pair of eyes']);
  assert.equal(r.code, 0, r.stdout);
  const posted = fake.requests().findLast((q) => q.key === 'POST /v2/control/handoff');
  assert.equal(posted.body.run_id, RUN);
  assert.equal(posted.body.to_agent_id, 'codex');
  assert.equal(posted.body.from_agent_id, 'claude-code');
  assert.equal(posted.body.requested_action, 'review');
  assert.equal(r.json.handoff_id, 'hnd_lab_1');

  const open = cli('handoff', ['list', '--open']).json.handoffs;
  assert.deepEqual(open.map((h) => [h.id, h.to]), [['hnd_lab_1', 'codex']]);
});
