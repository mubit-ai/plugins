// @ts-check
/**
 * The session scorecard end to end: real hook processes in the order the host runs them —
 * session-start, then per prompt stage-prompt + prompt-recall, then capture --stop — over three
 * turns, the second of which corrects the first. Each card is asserted exactly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { baseEnv, evidence, fakeMubit, makeDataDir, queryResponse, runHook, tempDir } from './helpers/harness.mjs';
import { postToolUse, sessionStart, stop, userPromptSubmit, SESSION_ID } from './helpers/fixtures.mjs';

const RUN_ID = 'cc-e2e-score-0';
const L1 = 'e2e00001-0000-4000-8000-000000000001';
const L2 = 'e2e00002-0000-4000-8000-000000000002';
const FACT = 'e2e00003-0000-4000-8000-000000000003';

const SCRATCH = tempDir('mubit-cc-card-e2e-');
const SPY = join(SCRATCH, 'spawn-spy.cjs');
writeFileSync(SPY, `const fs = require('node:fs');
const out = process.env.MUBIT_TEST_SPY_FILE;
if (out) { try { fs.appendFileSync(out, JSON.stringify({ argv: process.argv.slice(1) }) + '\\n'); } catch {} }
`);

function drains(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((l) => basename(String(l.argv?.[0] ?? '')) === 'drain.mjs');
}

async function waitForDrain(file, pred, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (drains(file).some(pred)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

function logTokens(dataDir) {
  const p = join(dataDir, 'scorecard', `${SESSION_ID}.jsonl`);
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.kind === 'start' || r.kind === 'shown')
    .reduce((n, r) => n + (Number(r.tokens) || 0), 0);
}

const tok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

test('scorecard end to end: three turns, a correction, and the exact card after each', async (t) => {
  const server = await fakeMubit({
    'POST /v2/control/query': {
      json: queryResponse({
        evidence: [
          evidence({ id: 'e1', reference_id: L1, entry_type: 'lesson', score: 0.9,
            content: 'Run vitest with --pool=forks; the threads pool hangs on the native module.' }),
          evidence({ id: 'e2', reference_id: L2, entry_type: 'lesson', score: 0.8,
            content: 'Run migrations before seeding the database; seeds assume the schema exists.' }),
          evidence({ id: 'e3', reference_id: FACT, entry_type: 'fact', score: 0.5,
            content: 'The CI runner image ships Node 22.' }),
        ],
      }),
    },
  });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  mkdirSync(join(dataDir, 'runs', RUN_ID), { recursive: true });
  writeFileSync(join(dataDir, 'runs', RUN_ID, 'drain.lock'), JSON.stringify({ pid: process.pid, ts: Date.now() }));
  const spy = join(SCRATCH, `spy-${randomUUID()}.jsonl`);
  const env = baseEnv({
    dataDir, endpoint: server.url, projectDir: dataDir,
    extra: {
      MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: RUN_ID,
      MUBIT_CC_OUTCOME_REVIEW: 'nudge',
      NODE_OPTIONS: `--require ${SPY}`, MUBIT_TEST_SPY_FILE: spy,
    },
  });

  await runHook('session-start', sessionStart(), { env });

  /** One turn the way the host drives it; returns the Stop output. */
  async function turn(promptId, prompt, reply, during = async () => {}) {
    const p = userPromptSubmit({ prompt_id: promptId, prompt });
    await Promise.all([runHook('stage-prompt', p, { env }), runHook('prompt-recall', p, { env })]);
    await during();
    return runHook('capture', stop({ prompt_id: promptId, last_assistant_message: reply }), { env, args: ['--stop'] });
  }

  // Turn 1: the standing lesson plus both recalled lessons are new; the reply uses the first.
  const one = await turn('p1', 'why does the test runner hang on CI?',
    'Use vitest with --pool=forks: the threads pool hangs on the native module.');
  assert.equal(one.json.systemMessage, [
    `mubit · this session · lessons on 1 of 1 prompt · memory added ${tok(logTokens(dataDir))} tok`,
    '  3 lessons shown',
    '  ├ 1 used      1 waiting on your reply',
    '  └ 2 not used',
    '  this turn: used "Run vitest with --pool=forks…"',
  ].join('\n'));

  // Turn 2: the user corrects turn 1, which used a lesson → a correction drain for p1.
  const two = await turn('p2', "no, that's wrong — the runner still hangs",
    'Let me look at the CI logs again.');
  assert.ok(await waitForDrain(spy, (d) => d.argv.includes('--correct')),
    `no correction drain: ${JSON.stringify(drains(spy).map((d) => d.argv.slice(1)))}`);
  const correct = drains(spy).find((d) => d.argv.includes('--correct'));
  assert.equal(correct.argv[correct.argv.indexOf('--correct') + 1], 'p1');
  assert.equal(correct.argv[correct.argv.indexOf('--run') + 1], RUN_ID);
  assert.equal(two.json.systemMessage, [
    `mubit · this session · lessons on 2 of 2 prompts · memory added ${tok(logTokens(dataDir))} tok`,
    '  3 lessons shown',
    '  ├ 1 used      1 failed',
    '  └ 2 not used',
    '  this turn: shown 2, none used',
    '  review: "Run vitest with --pool=forks…" failed on prompt 1',
  ].join('\n'));

  // Turn 3: a new question; the reply uses the second lesson and Claude saves a lesson.
  const three = await turn('p3', 'thanks — how should I seed the database for local dev?',
    'Run migrations first so the schema exists, then run the seeding script.',
    async () => {
      await runHook('capture', postToolUse({
        prompt_id: 'p3', tool_name: 'mcp__plugin_mubit-memory_mubit__mubit_learned',
        tool_input: { text: 'Seed only after migrations.' }, tool_use_id: 'toolu_learned',
      }), { env });
    });
  assert.equal(three.json.systemMessage, [
    `mubit · this session · lessons on 3 of 3 prompts · +1 learned · memory added ${tok(logTokens(dataDir))} tok`,
    '  3 lessons shown',
    '  ├ 2 used      1 failed · 1 waiting on your reply',
    '  └ 1 not used',
    '  this turn: used "Run migrations before seeding the database…"',
    '  review: "Run vitest with --pool=forks…" failed on prompt 1',
  ].join('\n'));
});
