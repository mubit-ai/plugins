// @ts-check
/**
 * `lib/scorecard-log.mjs` — one append-only log per host session, folded at render time.
 *
 * Several hooks write it concurrently (stage-prompt and prompt-recall on the same event,
 * capture on every tool call), so the contract is the ledger's: one `O_APPEND` write per row,
 * a torn line costs only itself, and a path built from a session id cannot climb.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lib, makeDataDir } from './helpers/harness.mjs';

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const cfgOf = (dir) => ({ dataDir: dir });

test('scorecard log: the path is <data>/scorecard/<session>.jsonl', async () => {
  const L = await lib('scorecard-log.mjs');
  const dir = makeDataDir();
  assert.equal(L.scorecardPath(cfgOf(dir), SESSION), join(dir, 'scorecard', `${SESSION}.jsonl`));
});

test('scorecard log: a traversal session id stays inside scorecard/, and a blank one has no path', async () => {
  const L = await lib('scorecard-log.mjs');
  const dir = makeDataDir();
  const p = L.scorecardPath(cfgOf(dir), '../../etc/passwd');
  assert.ok(p.startsWith(join(dir, 'scorecard')), `escaped: ${p}`);
  assert.equal(L.scorecardPath(cfgOf(dir), ''), '');
  assert.equal(L.scorecardPath(cfgOf(dir), undefined), '');
  assert.equal(L.appendScoreRow(cfgOf(dir), '', { kind: 'prompt' }), false);
});

test('scorecard log: rows come back in append order, stamped with v:1 and at', async () => {
  const L = await lib('scorecard-log.mjs');
  const dir = makeDataDir();
  const cfg = cfgOf(dir);
  assert.equal(L.appendScoreRow(cfg, SESSION, { kind: 'prompt', prompt_id: 'p1', correction: false, slash: false }), true);
  assert.equal(L.appendScoreRow(cfg, SESSION, { kind: 'tool', prompt_id: 'p1', failed: true, intent: 'exec' }), true);
  const rows = L.readScoreRows(cfg, SESSION);
  assert.deepEqual(rows.map((r) => r.kind), ['prompt', 'tool']);
  for (const r of rows) {
    assert.equal(r.v, L.SCORE_LOG_VERSION);
    assert.equal(L.SCORE_LOG_VERSION, 1);
    assert.equal(typeof r.at, 'number');
  }
});

test('scorecard log: a row without a kind, or that is not an object, is refused', async () => {
  const L = await lib('scorecard-log.mjs');
  const dir = makeDataDir();
  const cfg = cfgOf(dir);
  assert.equal(L.appendScoreRow(cfg, SESSION, null), false);
  assert.equal(L.appendScoreRow(cfg, SESSION, ['x']), false);
  assert.equal(L.appendScoreRow(cfg, SESSION, { prompt_id: 'p1' }), false);
  assert.deepEqual(L.readScoreRows(cfg, SESSION), []);
});

test('scorecard log: a missing file reads as no rows, never a throw', async () => {
  const L = await lib('scorecard-log.mjs');
  assert.deepEqual(L.readScoreRows(cfgOf(makeDataDir()), SESSION), []);
  assert.deepEqual(L.readScoreRows(cfgOf(makeDataDir()), ''), []);
});

test('scorecard log: a torn last line costs itself, and the next append starts a fresh line', async () => {
  const L = await lib('scorecard-log.mjs');
  const dir = makeDataDir();
  const cfg = cfgOf(dir);
  L.appendScoreRow(cfg, SESSION, { kind: 'prompt', prompt_id: 'p1' });
  appendFileSync(L.scorecardPath(cfg, SESSION), '{"kind":"tool","prompt_id":"p1","fai');
  assert.deepEqual(L.readScoreRows(cfg, SESSION).map((r) => r.kind), ['prompt']);
  L.appendScoreRow(cfg, SESSION, { kind: 'turn', prompt_id: 'p1' });
  assert.deepEqual(L.readScoreRows(cfg, SESSION).map((r) => r.kind), ['prompt', 'turn']);
});

test('scorecard log: a tail read returns only whole rows from the last N bytes', async () => {
  const L = await lib('scorecard-log.mjs');
  const dir = makeDataDir();
  const cfg = cfgOf(dir);
  for (let i = 0; i < 50; i++) L.appendScoreRow(cfg, SESSION, { kind: 'prompt', prompt_id: `p${i}` });
  const tail = L.readScoreRows(cfg, SESSION, { tailBytes: 300 });
  assert.ok(tail.length > 0 && tail.length < 50, `tail had ${tail.length} rows`);
  assert.equal(tail[tail.length - 1].prompt_id, 'p49');
  for (const r of tail) assert.equal(r.kind, 'prompt', 'a partial first line leaked through');
  const all = L.readScoreRows(cfg, SESSION, { tailBytes: 10_000_000 });
  assert.equal(all.length, 50);
});

test('scorecard log: rows of kinds the reader does not know are kept for the fold to ignore', async () => {
  const L = await lib('scorecard-log.mjs');
  const dir = makeDataDir();
  const cfg = cfgOf(dir);
  L.appendScoreRow(cfg, SESSION, { kind: 'from-the-future', x: 1 });
  assert.equal(L.readScoreRows(cfg, SESSION)[0].kind, 'from-the-future');
});

test('scorecard log: concurrent writers lose no rows', async () => {
  const dir = makeDataDir();
  const here = fileURLToPath(new URL('.', import.meta.url));
  const modPath = join(here, '..', 'lib', 'scorecard-log.mjs');
  const writers = 6;
  const perWriter = 40;
  const script = `
    const L = await import(${JSON.stringify(modPath)});
    const w = Number(process.argv[1]);
    for (let i = 0; i < ${perWriter}; i++) {
      L.appendScoreRow({ dataDir: ${JSON.stringify(dir)} }, ${JSON.stringify(SESSION)},
        { kind: 'tool', prompt_id: 'w' + w + '-' + i, failed: false, intent: 'exec', pad: 'x'.repeat(200) });
    }`;
  await Promise.all(Array.from({ length: writers }, (_, w) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, String(w)], { stdio: 'ignore' });
    child.on('exit', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`writer exited ${code}`))));
  })));
  const L = await lib('scorecard-log.mjs');
  const rows = L.readScoreRows(cfgOf(dir), SESSION);
  assert.equal(rows.length, writers * perWriter);
  assert.equal(new Set(rows.map((r) => r.prompt_id)).size, writers * perWriter);
  const text = readFileSync(L.scorecardPath(cfgOf(dir), SESSION), 'utf8');
  assert.equal(text.split('\n').filter(Boolean).length, writers * perWriter);
});

test('scorecard log: recentScoreLogs lists session logs newest first, and only .jsonl files', async () => {
  const L = await lib('scorecard-log.mjs');
  const dir = makeDataDir();
  const cfg = cfgOf(dir);
  L.appendScoreRow(cfg, 'old-session', { kind: 'prompt' });
  L.appendScoreRow(cfg, 'new-session', { kind: 'prompt' });
  const old = L.scorecardPath(cfg, 'old-session');
  const t = (Date.now() - 60_000) / 1000;
  utimesSync(old, t, t);
  appendFileSync(join(dir, 'scorecard', 'stray.txt'), 'x');
  const list = L.recentScoreLogs(cfg);
  assert.deepEqual(list, [L.scorecardPath(cfg, 'new-session'), old]);
  assert.deepEqual(L.recentScoreLogs(cfg, { limit: 1 }), [L.scorecardPath(cfg, 'new-session')]);
  assert.deepEqual(L.recentScoreLogs(cfg, { maxAgeMs: 30_000 }), [L.scorecardPath(cfg, 'new-session')]);
});
