// @ts-check
/**
 * The once-per-turn outcome review, through the Codex Stop hook.
 *
 * With `outcomeReview: stop`, `capture --stop` blocks the first Stop of a turn that showed
 * lessons, with `{"decision":"block","reason":…}`. The reason lists those lessons by the short
 * id the model was shown and asks it to credit or fault them with `mubit_outcome`, then to end
 * on one "Memory review:" line. The Stop of the continuation prints the session card, and the
 * turn's implicit outcome goes out then, minus anything the model credited itself.
 *
 * What codex-cli 0.154.0 was recorded doing with a block (`observed/payloads/Stop.continuation.json`,
 * `observed/output-acceptance.json`):
 *   - the model carries on in the **same** turn. The next Stop has `stop_hook_active: true`, the
 *     same `turn_id`, and a `last_assistant_message` holding only the continuation;
 *   - tool calls made in the continuation carry that `turn_id` too;
 *   - no `UserPromptSubmit` fires for the reason;
 *   - there is **no block cap**. The host honoured three blocks in a row, so the plugin's
 *     once-per-turn guard is the only thing standing between a review and a loop.
 *
 * The claims, each against the real Codex entry points (`hooks/src/*.mjs`, or the committed
 * bundles under `MUBIT_CC_TEST_TARGET=dist`) run as subprocesses against a fake endpoint, with
 * every payload checked against what the host was recorded sending and every Stop output
 * checked against the Codex output contract:
 *
 *   - **First Stop.** A turn that showed lessons blocks once, listing each lesson by its short
 *     id, in the only block shape the host was recorded accepting. The implicit outcome waits.
 *   - **The pending review is on disk.** Every hook is its own process, so the continuation
 *     can only know it is one from the turn file.
 *   - **Continuation Stop.** Never blocks; prints the card; use is measured on the first answer
 *     plus the continuation with its "Memory review:" line stripped; the first answer is what
 *     is stored; the review line never is.
 *   - **The loop guard.** However many Stops Codex sends for one `turn_id`, and whatever
 *     `stop_hook_active` says on them (true, false, or absent), there is exactly one block and
 *     one implicit outcome.
 *   - **A later Stop of a reviewed turn is its continuation**, whatever `stop_hook_active` says:
 *     its review line is neither measured nor stored, and the first answer's measurement stands.
 *   - **No block** when nothing was shown in full or used, when `outcomeMode` is `off`, when
 *     `outcomeReview` is `nudge` or `off`, when capture is off, or on a subagent's Stop.
 *   - **Crediting in the continuation.** `mubit_outcome` calls there settle those lessons: the
 *     implicit outcome does not credit them a second time.
 *   - **A message typed during the continuation** joins the turn and starts no second review.
 *   - **A new turn** after a reviewed one is reviewed again, once.
 *
 * `MUBIT_CC_OUTCOME_REVIEW` and `MUBIT_CC_SESSION_SCORE` are set in every case. Both have
 * Codex-specific defaults (`nudge` and `off` today), and a test that leant on them would change
 * meaning when they move.
 *
 * "Stored" means what reached the fake endpoint's ingest route, and "the implicit outcome" is
 * what reached its outcome route: the detached drains run for real here, so nothing is held
 * back and nothing is counted from local files alone.
 */

import test from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  assert, assertHookContract, assertValid, baseEnv, evidence, fakeMubit, lib, makeDataDir,
  makeProjectDir, mcpPostToolUse, observedPayload, postToolUse, queryResponse, queuedPrompt,
  runHook, stop, subagentStop, tempDir, userPromptSubmit, waitFor,
} from './helpers/codex-fixtures.mjs';

const { handleFor } = await lib('handles.mjs');
const { outcomeIdempotencyKey } = await lib('outcome.mjs');
const { markSeen } = await lib('seen.mjs');

/** Pinned, so where the turn file lives is never a derivation question. */
const RUN_ID = 'codex-review-test';
const SESSION = '0a0a0a0a-0000-4000-8000-0000000000aa';
const TURN = '0a0a0a0a-0000-4000-8000-000000000101';
const TURN_2 = '0a0a0a0a-0000-4000-8000-000000000102';

const REF_A = '0a0a0a0a-0000-4000-8000-000000000001';
const REF_B = '0b0b0b0b-0000-4000-8000-000000000002';
const REF_C = '0c0c0c0c-0000-4000-8000-000000000003';
const REF_D = '0d0d0d0d-0000-4000-8000-000000000004';

/** Four lessons whose vocabularies do not overlap, so "which one did the reply use" has one answer. */
const LESSON = {
  [REF_A]: 'Run vitest with --pool=forks; the threads pool deadlocks on the native module.',
  [REF_B]: 'Apply migrations before seeding the database, or the seed fails on missing tables.',
  [REF_C]: 'Postgres listens on port 5433 in this repository, not 5432.',
  [REF_D]: 'Pin the lockfile before bumping a dependency in the workspace.',
};

const hA = handleFor(REF_A);
const hB = handleFor(REF_B);
const hC = handleFor(REF_C);
const hD = handleFor(REF_D);

const PROMPT = 'why does the test runner hang?';
/** Uses A, and nothing of B or C. */
const ANSWER_A = 'Switch vitest to --pool=forks: the threads pool deadlocks on the native module.';
/** Uses A and C, and nothing of B. */
const ANSWER_AC = `${ANSWER_A} Postgres listens on 5433 here, so point the test config at that port.`;
/** Continuation text that uses C, and nothing of A or B. */
const BODY_C = 'Postgres listens on 5433 here, so point the test config at that port.';
/** A closing review line carrying B's vocabulary, which must never count as using B. */
const REVIEW_LINE = `Memory review: credited [${hA}]; the migrations and seeding lesson did not apply.`;

const NOT_ON_CODEX = /** @type {const} */ (['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR']);

// ---------------------------------------------------------------------------
// Watching the detached drains
// ---------------------------------------------------------------------------

/**
 * Loaded into every node process the hooks start, through `NODE_OPTIONS`, so a test can wait
 * for the detached drains to finish rather than guess. It records a start and an exit per
 * process; a drain that is still running is one with a start and no exit.
 */
const SCRATCH = tempDir('mubit-codex-review-');
const SPY = join(SCRATCH, 'drain-spy.cjs');
writeFileSync(SPY, `const fs = require('node:fs');
const out = process.env.MUBIT_TEST_SPY_FILE;
if (out) {
  const rec = (ev) => { try { fs.appendFileSync(out, JSON.stringify({ ev, pid: process.pid, argv: process.argv.slice(1) }) + '\\n'); } catch {} };
  rec('start');
  process.on('exit', () => rec('exit'));
}
`);

/** @param {string} file */
function drainRows(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => basename(String(r.argv?.[0] ?? '')) === 'drain.mjs');
}

/**
 * Wait until every drain the hooks have started has exited, and has stayed that way for a
 * moment: a drain spawned just before a hook returned may not have started yet.
 *
 * @param {Session} s
 */
async function drainsIdle(s) {
  let quietSince = 0;
  await waitFor(() => {
    const rows = drainRows(s.spy);
    const running = rows.filter((r) => r.ev === 'start').length - rows.filter((r) => r.ev === 'exit').length;
    if (running > 0) { quietSince = 0; return false; }
    if (!quietSince) quietSince = Date.now();
    return Date.now() - quietSince >= 400;
  }, 15_000);
}

// ---------------------------------------------------------------------------
// A Codex session against the fake endpoint
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Session
 * @property {any} server
 * @property {string} dataDir
 * @property {string} projectDir
 * @property {Record<string, string>} env
 * @property {string} spy
 */

/**
 * The recall answer: one lesson per reference id, in the order given.
 * @param {string[]} refs
 */
function recallOf(refs) {
  return {
    json: queryResponse({
      evidence: refs.map((ref, i) => evidence({
        id: `e${i + 1}`, reference_id: ref, entry_type: 'lesson', score: 0.9 - i / 10, content: LESSON[ref],
      })),
    }),
  };
}

/**
 * A fresh data dir, a fake endpoint that recalls `lessons`, and the environment a Codex hook
 * runs with: what setup pins into its registration, and none of the Claude Code names, which
 * `lib/boot.mjs` synthesises. The two settings under test are required, never defaulted.
 *
 * The batch trigger is held open, so the only drains are the ones a Stop spawns on purpose.
 *
 * @param {any} t
 * @param {{review: string, score: string, mode?: string, capture?: string, lessons?: string[]}} o
 * @returns {Promise<Session>}
 */
async function codexSession(t, o) {
  const server = await fakeMubit({ 'POST /v2/control/query': recallOf(o.lessons ?? [REF_A, REF_B, REF_C]) });
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();
  const spy = join(SCRATCH, `spy-${randomUUID()}.jsonl`);
  const env = baseEnv({
    dataDir, projectDir, endpoint: server.url,
    extra: {
      MUBIT_CC_RUN_STRATEGY: 'static',
      MUBIT_CC_RUN_ID: RUN_ID,
      MUBIT_CC_BATCH_MAX_ITEMS: '999',
      MUBIT_CC_BATCH_MAX_AGE_MS: '600000',
      MUBIT_CC_OUTCOME_REVIEW: o.review,
      MUBIT_CC_SESSION_SCORE: o.score,
      MUBIT_CC_OUTCOME_MODE: o.mode ?? 'implicit',
      ...(o.capture !== undefined ? { MUBIT_CC_CAPTURE: o.capture } : {}),
      NODE_OPTIONS: `--require ${SPY}`,
      MUBIT_TEST_SPY_FILE: spy,
    },
  });
  for (const k of NOT_ON_CODEX) delete env[k];
  const s = { server, dataDir, projectDir, env, spy };
  // The endpoint closes only once every drain a test started has finished with it.
  t.after(async () => {
    await drainsIdle(s).catch(() => {});
    await server.close();
  });
  return s;
}

/**
 * The `UserPromptSubmit` pair Codex runs for one typed message: `stage-prompt` and
 * `prompt-recall`, each its own process. Returns the block the model was shown.
 *
 * @param {Session} s
 * @param {string} turnId
 * @param {{queued?: boolean, text?: string}} [o]
 * @returns {Promise<string>}
 */
async function typePrompt(s, turnId, o = {}) {
  const over = { session_id: SESSION, turn_id: turnId, cwd: s.projectDir, ...(o.text ? { prompt: o.text } : {}) };
  const payload = o.queued ? queuedPrompt(over) : userPromptSubmit({ prompt: PROMPT, ...over });
  assertValid(payload, 'user-prompt-submit.command.input', 'the UserPromptSubmit fixture');
  await runHookOk(s, 'stage-prompt', payload);
  const recall = await runHookOk(s, 'prompt-recall', payload);
  return String(recall.json?.hookSpecificOutput?.additionalContext ?? '');
}

/**
 * @param {Session} s
 * @param {string} name
 * @param {Record<string, any>} payload
 * @param {string[]} [args]
 */
async function runHookOk(s, name, payload, args = []) {
  const r = await runHook(name, payload, { env: s.env, args });
  assertHookContract(r);
  return r;
}

/**
 * One Stop through `capture --stop`, as `hooks.json` registers it. The payload is held to what
 * the host was recorded sending, and the answer to what Codex accepts from a Stop hook.
 *
 * @param {Session} s
 * @param {Record<string, any>} payload
 */
async function sendStop(s, payload) {
  assertValid(payload, 'stop.command.input', 'the Stop fixture');
  const r = await runHookOk(s, 'capture', payload, ['--stop']);
  assert.ok(r.json && typeof r.json === 'object',
    `capture --stop printed no JSON object, so Codex has no answer to read:\n${r.stdout}\n${r.stderr}`);
  assertValid(r.json, 'stop.command.output', 'capture --stop');
  return r;
}

/** The Stop that ends a turn's answer. @param {Session} s @param {string} turnId @param {string} answer */
function firstStop(s, turnId, answer) {
  return sendStop(s, stop({
    session_id: SESSION, turn_id: turnId, cwd: s.projectDir,
    stop_hook_active: false, last_assistant_message: answer,
  }));
}

/**
 * The Stop after a block, built from the recording rather than from a builder: every key and
 * every value the host sent, with only the ids, the directory and the reply filled in.
 *
 * @param {Session} s
 * @param {string} turnId
 * @param {any} text  the continuation's own reply, which is all Codex sends
 * @returns {Record<string, any>}
 */
function recordedContinuation(s, turnId, text) {
  const rec = observedPayload('Stop.continuation');
  assert.ok(rec && rec.stop_hook_active === true && rec.hook_event_name === 'Stop',
    'observed/payloads/Stop.continuation.json no longer records a Stop with stop_hook_active: '
    + 'true, so nothing here is checked against what Codex sends after a block.');
  return {
    ...rec,
    session_id: SESSION,
    turn_id: turnId,
    transcript_path: stop().transcript_path,
    cwd: s.projectDir,
    last_assistant_message: text,
  };
}

/** @param {Session} s @param {string} turnId @param {any} text */
function continuationStop(s, turnId, text) {
  return sendStop(s, recordedContinuation(s, turnId, text));
}

/**
 * The model's own `mubit_outcome` call, as Codex reports it to `PostToolUse`: the plugin's MCP
 * tool under `mcp__mubit__`, the arguments verbatim, and the MCP result object.
 *
 * @param {Session} s
 * @param {string} turnId
 * @param {string[]} entryIds
 * @param {string} [outcome]
 */
async function creditByTool(s, turnId, entryIds, outcome = 'success') {
  const payload = mcpPostToolUse({
    session_id: SESSION, turn_id: turnId, cwd: s.projectDir,
    tool_input: { reference_id: 'global', outcome, entry_ids: entryIds },
    tool_use_id: `exec-${randomUUID()}`,
  });
  assertValid(payload, 'post-tool-use.command.input', 'the mubit_outcome PostToolUse fixture');
  const r = await runHookOk(s, 'capture', payload);
  if (r.json) assertValid(r.json, 'post-tool-use.command.output', 'capture on mubit_outcome');
  return r;
}

/** Every implicit outcome the drains posted for one turn. @param {Session} s @param {string} turnId */
function outcomesFor(s, turnId) {
  const key = outcomeIdempotencyKey(RUN_ID, turnId);
  return s.server.calls('POST', '/v2/control/outcome').filter((c) => c.body?.idempotency_key === key);
}

/**
 * Wait for the turn's implicit outcome to land, then for every drain to finish, so a duplicate
 * would already be on the endpoint when the caller counts.
 *
 * @param {Session} s @param {string} turnId
 */
async function settledOutcomes(s, turnId) {
  await waitFor(() => outcomesFor(s, turnId).length >= 1, 15_000).catch(() => {});
  await drainsIdle(s);
  return outcomesFor(s, turnId);
}

/** Every item that reached the ingest route. @param {Session} s */
function storedItems(s) {
  return s.server.calls('POST', '/v2/control/ingest').flatMap((c) => (Array.isArray(c.body?.items) ? c.body.items : []));
}

/**
 * The turn's Q/A items: its answer, and the answer to a message queued into it.
 * @param {Session} s @param {string} turnId
 */
function turnItems(s, turnId) {
  return storedItems(s).filter((i) => String(i.item_id ?? '').startsWith(`cc-stop-${turnId}`));
}

/** @param {Session} s @param {string} turnId */
function turnFile(s, turnId) {
  const p = join(s.dataDir, 'runs', RUN_ID, 'turns', `${turnId}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

/** The short ids a reason or a block lists, bare. @param {string} text */
function handlesIn(text) {
  return [...String(text).matchAll(/\[(m[a-z0-9]{4})\]/g)].map((m) => m[1]);
}

/** @param {any[]} list */
const sorted = (list) => [...list].sort();

/**
 * The first answer is stored once, as the turn's Q/A, and no Memory review line is stored at
 * all. Shared by every case that closes a review.
 *
 * @param {Session} s @param {string} turnId @param {string} answer
 */
function assertFirstAnswerStored(s, turnId, answer) {
  const items = turnItems(s, turnId);
  for (const it of items) {
    assert.doesNotMatch(String(it.text), /memory review/i,
      `the closing review line was stored as memory (${it.item_id}). A later recall would hand a `
      + `future session "Memory review: …" as if it were an answer:\n${it.text}`);
  }
  const main = items.filter((i) => i.item_id === `cc-stop-${turnId}`);
  assert.equal(main.length, 1,
    `the turn's Q/A was stored ${main.length} times under one id; a later Stop overwrote or `
    + `duplicated the first answer:\n${main.map((i) => i.text).join('\n---\n')}`);
  assert.ok(String(main[0].text).includes(answer),
    `the stored Q/A is not the first answer, which is the one the turn actually gave:\n${main[0].text}`);
}

// ===========================================================================
// Fixtures
// ===========================================================================

test('the fixture lessons carry four distinct short ids', () => {
  assert.equal(new Set([hA, hB, hC, hD]).size, 4,
    'two fixture lessons share a short id, so a test could pass by listing the wrong one.');
});

// ===========================================================================
// The first Stop
// ===========================================================================

test('first Stop: a turn that showed lessons blocks once, listing each by the id the model was shown', async (t) => {
  const s = await codexSession(t, { review: 'stop', score: 'full' });
  const shown = await typePrompt(s, TURN);
  assert.deepEqual(sorted(handlesIn(shown)), sorted([hA, hB, hC]),
    `prompt-recall did not show the model the three lessons this test reviews:\n${shown}`);

  const r = await firstStop(s, TURN, ANSWER_A);

  assert.equal(r.json.decision, 'block',
    `the first Stop of a turn that showed lessons did not block, so the model is never asked to `
    + `credit them:\n${JSON.stringify(r.json)}`);
  assert.equal(typeof r.json.reason, 'string');
  assert.ok(r.json.reason.trim(), 'a block without a reason is refused by Codex');
  assert.deepEqual(Object.keys(r.json).sort(), ['decision', 'reason'],
    '`{decision, reason}` is the one block shape codex-cli 0.154.0 was recorded accepting '
    + '(observed/output-acceptance.json); anything beside it is a guess about the host.');
  assert.deepEqual(sorted(handlesIn(r.json.reason)), sorted([hA, hB, hC]),
    'the reason must list every lesson shown this turn by the short id the model saw, and '
    + `nothing else, or the model credits ids that name nothing:\n${r.json.reason}`);
  assert.match(r.json.reason, /mubit_outcome/, 'the reason must name the tool that records a verdict');
  assert.match(r.json.reason, /Memory review:/,
    'the reason must ask for the closing "Memory review:" line, or the continuation ends silently');
  assert.doesNotMatch(r.json.reason, /claude/i,
    'the review reason is shared by both hosts and must not name one of them to a Codex model');

  const turn = turnFile(s, TURN);
  assert.ok(Number(turn?.review_requested_at) > 0, 'the review was asked for and not recorded on the turn');

  // The outcome waits for the model's verdicts, so nothing is credited before it gives them.
  await drainsIdle(s);
  assert.equal(outcomesFor(s, TURN).length, 0,
    'the implicit outcome went out before the review it waits on, so a lesson the model then '
    + `credits is reinforced twice; saw: ${s.server.summary()}`);
});

test('first Stop: a lesson shown only as a "(seen earlier)" pointer is asked about when the reply used it', async (t) => {
  const s = await codexSession(t, { review: 'stop', score: 'full', lessons: [REF_A] });
  assert.ok(markSeen({ dataDir: s.dataDir }, RUN_ID, [REF_A], SESSION),
    'could not mark the lesson as already shown, so this test would render it in full');
  const shown = await typePrompt(s, TURN);
  assert.match(shown, new RegExp(`\\(seen earlier\\) \\[${hA}\\]`),
    `prompt-recall did not render the lesson as a pointer:\n${shown}`);

  const r = await firstStop(s, TURN, ANSWER_A);
  assert.equal(r.json.decision, 'block',
    'the reply used a lesson shown as a pointer, and the model was not asked about it');
  assert.deepEqual(handlesIn(r.json.reason), [hA]);
});

test('first Stop: a lesson the model already credited this turn is not listed', async (t) => {
  const s = await codexSession(t, { review: 'stop', score: 'full' });
  await typePrompt(s, TURN);
  await creditByTool(s, TURN, [`[${hA}]`]);

  const r = await firstStop(s, TURN, ANSWER_A);
  assert.equal(r.json.decision, 'block');
  assert.deepEqual(sorted(handlesIn(r.json.reason)), sorted([hB, hC]),
    'a lesson the model credited with mubit_outcome earlier in the turn was listed again, so it '
    + `is asked to judge the same lesson twice:\n${r.json.reason}`);
});

// ===========================================================================
// The pending review, across processes
// ===========================================================================

test('the pending review is on disk, so the continuation Stop, a process of its own, finds it', async (t) => {
  const s = await codexSession(t, { review: 'stop', score: 'full' });
  await typePrompt(s, TURN);
  const first = await firstStop(s, TURN, ANSWER_A);
  assert.equal(first.json.decision, 'block');

  // The hook that blocked has exited. All the next process has is the turn file.
  const pending = turnFile(s, TURN);
  assert.ok(Number(pending?.review_requested_at) > 0,
    'the block left no record on the turn, so the continuation, a separate process, cannot tell '
    + 'it is one and blocks again. Codex has no cap on blocks.');
  assert.deepEqual(sorted(pending.review_ids ?? []), sorted([REF_A, REF_B, REF_C]),
    'the turn does not record which lessons the review asked about');

  // A shell call in the continuation: another process, the same turn, in between.
  const tool = postToolUse({ session_id: SESSION, turn_id: TURN, cwd: s.projectDir, tool_use_id: `exec-${randomUUID()}` });
  assertValid(tool, 'post-tool-use.command.input', 'the shell PostToolUse fixture');
  await runHookOk(s, 'capture', tool);

  const r = await continuationStop(s, TURN, REVIEW_LINE);
  assert.equal(r.json.decision, undefined,
    `the continuation was blocked again: the pending review did not survive between processes:\n${JSON.stringify(r.json)}`);
  assert.ok(Number(turnFile(s, TURN)?.review_closed_at) > 0,
    'the continuation did not close the review, so the turn still reads as waiting on one');
  const outcomes = await settledOutcomes(s, TURN);
  assert.equal(outcomes.length, 1, `expected the turn's one implicit outcome; saw: ${s.server.summary()}`);

  // Every "exactly once" below waits on this watcher; if it stopped seeing drains they would
  // be counted before the drain that posts a duplicate had run.
  const drains = drainRows(s.spy);
  assert.ok(drains.some((r) => r.ev === 'start' && r.argv.includes('--with-outcome')),
    'the drain watcher saw no drain start, so the waits for "every drain finished" wait on nothing');
  assert.equal(drains.filter((r) => r.ev === 'exit').length, drains.filter((r) => r.ev === 'start').length);
});

// ===========================================================================
// The continuation Stop
// ===========================================================================

test('continuation Stop (the recorded payload): no block, the card, and use measured on the answer plus the continuation without its review line', async (t) => {
  const s = await codexSession(t, { review: 'stop', score: 'full' });
  await typePrompt(s, TURN);
  assert.equal((await firstStop(s, TURN, ANSWER_A)).json.decision, 'block');

  const r = await continuationStop(s, TURN, `${BODY_C}\n\n${REVIEW_LINE}`);

  assert.equal(r.json.decision, undefined,
    `the continuation Stop blocked. Codex has no block cap, so this is a loop:\n${JSON.stringify(r.json)}`);
  assert.match(String(r.json.systemMessage ?? ''), /^mubit · this session/,
    `with MUBIT_CC_SESSION_SCORE=full the card belongs under the reviewed turn:\n${JSON.stringify(r.json)}`);

  const outcomes = await settledOutcomes(s, TURN);
  assert.equal(outcomes.length, 1,
    `the turn's implicit outcome must go out exactly once, after the review; saw: ${s.server.summary()}`);
  assert.deepEqual(sorted(outcomes[0].body.entry_ids ?? []), sorted([REF_A, REF_C]),
    'use is measured on the first answer (which used A) plus the continuation (which used C). '
    + 'B appears only in the "Memory review:" line, which is stripped before measuring. '
    + `Posted: ${JSON.stringify(outcomes[0].body.entry_ids)}`);

  assertFirstAnswerStored(s, TURN, ANSWER_A);
});

test('continuation holding only the review line: the first answer is what is measured and stored', async (t) => {
  const s = await codexSession(t, { review: 'stop', score: 'full' });
  await typePrompt(s, TURN);
  assert.equal((await firstStop(s, TURN, ANSWER_A)).json.decision, 'block');

  // Every lesson's vocabulary is in the review line; none of it may count.
  const r = await continuationStop(s, TURN,
    `**Memory review:** credited [${hA}] (vitest forks); skipped [${hB}] migrations and [${hC}] postgres.`);
  assert.equal(r.json.decision, undefined);
  assert.match(String(r.json.systemMessage ?? ''), /^mubit · this session/);

  const outcomes = await settledOutcomes(s, TURN);
  assert.equal(outcomes.length, 1, `saw: ${s.server.summary()}`);
  assert.deepEqual(outcomes[0].body.entry_ids, [REF_A],
    'the review line was measured as if it were an answer: the lessons it merely names were '
    + `credited as used. Posted: ${JSON.stringify(outcomes[0].body.entry_ids)}`);
  assertFirstAnswerStored(s, TURN, ANSWER_A);
});

test('continuation with an empty reply: no block, the card, and the first answer stands', async (t) => {
  const s = await codexSession(t, { review: 'stop', score: 'full' });
  await typePrompt(s, TURN);
  assert.equal((await firstStop(s, TURN, ANSWER_A)).json.decision, 'block');

  const r = await continuationStop(s, TURN, '');
  assert.equal(r.json.decision, undefined, 'an empty continuation was blocked again');
  assert.match(String(r.json.systemMessage ?? ''), /^mubit · this session/,
    'the card was lost because the continuation said nothing');

  const outcomes = await settledOutcomes(s, TURN);
  assert.equal(outcomes.length, 1, `saw: ${s.server.summary()}`);
  assert.deepEqual(outcomes[0].body.entry_ids, [REF_A],
    'an empty continuation erased the first answer\'s measurement');
  assertFirstAnswerStored(s, TURN, ANSWER_A);
});

// ===========================================================================
// The loop guard
// ===========================================================================

/**
 * Drive one turn through a first Stop and then `followUps`, one Stop each, waiting between them
 * for the drains a Stop starts (a real continuation takes a model round trip). Returns every
 * Stop's answer.
 *
 * @param {Session} s
 * @param {Array<{flag: boolean|'absent', text: string}>} followUps
 */
async function stopsInARow(s, followUps) {
  const answers = [await firstStop(s, TURN, ANSWER_A)];
  for (const f of followUps) {
    const payload = recordedContinuation(s, TURN, f.text);
    if (f.flag === 'absent') delete payload.stop_hook_active;
    else payload.stop_hook_active = f.flag;
    answers.push(await sendStop(s, payload));
    await drainsIdle(s);
  }
  return answers;
}

/**
 * What Codex may send after the first Stop of one turn. The first is the guard with no help from
 * the host at all; the second is the recorded continuation, and then Stops that no longer say
 * a hook blocked. Every follow-up ends on the review line, which is what a model repeating
 * itself sends.
 */
const SEQUENCES = /** @type {const} */ ({
  'stop_hook_active absent, then false': ['absent', false],
  'the recorded continuation, then false, then absent': [true, false, 'absent'],
});

for (const [name, flags] of Object.entries(SEQUENCES)) {
  const followUps = flags.map((flag) => ({ flag, text: REVIEW_LINE }));

  test(`loop guard: ${name} — exactly one block and one implicit outcome`, async (t) => {
    const s = await codexSession(t, { review: 'stop', score: 'full' });
    await typePrompt(s, TURN);

    const answers = await stopsInARow(s, followUps);

    assert.deepEqual(answers.map((r) => r.json.decision ?? null), ['block', ...followUps.map(() => null)],
      'Codex puts no cap on blocks, so a Stop hook that blocks one turn twice loops for as long '
      + 'as the model keeps answering. The turn file, not stop_hook_active, has to say a review '
      + `was already asked for:\n${answers.map((r) => JSON.stringify(r.json)).join('\n')}`);

    const outcomes = await settledOutcomes(s, TURN);
    assert.equal(outcomes.length, 1,
      `the turn's implicit outcome must go out exactly once whatever Stops follow; saw: ${s.server.summary()}`);
  });

  test(`a later Stop of a reviewed turn (${name}) is its continuation: the review line is neither measured nor stored`, async (t) => {
    const s = await codexSession(t, { review: 'stop', score: 'full' });
    await typePrompt(s, TURN);

    await stopsInARow(s, followUps);

    const outcomes = await settledOutcomes(s, TURN);
    assert.equal(outcomes.length, 1, `saw: ${s.server.summary()}`);
    assert.deepEqual(outcomes[0].body.entry_ids, [REF_A],
      'a Stop of the reviewed turn was measured as a fresh answer: the review line, which names '
      + 'the migrations and seeding lesson, replaced the first answer\'s use of the vitest one. '
      + `Posted: ${JSON.stringify(outcomes[0].body.entry_ids)}`);
    assert.equal(turnFile(s, TURN)?.used_evidence?.entries?.[REF_A]?.used, true,
      'a later Stop re-measured the turn on its review line and dropped the first answer\'s use of A');
    assertFirstAnswerStored(s, TURN, ANSWER_A);
  });
}

// ===========================================================================
// When there is no review
// ===========================================================================

test('no block: nothing was recalled', async (t) => {
  const s = await codexSession(t, { review: 'stop', score: 'full', lessons: [] });
  await typePrompt(s, TURN);
  const r = await firstStop(s, TURN, ANSWER_A);
  assert.equal(r.json.decision, undefined, 'a turn that showed no lesson was blocked for a review of nothing');
  assert.equal(turnFile(s, TURN)?.review_requested_at, undefined);
});

test('no block: the only lesson was a "(seen earlier)" pointer the reply did not use', async (t) => {
  const s = await codexSession(t, { review: 'stop', score: 'full', lessons: [REF_A] });
  assert.ok(markSeen({ dataDir: s.dataDir }, RUN_ID, [REF_A], SESSION));
  const shown = await typePrompt(s, TURN);
  assert.match(shown, new RegExp(`\\(seen earlier\\) \\[${hA}\\]`), shown);

  const r = await firstStop(s, TURN, 'Nothing in the repository needed changing.');
  assert.equal(r.json.decision, undefined,
    'a lesson neither shown in full nor used this turn was put up for review');
  assert.equal(turnFile(s, TURN)?.review_requested_at, undefined);
});

test('no block: outcomeMode off', async (t) => {
  const s = await codexSession(t, { review: 'stop', score: 'full', mode: 'off' });
  await typePrompt(s, TURN);
  const r = await firstStop(s, TURN, ANSWER_A);
  assert.equal(r.json.decision, undefined,
    'with outcomeMode off nothing is attributed, so a review has nowhere to go');
  assert.equal(turnFile(s, TURN)?.review_requested_at, undefined);
  await drainsIdle(s);
  assert.equal(s.server.countOf('POST', '/v2/control/outcome'), 0);
});

for (const review of ['nudge', 'off']) {
  test(`no block: outcomeReview ${review}, and the outcome is not held back for a review that never comes`, async (t) => {
    const s = await codexSession(t, { review, score: 'full' });
    await typePrompt(s, TURN);
    const r = await firstStop(s, TURN, ANSWER_A);
    assert.equal(r.json.decision, undefined, `outcomeReview ${review} blocked a Stop`);
    assert.match(String(r.json.systemMessage ?? ''), /^mubit · this session/,
      'with no review the card belongs under this Stop');
    assert.equal(turnFile(s, TURN)?.review_requested_at, undefined,
      'a review was recorded as pending, so the next Stop would be misread as its continuation');
    const outcomes = await settledOutcomes(s, TURN);
    assert.equal(outcomes.length, 1, `saw: ${s.server.summary()}`);
    assert.deepEqual(outcomes[0].body.entry_ids, [REF_A]);
  });
}

test('no block: capture off', async (t) => {
  const s = await codexSession(t, { review: 'stop', score: 'full', capture: '0' });
  await typePrompt(s, TURN);
  const r = await firstStop(s, TURN, ANSWER_A);
  assert.equal(r.json.decision, undefined, 'with capture off the Stop hook has no business blocking');
  assert.equal(turnFile(s, TURN)?.review_requested_at, undefined);
});

test('no block: a subagent\'s Stop, and the parent turn is still reviewed once', async (t) => {
  const s = await codexSession(t, { review: 'stop', score: 'full' });
  await typePrompt(s, TURN);

  const sub = subagentStop({ session_id: SESSION, turn_id: TURN, cwd: s.projectDir, last_assistant_message: ANSWER_A });
  assertValid(sub, 'subagent-stop.command.input', 'the SubagentStop fixture');
  const r = await runHookOk(s, 'capture', sub, ['--subagent']);
  if (r.json) assertValid(r.json, 'subagent-stop.command.output', 'capture --subagent');
  assert.equal(r.json?.decision, undefined, 'a subagent was blocked for a review; only the main turn is reviewed');
  assert.equal(turnFile(s, TURN)?.review_requested_at, undefined,
    'the subagent\'s Stop used up the parent turn\'s one review');

  const parent = await firstStop(s, TURN, ANSWER_A);
  assert.equal(parent.json.decision, 'block', 'the parent turn lost its review to a subagent');
});

// ===========================================================================
// Crediting in the continuation
// ===========================================================================

test('mubit_outcome in the continuation settles its lessons: the implicit outcome does not credit them again', async (t) => {
  const s = await codexSession(t, { review: 'stop', score: 'full' });
  await typePrompt(s, TURN);
  const first = await firstStop(s, TURN, ANSWER_AC);
  assert.deepEqual(sorted(handlesIn(first.json.reason)), sorted([hA, hB, hC]));

  // The continuation, as Codex runs it: the model's tool call carries the same turn_id.
  await creditByTool(s, TURN, [`[${hA}]`]);
  const r = await continuationStop(s, TURN, `Memory review: credited [${hA}].`);
  assert.equal(r.json.decision, undefined);
  assert.match(String(r.json.systemMessage ?? ''), /1 worked/,
    `the card does not count the lesson the model credited in the continuation as settled:\n${r.json.systemMessage}`);

  const outcomes = await settledOutcomes(s, TURN);
  assert.equal(outcomes.length, 1, `saw: ${s.server.summary()}`);
  assert.deepEqual(outcomes[0].body.entry_ids, [REF_C],
    'A was credited by the model in the continuation and then again by the implicit outcome; '
    + `one use, two reinforcements. Posted: ${JSON.stringify(outcomes[0].body.entry_ids)}`);
});

test('crediting every used lesson in the continuation leaves the implicit outcome nothing to post', async (t) => {
  const s = await codexSession(t, { review: 'stop', score: 'full' });
  await typePrompt(s, TURN);
  assert.equal((await firstStop(s, TURN, ANSWER_AC)).json.decision, 'block');

  await creditByTool(s, TURN, [`[${hA}]`, hC]);
  await creditByTool(s, TURN, [`[${hB}]`], 'failure');
  const r = await continuationStop(s, TURN, `Memory review: credited [${hA}] and [${hC}]; faulted [${hB}].`);
  assert.equal(r.json.decision, undefined);

  await drainsIdle(s);
  assert.equal(outcomesFor(s, TURN).length, 0,
    'the model judged every lesson itself, and the implicit outcome still reinforced some of '
    + `them a second time; saw: ${JSON.stringify(outcomesFor(s, TURN).map((c) => c.body.entry_ids))}`);
});

// ===========================================================================
// A message typed during the continuation
// ===========================================================================

test('a message typed during the continuation joins the turn and starts no second review', async (t) => {
  const s = await codexSession(t, { review: 'stop', score: 'full' });
  await typePrompt(s, TURN);
  assert.equal((await firstStop(s, TURN, ANSWER_A)).json.decision, 'block');
  const requestedAt = Number(turnFile(s, TURN)?.review_requested_at);

  // Typed while the model works on the review: Codex fires UserPromptSubmit again under the
  // running turn's id, and the continuation's Stop answers it.
  await typePrompt(s, TURN, { queued: true, text: 'Also: which port does the database use?' });
  const r = await continuationStop(s, TURN, `${BODY_C}\n\nMemory review: credited [${hA}].`);

  assert.equal(r.json.decision, undefined,
    `the queued message started a second review of the same turn:\n${JSON.stringify(r.json)}`);
  assert.equal(Number(turnFile(s, TURN)?.review_requested_at), requestedAt,
    'a second review was recorded for the turn');
  assert.match(String(r.json.systemMessage ?? ''), /lessons on 1 of 1 prompt/,
    `the queued message was counted as a prompt of its own rather than joining the turn:\n${r.json.systemMessage}`);

  const outcomes = await settledOutcomes(s, TURN);
  assert.equal(outcomes.length, 1, `saw: ${s.server.summary()}`);
  assert.deepEqual(sorted(outcomes[0].body.entry_ids ?? []), sorted([REF_A, REF_C]),
    'the answer to the queued message used C and was not measured');

  const items = turnItems(s, TURN);
  const queued = items.find((i) => /which port/.test(String(i.text)));
  assert.ok(queued, `the queued Q/A was not stored:\n${items.map((i) => `${i.item_id}: ${i.text}`).join('\n')}`);
  assert.match(String(queued.text), /5433/);
  assertFirstAnswerStored(s, TURN, ANSWER_A);
});

// ===========================================================================
// The next turn
// ===========================================================================

test('a new turn after a reviewed one is reviewed again, once', async (t) => {
  const s = await codexSession(t, { review: 'stop', score: 'full' });
  await typePrompt(s, TURN);
  assert.equal((await firstStop(s, TURN, ANSWER_A)).json.decision, 'block');
  assert.equal((await continuationStop(s, TURN, REVIEW_LINE)).json.decision, undefined);
  assert.equal((await settledOutcomes(s, TURN)).length, 1);

  // The next turn recalls a lesson this session has not seen.
  s.server.route('POST /v2/control/query', recallOf([REF_D]));
  const shown = await typePrompt(s, TURN_2, { text: 'how do I bump the dependency safely?' });
  assert.deepEqual(handlesIn(shown), [hD], shown);

  const first = await firstStop(s, TURN_2, 'Pin the lockfile first, then bump it inside the workspace.');
  assert.equal(first.json.decision, 'block',
    'the once-per-turn guard leaked into the next turn: a new turn_id that showed a lesson was not reviewed');
  assert.deepEqual(handlesIn(first.json.reason), [hD],
    `the second turn's review lists lessons it never showed:\n${first.json.reason}`);

  const again = await continuationStop(s, TURN_2, `Memory review: credited [${hD}].`);
  assert.equal(again.json.decision, undefined);

  assert.equal((await settledOutcomes(s, TURN_2)).length, 1,
    `the second turn's implicit outcome must go out exactly once; saw: ${s.server.summary()}`);
  assert.equal(outcomesFor(s, TURN).length, 1,
    'the first turn\'s outcome went out again when the second turn closed');
});
