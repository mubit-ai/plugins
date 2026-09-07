// @ts-check
/**
 * Lab 13, pinned: the backfill reads what the two hosts already wrote, and sends nothing it
 * would not have captured live.
 *
 * Every assertion is against the built `bin/import.mjs` driven the way the skill drives it,
 * over synthetic transcripts laid out in both hosts' layouts, against one fake instance whose
 * request log is the evidence. The transcripts hold a `.env` read whose path and body are on
 * different lines; the single most important assertion here is that the secret is on no wire
 * and in no file the plugin wrote.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REPO_ROOT, PLUGIN_ROOT, labState, startFake, deriveLabRunId, allDataFiles } from './helpers.mjs';
import { materialise, CODEX_THREADS } from '../import-fixtures.mjs';

/** @type {ReturnType<typeof labState>} */ let st;
/** @type {Awaited<ReturnType<typeof startFake>>} */ let fake;
/** @type {string} */ let RUN;
/** @type {string} */ let fixtures;

const SECRETS = ['hunter2', 'sk_live_notarealkey0123456789'];

before(async () => {
  st = labState();
  RUN = deriveLabRunId(st.env);
  st.env.LAB_RUN_ID = RUN;
  fake = await startFake(st);
  // The transcripts live OUTSIDE the data dir: they hold the secret on purpose, and the
  // "nowhere on disk" assertion walks the data dir.
  fixtures = mkdtempSync(join(tmpdir(), 'lab-import-'));
  const roots = materialise({ out: fixtures, projectDir: st.projectDir });
  st.env.MUBIT_CC_TRANSCRIPT_ROOT = roots.claudeRoot;
  st.env.MUBIT_CC_CODEX_SESSIONS_ROOT = roots.codexRoot;
});
after(async () => { await fake.stop(); st.cleanup(); rmSync(fixtures, { recursive: true, force: true }); });

/** `bin/import.mjs`, the built bundle, as the skill runs it. */
function runImport(args, env = st.env) {
  const r = spawnSync('node', [join(PLUGIN_ROOT, 'bin', 'import.mjs'), '--project', st.projectDir, '--pace', '0', '--json', ...args], {
    cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(r.status, 0, `import exited ${r.status}:\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

const ingests = (from = 0) => fake.requests().slice(from).filter((q) => q.key === 'POST /v2/control/ingest');
const cursorDir = () => join(st.dataDir, 'import');
const cursors = () => (existsSync(cursorDir()) ? readdirSync(cursorDir()).sort().map((f) => [f, readFileSync(join(cursorDir(), f), 'utf8')]) : []);
const metaOf = (item) => JSON.parse(item.metadata_json);

// ---------------------------------------------------------------------------------------
// 13a - a dry run
// ---------------------------------------------------------------------------------------

test('13a: the default is a dry run - counts reported, one line per source, nothing dialled', () => {
  const m = fake.mark();
  const r = runImport(['--source', 'all']);
  assert.equal(r.dryRun, true);
  assert.deepEqual(Object.keys(r.sources), ['claude-code', 'codex']);
  assert.ok(r.sources['claude-code'].items >= 5, `the session, its subagent and the turn: ${JSON.stringify(r.sources)}`);
  assert.ok(r.sources.codex.items >= 8, `both shapes and the subagent thread: ${JSON.stringify(r.sources)}`);
  assert.equal(r.items, r.sources['claude-code'].items + r.sources.codex.items);
  assert.equal(r.denied, 1, 'the .env read, dropped whole');
  assert.equal(ingests(m).length, 0, 'a dry run dials nothing');
  assert.deepEqual(cursors(), [], 'and moves no cursor');
});

// ---------------------------------------------------------------------------------------
// 13b - --send
// ---------------------------------------------------------------------------------------

test('13b: --send files every item under the run the hooks use, with the ids live capture would have written', () => {
  const m = fake.mark();
  const r = runImport(['--source', 'all', '--send']);
  assert.equal(r.failed, 0);
  assert.deepEqual(r.runs, [RUN], 'one run: the demo app, resolved per record from cwd');

  const bodies = ingests(m).map((q) => q.body);
  assert.ok(bodies.length >= 1, 'the drain-free ingest loop posted');
  for (const b of bodies) {
    assert.equal(b.run_id, RUN);
    assert.match(String(b.idempotency_key), /^cc-import-[0-9a-f]{16}$/);
  }
  const items = bodies.flatMap((b) => b.items);
  const byId = Object.fromEntries(items.map((i) => [i.item_id, i]));

  // The Claude Code side: the ids are the transcript's own tool_use ids.
  assert.ok(byId['cc-toolu_lab_i001'], 'the Bash call');
  assert.ok(byId['cc-toolu_lab_i101'], 'the subagent\'s Read, found under <session>/subagents/');
  assert.ok(!byId['cc-toolu_lab_i002'], 'the .env read is not on the wire');
  assert.equal(metaOf(byId['cc-toolu_lab_i001']).imported, true);
  assert.equal(metaOf(byId['cc-toolu_lab_i001']).session_id, '7a3088f2-e5c4-4308-b17f-863fd7889341');
  assert.deepEqual(metaOf(byId['cc-toolu_lab_i003']).files, [{ path: `${st.projectDir}/src/notes.md`, kind: 'update' }],
    'the Write\'s toolUseResult said update, and the file-change lane recorded it');
  assert.equal(byId['cc-toolu_lab_i005'].env_tags[0], 'tool:claude-code');
  assert.ok(!items.some((i) => i.text.includes('persisted-output')), 'the offload marker is not a prompt');
  const turns = items.filter((i) => metaOf(i).hook_event === 'Stop');
  assert.ok(turns.some((t) => t.text.startsWith('Q: why does the ingest job stay queued')));

  // The secret: on no wire, in no file the plugin wrote.
  const wire = JSON.stringify(fake.requests());
  for (const s of SECRETS) {
    assert.ok(!wire.includes(s), `${s} reached the wire`);
    for (const f of allDataFiles(st)) assert.ok(!f.text.includes(s), `${s} is on disk at ${f.path}`);
  }
  assert.equal(r.denied, 1);
  assert.ok(cursors().length >= 5, 'one cursor per transcript file, under import/');
});

// ---------------------------------------------------------------------------------------
// 13c - running it again
// ---------------------------------------------------------------------------------------

test('13c: a second --send reads nothing, dials nothing, and leaves every cursor as it was', () => {
  const before = cursors();
  const m = fake.mark();
  const r = runImport(['--source', 'all', '--send']);
  assert.equal(r.files, 0, 'nothing was even opened');
  assert.equal(r.items, 0);
  assert.equal(ingests(m).length, 0);
  assert.deepEqual(cursors(), before, 'import/*.json byte for byte');
});

// ---------------------------------------------------------------------------------------
// 13d - the Codex side, from the same wire
// ---------------------------------------------------------------------------------------

test('13d: Codex items - no preamble, a failed exec, a delete, and the subagent filed under its parent', () => {
  const items = ingests().flatMap((q) => q.body.items).filter((i) => i.env_tags[0] === 'tool:codex');
  assert.ok(items.length >= 8, `codex items on the wire: ${items.length}`);
  assert.ok(!items.some((i) => i.text.includes('recommended_plugins') || i.text.includes('environment_context')),
    'the host\'s preamble is not a prompt');

  const byId = Object.fromEntries(items.map((i) => [i.item_id, i]));
  // 0.146: the exit code lives in the output text, and the item is the join.
  assert.equal(metaOf(byId['cc-call_lab_1']).outcome, 'failure');
  assert.equal(metaOf(byId['cc-call_lab_1']).exit_code, 2);
  assert.equal(metaOf(byId['cc-call_lab_1']).tool, 'Bash');
  assert.deepEqual(metaOf(byId['cc-call_lab_2']).files, [{ path: `${st.projectDir}/docs/OLD.md`, kind: 'delete' }],
    'patch_apply_end names the kind and the absolute path');
  // 0.153: the item is the whole call, and its id is the host\'s own.
  assert.equal(metaOf(byId['cc-exec-lab-0001']).outcome, 'ok');
  assert.deepEqual(metaOf(byId['cc-fc-lab-0001']).files, [{ path: `${st.projectDir}/docs/OLD.md`, kind: 'delete' }]);
  assert.ok(!byId['cc-call_lab_3'], 'the exec script is a copy of the commands it ran, not a call');
  // The subagent thread: its parent\'s session, and the parent\'s run.
  const sub = byId['cc-exec-lab-sub-1'];
  assert.ok(sub, 'the subagent rollout was read');
  assert.equal(metaOf(sub).session_id, CODEX_THREADS.modern);
  const subBody = ingests().find((q) => q.body.items.some((i) => i.item_id === 'cc-exec-lab-sub-1'));
  assert.equal(subBody?.body.run_id, RUN);
  const subTurn = items.find((i) => metaOf(i).hook_event === 'Stop' && i.text.startsWith('Q: Find every call site'));
  assert.ok(subTurn, 'the subagent\'s task is its prompt, not the preamble');
});

// ---------------------------------------------------------------------------------------
// 13e - the server refuses
// ---------------------------------------------------------------------------------------

test('13e: an ingest failure stops, reports, and advances no cursor', async () => {
  const other = labState();
  const otherFixtures = mkdtempSync(join(tmpdir(), 'lab-import-fail-'));
  const bad = await startFake(other, { scenario: 'fail-ingest' });
  try {
    const roots = materialise({ out: otherFixtures, projectDir: other.projectDir });
    other.env.MUBIT_CC_TRANSCRIPT_ROOT = roots.claudeRoot;
    other.env.MUBIT_CC_CODEX_SESSIONS_ROOT = roots.codexRoot;
    const r = spawnSync('node', [join(PLUGIN_ROOT, 'bin', 'import.mjs'), '--project', other.projectDir, '--pace', '0', '--json', '--source', 'all', '--send'], {
      cwd: REPO_ROOT, env: other.env, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(r.status, 1, 'a refused batch is a non-zero exit');
    const report = JSON.parse(r.stdout);
    assert.equal(report.failed, 1, 'it stops at the first refusal');
    assert.match(report.truncatedReason, /cursor was not advanced/);
    assert.ok(!existsSync(join(other.dataDir, 'import')) || readdirSync(join(other.dataDir, 'import')).length === 0,
      'no cursor: a re-run resumes from the start of that file');
    assert.ok(!existsSync(join(other.dataDir, 'breaker')) || readdirSync(join(other.dataDir, 'breaker')).length === 0,
      'and the breaker is untouched — an import must not be able to open it');
  } finally {
    await bad.stop();
    other.cleanup();
    rmSync(otherFixtures, { recursive: true, force: true });
  }
});
