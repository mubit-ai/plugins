// @ts-check
/**
 * `hooks/src/stage-prompt.mjs` — UserPromptSubmit, fast path.
 *
 * Budget < 25 ms, zero network. It exists because the `Stop` payload carries
 * `last_assistant_message` but **not** the prompt that produced it: without staging, every
 * captured turn would be half a conversation. It is also the drain's user-paced trigger —
 * a new prompt arriving is exactly when the previous turn's captures are complete.
 *
 * The interesting part is that it shares `runs/<run_id>/turns/<prompt_id>.json` with
 * `prompt-recall`, which fills `recalled` in the same file on the same event. Both
 * orderings must end with a file carrying the prompt AND the recalled ids; neither hook
 * may clobber the other's field. That race is the reason
 * both hooks are specified as read-modify-write-atomic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  runHook, assertHookContract, assertWithinBudget, fakeMubit, baseEnv, lib, makeDataDir,
  readJsonFile, tempDir,
} from './helpers/harness.mjs';
import { userPromptSubmit, spoolItem, PROMPT_ID, SESSION_ID } from './helpers/fixtures.mjs';

const RUN_ID = 'cc-test-0000';
const PROMPT = 'why is the ingest job stuck in queued?';

// What `stage-prompt` may cost on top of starting node — `assertWithinBudget` measures that
// floor rather than assuming it. The target is 25 ms of work; 800 is set from the other
// end, above the 449 ms seen with four suites running at once (see `capture.test.mjs` for the
// full reasoning). A guard-rail against a gross regression, not a stopwatch: a network call
// sneaking onto the fast path is caught exactly, by the zero-request assertion below.
const BUDGET_MS = 800;

// ---------------------------------------------------------------------------

const SCRATCH = tempDir('mubit-cc-stage-');
const SPY = join(SCRATCH, 'spawn-spy.cjs');
writeFileSync(SPY, `const fs = require('node:fs');
const out = process.env.MUBIT_TEST_SPY_FILE;
if (out) {
  try {
    fs.appendFileSync(out, JSON.stringify({
      argv: process.argv.slice(1),
      detached: process.env.MUBIT_CC_DETACHED || '',
      at: Date.now(),
    }) + '\\n');
  } catch {}
}
`);

function spyLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function drainSpawns(file) {
  return spyLines(file).filter((l) => basename(String(l.argv?.[0] ?? '')) === 'drain.mjs');
}

function withSpy(env) {
  const file = join(SCRATCH, `spy-${randomUUID()}.jsonl`);
  return { file, env: { ...env, NODE_OPTIONS: `--require ${SPY}`, MUBIT_TEST_SPY_FILE: file } };
}

async function waitForSpawn(file, ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = drainSpawns(file);
    if (s.length) return s;
    if (Date.now() > deadline) return s;
    await new Promise((r) => setTimeout(r, 25));
  }
}

function staticEnv(dataDir, server, extra = {}) {
  return baseEnv({
    dataDir,
    endpoint: server.url,
    projectDir: dataDir,
    extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: RUN_ID, ...extra },
  });
}

const runDir = (dataDir) => join(dataDir, 'runs', RUN_ID);
const turnPath = (dataDir) => join(runDir(dataDir), 'turns', `${PROMPT_ID}.json`);

/** Hold the drain lock so a triggered drain records its spawn and then exits without dialing. */
function holdDrainLock(dataDir) {
  mkdirSync(runDir(dataDir), { recursive: true });
  writeFileSync(join(runDir(dataDir), 'drain.lock'),
    JSON.stringify({ pid: process.pid, ts: Date.now() }));
}

/** @param {string} dataDir @param {number} n @param {number} [ageMs] */
function seedSpool(dataDir, n, ageMs = 0) {
  const dir = join(runDir(dataDir), 'spool');
  mkdirSync(dir, { recursive: true });
  const base = Date.now() - ageMs;
  for (let i = 0; i < n; i++) {
    const ts = base + i;
    const p = join(dir, `${ts}-${String(i).padStart(6, '0')}.json`);
    writeFileSync(p, JSON.stringify(spoolItem({ item_id: `cc-seed-${i}` })));
    const secs = ts / 1000;
    utimesSync(p, secs, secs);
  }
}

/**
 * A fake Mubit whose listening socket is closed even when the test fails — otherwise an
 * open handle keeps the test process alive and the whole run hangs.
 * @param {any} t @param {any} [routes]
 */
async function mubit(t, routes) {
  const server = await fakeMubit(routes);
  t.after(() => server.close());
  return server;
}

// ---------------------------------------------------------------------------

// The staged turn file, and nothing on the wire.
test('stage-prompt: writes turns/<prompt_id>.json and issues zero HTTP', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  const r = await runHook('stage-prompt', userPromptSubmit({ prompt: PROMPT }), {
    env: staticEnv(dataDir, server),
  });

  assertHookContract(r);
  assert.deepEqual(r.json, { suppressOutput: true });
  assert.equal(server.requests.length, 0,
    `stage-prompt is the zero-network fast path; saw: ${server.summary()}`);
  await assertWithinBudget('stage-prompt', BUDGET_MS, r.ms, async () => (await runHook(
    'stage-prompt', userPromptSubmit({ prompt: PROMPT }),
    { env: staticEnv(makeDataDir(), server) },
  )).ms);

  const turn = readJsonFile(turnPath(dataDir));
  assert.equal(turn.prompt, PROMPT);
  assert.equal(turn.prompt_id, PROMPT_ID);
  assert.equal(turn.session_id, SESSION_ID);
  assert.equal(typeof turn.started_at, 'number');
  assert.ok(Math.abs(turn.started_at - Date.now()) < 60_000, 'started_at must be a recent ms timestamp');
  assert.deepEqual(turn.recalled, [], 'prompt-recall fills `recalled` in this same file');
});

// Race, ordering A: stage first, then recall. Recall must merge, not overwrite.
test('stage-prompt then prompt-recall: the turn file keeps both the prompt and the recalled ids', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  const env = staticEnv(dataDir, server);
  const payload = userPromptSubmit({ prompt: PROMPT });

  assertHookContract(await runHook('stage-prompt', payload, { env }));
  assertHookContract(await runHook('prompt-recall', payload, { env }));

  const turn = readJsonFile(turnPath(dataDir));
  assert.equal(turn.prompt, PROMPT, 'prompt-recall must not clobber the staged prompt');
  assert.ok(Array.isArray(turn.recalled) && turn.recalled.length > 0,
    `expected recalled reference_ids, got ${JSON.stringify(turn.recalled)}`);
  assert.ok(turn.recalled.includes('ref_rule_1'),
    'recalled carries reference_id — not id — because that is what feeds RecordOutcome.entry_ids');
});

// Race, ordering B: recall lands first. Staging must merge, not overwrite.
test('prompt-recall then stage-prompt: the turn file keeps both the prompt and the recalled ids', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  const env = staticEnv(dataDir, server);
  const payload = userPromptSubmit({ prompt: PROMPT });

  assertHookContract(await runHook('prompt-recall', payload, { env }));
  assertHookContract(await runHook('stage-prompt', payload, { env }));

  const turn = readJsonFile(turnPath(dataDir));
  assert.equal(turn.prompt, PROMPT);
  assert.ok(Array.isArray(turn.recalled) && turn.recalled.includes('ref_rule_1'),
    `stage-prompt clobbered the recalled ids: ${JSON.stringify(turn.recalled)}`);
});

// Count trigger: spoolStats().count >= batchMaxItems.
test('stage-prompt: spawns a drain when the item-count trigger fires', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  holdDrainLock(dataDir);
  seedSpool(dataDir, 3);
  const { env, file } = withSpy(staticEnv(dataDir, server, { MUBIT_CC_BATCH_MAX_ITEMS: '2' }));

  const r = await runHook('stage-prompt', userPromptSubmit({ prompt: PROMPT }), { env });
  assertHookContract(r);

  const spawns = await waitForSpawn(file);
  assert.equal(spawns.length, 1, '3 spooled items against batchMaxItems=2 must spawn exactly one drain');
  assert.equal(spawns[0].detached, '1');
});

// Age trigger: spoolStats().oldestMs >= batchMaxAgeMs. A quiet session still
// gets its captures flushed on the next prompt.
test('stage-prompt: spawns a drain when the oldest-item age trigger fires', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  holdDrainLock(dataDir);
  seedSpool(dataDir, 1, 60_000);
  const { env, file } = withSpy(staticEnv(dataDir, server, {
    MUBIT_CC_BATCH_MAX_ITEMS: '32',
    MUBIT_CC_BATCH_MAX_AGE_MS: '1000',
  }));

  const r = await runHook('stage-prompt', userPromptSubmit({ prompt: PROMPT }), { env });
  assertHookContract(r);

  const spawns = await waitForSpawn(file);
  assert.equal(spawns.length, 1, 'a 60s-old spool item against maxAge=1000ms must spawn one drain');
});

// Neither trigger fires: no drain, and still nothing on the wire.
test('stage-prompt: spawns no drain when neither trigger fires', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  holdDrainLock(dataDir);
  seedSpool(dataDir, 1);
  const { env, file } = withSpy(staticEnv(dataDir, server, {
    MUBIT_CC_BATCH_MAX_ITEMS: '32',
    MUBIT_CC_BATCH_MAX_AGE_MS: '30000',
  }));

  const r = await runHook('stage-prompt', userPromptSubmit({ prompt: PROMPT }), { env });
  assertHookContract(r);
  await new Promise((res) => setTimeout(res, 250));

  assert.equal(drainSpawns(file).length, 0,
    'one fresh item is neither 32 items nor 30s old — no drain');
  assert.equal(server.requests.length, 0, `saw unexpected HTTP: ${server.summary()}`);
});

// "Failure: swallow everything; the cost is one Q&A pair." An unwritable data dir
// must not turn into a failed hook, and certainly not into a blocked prompt.
test('stage-prompt: exits 0 with valid JSON when the data dir is unwritable', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root: permissions are unenforceable');
    return;
  }
  const dataDir = makeDataDir();
  const server = await mubit(t);
  const dir = runDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const before = statSync(dir).mode;
  chmodSync(dir, 0o555);
  try {
    const r = await runHook('stage-prompt', userPromptSubmit({ prompt: PROMPT }), {
      env: staticEnv(dataDir, server),
    });
    assertHookContract(r);
    assert.deepEqual(r.json, { suppressOutput: true });
    assert.equal(existsSync(turnPath(dataDir)), false, 'nothing could be written — that is the whole cost');
    assert.equal(server.requests.length, 0);
  } finally {
    chmodSync(dir, before);
  }
});

// ---------------------------------------------------------------------------
// The run id is a path segment too
// ---------------------------------------------------------------------------

/**
 * `prompt_id` was sanitised here from the start; `run_id` was not, and it is the half a user
 * can pin by hand. A pin carrying a separator used to write the turn file *outside*
 * `runs/<run_id>/`, where no sibling hook looks — so the prompt vanished and the turn was
 * captured as half a conversation, silently.
 *
 * `lib/runid.mjs` now refuses such a pin outright, so this drives the hook the way the
 * failure actually reached it: a run id resolved from a project config file.
 */
test('a run id carrying a path separator cannot escape runs/', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const projectDir = tempDir('mubit-cc-hostile-');
  writeFileSync(join(projectDir, '.mubit-cc.json'),
    JSON.stringify({ runStrategy: 'static', runId: '../../escaped' }));

  const env = baseEnv({ dataDir, endpoint: server.url, projectDir });
  const r = await runHook('stage-prompt', userPromptSubmit({ prompt: PROMPT }), { env });
  assertHookContract(r);

  // Whatever it did, it did not write above the data dir.
  assert.ok(!existsSync(join(dataDir, '..', '..', 'escaped')), 'the turn escaped the data dir');
  assert.ok(!existsSync(join(dataDir, '..', 'escaped')), 'the turn escaped the run root');

  const runsRoot = join(dataDir, 'runs');
  if (existsSync(runsRoot)) {
    for (const name of readdirSync(runsRoot)) {
      assert.ok(!name.includes('/') && name !== '..' && name !== '.',
        `"${name}" is not a single flattened segment`);
    }
  }
});

/**
 * A run id that needs flattening but is not a path — the shape `lib/runid.mjs` lets through.
 * The turn file must land on the segment every *other* module computes, or `prompt-recall`
 * fills `recalled` in one file while this hook writes the prompt to another.
 */
test('a run id needing flattening lands on the segment every module uses', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const projectDir = tempDir('mubit-cc-hostile2-');
  const hostile = 'cc-a:b*c';
  writeFileSync(join(projectDir, '.mubit-cc.json'),
    JSON.stringify({ runStrategy: 'static', runId: hostile }));

  const env = baseEnv({ dataDir, endpoint: server.url, projectDir });
  assertHookContract(await runHook('stage-prompt', userPromptSubmit({ prompt: PROMPT }), { env }));

  const state = await lib('state.mjs');
  const segment = state.safeSegment(hostile);
  assert.equal(segment, 'cc-a_b_c');
  const staged = join(dataDir, 'runs', segment, 'turns', `${PROMPT_ID}.json`);
  assert.ok(existsSync(staged), `the turn is not at ${staged}`);
  assert.equal(readJsonFile(staged).prompt, PROMPT);
});

// ---------------------------------------------------------------------------
// The session scorecard: one `prompt` row per prompt, and the correction trigger
// ---------------------------------------------------------------------------

const PREV = '99999999-8888-7777-6666-555555555555';
const logPath = (dataDir) => join(dataDir, 'scorecard', `${SESSION_ID}.jsonl`);

/** @param {string} dataDir @param {Record<string, any>[]} rows */
function seedLog(dataDir, rows) {
  mkdirSync(join(dataDir, 'scorecard'), { recursive: true });
  writeFileSync(logPath(dataDir), rows.map((r) => JSON.stringify({ v: 1, at: Date.now(), ...r })).join('\n') + '\n');
}

/** @param {string} dataDir */
function logRows(dataDir) {
  if (!existsSync(logPath(dataDir))) return [];
  return readFileSync(logPath(dataDir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const prevTurn = (over = {}) => ({
  kind: 'turn', prompt_id: PREV, run_id: RUN_ID, lessons: {}, used_refs: ['ref_lesson_1'],
  ended_with_question: false, ...over,
});

const correctSpawns = (file) => drainSpawns(file).filter((s) => s.argv.includes('--correct'));

test('stage-prompt: appends a prompt row to the session log', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  assertHookContract(await runHook('stage-prompt', userPromptSubmit({ prompt: PROMPT }), {
    env: staticEnv(dataDir, server),
  }));
  const rows = logRows(dataDir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'prompt');
  assert.equal(rows[0].prompt_id, PROMPT_ID);
  assert.equal(rows[0].correction, false);
  assert.equal(rows[0].slash, false);
  assert.equal(server.requests.length, 0);
});

test('stage-prompt: a slash command is marked slash and is never a correction', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  seedLog(dataDir, [prevTurn()]);
  const { env, file } = withSpy(staticEnv(dataDir, server));
  await runHook('stage-prompt', userPromptSubmit({ prompt: '/clear' }), { env });
  const row = logRows(dataDir).at(-1);
  assert.equal(row.slash, true);
  assert.equal(row.correction, false);
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(correctSpawns(file).length, 0);
});

// A prompt that opens with a Codex skill mention (`$name`, `$plugin:name`) is addressed to the
// skill, like a slash command. The rule names no host, so it holds on a Claude Code payload too,
// and only the first word counts: a `$` further in leaves the prompt judged as usual. The table
// is `correction.test.mjs`; this is the hook reading it.
test('stage-prompt: a $skill prompt is never a correction on Claude Code either; a $ further in changes nothing', async (t) => {
  const got = [];
  for (const prompt of ["$recall no, that's wrong", "no, that's wrong — use $HOME/.cache"]) {
    const dataDir = makeDataDir();
    const server = await mubit(t);
    holdDrainLock(dataDir);
    seedLog(dataDir, [{ kind: 'prompt', prompt_id: PREV, correction: false, slash: false }, prevTurn()]);
    await runHook('stage-prompt', userPromptSubmit({ prompt }), { env: staticEnv(dataDir, server) });
    got.push([prompt, logRows(dataDir).at(-1)?.correction]);
  }
  assert.deepEqual(got, [["$recall no, that's wrong", false], ["no, that's wrong — use $HOME/.cache", true]]);
});

test('stage-prompt: a correction of a turn that used memory spawns drain --correct for it', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  holdDrainLock(dataDir);
  seedLog(dataDir, [
    { kind: 'prompt', prompt_id: PREV, correction: false, slash: false },
    prevTurn(),
  ]);
  const { env, file } = withSpy(staticEnv(dataDir, server));
  assertHookContract(await runHook('stage-prompt', userPromptSubmit({ prompt: "no, that's wrong" }), { env }));

  assert.equal(logRows(dataDir).at(-1).correction, true);
  const spawns = await waitForSpawn(file);
  const argv = correctSpawns(file)[0]?.argv ?? [];
  assert.ok(argv.length, `no drain --correct spawned: ${JSON.stringify(spawns)}`);
  assert.equal(argv[argv.indexOf('--correct') + 1], PREV);
  assert.equal(argv[argv.indexOf('--run') + 1], RUN_ID);
});

test('stage-prompt: a correction of a turn that used nothing is recorded but posts nothing', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  seedLog(dataDir, [prevTurn({ used_refs: [] })]);
  const { env, file } = withSpy(staticEnv(dataDir, server));
  await runHook('stage-prompt', userPromptSubmit({ prompt: 'that didn\'t work' }), { env });
  assert.equal(logRows(dataDir).at(-1).correction, true);
  await new Promise((res) => setTimeout(res, 250));
  assert.equal(correctSpawns(file).length, 0);
});

test('stage-prompt: never a correction across a /clear', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  seedLog(dataDir, [prevTurn(), { kind: 'start', source: 'clear', lessons: {}, refs: [], tokens: 0 }]);
  const { env, file } = withSpy(staticEnv(dataDir, server));
  await runHook('stage-prompt', userPromptSubmit({ prompt: "no, that's wrong" }), { env });
  assert.equal(logRows(dataDir).at(-1).correction, false);
  await new Promise((res) => setTimeout(res, 250));
  assert.equal(correctSpawns(file).length, 0);
});

test('stage-prompt: a bare "no" answering a question is not a correction', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  seedLog(dataDir, [prevTurn({ ended_with_question: true })]);
  await runHook('stage-prompt', userPromptSubmit({ prompt: 'no' }), { env: staticEnv(dataDir, server) });
  assert.equal(logRows(dataDir).at(-1).correction, false);
});

test('stage-prompt: with implicit outcomes off the correction is recorded but not posted', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  seedLog(dataDir, [prevTurn()]);
  const { env, file } = withSpy(staticEnv(dataDir, server, { MUBIT_CC_OUTCOME_MODE: 'explicit' }));
  await runHook('stage-prompt', userPromptSubmit({ prompt: "no, that's wrong" }), { env });
  assert.equal(logRows(dataDir).at(-1).correction, true);
  await new Promise((res) => setTimeout(res, 250));
  assert.equal(correctSpawns(file).length, 0);
});

test('stage-prompt: this prompt\'s own turn row is not the previous turn', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  seedLog(dataDir, [prevTurn({ prompt_id: PROMPT_ID })]);
  await runHook('stage-prompt', userPromptSubmit({ prompt: "no, that's wrong" }), { env: staticEnv(dataDir, server) });
  assert.equal(logRows(dataDir).at(-1).correction, false);
});

test('stage-prompt: a second prompt into the same turn is stamped queued_at; the first is not', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  await runHook('stage-prompt', userPromptSubmit({ prompt: PROMPT }), { env: staticEnv(dataDir, server) });
  assert.equal(readJsonFile(turnPath(dataDir)).queued_at, undefined);
  const before = Date.now();
  await runHook('stage-prompt', userPromptSubmit({ prompt: 'and one more thing' }), { env: staticEnv(dataDir, server) });
  const staged = readJsonFile(turnPath(dataDir));
  assert.ok(staged.queued_at >= before, JSON.stringify(staged));
  assert.equal(staged.prompt, 'and one more thing');
});

// The correction targets the turn the card fails: the latest non-slash prompt before this one
// (lib/scorecard.mjs previousTurn), never merely the latest turn row.
test('stage-prompt: after an interrupted turn the correction is that turn\'s, so nothing earlier is posted', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  holdDrainLock(dataDir);
  seedLog(dataDir, [
    { kind: 'prompt', prompt_id: PREV, correction: false, slash: false },
    prevTurn(),
    { kind: 'prompt', prompt_id: 'interrupted-1', correction: false, slash: false },
    { kind: 'shown', prompt_id: 'interrupted-1', lessons: {}, refs: [], tokens: 10 },
  ]);
  const { env, file } = withSpy(staticEnv(dataDir, server));
  await runHook('stage-prompt', userPromptSubmit({ prompt: "no, that's wrong" }), { env });
  assert.equal(logRows(dataDir).at(-1).correction, false);
  await new Promise((res) => setTimeout(res, 250));
  assert.equal(correctSpawns(file).length, 0);
});

test('stage-prompt: a slash command between is skipped — the turn before it is corrected', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  holdDrainLock(dataDir);
  seedLog(dataDir, [
    { kind: 'prompt', prompt_id: PREV, correction: false, slash: false },
    prevTurn(),
    { kind: 'prompt', prompt_id: 'slash-1', correction: false, slash: true },
    prevTurn({ prompt_id: 'slash-1', used_refs: [] }),
  ]);
  const { env, file } = withSpy(staticEnv(dataDir, server));
  await runHook('stage-prompt', userPromptSubmit({ prompt: "no, that's wrong" }), { env });
  assert.equal(logRows(dataDir).at(-1).correction, true);
  await waitForSpawn(file);
  const argv = correctSpawns(file)[0]?.argv ?? [];
  assert.equal(argv[argv.indexOf('--correct') + 1], PREV);
});

// Observed live (Claude Code 2.1.282): a message typed while Claude is working is delivered
// into the running turn under the SAME prompt_id. It joins that turn; it is not a new prompt,
// and it can never correct the turn before it.
test('stage-prompt: a message queued into the running turn adds no prompt row and is never a correction', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  holdDrainLock(dataDir);
  seedLog(dataDir, [
    { kind: 'prompt', prompt_id: PREV, correction: false, slash: false },
    prevTurn(),
    { kind: 'prompt', prompt_id: PROMPT_ID, correction: false, slash: false },
  ]);
  const { env, file } = withSpy(staticEnv(dataDir, server));
  assertHookContract(await runHook('stage-prompt', userPromptSubmit({ prompt: "no, that's wrong" }), { env }));
  assert.deepEqual(logRows(dataDir).filter((r) => r.kind === 'prompt').map((r) => r.prompt_id), [PREV, PROMPT_ID]);
  await new Promise((res) => setTimeout(res, 250));
  assert.equal(correctSpawns(file).length, 0);
});

test('stage-prompt: with capture off nothing is appended', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  await runHook('stage-prompt', userPromptSubmit({ prompt: PROMPT }), {
    env: staticEnv(dataDir, server, { MUBIT_CC_CAPTURE: 'false' }),
  });
  assert.deepEqual(logRows(dataDir), []);
});

test('stage-prompt: a long session log stays inside the budget', async (t) => {
  const dataDir = makeDataDir();
  const server = await mubit(t);
  const rows = [];
  for (let i = 0; i < 4000; i++) {
    rows.push({ kind: 'tool', prompt_id: `p${i % 50}`, failed: false, intent: 'exec' });
    if (i % 80 === 0) rows.push(prevTurn({ prompt_id: `p${i}` }));
  }
  seedLog(dataDir, rows);
  const r = await runHook('stage-prompt', userPromptSubmit({ prompt: "no, that's wrong" }), {
    env: staticEnv(dataDir, server),
  });
  assertHookContract(r);
  assert.equal(logRows(dataDir).at(-1).correction, true);
  await assertWithinBudget('stage-prompt with a long log', BUDGET_MS, r.ms, async () => (await runHook(
    'stage-prompt', userPromptSubmit({ prompt: "no, that's wrong" }),
    { env: staticEnv(dataDir, server) },
  )).ms);
});
