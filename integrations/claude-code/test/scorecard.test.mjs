// @ts-check
/**
 * `lib/scorecard.mjs` — the session scorecard, as a pure fold over the session log and an
 * exact renderer.
 *
 * The golden fixtures under `test/fixtures/scorecard/` are the spec: each is a session log, the
 * prompt the card is rendered for, the summary the fold must produce, and the exact card text.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lib } from './helpers/harness.mjs';

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'scorecard');

/** @param {string} dir */
function fixture(dir) {
  const base = join(FIXTURES, dir);
  const rows = readFileSync(join(base, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return {
    rows,
    current: JSON.parse(readFileSync(join(base, 'meta.json'), 'utf8')).current,
    summary: JSON.parse(readFileSync(join(base, 'summary.json'), 'utf8')),
    full: readFileSync(join(base, 'card.full.txt'), 'utf8').replace(/\n$/, ''),
    compact: readFileSync(join(base, 'card.compact.txt'), 'utf8').replace(/\n$/, ''),
  };
}

for (const dir of readdirSync(FIXTURES)) {
  test(`scorecard golden: ${dir} folds to the expected summary`, async () => {
    const S = await lib('scorecard.mjs');
    const f = fixture(dir);
    assert.deepEqual(S.foldScorecard(f.rows, f.current), f.summary);
  });
  test(`scorecard golden: ${dir} renders the exact full and compact cards`, async () => {
    const S = await lib('scorecard.mjs');
    const f = fixture(dir);
    const summary = S.foldScorecard(f.rows, f.current);
    assert.equal(S.renderScorecard(summary, 'full'), f.full);
    assert.equal(S.renderScorecard(summary, 'compact'), f.compact);
    assert.equal(S.renderScorecard(summary, 'off'), '');
  });
}

// ---------------------------------------------------------------------------
// Small logs
// ---------------------------------------------------------------------------

const lesson = (title, pointer = false) => ({ title, terms: ['x'], handle: 'mxxxx', pointer });
const P = (id, over = {}) => ({ kind: 'prompt', prompt_id: id, correction: false, slash: false, ...over });
const SH = (id, lessons, tokens = 0) => ({ kind: 'shown', prompt_id: id, lessons, refs: Object.keys(lessons), tokens });
const T = (id, used, over = {}) => ({
  kind: 'turn', prompt_id: id, run_id: 'r',
  lessons: Object.fromEntries(Object.entries(used).map(([k, v]) => [k, { used: v, matched: [] }])),
  used_refs: Object.entries(used).filter(([, v]) => v === true).map(([k]) => k),
  ended_with_question: false, ...over,
});
const TOOL = (id, intent, failed) => ({ kind: 'tool', prompt_id: id, intent, failed });
const EX = (id, ids, outcome) => ({ kind: 'explicit', prompt_id: id, ids, outcome });

test('scorecard: an explicit partial counts as worked; a neutral names the lesson as used and leaves the verdict to the other rules', async () => {
  const S = await lib('scorecard.mjs');
  const rows = [
    P('p1'), SH('p1', { a: lesson('A'), b: lesson('B'), c: lesson('C') }),
    T('p1', { a: false, b: false, c: true }),
    EX('p1', ['a'], 'partial'), EX('p1', ['b'], 'neutral'), EX('p1', ['c'], 'neutral'),
  ];
  const s = S.foldScorecard(rows, 'p1');
  assert.deepEqual(s.lessons, { shown: 3, used: 3, notUsed: 0, unknown: 0, worked: 1, failed: 0, waiting: 2 });
  assert.deepEqual(s.thisTurn.lessons.map((l) => l.explicit), ['partial', 'neutral', 'neutral']);
  const corrected = S.foldScorecard([...rows, P('p2', { correction: true })], 'p2');
  assert.deepEqual([corrected.lessons.worked, corrected.lessons.failed], [1, 2]);
});

test('scorecard: the last explicit verdict for a lesson in a turn wins', async () => {
  const S = await lib('scorecard.mjs');
  const rows = [P('p1'), SH('p1', { a: lesson('A') }), T('p1', { a: true }), EX('p1', ['a'], 'success'), EX('p1', ['a'], 'failure')];
  assert.equal(S.foldScorecard(rows, 'p1').lessons.failed, 1);
});

test('scorecard: a correction fails only the turn right before it', async () => {
  const S = await lib('scorecard.mjs');
  const rows = [
    P('p1'), SH('p1', { a: lesson('A') }), T('p1', { a: true }),
    P('p2'), SH('p2', { b: lesson('B') }), T('p2', { b: true }),
    P('p3', { correction: true }), SH('p3', { c: lesson('C') }), T('p3', { c: false }),
  ];
  const s = S.foldScorecard(rows, 'p3');
  assert.deepEqual(s.review.failed.map((f) => f.ref), ['b']);
  assert.equal(s.lessons.worked, 1);
});

test('scorecard: a slash prompt neither counts as a prompt nor settles the turn before it', async () => {
  const S = await lib('scorecard.mjs');
  const rows = [P('p1'), SH('p1', { a: lesson('A') }), T('p1', { a: true }), P('p2', { slash: true })];
  const s = S.foldScorecard(rows, 'p1');
  assert.equal(s.prompts, 1);
  assert.equal(s.lessons.waiting, 1);
});

test('scorecard: a correction across a /clear session start is ignored', async () => {
  const S = await lib('scorecard.mjs');
  const rows = [
    P('p1'), SH('p1', { a: lesson('A') }), T('p1', { a: true }),
    { kind: 'start', source: 'clear', lessons: {}, refs: [], tokens: 0 },
    P('p2', { correction: true }),
  ];
  assert.equal(S.foldScorecard(rows, 'p2').lessons.worked, 1);
});

test('scorecard: a correction across a compact or resume start still counts', async () => {
  const S = await lib('scorecard.mjs');
  const rows = [
    P('p1'), SH('p1', { a: lesson('A') }), T('p1', { a: true }),
    { kind: 'start', source: 'compact', lessons: {}, refs: [], tokens: 0 },
    P('p2', { correction: true }),
  ];
  assert.equal(S.foldScorecard(rows, 'p2').lessons.failed, 1);
});

test('scorecard: only the last non-read-only tool call decides a tool failure', async () => {
  const S = await lib('scorecard.mjs');
  const base = [P('p1'), SH('p1', { a: lesson('A') }), T('p1', { a: true })];
  const verdict = (tools) => S.foldScorecard([...base, ...tools, P('p2')], 'p2').lessons;
  assert.equal(verdict([TOOL('p1', 'exec', true), TOOL('p1', 'read', false)]).failed, 1);
  assert.equal(verdict([TOOL('p1', 'exec', false), TOOL('p1', 'search', true)]).worked, 1);
  assert.equal(verdict([TOOL('p1', 'exec', true), TOOL('p1', 'exec', false)]).worked, 1);
  assert.equal(verdict([TOOL('p1', 'write', true)]).failed, 1);
  assert.equal(verdict([TOOL('p1', 'other', true)]).failed, 1);
  assert.equal(verdict([TOOL('p2', 'exec', true)]).worked, 1);
});

test('scorecard: without a next prompt a clean turn is waiting, with one it worked', async () => {
  const S = await lib('scorecard.mjs');
  const rows = [P('p1'), SH('p1', { a: lesson('A') }), T('p1', { a: true })];
  assert.equal(S.foldScorecard(rows, 'p1').lessons.waiting, 1);
  assert.equal(S.foldScorecard([...rows, P('p2')], 'p2').lessons.worked, 1);
});

test('scorecard: one failed use marks the lesson failed; otherwise waiting beats worked', async () => {
  const S = await lib('scorecard.mjs');
  const rows = [
    P('p1'), SH('p1', { a: lesson('A') }), T('p1', { a: true }), EX('p1', ['a'], 'failure'),
    P('p2'), SH('p2', { a: lesson('A', true), b: lesson('B') }), T('p2', { a: true, b: true }),
    P('p3'), SH('p3', { b: lesson('B', true) }), T('p3', { b: true }),
  ];
  const s = S.foldScorecard(rows, 'p3');
  assert.deepEqual(s.lessons, { shown: 2, used: 2, notUsed: 0, unknown: 0, worked: 0, failed: 1, waiting: 1 });
});

test('scorecard: the latest turn row for a prompt wins', async () => {
  const S = await lib('scorecard.mjs');
  const rows = [P('p1'), SH('p1', { a: lesson('A') }), T('p1', { a: true }), T('p1', { a: false })];
  assert.equal(S.foldScorecard(rows, 'p1').lessons.notUsed, 1);
});

test('scorecard: a shown lesson with no turn row, or a null verdict, is unknown', async () => {
  const S = await lib('scorecard.mjs');
  const rows = [P('p1'), SH('p1', { a: lesson('A') }), P('p2'), SH('p2', { b: lesson('B') }), T('p2', { b: null })];
  const s = S.foldScorecard(rows, 'p2');
  assert.equal(s.lessons.unknown, 2);
  assert.equal(s.thisTurn.checkable, false);
});

test('scorecard: standing lessons attach to the first non-slash prompt after each start only', async () => {
  const S = await lib('scorecard.mjs');
  const rows = [
    { kind: 'start', source: 'startup', lessons: { s: { title: 'S', terms: ['x'], handle: 'mxxxx' } }, refs: ['s'], tokens: 10 },
    P('p0', { slash: true }),
    P('p1'), T('p1', { s: true }),
    P('p2'), SH('p2', { a: lesson('A') }), T('p2', { a: false }),
  ];
  const s = S.foldScorecard(rows, 'p1');
  assert.equal(s.thisTurn.shown, 1);
  assert.equal(s.lessonPrompts, 2);
  assert.equal(s.tokens, 10);
  assert.equal(S.foldScorecard(rows, 'p2').thisTurn.shown, 1);
});

test('scorecard: 3+ showings without a use is flagged; fewer is not', async () => {
  const S = await lib('scorecard.mjs');
  const turn = (id, ptr) => [P(id), SH(id, { n: lesson('N', ptr) }), T(id, { n: false })];
  assert.equal(S.foldScorecard([...turn('p1', false), ...turn('p2', true)], 'p2').review.neverUsed, 0);
  assert.equal(S.foldScorecard([...turn('p1', false), ...turn('p2', true), ...turn('p3', true)], 'p3').review.neverUsed, 1);
});

test('scorecard: unknown row kinds and malformed rows are ignored', async () => {
  const S = await lib('scorecard.mjs');
  const rows = [
    { kind: 'from-the-future' }, null, 'x', P('p1'), { kind: 'shown', prompt_id: 'p1', lessons: 'bad' },
    SH('p1', { a: lesson('A') }), { kind: 'turn', prompt_id: 'p1', lessons: null }, T('p1', { a: true }),
    { kind: 'tool' }, { kind: 'explicit', prompt_id: 'p1', ids: 'a' },
  ];
  assert.equal(S.foldScorecard(/** @type {any} */ (rows), 'p1').lessons.used, 1);
  assert.deepEqual(S.foldScorecard(/** @type {any} */ (null), 'p1').lessons.shown, 0);
});

// ---------------------------------------------------------------------------
// Invariants over random logs
// ---------------------------------------------------------------------------

test('scorecard: shown = used + not used + unknown, and used = worked + failed + waiting, always', async () => {
  const S = await lib('scorecard.mjs');
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const refs = ['a', 'b', 'c', 'd', 'e', 'f'];
  for (let run = 0; run < 300; run++) {
    const rows = [];
    const n = 1 + Math.floor(rnd() * 6);
    for (let i = 0; i < n; i++) {
      const id = `p${i}`;
      if (rnd() < 0.15) rows.push({ kind: 'start', source: pick(['startup', 'clear', 'compact']), lessons: rnd() < 0.5 ? { s: lesson('S') } : {}, refs: [], tokens: 5 });
      rows.push(P(id, { correction: rnd() < 0.3, slash: rnd() < 0.1 }));
      const shown = Object.fromEntries(refs.filter(() => rnd() < 0.4).map((r) => [r, lesson(r.toUpperCase(), rnd() < 0.3)]));
      if (rnd() < 0.9) rows.push(SH(id, shown, 10));
      for (let k = 0; k < 3; k++) if (rnd() < 0.3) rows.push(TOOL(id, pick(['read', 'search', 'exec', 'write', 'other']), rnd() < 0.4));
      if (rnd() < 0.3) rows.push(EX(id, [pick(refs)], pick(['success', 'failure', 'partial', 'neutral'])));
      if (rnd() < 0.8) rows.push(T(id, Object.fromEntries([...Object.keys(shown), 's'].map((r) => [r, pick([true, false, null])]))));
    }
    const s = S.foldScorecard(rows, `p${n - 1}`);
    const l = s.lessons;
    assert.equal(l.shown, l.used + l.notUsed + l.unknown, JSON.stringify(rows));
    assert.equal(l.used, l.worked + l.failed + l.waiting, JSON.stringify(rows));
    for (const v of Object.values(l)) assert.ok(Number.isInteger(v) && v >= 0);
    const card = S.renderScorecard(s, 'full');
    if (s.thisTurn.shown === 0) assert.equal(card, '');
    else assert.match(card, /^mubit · this session · lessons on \d+ of \d+ prompts?/);
  }
});

// ---------------------------------------------------------------------------
// Rendering edges
// ---------------------------------------------------------------------------

/** A summary with everything zero except what `over` sets. */
function summary(over = {}) {
  return {
    prompts: 1, lessonPrompts: 1, learned: 0, tokens: 0,
    lessons: { shown: 1, used: 0, notUsed: 1, unknown: 0, worked: 0, failed: 0, waiting: 0 },
    thisTurn: { promptId: 'p1', shown: 1, used: [], checkable: true, lessons: [] },
    review: { failed: [], neverUsed: 0 },
    ...over,
  };
}

test('scorecard render: singulars, and zero parts omitted', async () => {
  const S = await lib('scorecard.mjs');
  assert.equal(S.renderScorecard(summary(), 'full'), [
    'mubit · this session · lessons on 1 of 1 prompt',
    '  1 lesson shown',
    '  └ 1 not used',
    '  this turn: shown 1, none used',
  ].join('\n'));
  assert.equal(S.renderScorecard(summary(), 'compact'),
    'mubit · this session · lessons on 1 of 1 prompt · 0 of 1 lesson used');
});

test('scorecard render: token amounts', async () => {
  const S = await lib('scorecard.mjs');
  const head = (tokens) => S.renderScorecard(summary({ tokens }), 'full').split('\n')[0];
  assert.match(head(999), / · memory added 999 tok$/);
  assert.match(head(1000), / · memory added 1\.0k tok$/);
  assert.match(head(12345), / · memory added 12\.3k tok$/);
  assert.doesNotMatch(head(0), /memory added/);
});

test('scorecard render: this turn names at most two lessons, then counts the rest', async () => {
  const S = await lib('scorecard.mjs');
  const s = summary({
    lessons: { shown: 3, used: 3, notUsed: 0, unknown: 0, worked: 0, failed: 0, waiting: 3 },
    thisTurn: { promptId: 'p1', shown: 3, used: ['one', 'say "hi"', 'three'], checkable: true, lessons: [] },
  });
  const lines = S.renderScorecard(s, 'full').split('\n');
  assert.equal(lines[2], '  └ 3 used      3 waiting on your reply');
  assert.equal(lines[3], `  this turn: used "one", "say 'hi'" +1 more`);
});

test('scorecard render: a turn nothing could be checked on says so', async () => {
  const S = await lib('scorecard.mjs');
  const s = summary({
    lessons: { shown: 2, used: 0, notUsed: 0, unknown: 2, worked: 0, failed: 0, waiting: 0 },
    thisTurn: { promptId: 'p1', shown: 2, used: [], checkable: false, lessons: [] },
  });
  assert.deepEqual(S.renderScorecard(s, 'full').split('\n').slice(1), [
    '  2 lessons shown', '  └ 2 unknown', '  this turn: shown 2, none checkable',
  ]);
});

test('scorecard render: the review line, each half alone', async () => {
  const S = await lib('scorecard.mjs');
  const oneFailed = summary({
    lessons: { shown: 1, used: 1, notUsed: 0, unknown: 0, worked: 0, failed: 1, waiting: 0 },
    review: { failed: [{ ref: 'a', title: 'use npm ci in CI', prompt: 5 }], neverUsed: 0 },
  });
  assert.equal(S.renderScorecard(oneFailed, 'full').split('\n').at(-1), '  review: "use npm ci in CI" failed on prompt 5');
  assert.match(S.renderScorecard(oneFailed, 'full'), /  └ 1 used      1 failed\n/);
  const noisy = summary({ review: { failed: [], neverUsed: 2 } });
  assert.equal(S.renderScorecard(noisy, 'full').split('\n').at(-1), '  review: 2 lessons shown 3+ times and never used');
});

test('scorecard render: the used column stays aligned past single digits', async () => {
  const S = await lib('scorecard.mjs');
  const s = summary({ lessons: { shown: 14, used: 12, notUsed: 2, unknown: 0, worked: 12, failed: 0, waiting: 0 } });
  assert.match(S.renderScorecard(s, 'full'), /\n {2}├ 12 used {5}12 worked\n {2}└ 2 not used\n/);
});

test('scorecard render: no card when this turn showed no lesson, or for an unknown mode', async () => {
  const S = await lib('scorecard.mjs');
  const s = summary({ thisTurn: { promptId: 'p1', shown: 0, used: [], checkable: false, lessons: [] } });
  assert.equal(S.renderScorecard(s, 'full'), '');
  assert.equal(S.renderScorecard(s, 'compact'), '');
  assert.equal(S.renderScorecard(summary(), /** @type {any} */ ('loud')), '');
  assert.equal(S.renderScorecard(/** @type {any} */ (null), 'full'), '');
});
