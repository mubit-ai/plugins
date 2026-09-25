// @ts-check
/**
 * `lib/terms.mjs` — memory vocabulary and the per-entry used-signal.
 *
 * The v1 signal pooled every injected entry's words and called the turn "used" on a single
 * hit. The per-entry check asks the question per entry, drops words two entries share, and
 * needs several of an entry's own words before it calls that entry used.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { lib } from './helpers/harness.mjs';
import { SECRETS } from './helpers/fixtures.mjs';

const T = () => lib('terms.mjs');
const CFG = { redact: true };

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

test('terms: handles never become vocabulary', async () => {
  const { memoryTerms, vocabularyOf } = await T();
  const { handleTag } = await lib('handles.mjs');
  const tag = handleTag('ref_lesson_1');
  const block = `## Lessons\n- ${tag} Run vitest with forks\n`;
  assert.doesNotMatch(vocabularyOf(block), /\[m/);
  const terms = memoryTerms(CFG, [block], '');
  assert.ok(terms.includes('vitest'));
  assert.ok(!terms.includes(tag.slice(1, -1)), JSON.stringify(terms));
});

test('terms: pointer lines, headings and the stale mark stay out of the vocabulary', async () => {
  const { memoryTerms } = await T();
  const { handleTag } = await lib('handles.mjs');
  const block = '## Active rules\n'
    + `- (seen earlier) ${handleTag('ref_rule_1')} — Ingest returns when queued…\n`
    + `- ${handleTag('ref_fact_1')} (stale) Port listener binds loopback\n`;
  const terms = memoryTerms(CFG, [block], '');
  assert.ok(!terms.includes('ingest') && !terms.includes('active') && !terms.includes('stale'), JSON.stringify(terms));
  assert.ok(terms.includes('listener') && terms.includes('loopback'));
});

test('terms: prompt words and stopwords are subtracted from the pooled vocabulary', async () => {
  const { memoryTerms } = await T();
  const terms = memoryTerms(CFG, ['- Poll the ingest job until indexing completes'], 'why is the ingest stuck?');
  assert.ok(!terms.includes('ingest'), 'the user typed it');
  assert.ok(!terms.includes('until'), 'a stopword');
  assert.ok(terms.includes('indexing') && terms.includes('completes'));
});

test('terms: matchTerms matches at a left word boundary and accepts suffixes', async () => {
  const { matchTerms } = await T();
  assert.deepEqual(matchTerms(['queue', 'poll', 'index'], 'The job was queued; polling. reindex'), ['queue', 'poll']);
});

test('terms: entryTerms strips handles, redacts, drops placeholders, stopwords and prompt terms', async () => {
  const { entryTerms } = await T();
  const { handleTag } = await lib('handles.mjs');
  const text = `${handleTag('ref_x')} Deploy with token ${SECRETS.githubToken} using vitest forks because threads hang`;
  const terms = entryTerms(CFG, text, new Set(['vitest']));
  assert.ok(terms.includes('deploy') && terms.includes('forks') && terms.includes('threads'), JSON.stringify(terms));
  assert.ok(!terms.includes('vitest'), 'a prompt term');
  assert.ok(!terms.includes('because'), 'a stopword');
  assert.ok(!terms.some((t) => t.startsWith('m') && t.length === 5 && /\d/.test(t)), 'no handle');
  assert.ok(!terms.includes('redacted'), 'placeholders are not vocabulary');
  assert.ok(!terms.some((t) => SECRETS.githubToken.toLowerCase().includes(t) && t.length > 8), JSON.stringify(terms));
});

test('terms: entryTerms is capped, deduplicated and lowercased', async () => {
  const { entryTerms } = await T();
  const words = Array.from({ length: 60 }, (_, i) => `Word${String.fromCharCode(97 + (i % 26))}${i}`);
  const terms = entryTerms(CFG, `${words.join(' ')} WORDA0 worda0`, new Set(), 10);
  assert.equal(terms.length, 10);
  assert.equal(new Set(terms).size, 10);
  for (const t of terms) assert.equal(t, t.toLowerCase());
  assert.ok(entryTerms(CFG, words.join(' '), new Set()).length <= 32, 'default cap is 32');
});

test('terms: a scrub that throws yields no terms rather than raw words', async () => {
  const { entryTerms } = await T();
  const hostile = new Proxy({}, { get() { throw new Error('boom'); } });
  assert.deepEqual(entryTerms(hostile, 'plain words that would otherwise count', new Set()), []);
  assert.deepEqual(entryTerms(CFG, '', new Set()), []);
});

// ---------------------------------------------------------------------------
// evaluateUse
// ---------------------------------------------------------------------------

const VITEST = ['vitest', 'pool', 'forks', 'thread', 'hangs', 'native', 'module'];

test('evaluateUse: a reply carrying enough of an entry\'s own words uses it', async () => {
  const { evaluateUse } = await T();
  const r = evaluateUse([{ ref: 'L1', terms: VITEST }], 'Run vitest with --pool=forks; the threads pool is flaky.');
  assert.equal(r.L1.used, true);
  assert.equal(r.L1.candidates, 7);
  assert.deepEqual(r.L1.matched, ['vitest', 'pool', 'forks', 'thread']);
});

test('evaluateUse: two generic words shared with a long lesson are not a use', async () => {
  const { evaluateUse } = await T();
  const lesson = ['default', 'module', 'vitest', 'pool', 'forks', 'thread', 'hangs', 'native',
    'binding', 'worker', 'isolate', 'config'];
  const r = evaluateUse([{ ref: 'L1', terms: lesson }], 'The default export of this module is fine as it is.');
  assert.equal(r.L1.used, false, 'threshold is ceil(12/4) = 3');
  assert.deepEqual(r.L1.matched, ['default', 'module']);
});

test('evaluateUse: a term two entries share counts for neither', async () => {
  const { evaluateUse } = await T();
  const entries = [
    { ref: 'A', terms: ['queue', 'indexing', 'stored'] },
    { ref: 'B', terms: ['queue', 'retry', 'backoff'] },
  ];
  const onlyShared = evaluateUse(entries, 'It sits in the queue.');
  assert.equal(onlyShared.A.used, false);
  assert.equal(onlyShared.B.used, false);
  assert.equal(onlyShared.A.candidates, 2);
  const bOwn = evaluateUse(entries, 'Queued jobs retry with exponential backoff.');
  assert.equal(bOwn.B.used, true);
  assert.equal(bOwn.A.used, false);
  assert.ok(!bOwn.B.matched.includes('queue'));
});

test('evaluateUse: a prompt term never counts', async () => {
  const { evaluateUse } = await T();
  const r = evaluateUse([{ ref: 'L1', terms: ['vitest', 'forks'] }], 'Use vitest.', { exclude: new Set(['vitest']) });
  assert.equal(r.L1.candidates, 1);
  assert.equal(r.L1.used, false);
  const arr = evaluateUse([{ ref: 'L1', terms: ['vitest', 'forks'] }], 'Use vitest.', { exclude: ['vitest'] });
  assert.equal(arr.L1.candidates, 1);
});

test('evaluateUse: inflection still matches (queue ~ queued)', async () => {
  const { evaluateUse } = await T();
  const r = evaluateUse([{ ref: 'L1', terms: ['queue', 'poll'] }], 'The job was queued and polling continues.');
  assert.equal(r.L1.used, true, 'two candidates: both must match, and both do');
});

test('evaluateUse: with two or fewer candidates every one must match', async () => {
  const { evaluateUse } = await T();
  const r = evaluateUse([{ ref: 'L1', terms: ['queue', 'poll'] }, { ref: 'L2', terms: ['backoff'] }],
    'It was queued. Backoff applies.');
  assert.equal(r.L1.used, false);
  assert.equal(r.L2.used, true);
});

test('evaluateUse: no candidates and no reply are unmeasurable, never unused', async () => {
  const { evaluateUse } = await T();
  const r = evaluateUse([{ ref: 'E', terms: [] }, { ref: 'F', terms: ['abc', 'x'.repeat(30)] }, { ref: 'G', terms: ['vitest'] }], '   ');
  assert.deepEqual(r.E, { used: null, matched: [], candidates: 0, reason: 'no_distinct_terms' });
  assert.equal(r.F.used, null);
  assert.equal(r.F.reason, 'no_distinct_terms', 'terms outside 4..24 chars are not candidates');
  assert.deepEqual(r.G, { used: null, matched: [], candidates: 1, reason: 'no_reply' });
});

test('evaluateUse: terms are lowercased and matched output is capped at 12', async () => {
  const { evaluateUse } = await T();
  const terms = Array.from({ length: 20 }, (_, i) => `Term${String.fromCharCode(97 + i)}x`);
  const reply = terms.map((t) => t.toLowerCase()).join(' ');
  const r = evaluateUse([{ ref: 'L', terms }], reply);
  assert.equal(r.L.used, true);
  assert.equal(r.L.matched.length, 12);
  assert.equal(r.L.candidates, 20);
});

test('evaluateUse: the reply scan is bounded at 64 KB', async () => {
  const { evaluateUse } = await T();
  const reply = `${'x '.repeat(40 * 1024)} vitest forks`;
  const r = evaluateUse([{ ref: 'L', terms: ['vitest', 'forks'] }], reply);
  assert.equal(r.L.used, false);
});

test('evaluateUse: malformed input is tolerated', async () => {
  const { evaluateUse } = await T();
  const r = evaluateUse(/** @type {any} */ ([null, { ref: 'A' }, { ref: 'B', terms: 'nope' }, { terms: ['vitest'] }]), 'vitest');
  assert.equal(r.A.used, null);
  assert.equal(r.B.used, null);
  assert.deepEqual(Object.keys(r).sort(), ['A', 'B']);
  assert.deepEqual(evaluateUse(/** @type {any} */ (null), 'x'), {});
});

// ---------------------------------------------------------------------------
// entryTitle
// ---------------------------------------------------------------------------

test('entryTitle: a one-sentence entry is its own title, with no ellipsis for the dropped stop', async () => {
  const { entryTitle } = await T();
  assert.equal(entryTitle(CFG, 'A job stays queued until indexing completes.'), 'A job stays queued until indexing completes');
});

test('entryTitle: a longer entry is cut at its first clause and capped at 48 characters', async () => {
  const { entryTitle } = await T();
  assert.equal(entryTitle(CFG, 'Run vitest with --pool=forks; the thread pool hangs on the native module.'),
    'Run vitest with --pool=forks…');
  const long = entryTitle(CFG, 'Always run the integration suite against a disposable database before merging anything; it catches it.');
  assert.ok(long.length <= 48 && long.endsWith('…'), long);
});

test('entryTitle: a secret never survives into a title, and a hostile cfg yields an empty title', async () => {
  const { entryTitle } = await T();
  assert.ok(!entryTitle(CFG, `${SECRETS.openaiKey} is the key.`).includes(SECRETS.openaiKey));
  const hostile = new Proxy({}, { get() { throw new Error('boom'); } });
  assert.equal(entryTitle(hostile, 'anything at all'), '');
});
