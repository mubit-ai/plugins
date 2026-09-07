// @ts-check
/**
 * Lab 14, pinned: what a tool call did to which file, as a structured record.
 *
 * Each capture is a real hook process against a private fake instance. The lane writes two
 * things — `metadata_json.files` on the item, and `runs/<run>/files.json`, the per-run index
 * of what is in play — and the README documents both; these assertions are what keep the
 * two from drifting apart.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { labState, startFake, runHook, deriveLabRunId, spoolItems, eventually, allDataFiles } from './helpers.mjs';

/** @type {ReturnType<typeof labState>} */ let st;
/** @type {Awaited<ReturnType<typeof startFake>>} */ let fake;
/** @type {string} */ let RUN;

before(async () => {
  st = labState();
  RUN = deriveLabRunId(st.env);
  st.env.LAB_RUN_ID = RUN;
  fake = await startFake(st);
  runHook(st, 'session-start', '01-session-start.json');
  await eventually(() => fake.requests().some((q) => q.key === 'POST /v2/control/context'));
  // The Stop in 14f pairs the answer with a staged prompt, as Lab 5 does.
  runHook(st, 'stage-prompt', '02-prompt.json');
});
after(async () => { await fake.stop(); st.cleanup(); });

const index = () => {
  const p = join(st.dataDir, 'runs', RUN, 'files.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};
const filesOf = (item) => JSON.parse(item.metadata_json).files;
const last = () => spoolItems(st, RUN).at(-1)?.item;

// ---------------------------------------------------------------------------------------
// 14a - a Write says whether it created or overwrote
// ---------------------------------------------------------------------------------------

test('14a: a Write is add or update by its result, and the index merges the two', () => {
  const m = fake.mark();
  assert.equal(runHook(st, 'capture', '15-write-create.json').code, 0);
  assert.deepEqual(filesOf(last()), [{ path: 'src/notes.md', kind: 'add' }], 'the result said create');

  assert.equal(runHook(st, 'capture', '16-write-overwrite.json').code, 0);
  assert.deepEqual(filesOf(last()), [{ path: 'src/notes.md', kind: 'update' }],
    'the same input, but the result said update — the input alone cannot tell');

  const idx = index();
  assert.equal(idx.version, 1);
  assert.deepEqual(idx.files.map((f) => f.path), ['src/notes.md']);
  assert.deepEqual(idx.files[0].kinds, ['add', 'update'], 'a set, in first-seen order');
  assert.equal(idx.files[0].occurrences, 2);
  assert.equal(fake.since(m).length, 0, 'capture never dials');
});

// ---------------------------------------------------------------------------------------
// 14b - MultiEdit: one path, several edits, one change
// ---------------------------------------------------------------------------------------

test('14b: a MultiEdit is one update to the file it names, and the index puts it first', () => {
  assert.equal(runHook(st, 'capture', '17-multiedit.json').code, 0);
  assert.deepEqual(filesOf(last()), [{ path: 'src/server.js', kind: 'update' }], 'two edits, one change: deduped on kind and path');
  assert.deepEqual(index().files.map((f) => f.path), ['src/server.js', 'src/notes.md'], 'most recently touched first');
});

// ---------------------------------------------------------------------------------------
// 14c - a failure changed nothing
// ---------------------------------------------------------------------------------------

test('14c: a failed edit carries no files and touches no index row', () => {
  const before = JSON.stringify(index());
  assert.equal(runHook(st, 'capture', '18-edit-failure.json', ['--failure']).code, 0);
  const item = last();
  assert.equal(JSON.parse(item.metadata_json).outcome, 'failure');
  assert.ok(!('files' in JSON.parse(item.metadata_json)), 'the edit did not land, so nothing changed');
  assert.equal(JSON.stringify(index()), before, 'the index is byte for byte what it was');
});

// ---------------------------------------------------------------------------------------
// 14d - a patch says its kinds outright
// ---------------------------------------------------------------------------------------

test('14d: apply_patch markers give three kinds, delete included, whatever the tool is called', () => {
  assert.equal(runHook(st, 'capture', '19-apply-patch.json').code, 0);
  assert.deepEqual(filesOf(last()), [
    { path: 'src/queue.js', kind: 'update' },
    { path: 'docs/NOTES.md', kind: 'add' },
    { path: 'docs/OLD.md', kind: 'delete' },
  ]);
  const idx = index();
  assert.deepEqual(idx.files.map((f) => f.path), ['src/queue.js', 'docs/NOTES.md', 'docs/OLD.md', 'src/server.js', 'src/notes.md']);
  assert.deepEqual(idx.files.find((f) => f.path === 'docs/OLD.md').kinds, ['delete']);
});

// ---------------------------------------------------------------------------------------
// 14e - the denylist reaches inside the patch
// ---------------------------------------------------------------------------------------

test('14e: a patch that touches .env is dropped whole, and the index never learns the path', () => {
  const count = spoolItems(st, RUN).length;
  assert.equal(runHook(st, 'capture', '19-apply-patch-env.json').code, 0);
  assert.equal(spoolItems(st, RUN).length, count, 'nothing spooled');
  assert.ok(!index().files.some((f) => f.path.endsWith('.env')), 'no row for .env');
  for (const f of allDataFiles(st)) assert.ok(!f.text.includes('hunter3'), `the new secret is on disk at ${f.path}`);
});

// ---------------------------------------------------------------------------------------
// 14f - the record reaches the wire
// ---------------------------------------------------------------------------------------

test('14f: after the drain, the ingest body carries files on every item that changed one', async () => {
  const m = fake.mark();
  assert.equal(runHook(st, 'capture', '07-stop.json', ['--stop']).code, 0);
  const ingest = await eventually(() => fake.since(m).find((q) => q.key === 'POST /v2/control/ingest'));
  assert.ok(ingest, 'the detached drain posted the batch');
  const items = ingest.body.items;
  const byId = Object.fromEntries(items.map((i) => [i.item_id, i]));
  assert.deepEqual(filesOf(byId['cc-toolu_lab_0016']), [{ path: 'src/notes.md', kind: 'update' }]);
  assert.equal(filesOf(byId['cc-toolu_lab_0019']).length, 3);
  assert.ok(!('files' in JSON.parse(byId['cc-toolu_lab_0018'].metadata_json)));
  assert.ok(!byId['cc-toolu_lab_0020'], 'the .env patch is not on the wire');
  assert.ok(!JSON.stringify(ingest.body).includes('hunter3'));
});
