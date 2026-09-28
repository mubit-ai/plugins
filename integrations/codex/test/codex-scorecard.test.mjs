// @ts-check
/**
 * The session scorecard, end to end, on Codex payloads (#22).
 *
 * The claim: the card printed under a Codex reply is the card Claude Code prints for the same
 * session, and it stays right where Codex differs:
 *
 *   - a turn is keyed by `turn_id` — Codex sends no `prompt_id`;
 *   - a shell call's failure is nowhere in its `PostToolUse`. `tool_response` is the output
 *     string and nothing else; the verdict is an `item_completed` line in the rollout (0.154),
 *     whose `item.id` is the hook's `tool_use_id`;
 *   - the host's flow: a message typed mid-turn is a second `UserPromptSubmit` under the running
 *     `turn_id`; Esc fires `Interrupt`, which the plugin does not register, and no `Stop`;
 *     `/clear` is a `SessionStart` with `source: "clear"` in the same session; `/new` is a new
 *     session id with `source: "startup"`; and `SessionStart` fires just before the first
 *     prompt rather than at launch.
 *
 * Every case runs the Codex entry points (`integrations/codex/hooks/src/*`) as real
 * subprocesses in the order the host runs them — session-start; prompt-recall and stage-prompt
 * together; capture once per tool call; `capture --stop` — against a fake Mubit whose recall
 * answers two lessons. The card is asserted exactly, and every Stop output is held to the Codex
 * output contract (`test/fixtures/codex-output-rules.json`, and the keys a recorded session
 * saw the host take on Stop).
 *
 * `MUBIT_CC_SESSION_SCORE` is set in every case: on Codex it defaults off (#25 turns it on), so
 * a case that left it out would be testing the default rather than the card.
 * `MUBIT_CC_OUTCOME_REVIEW` is `nudge`, Codex's default, so the once-per-turn review (#24) never
 * blocks a Stop here.
 */

import test from 'node:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  assert, baseEnv, evidence, fakeMubit, lib, makeDataDir, makeProjectDir, queryResponse, runHook,
  tempDir, waitFor, assertHookContract, assertOutputAccepted, assertValid, outputAcceptance,
  CODEX_ROOT,
  sessionStart as sessionStartPayload,
  userPromptSubmit as promptPayload,
  queuedPrompt as queuedPayload,
  postToolUse as toolPayload,
  stop as stopPayload,
  stopContinuation as continuationPayload,
  subagentStop as subagentStopPayload,
  rolloutJsonl, rolloutCommandCompleted, rolloutExecScript, rolloutExecScriptOutput,
} from './helpers/codex-fixtures.mjs';

const RUN_ID = 'codex-scorecard-test';

/** A fake id in a UUID's shape; `prefix` says what kind of thing it names. */
const fakeId = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SESSION = (n) => fakeId('0a0a0a0a', n);
const TURN = (n) => fakeId('0b0b0b0b', n);
const CALL = (n) => `exec-${fakeId('0c0c0c0c', n)}`;
const AGENT = fakeId('0f0f0f0f', 1);

// ---------------------------------------------------------------------------
// What the fake Mubit knows
// ---------------------------------------------------------------------------

const R1 = fakeId('0d0d0d0d', 1);
const R2 = fakeId('0d0d0d0d', 2);
const S1 = fakeId('0d0d0d0d', 3);
const S2 = fakeId('0d0d0d0d', 4);
const FACT = fakeId('0d0d0d0d', 5);
const STANDING = fakeId('0d0d0d0d', 6);

const R1_TITLE = 'Run vitest with --pool=forks…';
const S1_TITLE = 'Run migrations before seeding the database…';
const STANDING_TITLE = 'Use pnpm workspaces in this repo…';

/** What recall answers a question about the test runner: two lessons. */
const RUNNER = [
  evidence({ id: 'e-r1', reference_id: R1, entry_type: 'lesson', score: 0.9,
    content: 'Run vitest with --pool=forks; the threads pool hangs on the native module.' }),
  evidence({ id: 'e-r2', reference_id: R2, entry_type: 'lesson', score: 0.8,
    content: 'Set the CI job timeout to 20 minutes; the macOS runners queue for a long time.' }),
];

/** What recall answers a question about seeding: two other lessons. */
const SEEDING = [
  evidence({ id: 'e-s1', reference_id: S1, entry_type: 'lesson', score: 0.9,
    content: 'Run migrations before seeding the database; seeds assume the schema exists.' }),
  evidence({ id: 'e-s2', reference_id: S2, entry_type: 'lesson', score: 0.8,
    content: 'Load the fixtures with the dev profile; the prod profile refuses fake users.' }),
];

/** What recall answers a question about postgres: a fact, and no lesson at all. */
const FACT_ONLY = [
  evidence({ id: 'e-f', reference_id: FACT, entry_type: 'fact', score: 0.7,
    content: 'Postgres listens on 5433 in the dev compose file.' }),
];

/** @param {any} query */
function recallFor(query) {
  const q = String(query ?? '').toLowerCase();
  if (q.includes('postgres')) return FACT_ONLY;
  if (q.includes('seed')) return SEEDING;
  return RUNNER;
}

/** The activity feed session-start reads its standing lessons from. */
function activityFeed(standing) {
  return {
    entries: standing ? [{
      id: STANDING,
      created_at: '2026-09-01T00:00:00Z',
      entry_type: 'lesson',
      run_id: 'codex-some-other-run',
      content: 'Use pnpm workspaces in this repo; npm hoisting breaks the workspace links.',
      source: 'reflection:codex-some-other-run',
      metadata_json: JSON.stringify({ scope: 'global', lesson_type: 'rule', importance: 'high' }),
    }] : [],
    next_page_token: '',
    total_visible: standing ? 1 : 0,
  };
}

// The prompts and replies. A reply "uses" a lesson when it carries enough of that lesson's own
// words and none of the other's; the prompt's words never count.
const RUNNER_PROMPT = 'why does the test runner hang on CI?';
const SEED_PROMPT = 'how should I seed the database for local dev?';
const CORRECTION = "no, that's wrong — the runner still hangs";
const USES_R1 = 'Use vitest with --pool=forks: the threads pool hangs on the native module.';
const USES_S1 = 'Run the migrations first so the schema exists, then run the seeding script.';
const USES_STANDING = 'Use pnpm with a workspace so hoisting stays predictable.';
const USES_NOTHING = 'Let me look at the CI logs again.';

// ---------------------------------------------------------------------------
// The harness: one Codex session, driven hook by hook
// ---------------------------------------------------------------------------

const SCRATCH = tempDir('mubit-codex-card-');
const SPY = join(SCRATCH, 'spawn-spy.cjs');
writeFileSync(SPY, `const fs = require('node:fs');
const out = process.env.MUBIT_TEST_SPY_FILE;
if (out) { try { fs.appendFileSync(out, JSON.stringify({ argv: process.argv.slice(1) }) + '\\n'); } catch {} }
`);
let spies = 0;
let scripts = 0;

/**
 * One data dir, one fake Mubit, one environment — shared by every session in a case.
 *
 * `score` is required on purpose: it is the setting under test, and Codex defaults it off.
 * Detached drains stand down on a held lock unless `drains` is set, so nothing dials after
 * the case is over; the correction case needs its drain to run.
 *
 * @param {import('node:test').TestContext} t
 * @param {{score: 'full'|'compact'|'off', standing?: boolean, drains?: boolean,
 *          extra?: Record<string, string>}} o
 */
async function scenario(t, o) {
  const server = await fakeMubit({
    'POST /v2/control/query': (req) => ({ json: queryResponse({ evidence: recallFor(req.body?.query) }) }),
    'POST /v2/control/activity': { json: activityFeed(!!o.standing) },
  });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();
  const rollouts = tempDir('mubit-codex-sessions-');
  if (!o.drains) {
    mkdirSync(join(dataDir, 'runs', RUN_ID), { recursive: true });
    writeFileSync(join(dataDir, 'runs', RUN_ID, 'drain.lock'), JSON.stringify({ pid: process.pid, ts: Date.now() }));
  }
  const spy = join(SCRATCH, `spy-${++spies}.jsonl`);
  const env = baseEnv({
    dataDir, projectDir, endpoint: server.url,
    extra: {
      MUBIT_CC_RUN_STRATEGY: 'static',
      MUBIT_CC_RUN_ID: RUN_ID,
      MUBIT_CC_SESSION_SCORE: o.score,
      MUBIT_CC_OUTCOME_REVIEW: 'nudge',
      // Recall against a local fake answers in milliseconds; the headroom is for a loaded
      // runner, where a recall that timed out would show no lessons and no card.
      MUBIT_CC_RECALL_BUDGET_MS: '2400',
      NODE_OPTIONS: `--require ${SPY}`,
      MUBIT_TEST_SPY_FILE: spy,
      ...(o.extra ?? {}),
    },
  });
  const ctx = { server, dataDir, projectDir, rollouts, env, spy };
  return { ...ctx, session: (/** @type {number} */ n) => codexSession(ctx, SESSION(n)) };
}

/**
 * A Codex session: the payloads the host sends, the rollout it writes as the turn goes, and
 * the hooks it runs for each event. Every payload is checked against the host's recording of
 * that event before it is sent, so nothing here is a shape Codex never sent.
 *
 * @param {{dataDir: string, projectDir: string, rollouts: string, env: Record<string, string>}} ctx
 * @param {string} sessionId
 */
function codexSession(ctx, sessionId) {
  const transcript = join(ctx.rollouts, `rollout-2026-09-28T10-00-00-${sessionId}.jsonl`);
  /** @type {any[]} */
  const entries = [];
  const flush = () => writeFileSync(transcript, rolloutJsonl(entries, { complete: false, sessionId }));
  flush();
  const at = { session_id: sessionId, transcript_path: transcript, cwd: ctx.projectDir };
  const run = (name, payload, args = []) => runHook(name, payload, { env: ctx.env, args });

  /** UserPromptSubmit: both registered handlers, together, as the host runs them. */
  async function prompt(turnId, text, build = promptPayload) {
    const payload = build({ ...at, turn_id: turnId, prompt: text });
    assertValid(payload, 'user-prompt-submit.command.input', 'the UserPromptSubmit payload');
    entries.push({ role: 'user', text });
    flush();
    const [staged, recalled] = await Promise.all([run('stage-prompt', payload), run('prompt-recall', payload)]);
    assertHookContract(staged);
    assertHookContract(recalled);
    return { staged, recalled };
  }

  return {
    id: sessionId,
    rows: () => logRows(ctx.dataDir, sessionId),

    /** SessionStart. `source` is `startup` for a launch or `/new`, `clear` for `/clear`. */
    async start(source = 'startup') {
      const payload = sessionStartPayload({ ...at, source });
      assertValid(payload, 'session-start.command.input', 'the SessionStart payload');
      const r = await run('session-start', payload);
      assertHookContract(r);
      return r;
    },

    prompt,

    /** A message typed while the turn is running: the same `turn_id`, nothing else to mark it. */
    queued(turnId, text) {
      return prompt(turnId, text, queuedPayload);
    },

    /**
     * One shell command, the 0.154 way. The model's `exec` script goes into the rollout, then
     * the `item_completed` record(s) the host writes as the command finishes, and only then
     * does `PostToolUse` fire — carrying the output string and no outcome at all.
     *
     * `recorded` is what the rollout holds for this step (default: this call, with
     * `exitCode`); `transcript` points the payload somewhere else; `agent` makes it a
     * subagent's call, which writes to its own rollout and not to this one.
     *
     * @param {string} turnId
     * @param {{call: string, command: string, exitCode?: number, output?: string,
     *          recorded?: {call: string, exitCode: number, command?: string}[],
     *          transcript?: string, agent?: Record<string, string>}} c
     */
    async tool(turnId, c) {
      const script = `call_${fakeId('0e0e0e0e', ++scripts)}`;
      if (!c.agent) {
        entries.push({ line: rolloutExecScript({ callId: script, script: `await tools.exec_command({cmd: ${JSON.stringify(c.command)}})` }) });
        for (const rec of c.recorded ?? [{ call: c.call, exitCode: c.exitCode ?? 0 }]) {
          entries.push({ line: rolloutCommandCompleted({
            toolUseId: rec.call, cmd: rec.command ?? c.command, exitCode: rec.exitCode,
            stdout: c.output ?? '', turnId, threadId: sessionId,
          }) });
        }
        flush();
      }
      const payload = toolPayload({
        ...at, turn_id: turnId, tool_name: 'Bash', tool_input: { command: c.command },
        tool_response: c.output ?? '', tool_use_id: c.call,
        ...(c.transcript ? { transcript_path: c.transcript } : {}),
        ...(c.agent ?? {}),
      });
      // A subagent's tool call has no recording to hold it to; the issue names `agent_id` as
      // what marks one.
      if (!c.agent) assertValid(payload, 'post-tool-use.command.input', 'the PostToolUse payload');
      const r = await run('capture', payload);
      assertHookContract(r);
      assertOutputAccepted('PostToolUse', r.json, 'capture');
      if (!c.agent) {
        entries.push({ line: rolloutExecScriptOutput({ callId: script }) });
        flush();
      }
      return r;
    },

    /** Stop, or — with `stopContinuation` — the Stop after some hook blocked the first one. */
    async stop(turnId, reply, build = stopPayload) {
      entries.push({ role: 'assistant', text: reply });
      flush();
      const payload = build({ ...at, turn_id: turnId, last_assistant_message: reply });
      assertValid(payload, 'stop.command.input', 'the Stop payload');
      return run('capture', payload, ['--stop']);
    },

    /** SubagentStop, which Codex sends under the parent's `turn_id`. */
    async subagentStop(turnId, over) {
      const payload = subagentStopPayload({ ...at, turn_id: turnId, ...over });
      assertValid(payload, 'subagent-stop.command.input', 'the SubagentStop payload');
      return run('capture', payload, ['--subagent']);
    },
  };
}

// ---------------------------------------------------------------------------
// Reading what the hooks left behind
// ---------------------------------------------------------------------------

/** @param {string} dataDir @param {string} sessionId */
const logPath = (dataDir, sessionId) => join(dataDir, 'scorecard', `${sessionId}.jsonl`);

/** @param {string} dataDir @param {string} sessionId @returns {Record<string, any>[]} */
function logRows(dataDir, sessionId) {
  const p = logPath(dataDir, sessionId);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** The tool rows, as `[intent, failed]`. */
const toolRows = (rows) => rows.filter((r) => r.kind === 'tool').map((r) => [r.intent, r.failed]);

/** @param {string} dataDir @param {string} turnId */
const turnFile = (dataDir, turnId) => JSON.parse(readFileSync(join(dataDir, 'runs', RUN_ID, 'turns', `${turnId}.json`), 'utf8'));

/** The card's first line, with the token figure read off the log the hooks wrote. */
function head(rows, lessonPrompts, prompts) {
  const n = rows.filter((r) => r.kind === 'start' || r.kind === 'shown')
    .reduce((sum, r) => sum + (Number(r.tokens) || 0), 0);
  const tok = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  return `mubit · this session · lessons on ${lessonPrompts} of ${prompts} ${prompts === 1 ? 'prompt' : 'prompts'}`
    + ` · memory added ${tok} tok`;
}

/** Detached `drain` processes, by the argv they were started with. */
function drains(spy) {
  if (!existsSync(spy)) return [];
  return readFileSync(spy, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((l) => basename(String(l.argv?.[0] ?? '')) === 'drain.mjs');
}
const corrections = (spy) => drains(spy).filter((d) => d.argv.includes('--correct'));
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The Codex output contract for Stop
// ---------------------------------------------------------------------------

/** Every key a recorded session saw the host take in a Stop output. */
const STOP_TAKES = new Set((outputAcceptance().probes ?? [])
  .filter((p) => p.verdict?.Stop === 'accepted')
  .flatMap((p) => Object.keys(p.output ?? {})));

/** @param {any} r @param {string} what */
function assertStopTaken(r, what) {
  assertHookContract(r);
  assert.ok(r.json && typeof r.json === 'object' && !Array.isArray(r.json),
    `${what} must answer Stop with a JSON object; Codex fails the hook on anything else. Got: ${r.stdout}`);
  assertOutputAccepted('Stop', r.json, what);
  const unseen = Object.keys(r.json).filter((k) => !STOP_TAKES.has(k));
  assert.deepEqual(unseen, [],
    `${what} answered Stop with keys no recorded Codex session has taken on Stop `
    + `(${[...STOP_TAKES].join(', ')}), so nothing says the host shows the card rather than failing the hook.`);
}

/** @param {any} r @param {string[]} lines @param {string} why */
function assertCard(r, lines, why) {
  assertStopTaken(r, 'capture --stop');
  assert.equal(r.json.decision, undefined,
    `the card must never block the Stop: under nudge nothing here asks the model to continue. Got: ${r.stdout}`);
  assert.equal(r.json.systemMessage, lines.join('\n'), why);
}

/** @param {any} r @param {string} why */
function assertNoCard(r, why) {
  assertStopTaken(r, 'capture --stop');
  assert.deepEqual(r.json, { suppressOutput: true }, why);
}

// ===========================================================================
// The card
// ===========================================================================

test('the card: a turn whose reply uses one lesson prints the exact full card, keyed by turn_id', async (t) => {
  const ctx = await scenario(t, { score: 'full' });
  const s = ctx.session(1);
  await s.start();
  await s.prompt(TURN(1), RUNNER_PROMPT);
  await s.tool(TURN(1), { call: CALL(1), command: 'npm test', output: 'Test Files  12 passed (12)\n' });
  const r = await s.stop(TURN(1), USES_R1);

  const rows = s.rows();
  assertCard(r, [
    head(rows, 1, 1),
    '  2 lessons shown',
    '  ├ 1 used      1 waiting on your reply',
    '  └ 1 not used',
    `  this turn: used "${R1_TITLE}"`,
  ], 'the Stop output\'s systemMessage is the card Claude Code prints for the same turn. Anything '
    + 'else is a Codex user reading a different account of the same session.');

  assert.deepEqual(rows.map((x) => x.kind).sort(), ['prompt', 'shown', 'start', 'tool', 'turn'],
    'one row of each kind for one turn with one tool call — a missing row is a card built on a gap.');
  for (const row of rows.filter((x) => x.kind !== 'start')) {
    assert.equal(row.prompt_id, TURN(1),
      `a ${row.kind} row was filed under ${JSON.stringify(row.prompt_id)}, not the turn_id. Codex `
      + 'sends no prompt_id, so a row keyed by anything else never meets the rest of its turn.');
  }
});

test('the card: in compact mode the same turn prints the exact one line', async (t) => {
  const ctx = await scenario(t, { score: 'compact' });
  const s = ctx.session(1);
  await s.start();
  await s.prompt(TURN(1), RUNNER_PROMPT);
  await s.tool(TURN(1), { call: CALL(1), command: 'npm test', output: 'Test Files  12 passed (12)\n' });
  const r = await s.stop(TURN(1), USES_R1);

  const tokens = head(s.rows(), 1, 1).split(' · ').at(-1);
  assertCard(r, [
    `mubit · this session · lessons on 1 of 1 prompt · 1 of 2 lessons used · 1 waiting · ${tokens}`,
  ], 'compact is one line, and it is the same one Claude Code prints.');
});

// ===========================================================================
// Tool failures, which Codex writes only to the rollout
// ===========================================================================

test('a tool failure known only from the rollout fails the lesson the reply used', async (t) => {
  const ctx = await scenario(t, { score: 'full' });
  const s = ctx.session(1);
  await s.start();
  await s.prompt(TURN(1), RUNNER_PROMPT);
  // The payload says only what the command printed. The rollout's `item_completed` says it
  // exited 1, under this call's tool_use_id.
  await s.tool(TURN(1), { call: CALL(1), command: 'npm test', exitCode: 1, output: 'FAIL  src/runner.test.ts\n' });
  const r = await s.stop(TURN(1), USES_R1);

  const rows = s.rows();
  assert.deepEqual(toolRows(rows), [['exec', true]],
    'the rollout recorded status "failed" for this exact tool_use_id and the tool row says it '
    + 'succeeded. Codex has no PostToolUseFailure, so the rollout is the only place the failure exists.');
  assertCard(r, [
    head(rows, 1, 1),
    '  2 lessons shown',
    '  ├ 1 used      1 failed',
    '  └ 1 not used',
    `  this turn: used "${R1_TITLE}"`,
    `  review: "${R1_TITLE}" failed on prompt 1`,
  ], 'a used lesson whose turn ended on a failed command is a failed lesson; the card said otherwise.');
  const turn = turnFile(ctx.dataDir, TURN(1));
  assert.equal(turn.outcome, 'failure', 'the turn the card fails must be the turn the outcome fails.');
  assert.equal(turn.failure_reason, 'tool_failure',
    'the turn file must say why it failed, or the drain posts the failure without its reason.');
});

test('the last acting command decides: a later failure fails the turn, a later success clears it', async (t) => {
  const ctx = await scenario(t, { score: 'full' });

  // Two acting commands, and only the last one failed; a search that finds nothing after it
  // neither rescues the turn nor fails it again.
  const a = ctx.session(1);
  await a.start();
  await a.prompt(TURN(1), RUNNER_PROMPT);
  await a.tool(TURN(1), { call: CALL(1), command: 'npm ci', output: 'added 812 packages\n' });
  await a.tool(TURN(1), { call: CALL(2), command: 'npm test', exitCode: 1, output: 'FAIL  src/runner.test.ts\n' });
  await a.tool(TURN(1), { call: CALL(3), command: 'rg -n "pool=forks" src', exitCode: 1 });
  const ra = await a.stop(TURN(1), USES_R1);
  assert.deepEqual(toolRows(a.rows()), [['exec', false], ['exec', true], ['search', true]],
    'each command\'s own rollout record, joined by its own tool_use_id, decides its row.');
  assertCard(ra, [
    head(a.rows(), 1, 1),
    '  2 lessons shown',
    '  ├ 1 used      1 failed',
    '  └ 1 not used',
    `  this turn: used "${R1_TITLE}"`,
    `  review: "${R1_TITLE}" failed on prompt 1`,
  ], 'the last command that acted failed, so the turn failed; the search after it only read.');

  // The same failure, then a rerun that passed: the turn's last word is the rerun.
  const b = ctx.session(2);
  await b.start();
  await b.prompt(TURN(2), RUNNER_PROMPT);
  await b.tool(TURN(2), { call: CALL(4), command: 'npm test', exitCode: 1, output: 'FAIL  src/runner.test.ts\n' });
  await b.tool(TURN(2), { call: CALL(5), command: 'npm test -- --pool=forks', output: 'Test Files  12 passed (12)\n' });
  const rb = await b.stop(TURN(2), USES_R1);
  assert.deepEqual(toolRows(b.rows()), [['exec', true], ['exec', false]],
    'the rerun\'s own record says it passed; its row must say so, or the fix reads as a second failure.');
  assertCard(rb, [
    head(b.rows(), 1, 1),
    '  2 lessons shown',
    '  ├ 1 used      1 waiting on your reply',
    '  └ 1 not used',
    `  this turn: used "${R1_TITLE}"`,
  ], 'a failure the turn went on to fix is not how the turn ended; the lesson must not be failed for it.');
});

test('a failing read-only command, such as a search with no match, is not a failure', async (t) => {
  const ctx = await scenario(t, { score: 'full' });
  const s = ctx.session(1);
  await s.start();
  await s.prompt(TURN(1), RUNNER_PROMPT);
  // Both exit 1 because they found nothing — which the rollout records as "failed".
  await s.tool(TURN(1), { call: CALL(1), command: 'rg -n "pool=forks" vitest.config.ts', exitCode: 1 });
  await s.tool(TURN(1), { call: CALL(2), command: 'grep -rn threads src', exitCode: 1 });
  const r = await s.stop(TURN(1), USES_R1);

  const rows = s.rows();
  assert.deepEqual(toolRows(rows), [['search', true], ['search', true]],
    'the rows keep what the host said; the card is what must not count it.');
  assertCard(r, [
    head(rows, 1, 1),
    '  2 lessons shown',
    '  ├ 1 used      1 waiting on your reply',
    '  └ 1 not used',
    `  this turn: used "${R1_TITLE}"`,
  ], 'a grep that matched nothing changed nothing, and failing a lesson for it is a false failure.');
});

test('only this call\'s own rollout record counts, and no readable rollout is no verdict', async (t) => {
  const ctx = await scenario(t, { score: 'full' });
  const waiting = (rows) => [
    head(rows, 1, 1),
    '  2 lessons shown',
    '  ├ 1 used      1 waiting on your reply',
    '  └ 1 not used',
    `  this turn: used "${R1_TITLE}"`,
  ];

  // A failed record for a different tool_use_id, and a completed one for this call.
  const other = ctx.session(1);
  await other.start();
  await other.prompt(TURN(1), RUNNER_PROMPT);
  await other.tool(TURN(1), {
    call: CALL(1), command: 'npm test', output: 'Test Files  12 passed (12)\n',
    recorded: [{ call: CALL(9), exitCode: 2, command: 'npm run lint' }, { call: CALL(1), exitCode: 0 }],
  });
  const r1 = await other.stop(TURN(1), USES_R1);
  assert.deepEqual(toolRows(other.rows()), [['exec', false]],
    'a failure belonging to another call was read onto this one. The join is on tool_use_id and must be exact.');
  assertCard(r1, waiting(other.rows()), 'another call\'s failure failed this turn\'s lesson.');

  // The payload names a rollout that is not there.
  const missing = ctx.session(2);
  await missing.start();
  await missing.prompt(TURN(2), RUNNER_PROMPT);
  await missing.tool(TURN(2), {
    call: CALL(2), command: 'npm test', exitCode: 1, output: 'FAIL  src/runner.test.ts\n',
    transcript: join(ctx.rollouts, 'rollout-2026-09-28T10-00-00-gone.jsonl'),
  });
  const r2 = await missing.stop(TURN(2), USES_R1);
  assert.deepEqual(toolRows(missing.rows()), [['exec', false]],
    'with no rollout to read, the plugin must not invent a verdict in either direction.');
  assertCard(r2, waiting(missing.rows()), 'a missing rollout must leave the card exactly as silence would.');

  // The payload names something that cannot be read as a file.
  const unreadable = ctx.session(3);
  await unreadable.start();
  await unreadable.prompt(TURN(3), RUNNER_PROMPT);
  const tool = await unreadable.tool(TURN(3), {
    call: CALL(3), command: 'npm test', exitCode: 1, output: 'FAIL  src/runner.test.ts\n',
    transcript: ctx.rollouts,
  });
  assert.equal(tool.code, 0, 'an unreadable rollout must cost the verdict, never the hook.');
  const r3 = await unreadable.stop(TURN(3), USES_R1);
  assert.deepEqual(toolRows(unreadable.rows()), [['exec', false]],
    'with no rollout it can read, the plugin must not invent a verdict in either direction.');
  assertCard(r3, waiting(unreadable.rows()), 'an unreadable rollout must leave the card exactly as silence would.');
});

// ===========================================================================
// Corrections
// ===========================================================================

test('a correction on the next prompt fails the lesson and posts the correction for that turn\'s used entries only', async (t) => {
  const ctx = await scenario(t, { score: 'full', drains: true });
  const s = ctx.session(1);
  await s.start();
  await s.prompt(TURN(1), RUNNER_PROMPT);
  await s.stop(TURN(1), USES_R1);

  await s.prompt(TURN(2), CORRECTION);
  const prompts = s.rows().filter((r) => r.kind === 'prompt');
  assert.deepEqual(prompts.map((r) => [r.prompt_id, r.correction]), [[TURN(1), false], [TURN(2), true]],
    'the second prompt corrects the first turn, which used a lesson.');

  // The detached correction pass, named for the turn it corrects and the run it lives in.
  const key = `cc-correction-${RUN_ID}-${TURN(1)}`;
  const post = await waitFor(
    () => ctx.server.calls('POST', '/v2/control/outcome').find((c) => c.body?.idempotency_key === key), 10_000,
  ).catch(() => null);
  assert.ok(post, `no correction was posted for ${TURN(1)}; the server saw: ${ctx.server.summary()}; `
    + `drains spawned: ${JSON.stringify(drains(ctx.spy).map((d) => d.argv.slice(1)))}`);
  assert.equal(post.body.outcome, 'failure', 'a correction that is not posted as a failure reinforces the lesson the user just rejected.');
  assert.deepEqual(post.body.entry_ids, [R1],
    'the correction must name the entries the corrected reply used — R1 — and nothing it merely '
    + 'showed. R2 was in front of the model and unused; failing it punishes a lesson that played no part.');
  const pass = corrections(ctx.spy);
  assert.equal(pass.length, 1, `exactly one correction pass: ${JSON.stringify(pass.map((d) => d.argv.slice(1)))}`);
  assert.equal(pass[0].argv[pass[0].argv.indexOf('--correct') + 1], TURN(1),
    'the pass must be told the corrected turn by its turn_id.');
  assert.equal(pass[0].argv[pass[0].argv.indexOf('--run') + 1], RUN_ID,
    'the pass must be told the run the corrected turn lives in, or it looks for the turn file in the wrong place.');

  const r = await s.stop(TURN(2), USES_NOTHING);
  const rows = s.rows();
  assertCard(r, [
    head(rows, 2, 2),
    '  2 lessons shown',
    '  ├ 1 used      1 failed',
    '  └ 1 not used',
    '  this turn: shown 2, none used',
    `  review: "${R1_TITLE}" failed on prompt 1`,
  ], 'the card fails exactly the lesson the correction was posted against.');
});

test('a slash command or a $skill prompt never counts as a correction', async (t) => {
  const ctx = await scenario(t, { score: 'full' });
  const { foldScorecard } = await lib('scorecard.mjs');
  const cases = [
    ['a slash command', "/review that's wrong — look at the runner again"],
    ['a namespaced $skill', "$mubit-memory:recall that's wrong — what do we know about the runner hang?"],
    ['a bare $skill', "$recall no, that's wrong, the runner still hangs"],
  ];

  // Each in a session of its own, after a turn that used a lesson; every verdict is collected
  // before any is asserted, so one failure does not hide the others.
  const got = [];
  let n = 0;
  for (const [what, text] of cases) {
    n++;
    const s = ctx.session(n);
    await s.start();
    await s.prompt(TURN(10 * n + 1), RUNNER_PROMPT);
    await s.stop(TURN(10 * n + 1), USES_R1);
    await s.prompt(TURN(10 * n + 2), text);

    const row = s.rows().find((r) => r.kind === 'prompt' && r.prompt_id === TURN(10 * n + 2));
    const summary = foldScorecard(s.rows(), TURN(10 * n + 1));
    got.push({ what, correction: row?.correction ?? 'no prompt row', failed: summary.lessons.failed });
  }
  await settle();
  const spawned = corrections(ctx.spy).map((d) => d.argv[d.argv.indexOf('--correct') + 1]);

  assert.deepEqual(got, cases.map(([what]) => ({ what, correction: false, failed: 0 })),
    'a prompt addressed to the harness (`/…`) or to a skill (`$…`) was recorded as a correction '
    + 'of the turn before it, and that turn\'s lesson counted as failed. Neither is a verdict on '
    + 'the reply, however it is worded.');
  assert.deepEqual(spawned, [],
    'a correction pass was started for the turn before a slash or $skill prompt — it posts a '
    + 'failure against a lesson that helped.');
});

// ===========================================================================
// The host's flow
// ===========================================================================

test('a message typed mid-turn joins the running turn: no new prompt, and never a correction', async (t) => {
  const ctx = await scenario(t, { score: 'full' });
  const s = ctx.session(1);
  await s.start();
  await s.prompt(TURN(1), RUNNER_PROMPT);
  await s.stop(TURN(1), USES_R1);

  await s.prompt(TURN(2), SEED_PROMPT);
  await s.tool(TURN(2), { call: CALL(1), command: 'npm run db:migrate', output: 'migrated 4 files\n' });
  // Codex fires UserPromptSubmit again with the running turn_id; the turn gets one Stop.
  await s.queued(TURN(2), "no, that's wrong — seed it with the dev profile instead");
  const r = await s.stop(TURN(2), USES_S1);

  const rows = s.rows();
  assert.deepEqual(rows.filter((x) => x.kind === 'prompt').map((x) => [x.prompt_id, x.correction]),
    [[TURN(1), false], [TURN(2), false]],
    'the queued message is part of the running turn: a second prompt row inflates the prompt '
    + 'count, and a correction fails the previous turn\'s lesson for a message about this one.');
  await settle();
  assert.deepEqual(corrections(ctx.spy).map((d) => d.argv.slice(1)), [],
    'the queued message started a correction pass against the turn before it.');
  assertCard(r, [
    head(rows, 2, 2),
    '  4 lessons shown',
    '  ├ 2 used      1 worked · 1 waiting on your reply',
    '  └ 2 not used',
    `  this turn: used "${S1_TITLE}"`,
  ], 'two prompts, not three; the first turn\'s lesson worked, and nothing failed.');
});

test('an interrupted turn has no Stop: its lessons are unknown, and a correction next faults nothing', async (t) => {
  const hooks = JSON.parse(readFileSync(join(CODEX_ROOT, 'hooks.json'), 'utf8')).hooks;
  assert.ok(!('Interrupt' in hooks),
    'this case assumes the plugin does not register Interrupt; if it now does, drive it here.');

  const ctx = await scenario(t, { score: 'full' });
  const s = ctx.session(1);
  await s.start();
  await s.prompt(TURN(1), RUNNER_PROMPT);
  await s.stop(TURN(1), USES_R1);

  await s.prompt(TURN(2), 'and why is the seeding script failing locally?');
  await s.tool(TURN(2), { call: CALL(1), command: 'cat package.json', output: '{ "name": "app" }\n' });
  // Esc. Codex fires Interrupt, which reaches no hook of this plugin, and no Stop.

  await s.prompt(TURN(3), "no, that's wrong — stop and just list the migrations folder");
  const rows = s.rows();
  assert.equal(rows.find((x) => x.kind === 'prompt' && x.prompt_id === TURN(3))?.correction, false,
    'the prompt after an interrupt followed a turn that never answered; there is no reply to correct.');
  const r = await s.stop(TURN(3), 'Listing the migrations folder now.');
  await settle();
  assert.deepEqual(corrections(ctx.spy).map((d) => d.argv.slice(1)), [],
    'a correction pass was started for a turn the correction did not follow.');

  assertCard(r, [
    head(s.rows(), 3, 3),
    '  4 lessons shown',
    '  ├ 1 used      1 worked',
    '  ├ 1 not used',
    '  └ 2 unknown',
    '  this turn: shown 2, none used',
  ], 'the interrupted turn\'s two lessons were never measured — unknown, not unused — and the turn '
    + 'before it still worked.');
});

test('/clear is a SessionStart with source "clear", and no correction crosses it', async (t) => {
  const ctx = await scenario(t, { score: 'full' });
  const s = ctx.session(1);
  await s.start();
  await s.prompt(TURN(1), RUNNER_PROMPT);
  await s.stop(TURN(1), USES_R1);

  await s.start('clear');
  await s.prompt(TURN(2), CORRECTION);
  const rows = s.rows();
  assert.deepEqual(rows.filter((x) => x.kind === 'start').map((x) => x.source), ['startup', 'clear'],
    'the clear is logged as its own session start; without it nothing in the log marks where the conversation was cleared.');
  assert.equal(rows.find((x) => x.kind === 'prompt' && x.prompt_id === TURN(2))?.correction, false,
    'the user cleared the conversation; what they type next is about the new one.');
  const r = await s.stop(TURN(2), USES_NOTHING);
  await settle();
  assert.deepEqual(corrections(ctx.spy).map((d) => d.argv.slice(1)), [],
    'a correction pass was started across a /clear.');

  assertCard(r, [
    head(s.rows(), 2, 2),
    '  2 lessons shown',
    '  ├ 1 used      1 worked',
    '  └ 1 not used',
    '  this turn: shown 2, none used',
  ], 'the session\'s card runs on across /clear, and the lesson used before it worked.');
});

test('/new starts a new session id, which gets a fresh card', async (t) => {
  const ctx = await scenario(t, { score: 'full' });
  const a = ctx.session(1);
  await a.start();
  await a.prompt(TURN(1), RUNNER_PROMPT);
  await a.stop(TURN(1), USES_R1);
  const before = a.rows();

  const b = ctx.session(2);
  await b.start('startup');
  await b.prompt(TURN(2), CORRECTION);
  const r = await b.stop(TURN(2), USES_R1);

  const rows = b.rows();
  assert.equal(rows.find((x) => x.kind === 'prompt')?.correction, false,
    'the first prompt of a new session follows nothing in it.');
  const shown = rows.find((x) => x.kind === 'shown');
  assert.deepEqual(Object.values(shown?.lessons ?? {}).map((l) => l.pointer), [false, false],
    'a new session has seen nothing, so its lessons are rendered in full, not as "(seen earlier)".');
  assertCard(r, [
    head(rows, 1, 1),
    '  2 lessons shown',
    '  ├ 1 used      1 waiting on your reply',
    '  └ 1 not used',
    `  this turn: used "${R1_TITLE}"`,
  ], 'the new session\'s card counts the new session only.');

  await settle();
  assert.deepEqual(corrections(ctx.spy).map((d) => d.argv.slice(1)), [],
    'a correction pass was started across /new, against a turn in another session.');
  assert.deepEqual(a.rows(), before, 'the new session wrote into the old session\'s log.');
});

test('SessionStart fires just before the first prompt, and its standing lesson still counts on turn 1', async (t) => {
  const ctx = await scenario(t, { score: 'full', standing: true });
  const s = ctx.session(1);
  // No gap between the two events: Codex runs SessionStart as the first prompt is submitted.
  await s.start();
  await s.prompt(TURN(1), RUNNER_PROMPT);
  const r = await s.stop(TURN(1), USES_STANDING);

  const rows = s.rows();
  assert.deepEqual(Object.keys(rows.find((x) => x.kind === 'start')?.lessons ?? {}), [STANDING],
    'the session start must log the standing lesson it showed, or no turn can count it as shown.');
  assert.ok(rows.findIndex((x) => x.kind === 'start') < rows.findIndex((x) => x.kind === 'prompt'),
    'the start row must precede the first prompt\'s, or the standing lessons attach to the prompt after it.');
  assert.equal(rows.find((x) => x.kind === 'turn')?.lessons?.[STANDING]?.used, true,
    'the reply used the standing lesson and the turn row does not say so.');
  assertCard(r, [
    head(rows, 1, 1),
    '  3 lessons shown',
    '  ├ 1 used      1 waiting on your reply',
    '  └ 2 not used',
    `  this turn: used "${STANDING_TITLE}"`,
  ], 'the standing lesson was shown at session start and used on turn 1; the card must count it.');
});

// ===========================================================================
// No card
// ===========================================================================

test('no card on a turn that showed no lesson', async (t) => {
  const ctx = await scenario(t, { score: 'full' });
  const s = ctx.session(1);
  await s.start();
  await s.prompt(TURN(1), RUNNER_PROMPT);
  assertCard(await s.stop(TURN(1), USES_R1), [
    head(s.rows(), 1, 1),
    '  2 lessons shown',
    '  ├ 1 used      1 waiting on your reply',
    '  └ 1 not used',
    `  this turn: used "${R1_TITLE}"`,
  ], 'the turn that did show lessons prints its card.');

  // Too short to recall against.
  await s.prompt(TURN(2), 'thanks');
  assertNoCard(await s.stop(TURN(2), 'You are welcome.'),
    'a turn that showed nothing has nothing to report, and a card under it reads as noise.');

  // Recall answered, but with a fact and no lesson.
  await s.prompt(TURN(3), 'which port does postgres listen on locally?');
  assertNoCard(await s.stop(TURN(3), 'Postgres listens on 5433 in the dev compose file.'),
    'a fact is not a lesson; a turn that showed only facts gets no card.');
});

test('no card with MUBIT_CC_SESSION_SCORE=off', async (t) => {
  const ctx = await scenario(t, { score: 'off' });
  const s = ctx.session(1);
  await s.start();
  await s.prompt(TURN(1), RUNNER_PROMPT);
  await s.tool(TURN(1), { call: CALL(1), command: 'npm test', output: 'Test Files  12 passed (12)\n' });
  assertNoCard(await s.stop(TURN(1), USES_R1), 'off prints nothing, on a turn that would have had a full card.');
});

test('no card, and no session log, with capture off', async (t) => {
  const ctx = await scenario(t, { score: 'full', extra: { MUBIT_CC_CAPTURE: '0' } });
  const s = ctx.session(1);
  await s.start();
  await s.prompt(TURN(1), RUNNER_PROMPT);
  await s.tool(TURN(1), { call: CALL(1), command: 'npm test', exitCode: 1, output: 'FAIL  src/runner.test.ts\n' });
  assertNoCard(await s.stop(TURN(1), USES_R1), 'with capture off nothing is recorded, so there is nothing to score.');
  assert.equal(existsSync(logPath(ctx.dataDir, s.id)), false, 'capture off wrote a session log.');
});

// ===========================================================================
// Subagents
// ===========================================================================

test('a subagent\'s tool calls are excluded, and its SubagentStop closes no turn', async (t) => {
  const ctx = await scenario(t, { score: 'full' });
  const s = ctx.session(1);
  await s.start();
  await s.prompt(TURN(1), RUNNER_PROMPT);
  await s.tool(TURN(1), { call: CALL(1), command: 'npm test', output: 'Test Files  12 passed (12)\n' });

  // The subagent works in its own rollout, under the parent's turn, and its build fails there.
  const agentRollout = join(ctx.rollouts, `rollout-2026-09-28T10-05-00-${AGENT}.jsonl`);
  writeFileSync(agentRollout, rolloutJsonl([
    { role: 'user', text: 'Check whether the build passes.' },
    { line: rolloutCommandCompleted({ toolUseId: CALL(2), cmd: 'npm run build', exitCode: 1, turnId: TURN(1), threadId: AGENT }) },
  ], { complete: false, sessionId: AGENT }));
  await s.tool(TURN(1), {
    call: CALL(2), command: 'npm run build', exitCode: 1, output: 'error TS2307\n',
    transcript: agentRollout, agent: { agent_id: AGENT, agent_type: 'default' },
  });
  const sub = await s.subagentStop(TURN(1), {
    agent_id: AGENT, agent_transcript_path: agentRollout, last_assistant_message: 'The build fails.',
  });
  assertHookContract(sub);
  assertOutputAccepted('SubagentStop', sub.json, 'capture --subagent');
  assert.deepEqual(sub.json, { suppressOutput: true }, 'a subagent never prints a card.');
  assert.deepEqual(s.rows().filter((x) => x.kind === 'turn'), [],
    'SubagentStop carries the parent\'s turn_id; a turn row from it would close the parent\'s turn early.');

  const r = await s.stop(TURN(1), USES_R1);
  const rows = s.rows();
  assert.deepEqual(toolRows(rows), [['exec', false]],
    'the subagent\'s call became a tool row of the parent\'s turn.');
  assertCard(r, [
    head(rows, 1, 1),
    '  2 lessons shown',
    '  ├ 1 used      1 waiting on your reply',
    '  └ 1 not used',
    `  this turn: used "${R1_TITLE}"`,
  ], 'a subagent\'s failed build is not how the main agent\'s turn ended.');
});

// ===========================================================================
// Edges
// ===========================================================================

test('a turn whose lessons were shown only as "(seen earlier)" pointers still gets its card', async (t) => {
  const ctx = await scenario(t, { score: 'full' });
  const s = ctx.session(1);
  await s.start();
  await s.prompt(TURN(1), RUNNER_PROMPT);
  await s.stop(TURN(1), USES_R1);

  const { recalled } = await s.prompt(TURN(2), 'which vitest option controls the worker pool?');
  const context = String(recalled.json?.hookSpecificOutput?.additionalContext ?? '');
  assert.match(context, /\(seen earlier\)/, 'the premise: the second recall points at the first rather than repeating it.');
  const shown = s.rows().filter((x) => x.kind === 'shown').at(-1);
  assert.deepEqual(Object.values(shown?.lessons ?? {}).map((l) => l.pointer), [true, true],
    'the premise: both lessons reached this turn as pointers only.');

  const r = await s.stop(TURN(2), 'Pass --pool=forks: the threads pool hangs on the native module otherwise.');
  assertCard(r, [
    head(s.rows(), 2, 2),
    '  2 lessons shown',
    '  ├ 1 used      1 waiting on your reply',
    '  └ 1 not used',
    `  this turn: used "${R1_TITLE}"`,
  ], 'a pointer is a lesson in front of the model; a turn that showed only pointers is still a '
    + 'lesson turn, and a reply that follows one still used it.');
});

test('the Stop after another hook blocked keeps the use the first reply made', async (t) => {
  const ctx = await scenario(t, { score: 'full' });
  const s = ctx.session(1);
  await s.start();
  await s.prompt(TURN(1), RUNNER_PROMPT);
  const first = await s.stop(TURN(1), USES_R1);
  const card = [
    head(s.rows(), 1, 1),
    '  2 lessons shown',
    '  ├ 1 used      1 waiting on your reply',
    '  └ 1 not used',
    `  this turn: used "${R1_TITLE}"`,
  ];
  assertCard(first, card, 'the first Stop of the turn prints its card.');

  // Some other Stop hook blocked; the model carried on in the same turn. Codex's next Stop has
  // stop_hook_active: true and only what was said after the block (Stop.continuation.json).
  const again = await s.stop(TURN(1), 'Done: nothing else to add.', continuationPayload);
  assertCard(again, card,
    'the continuation holds only what the model said after the block, and it undid the use the '
    + 'first reply made: the card now says the lesson went unused in a turn whose answer used it.');
});
