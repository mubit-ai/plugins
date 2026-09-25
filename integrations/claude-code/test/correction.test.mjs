// @ts-check
/**
 * `lib/correction.mjs` — does the user's next prompt say the last turn went wrong?
 *
 * A correction marks the previous turn's used lessons failed and posts a −0.3 against them,
 * so a false positive punishes memory that worked. The table is deliberately conservative:
 * every miss here costs one signal, every false hit costs a lesson's standing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { lib } from './helpers/harness.mjs';

/** [prompt, expected, lastReplyEndedWithQuestion?] */
const ROWS = [
  // Clear corrections.
  ['no, that\'s wrong', true],
  ['No. The test still fails.', true],
  ['nope, try again with the other flag', true],
  ['That\'s wrong — the port is 47101', true],
  ['that is wrong, the config lives in lib/', true],
  ['wrong file, I meant capture.mjs', true],
  ['This is not what I asked for', true],
  ['that\'s not right, it should be 0.2', true],
  ['Incorrect: the key is outcomeMode', true],
  ['you broke the build', true],
  ['it broke the dashboard', true],
  ['this broke everything', true],
  ['still failing on CI', true],
  ['it\'s still broken', true],
  ['still doesn\'t work after that change', true],
  ['still not working', true],
  ['the fix doesn\'t work', true],
  ['that didn\'t work', true],
  ['it does not work on node 20', true],
  ['revert that please', true],
  ['undo that change', true],
  ['roll back the last edit', true],
  ['you misunderstood the question', true],
  ['that\'s not it', true],
  ['no, that\'s wrong', true, true],
  ['NO, stop, that deletes the wrong directory', true],

  // Not corrections.
  ['no problem, thanks!', false],
  ['No worries, carry on', false],
  ['no thanks, that is enough', false],
  ['no need to run the tests again', false],
  ['not bad at all, ship it', false],
  ['there is nothing wrong with the first approach', false],
  ['no rush on this one', false],
  ['great, now add a test for the parser', false],
  ['yes, go ahead', false],
  ['what does the wrong-type error in config mean?', false],
  ['/clear', false],
  ['/mubit-memory:recall wrong outcomes', false],
  ['', false],
  ['   ', false],
  ['Can you explain why the drain rolls the batch?', false],
  ['add a "does not work offline" note to the README', false],

  // A bare no after a question is an answer, not a correction.
  ['no', false, true],
  ['nope.', false, true],
  ['No!', false, true],
  ['no', true, false],
  ['nope', true, false],
  // After a question, a leading "no" is an answer; only a correction phrase still counts.
  ['no, just the code', false, true],
  ['nope, leave the docs alone', false, true],
  ['no, just the code', true, false],
  ['no, that\'s wrong', true, true],
  ['no — it still fails', true, true],
];

for (const [prompt, expected, asked = false] of ROWS) {
  test(`isCorrection(${JSON.stringify(prompt)}${asked ? ', after a question' : ''}) → ${expected}`, async () => {
    const C = await lib('correction.mjs');
    assert.equal(C.isCorrection(prompt, { lastReplyEndedWithQuestion: asked }), expected);
  });
}

test('isCorrection: non-strings are never corrections', async () => {
  const C = await lib('correction.mjs');
  for (const v of [null, undefined, 42, {}, ['no']]) assert.equal(C.isCorrection(/** @type {any} */ (v)), false);
});

test('isCorrection: a fenced code block is not read', async () => {
  const C = await lib('correction.mjs');
  const prompt = 'Here is the log:\n```\nError: that is wrong\nstill failing\n```\nwhat does it mean?';
  assert.equal(C.isCorrection(prompt), false);
});

test('isCorrection: only the opening of a long prompt is scanned', async () => {
  const C = await lib('correction.mjs');
  const prompt = `${'Please add pagination to the list endpoint and document it. '.repeat(10)}that's wrong`;
  assert.equal(C.isCorrection(prompt), false);
});

test('isCorrection: the options argument is optional', async () => {
  const C = await lib('correction.mjs');
  assert.equal(C.isCorrection('no'), true);
  assert.equal(C.isCorrection('that didn\'t work'), true);
});
