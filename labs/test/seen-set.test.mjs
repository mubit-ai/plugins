// @ts-check
/**
 * Lab 12, pinned: what one conversation has already been shown.
 *
 * The seen-set is keyed by the host session id as well as the run, a process with no session
 * never touches it, the shell command that renders the catalogue never touches it either, and
 * `recallRepeatMode: full` switches the pointers off on both surfaces. Every assertion here
 * is made against processes on a wire: real hooks, the real launcher, the real CLI, one fake
 * instance — the same commands the README has you type.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  LAB_ROOT, SESSION_A, SESSION_B,
  labState, startFake, runHook, driveMcp, runAdmin, deriveLabRunId,
  seenFiles, readSeenFile, turnFile, eventually,
} from './helpers.mjs';

/** @type {ReturnType<typeof labState>} */ let st;
/** @type {Awaited<ReturnType<typeof startFake>>} */ let fake;
/** @type {string} */ let RUN;

const RETRY_REFS = ['ref_retry_rule', 'ref_retry_lesson', 'ref_retry_fact'];
const QUERY = { query: 'retry when the ingest job stays queued' };

const block = (r) => r.json?.hookSpecificOutput?.additionalContext ?? '';
const pointers = (text) => (text.match(/\(seen earlier\) ref_/g) ?? []).length;
const payload = (name) => JSON.parse(readFileSync(join(LAB_ROOT, 'payloads', name), 'utf8'));

before(async () => {
  st = labState();
  RUN = deriveLabRunId(st.env);
  st.env.LAB_RUN_ID = RUN;
  fake = await startFake(st);
  runHook(st, 'session-start', '01-session-start.json');
  // Let the detached resume prefetch land so its stash does not race the prompts below.
  await eventually(() => fake.requests().some((q) => q.key === 'POST /v2/control/context'));
});
after(async () => { await fake.stop(); st.cleanup(); });

// ---------------------------------------------------------------------------------------
// 12a - a second prompt in the same conversation
// ---------------------------------------------------------------------------------------

test('12a: the first prompt renders in full; the second degrades every repeat to a pointer', () => {
  const first = runHook(st, 'prompt-recall', '11-prompt-retry.json');
  assert.equal(first.code, 0);
  const b1 = block(first);
  for (const ref of RETRY_REFS) assert.ok(!b1.includes(ref), `${ref}: a full line carries the text, not the id`);
  assert.equal(pointers(b1), 0, 'nothing has been shown yet');
  assert.match(b1, /Never retry an ingest batch that answered "queued"/, 'the full rule text is there');

  const second = runHook(st, 'prompt-recall', '12-prompt-retry-again.json');
  assert.equal(second.code, 0);
  const b2 = block(second);
  assert.equal(pointers(b2), 3, `all three repeats degraded:\n${b2}`);
  assert.match(b2, /\(seen earlier\) ref_retry_rule — Never retry an ingest batch/, 'id plus first clause');
  assert.ok(!/re-sending it only creates a duplicate/.test(b2), 'the rest of the entry is not repeated');

  assert.deepEqual(seenFiles(st, RUN), [SESSION_A], 'runs/<run>/seen/<session_id>.json, keyed by the conversation');
  const file = JSON.parse(readSeenFile(st, RUN, SESSION_A) ?? '{}');
  assert.equal(file.run_id, RUN);
  assert.equal(file.session_id, SESSION_A);
  // The resume block's one source (ref_rule_1, Lab 3) is in here too: the first prompt of a
  // session shows it in full, so it is a sighting like any other.
  for (const ref of RETRY_REFS) assert.ok(file.refs[ref], `${ref} recorded`);
  assert.equal(file.refs.ref_retry_rule.count, 2, 'both sightings counted');
});

test('12a: a pointed entry is still staged for attribution - cheaper to read, not cheaper to credit', () => {
  const turn = turnFile(st, RUN, 'p_lab_0012');
  assert.ok(turn, 'the second prompt has a turn file');
  for (const ref of RETRY_REFS) {
    assert.ok((turn.recalled ?? []).includes(ref), `${ref} is in the turn's recalled ids despite being a pointer`);
  }
});

test("12a: Lab 3's one-line memories never degrade - a pointer longer than its entry is not used", () => {
  const again = runHook(st, 'prompt-recall', JSON.stringify({ ...payload('02-prompt.json'), prompt_id: 'p_lab_0003' }));
  assert.equal(again.code, 0);
  const b = block(again);
  assert.match(b, /Ingest returns when queued, not when stored; poll the job id\./, 'full, on a repeat');
  assert.equal(pointers(b), 0);
  const file = JSON.parse(readSeenFile(st, RUN, SESSION_A) ?? '{}');
  assert.ok(file.refs.ref_rule_1, 'shown in full, so it is recorded as seen all the same');
});

// ---------------------------------------------------------------------------------------
// 12b - another conversation in the same directory
// ---------------------------------------------------------------------------------------

test('12b: session B gets every line in full and its own file; A\'s file is untouched', () => {
  const aBefore = readSeenFile(st, RUN, SESSION_A);
  const r = runHook(st, 'prompt-recall', '13-prompt-retry-session-b.json');
  assert.equal(r.code, 0);
  assert.equal(pointers(block(r)), 0, 'same run, same directory, a different conversation: nothing was shown to B');
  assert.deepEqual(seenFiles(st, RUN), [SESSION_A, SESSION_B].sort());
  assert.equal(readSeenFile(st, RUN, SESSION_A), aBefore, 'byte for byte');
  const b = JSON.parse(readSeenFile(st, RUN, SESSION_B) ?? '{}');
  for (const ref of RETRY_REFS) assert.ok(b.refs[ref], `${ref} recorded for B`);
});

// ---------------------------------------------------------------------------------------
// 12c - no session at all
// ---------------------------------------------------------------------------------------

test('12c: a payload with no usable session id renders in full and marks nothing', () => {
  const before = seenFiles(st, RUN);
  const none = runHook(st, 'prompt-recall', '14-prompt-retry-no-session.json');
  assert.equal(none.code, 0);
  assert.equal(pointers(block(none)), 0);
  assert.match(block(none), /Never retry an ingest batch/);

  const placeholder = runHook(st, 'prompt-recall',
    JSON.stringify({ ...payload('14-prompt-retry-no-session.json'), session_id: 'default', prompt_id: 'p_lab_0015' }));
  assert.equal(placeholder.code, 0);
  assert.equal(pointers(block(placeholder)), 0, '"default" is a placeholder, not a conversation');

  assert.deepEqual(seenFiles(st, RUN), before, 'no third file, and nothing added to the two');
});

// ---------------------------------------------------------------------------------------
// 12d - the MCP tools are one conversation too
// ---------------------------------------------------------------------------------------

test('12d: mubit_recall as session A points at what the hooks showed A - one set, two surfaces', () => {
  const r = driveMcp(st, 'mubit_recall', QUERY, ['--session', SESSION_A]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Memories \(3, 3 seen earlier\):/);
  assert.match(r.stdout, /\(seen earlier\) ref_retry_rule — /);
  assert.match(r.stdout, /mubit_dereference returns its text/, 'the footer says how to expand a pointer');
  const file = JSON.parse(readSeenFile(st, RUN, SESSION_A) ?? '{}');
  assert.ok(file.refs.ref_retry_rule.count >= 3, 'the tool call was a sighting too');
});

test('12d: with no session id the launcher renders every result in full and writes nothing', () => {
  const before = seenFiles(st, RUN).map((s) => readSeenFile(st, RUN, s));
  const r = driveMcp(st, 'mubit_recall', QUERY);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Memories \(3\):/);
  assert.equal((r.stdout.match(/seen earlier/g) ?? []).length, 0);
  assert.deepEqual(seenFiles(st, RUN).map((s) => readSeenFile(st, RUN, s)), before, 'both files byte-identical');
});

// ---------------------------------------------------------------------------------------
// 12e - the shell is not a conversation
// ---------------------------------------------------------------------------------------

test('12e: bin/admin.mjs renders the catalogue in full and never touches the set', () => {
  const before = seenFiles(st, RUN).map((s) => readSeenFile(st, RUN, s));
  for (let i = 0; i < 2; i += 1) {
    const r = runAdmin(st, ['lessons']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^run_id: /m);
    assert.match(r.stdout, /Lessons \(4\):/);
    assert.equal((r.stdout.match(/seen earlier/g) ?? []).length, 0, 'a shell cannot know what reached a model');
  }
  assert.deepEqual(seenFiles(st, RUN).map((s) => readSeenFile(st, RUN, s)), before);
});

test('12e: --data-dir names the store when nothing in the environment does', () => {
  const env = { ...st.env };
  delete env.MUBIT_CC_DATA_DIR;
  delete env.CLAUDE_PLUGIN_DATA;
  const r = runAdmin(st, ['lessons'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(`run_id: ${RUN}`),
    'the run is picked from the flagged store, not from a search of ~/.claude/plugins/data');
});

// ---------------------------------------------------------------------------------------
// 12f - compaction clears one conversation's file
// ---------------------------------------------------------------------------------------

test('12f: PostCompact clears the compacted conversation\'s file and nobody else\'s', () => {
  const post = runHook(st, 'checkpoint', '10-precompact.json', ['--post']);   // session A
  assert.equal(post.code, 0);
  assert.deepEqual(seenFiles(st, RUN), [SESSION_B], 'A starts over; B\'s transcript is intact');

  const anon = runHook(st, 'checkpoint', JSON.stringify({ hook_event_name: 'PostCompact', cwd: 'labs/.work/demo-app' }), ['--post']);
  assert.equal(anon.code, 0);
  assert.deepEqual(seenFiles(st, RUN), [SESSION_B], 'no session id: nothing to clear, nothing cleared');
});

// ---------------------------------------------------------------------------------------
// 12g - opting out
// ---------------------------------------------------------------------------------------

test('12g: recallRepeatMode=full switches pointers off on both surfaces', () => {
  const env = { ...st.env, MUBIT_CC_RECALL_REPEAT_MODE: 'full' };
  const hook = runHook({ ...st, env }, 'prompt-recall', '13-prompt-retry-session-b.json');
  assert.equal(hook.code, 0);
  assert.equal(pointers(block(hook)), 0, 'B has seen these, and gets them in full anyway');
  assert.match(block(hook), /Never retry an ingest batch/);

  const tool = driveMcp({ ...st, env }, 'mubit_recall', QUERY, ['--session', SESSION_B]);
  assert.equal(tool.code, 0, tool.stderr);
  assert.match(tool.stdout, /Memories \(3\):/);
  assert.equal((tool.stdout.match(/seen earlier/g) ?? []).length, 0);
});
