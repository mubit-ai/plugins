// @ts-check
/**
 * The model's own credit calls, `mubit_outcome` and `mubit_learned`, as Codex delivers them.
 *
 * The claim defended here: **a call to the plugin's own `mubit_outcome` or `mubit_learned`,
 * arriving as the PostToolUse Codex 0.154.0 sends, lands in the session log
 * (`<dataDir>/scorecard/<session_id>.jsonl`) exactly as the same call does under Claude Code**:
 * an `explicit` row carrying the entry ids its short ids name and the outcome given, a `learned`
 * row per lesson written, and nothing at all for a call that failed, was only asked about, never
 * ran, or came from another MCP server. **At Stop the model's verdict stands over the implicit
 * one**: the entries it judged are left out of the implicit credit, and the card shows its
 * verdict rather than what the reply check guessed.
 *
 * Why this needs its own file. The capture code (`../../claude-code/hooks/src/capture.mjs`,
 * the own-tool part) was written against Claude Code's payloads, where the tool is
 * `mcp__plugin_mubit-memory_mubit__<tool>`. Codex names it `mcp__mubit__<tool>` and sends the
 * MCP result object as `tool_response`. Until now every Codex payload for this path was
 * hand-built beside the code that reads it; these are held to the recording.
 *
 * Nothing reports it when this breaks. The model faults a lesson, the tool says the verdict
 * landed, and at Stop the plugin credits that same lesson as a success on the model's behalf;
 * or the card says a lesson is "waiting" when the model has already judged it.
 *
 * Where each payload shape comes from:
 *   - **recorded** (`observed/payloads/PostToolUse.mcp.json`, `PermissionRequest.json`): the
 *     tool names, `tool_input` holding the arguments verbatim, a `tool_use_id`, the result
 *     object `{"content":[{"type":"text",…}]}`; a PermissionRequest with no `tool_use_id`; and
 *     no PostToolUse at all for a call that was declined.
 *   - **spec-derived, not recorded**: `isError: true` on the result object. The recorder's
 *     server never failed a call, so Codex was never seen reporting one. This is the MCP spec's
 *     `CallToolResult.isError`, and it is what the plugin's bundled MCP server answers every
 *     failed call with, an argument its schema rejects included.
 *   - **not recorded, by premise**: `agent_id` on a tool call made inside a subagent. No
 *     recorded session spawned one (`observed/README.md`, "What is not covered").
 *   - **defensive, not observed**: the result object serialised as a JSON string.
 *
 * Deliberately not asked for: collapsing one call's PostToolUse delivered twice. No host was
 * seen doing it, and the only way to get it is two registrations of the capture hook, which
 * re-running setup does not produce (its merge replaces the plugin's own handlers). Two
 * registrations would run every hook twice, not only this one: a setup fault for the doctor to
 * report, and deduplicating two rows here would hide one symptom of it. Two handlers of one
 * event may also run at once, and a read-the-log-then-append check cannot close that race. A
 * doubled `explicit` row is already inert (the card and the turn file both key verdicts by
 * entry).
 *
 * Every payload is checked against the recording before it is sent. A field the recording does
 * not have must be named at the call site, with the reason, or the check fails (`sendable`).
 *
 * Every hook runs as a subprocess of the Codex entry point, against the fake endpoint, in the
 * environment Codex gives it: no `CLAUDE_*` names, which `lib/boot.mjs` fills in.
 * `MUBIT_CC_SESSION_SCORE=full` so the card prints, and `MUBIT_CC_OUTCOME_REVIEW=off` so Stop
 * never blocks; the Stop-hook review is #24's.
 */

import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assert, assertValid, baseEnv, eventOfTitle, evidence, fakeMubit, lib, makeDataDir,
  makeProjectDir, mcpPostToolUse, observedKeyErrors, permissionRequest, queryResponse,
  readJsonFile, runHook, schemaSlug, stop, subagentStart, userPromptSubmit, waitFor,
} from './helpers/codex-fixtures.mjs';

const { handleFor } = await lib('handles.mjs');
const { decideOutcome } = await lib('outcome.mjs');

/** Pinned, so where the turn file lives is never a derivation question. */
const RUN = 'codex-explicit-run';

/** The builders' own ids, so every payload in a test names the same session and turn. */
const SESSION = userPromptSubmit().session_id;
const TURN = userPromptSubmit().turn_id;
/** The session's next turn, in Codex's turn_id shape. */
const TURN_2 = '01a0240c-8a15-7ca3-a641-cf8d141498a1';
const AGENT = subagentStart().agent_id;

const REF_A = '0a0a0a0a-0000-4000-8000-000000000001';
const REF_B = '0b0b0b0b-0000-4000-8000-000000000002';
/** An entry no turn in any test shows. */
const NEVER_SHOWN = '0e0e0e0e-0000-4000-8000-00000000000e';

const LESSON_A = 'Run vitest with --pool=forks; the threads pool hangs on the native module.';
const LESSON_B = 'Run database migrations before seeding fixtures.';

/** A reply carrying both lessons' own words, so the reply check marks both used. */
const USES_BOTH = 'Run vitest with --pool=forks, since the threads pool hangs on the native '
  + 'module, and run database migrations before seeding.';
/** A reply carrying neither, so the reply check marks both not used. */
const USES_NEITHER = 'Done. The suite passes locally now.';

const OWN_OUTCOME = 'mcp__mubit__mubit_outcome';
const OWN_LEARNED = 'mcp__mubit__mubit_learned';

/** What a lesson write returns. The recorder's server only had `mubit_outcome`. */
const LEARNED_OK = { content: [{ type: 'text', text: 'Lesson recorded.' }] };

// ---------------------------------------------------------------------------
// Fields a payload here carries that the recording does not, and why each is allowed
// ---------------------------------------------------------------------------

/**
 * The recording is of a `mubit_outcome` call, so its `tool_input` has that tool's argument
 * names. A `mubit_learned` call's arguments are `{text}`. `tool_input` holding the arguments
 * verbatim is what was recorded; the names inside it belong to the tool, not to Codex.
 */
const LEARNED_ARGS = ['tool_input.text'];

/** Spec-derived: the MCP spec's `CallToolResult.isError`. Codex was never recorded sending it. */
const SPEC_IS_ERROR = ['tool_response.isError'];

/** Not recorded: no recorded session ran a subagent. The issue's premise, and Claude Code's. */
const IN_SUBAGENT = ['agent_id'];

/**
 * The names Codex never gives a hook process. The shared harness fills them in for Claude
 * Code; removing them makes `lib/boot.mjs` do the work it does under Codex.
 */
const NOT_ON_CODEX = /** @type {const} */ (['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR']);

// ===========================================================================
// The session
// ===========================================================================

/**
 * @typedef {object} Session
 * @property {Awaited<ReturnType<typeof fakeMubit>>} server
 * @property {string} dataDir
 * @property {string} projectDir
 * @property {Record<string, string>} env
 * @property {() => string} nextCallId  a fresh `tool_use_id` in Codex's `exec-<uuid>` shape
 * @property {string} hA  the short id prompt-recall printed for REF_A
 * @property {string} hB  the short id prompt-recall printed for REF_B
 */

/**
 * One Codex session, with a turn that has shown two lessons: prompt-recall then stage-prompt,
 * in `hooks.json` order, against an endpoint that recalls REF_A and REF_B.
 *
 * @param {any} t
 * @returns {Promise<Session>}
 */
async function session(t) {
  const server = await fakeMubit({
    'POST /v2/control/query': {
      json: queryResponse({
        evidence: [
          evidence({ id: 'e1', reference_id: REF_A, entry_type: 'lesson', score: 0.9, content: LESSON_A }),
          evidence({ id: 'e2', reference_id: REF_B, entry_type: 'lesson', score: 0.8, content: LESSON_B }),
        ],
      }),
    },
  });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir();
  const env = baseEnv({
    dataDir, projectDir, endpoint: server.url,
    extra: {
      MUBIT_CC_RUN_STRATEGY: 'static',
      MUBIT_CC_RUN_ID: RUN,
      MUBIT_CC_SESSION_SCORE: 'full',
      MUBIT_CC_OUTCOME_REVIEW: 'off',
    },
  });
  for (const k of NOT_ON_CODEX) delete env[k];
  let calls = 0;
  const s = {
    server, dataDir, projectDir, env,
    nextCallId: () => `exec-0a0a0a0a-0000-4000-8000-${String(++calls).padStart(12, '0')}`,
    hA: '', hB: '',
  };

  const prompt = userPromptSubmit({ cwd: projectDir, prompt: 'Why does the test runner hang on CI?' });
  const recall = await hook(s, 'prompt-recall', prompt);
  await hook(s, 'stage-prompt', prompt);
  const shown = String(recall.json?.hookSpecificOutput?.additionalContext ?? '');
  for (const ref of [REF_A, REF_B]) {
    assert.ok(shown.includes(`[${handleFor(ref)}]`),
      `prompt-recall did not show the model the short id of ${ref}, so there is nothing for it `
      + `to credit and every test below would pass for nothing:\n${shown}`);
  }
  s.hA = handleFor(REF_A);
  s.hB = handleFor(REF_B);
  assert.notEqual(s.hA, s.hB, 'the two fixtures share a short id, so a test could pass by resolving the wrong one');
  assert.ok(![s.hA, s.hB].includes(handleFor(NEVER_SHOWN)),
    'the never-shown fixture shares a short id with a shown one, so it would resolve');
  return s;
}

/**
 * Remove dotted paths from a copy of `value`.
 *
 * @param {Record<string, any>} value @param {string[]} paths
 * @returns {Record<string, any>}
 */
function without(value, paths) {
  const copy = structuredClone(value);
  for (const path of paths) {
    const keys = path.split('.');
    let cur = copy;
    for (const k of keys.slice(0, -1)) cur = cur?.[k];
    if (cur && typeof cur === 'object') delete cur[/** @type {string} */ (keys.at(-1))];
  }
  return copy;
}

/**
 * Assert a payload is one Codex could have sent: every field is in the recording, except
 * exactly the ones the caller names in `unrecorded`, each of which has a reason above.
 *
 * @param {Record<string, any>} payload @param {string} title @param {string} what
 * @param {string[]} unrecorded
 */
function sendable(payload, title, what, unrecorded) {
  const got = observedKeyErrors(eventOfTitle(title), payload).map((e) => e.split(':')[0]).sort();
  assert.deepEqual(got, unrecorded.map((p) => `$.${p}`).sort(),
    `${what} is not the payload this test says it is. Its only fields missing from the recording `
    + 'must be the ones named at the call site, each with its provenance; any other is a field '
    + 'the test invented, and a test built on it proves nothing about Codex.');
  assertValid(without(payload, unrecorded), title, what);
}

/**
 * Run one Codex entry point on a payload that has been checked against the recording, and
 * check its output against Codex's output contract.
 *
 * @param {Session} s @param {string} name @param {Record<string, any>} payload
 * @param {{args?: string[], unrecorded?: string[]}} [o]
 */
async function hook(s, name, payload, o = {}) {
  const slug = schemaSlug(payload.hook_event_name);
  const args = o.args ?? [];
  const what = `${name}${args.length ? ` ${args.join(' ')}` : ''} on ${payload.hook_event_name}`;
  sendable(payload, `${slug}.command.input`, `the payload for ${what}`, o.unrecorded ?? []);
  const r = await runHook(name, payload, { env: s.env, args });
  assert.equal(r.code, 0,
    `${what} exited ${r.code}. Codex reads anything but 0 as a hook error, and 2 as a block:\n${r.stderr}`);
  assertValid(r.json, `${slug}.command.output`, what);
  return r;
}

/**
 * The PostToolUse Codex sends when one of the plugin's MCP tools returns.
 *
 * @param {Session} s @param {string} tool @param {Record<string, any>} args
 * @param {Record<string, any>} [over]
 * @returns {Record<string, any>}
 */
function mcpCall(s, tool, args, over = {}) {
  return mcpPostToolUse({
    cwd: s.projectDir, tool_name: tool, tool_input: args, tool_use_id: s.nextCallId(), ...over,
  });
}

/**
 * `mubit_outcome` returned, and capture ran on it.
 *
 * @param {Session} s @param {Record<string, any>} args
 * @param {{over?: Record<string, any>, unrecorded?: string[], tool?: string}} [o]
 */
function outcome(s, args, o = {}) {
  return hook(s, 'capture', mcpCall(s, o.tool ?? OWN_OUTCOME, args, o.over), { unrecorded: o.unrecorded });
}

/**
 * `mubit_learned` returned, and capture ran on it.
 *
 * @param {Session} s @param {string} text
 * @param {{over?: Record<string, any>, unrecorded?: string[], tool?: string}} [o]
 */
function learned(s, text, o = {}) {
  return hook(s, 'capture',
    mcpCall(s, o.tool ?? OWN_LEARNED, { text }, { tool_response: LEARNED_OK, ...(o.over ?? {}) }),
    { unrecorded: [...LEARNED_ARGS, ...(o.unrecorded ?? [])] });
}

/**
 * Stop, and the card it printed ('' when it printed none).
 *
 * @param {Session} s @param {string} reply
 */
async function finish(s, reply) {
  const r = await hook(s, 'capture', stop({ cwd: s.projectDir, last_assistant_message: reply }), { args: ['--stop'] });
  assert.equal(r.json?.decision, undefined,
    'Stop blocked with MUBIT_CC_OUTCOME_REVIEW=off. The review is #24; this file must never reach it.');
  return String(r.json?.systemMessage ?? '');
}

/**
 * Every implicit outcome posted for the turn, once nothing is left to post.
 *
 * `capture --stop` spawns a detached drain with `--with-outcome`; this runs the same drain in
 * the foreground. The two take one lock, and the second to hold it finds the outcome already
 * sent. A foreground drain that waited out the lock leaves the post to the holder, so this also
 * waits until the turn file has nothing left to post (`decideOutcome` says so once the post has
 * been answered). The fake records a request before it answers, so by then every post that will
 * ever be made for the turn is in `server.calls`.
 *
 * @param {Session} s
 */
async function implicitCredit(s) {
  const r = await runHook('drain', {}, { env: s.env, args: ['--with-outcome', TURN] });
  assert.equal(r.code, 0, `drain --with-outcome exited ${r.code}:\n${r.stderr}`);
  await waitFor(() => !decideOutcome(turnFile(s)).post, 5000);
  return s.server.calls('POST', '/v2/control/outcome').map((c) => c.body);
}

/** @param {Session} s @returns {Record<string, any>[]} */
function logRows(s) {
  const p = join(s.dataDir, 'scorecard', `${SESSION}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** The `explicit` rows, without the stamps. @param {Session} s */
function explicitRows(s) {
  return logRows(s).filter((r) => r.kind === 'explicit')
    .map((r) => ({ prompt_id: r.prompt_id, ids: r.ids, outcome: r.outcome }));
}

/** @param {Session} s */
function learnedRows(s) {
  return logRows(s).filter((r) => r.kind === 'learned');
}

/** @param {Session} s @returns {Record<string, any>} */
function turnFile(s) {
  return readJsonFile(join(s.dataDir, 'runs', RUN, 'turns', `${TURN}.json`));
}

/** The title prompt-recall logged for a lesson, which is what the card quotes. @param {Session} s @param {string} ref */
function titleOf(s, ref) {
  const shown = logRows(s).find((r) => r.kind === 'shown');
  return String(shown?.lessons?.[ref]?.title ?? '');
}

/** The card's tree: the `├`/`└` lines under "N lessons shown". @param {string} card */
function treeOf(card) {
  return card.split('\n').filter((l) => /^ {2}[├└] /.test(l));
}

/**
 * Nothing the model said about memory was recorded: no explicit or learned row, and no
 * verdict merged onto the turn.
 *
 * @param {Session} s @param {string} why
 */
function assertNothingRecorded(s, why) {
  assert.deepEqual(explicitRows(s), [],
    `${why} was recorded as the model's verdict. Its entries are then left out of the implicit `
    + 'credit at Stop, and the card shows a verdict the model never gave.');
  assert.deepEqual(learnedRows(s), [],
    `${why} was counted as a lesson written, so the card says "+N learned" for a lesson that is not in memory.`);
  const turn = turnFile(s);
  assert.equal(turn.explicit_ids, undefined,
    `${why} put ids on the turn's explicit list, so the implicit outcome skips entries nobody judged.`);
  assert.equal(turn.explicit, undefined, `${why} merged a verdict onto the turn file.`);
}

// ===========================================================================
// Recorded rows
// ===========================================================================

test('mubit_outcome by short id, bracketed and bare, appends one explicit row naming the entries', async (t) => {
  const s = await session(t);
  // The recorded shape: reference_id "global", the verdict, and the ids in entry_ids. The
  // bracketed form is how the model is shown an id, so it is the likeliest to be copied.
  await outcome(s, { reference_id: 'global', outcome: 'success', entry_ids: [`[${s.hA}]`, s.hB] });

  assert.deepEqual(explicitRows(s), [{ prompt_id: TURN, ids: [REF_A, REF_B], outcome: 'success' }],
    'a Codex mubit_outcome did not land as one explicit row naming the entries its short ids '
    + 'resolve to, keyed by Codex\'s turn_id. The model\'s verdict is lost, and at Stop the plugin '
    + 'credits the same entries again on its own guess.');
  const turn = turnFile(s);
  assert.deepEqual(turn.explicit_ids, [REF_A, REF_B],
    'the verdict did not reach the turn file, which is what the implicit outcome reads to leave these entries out.');
  assert.deepEqual(turn.explicit, { [REF_A]: 'success', [REF_B]: 'success' },
    'the turn file does not say which verdict each entry got.');
});

test('a later failure call for another entry appends its own row', async (t) => {
  const s = await session(t);
  await outcome(s, { reference_id: 'global', outcome: 'success', entry_ids: [`[${s.hA}]`] });
  await outcome(s, { reference_id: 'global', outcome: 'failure', entry_ids: [`[${s.hB}]`] });

  assert.deepEqual(explicitRows(s), [
    { prompt_id: TURN, ids: [REF_A], outcome: 'success' },
    { prompt_id: TURN, ids: [REF_B], outcome: 'failure' },
  ], 'the second verdict of the turn was dropped or merged into the first. The model credited one '
    + 'lesson and faulted another; the log has to say both, in order.');
  assert.deepEqual(turnFile(s).explicit, { [REF_A]: 'success', [REF_B]: 'failure' },
    'the turn file lost one of the two verdicts, so Stop credits that entry implicitly.');
});

test('reference_id names the entry, as a full id or a short id, and "global" never does', async (t) => {
  const s = await session(t);
  await outcome(s, { reference_id: REF_B, outcome: 'failure' });
  // A model judging one entry puts its short id here and nowhere else. The MCP launcher
  // resolves it there (`codex-handles.test.mjs`), so the credit landed on REF_A.
  await outcome(s, { reference_id: `[${s.hA}]`, outcome: 'success' });
  await outcome(s, { reference_id: 'global', outcome: 'success', entry_ids: [] });

  assert.deepEqual(explicitRows(s), [
    { prompt_id: TURN, ids: [REF_B], outcome: 'failure' },
    { prompt_id: TURN, ids: [REF_A], outcome: 'success' },
  ], 'reference_id must be the verdict\'s target, a full id as itself and a short id as the entry it '
    + 'names, the way the MCP launcher sent it; and "global" (the run-level placeholder) must never '
    + 'be: a call naming only "global" judged no entry.');
});

test('an unknown short id is left out, and a call naming only unknown ids records nothing', async (t) => {
  const s = await session(t);
  const stranger = handleFor(NEVER_SHOWN);
  await outcome(s, { reference_id: 'global', outcome: 'success', entry_ids: [`[${s.hA}]`, `[${stranger}]`] });
  await outcome(s, { reference_id: 'global', outcome: 'failure', entry_ids: [stranger] });

  assert.deepEqual(explicitRows(s), [{ prompt_id: TURN, ids: [REF_A], outcome: 'success' }],
    'a short id this session never showed was recorded, either as itself or as a guess. It names '
    + 'no entry the plugin knows, so a row for it is a verdict on nothing.');
  assert.deepEqual(turnFile(s).explicit_ids, [REF_A],
    'an unresolved short id reached the turn\'s explicit list.');
});

test('partial and neutral are verdicts too', async (t) => {
  const s = await session(t);
  await outcome(s, { reference_id: 'global', outcome: 'partial', entry_ids: [`[${s.hA}]`] });
  await outcome(s, { reference_id: 'global', outcome: 'neutral', entry_ids: [s.hB] });

  assert.deepEqual(explicitRows(s), [
    { prompt_id: TURN, ids: [REF_A], outcome: 'partial' },
    { prompt_id: TURN, ids: [REF_B], outcome: 'neutral' },
  ], 'mubit_outcome accepts four outcomes; a partial or neutral verdict was dropped, so the plugin '
    + 'credits those entries implicitly over the model\'s own judgement.');
  assert.deepEqual(turnFile(s).explicit, { [REF_A]: 'partial', [REF_B]: 'neutral' });
});

test('a successful mubit_learned appends a learned row, and the card shows +1 learned', async (t) => {
  const s = await session(t);
  await learned(s, 'Run vitest with --pool=forks on CI; the threads pool hangs on the native module.');

  assert.deepEqual(learnedRows(s).map((r) => r.prompt_id), [TURN],
    'a Codex mubit_learned did not append one learned row for this turn.');
  const card = await finish(s, USES_NEITHER);
  assert.ok(card, 'the turn showed two lessons with MUBIT_CC_SESSION_SCORE=full, and Stop printed no card');
  assert.match(card.split('\n')[0], / · \+1 learned( · |$)/,
    `the card does not say a lesson was written this session:\n${card}`);
});

// ===========================================================================
// Calls that record nothing
// ===========================================================================

test('a result with isError: true records nothing, for either tool', async (t) => {
  // Spec-derived, not recorded: the MCP spec's error flag on the result object.
  const s = await session(t);
  const failed = { content: [{ type: 'text', text: 'Outcome not recorded: the endpoint answered 503.' }], isError: true };
  await outcome(s, { reference_id: 'global', outcome: 'success', entry_ids: [`[${s.hA}]`] },
    { over: { tool_response: failed }, unrecorded: SPEC_IS_ERROR });
  await learned(s, 'Run database migrations before seeding fixtures.',
    { over: { tool_response: { ...failed, content: [{ type: 'text', text: 'Lesson not recorded.' }] } }, unrecorded: SPEC_IS_ERROR });

  assertNothingRecorded(s, 'a call whose result says isError');
  const card = await finish(s, USES_NEITHER);
  assert.doesNotMatch(card, /learned/, `the card counts a lesson write that failed:\n${card}`);
});

test('a PermissionRequest for the tool records nothing', async (t) => {
  const s = await session(t);
  // Recorded: the ask carries the tool and its arguments, and no tool_use_id. It is asked
  // before the call runs, so it says nothing about whether the verdict landed.
  await hook(s, 'capture', permissionRequest({
    cwd: s.projectDir,
    tool_input: { reference_id: 'global', outcome: 'failure', entry_ids: [`[${s.hA}]`] },
  }), { args: ['--permission'] });

  assertNothingRecorded(s, 'the approval ask for a mubit_outcome call');
});

test('a declined call, asked about and never run, records nothing, and Stop credits as usual', async (t) => {
  const s = await session(t);
  // Recorded: a declined call produces the ask and then no PostToolUse at all.
  await hook(s, 'capture', permissionRequest({
    cwd: s.projectDir,
    tool_input: { reference_id: 'global', outcome: 'failure', entry_ids: [`[${s.hA}]`] },
  }), { args: ['--permission'] });
  await finish(s, USES_BOTH);

  assertNothingRecorded(s, 'a declined mubit_outcome');
  const posts = await implicitCredit(s);
  assert.equal(posts.length, 1, `expected the turn's one implicit outcome; saw ${JSON.stringify(posts)}`);
  assert.deepEqual([...posts[0].entry_ids].sort(), [REF_A, REF_B].sort(),
    'an entry named in a declined call was left out of the implicit credit. The model\'s verdict '
    + 'never ran, so the entry is owed the credit the reply earned it.');
});

test('a tool of the same name on another MCP server records nothing', async (t) => {
  const s = await session(t);
  for (const server of ['mubit_other', 'notmubit']) {
    await outcome(s, { reference_id: 'global', outcome: 'failure', entry_ids: [`[${s.hA}]`] },
      { tool: `mcp__${server}__mubit_outcome` });
    await learned(s, 'Run database migrations before seeding fixtures.', { tool: `mcp__${server}__mubit_learned` });
  }

  assertNothingRecorded(s, 'a mubit_outcome or mubit_learned served by another MCP server');
});

test('inside a subagent, mubit_outcome records nothing and mubit_learned counts, as on Claude Code', async (t) => {
  // Parity with Claude Code. There an explicit row comes from the main agent's mubit_outcome
  // only (`noteOwnTool` in the shared capture hook), and a subagent's mubit_learned is counted,
  // which `../../claude-code/test/capture-scorecard.test.mjs` pins ("a successful mubit_learned
  // appends a learned row, from a subagent too"). The two hosts run this code and print one
  // card, so the issue's "record nothing" is held to for the verdict, and the lesson count
  // follows Claude Code.
  const s = await session(t);
  await outcome(s, { reference_id: 'global', outcome: 'failure', entry_ids: [`[${s.hA}]`] },
    { over: { agent_id: AGENT }, unrecorded: IN_SUBAGENT });
  await learned(s, 'Run database migrations before seeding fixtures.',
    { over: { agent_id: AGENT }, unrecorded: IN_SUBAGENT });

  assert.deepEqual(explicitRows(s), [],
    'a subagent\'s mubit_outcome was recorded as the main turn\'s verdict. Claude Code records none, '
    + 'and the two hosts share one card.');
  assert.equal(turnFile(s).explicit_ids, undefined,
    'a subagent\'s verdict reached the parent turn\'s explicit list, so the parent\'s implicit credit skips the entry.');
  assert.equal(learnedRows(s).length, 1,
    'a lesson written by a subagent was not counted. Claude Code counts it, and the two hosts share one card.');

  await finish(s, USES_BOTH);
  const posts = await implicitCredit(s);
  assert.equal(posts.length, 1, `expected the turn's one implicit outcome; saw ${JSON.stringify(posts)}`);
  assert.ok(posts[0].entry_ids.includes(REF_A),
    'the parent turn\'s implicit credit left out an entry only a subagent judged.');
});

// ===========================================================================
// The result, read strictly
// ===========================================================================

test('a result whose text says error, with no isError, is a result: the credit is recorded', async (t) => {
  const s = await session(t);
  // Only isError marks a failed MCP call. The text is the tool's to word, and a credit whose
  // reply happens to mention an error landed all the same.
  await outcome(s, { reference_id: 'global', outcome: 'success', entry_ids: [`[${s.hA}]`] },
    { over: { tool_response: { content: [{ type: 'text', text: 'Outcome recorded. Error: none.' }] } } });

  assert.deepEqual(explicitRows(s), [{ prompt_id: TURN, ids: [REF_A], outcome: 'success' }],
    'a successful result was read as a failure from its wording, so a verdict that landed is '
    + 'missing from the log and the entry is credited again at Stop.');
});

test('a result serialised as a JSON string is still a successful result', async (t) => {
  // Defensive: Codex was recorded sending the object.
  const s = await session(t);
  await outcome(s, { reference_id: 'global', outcome: 'failure', entry_ids: [`[${s.hA}]`] },
    { over: { tool_response: JSON.stringify({ content: [{ type: 'text', text: 'Outcome recorded.' }] }) } });

  assert.deepEqual(explicitRows(s), [{ prompt_id: TURN, ids: [REF_A], outcome: 'failure' }],
    'a result delivered as a string was not recorded, so the verdict is lost.');
});

test('a result serialised as a JSON string that says isError records nothing', async (t) => {
  // Defensive: Codex was recorded sending the object, and the error flag is spec-derived.
  const s = await session(t);
  const failed = JSON.stringify({ content: [{ type: 'text', text: 'Outcome not recorded.' }], isError: true });
  await outcome(s, { reference_id: 'global', outcome: 'success', entry_ids: [`[${s.hA}]`] },
    { over: { tool_response: failed } });
  await learned(s, 'Run database migrations before seeding fixtures.',
    { over: { tool_response: JSON.stringify({ content: [{ type: 'text', text: 'Lesson not recorded.' }], isError: true }) } });

  assertNothingRecorded(s, 'a call whose result, sent as a string, says isError');
});

// ===========================================================================
// Every call counts, in the turn it was made
// ===========================================================================

test('two mubit_learned calls in one turn count twice', async (t) => {
  const s = await session(t);
  await learned(s, 'Run vitest with --pool=forks on CI.');
  await learned(s, 'Run database migrations before seeding fixtures.');

  assert.equal(learnedRows(s).length, 2,
    'two lesson writes, each its own call, were counted as one. Nothing about a second lesson in '
    + 'the same turn makes it less written.');
  const card = await finish(s, USES_NEITHER);
  assert.match(card.split('\n')[0], / · \+2 learned( · |$)/, `the card lost a lesson written:\n${card}`);
});

test('a verdict given a turn later, on a lesson the earlier turn showed, is keyed to the turn it was given in', async (t) => {
  // The model often judges a lesson once the user has answered: "that worked" is the next
  // prompt, and the credit comes in that turn. The short id was shown a turn earlier, and the
  // session log is where it still resolves. A prompt this short gets no recall, so the second
  // turn shows nothing and only the log can resolve the id.
  const s = await session(t);
  await finish(s, USES_NEITHER);
  const next = userPromptSubmit({ cwd: s.projectDir, turn_id: TURN_2, prompt: 'thanks' });
  const recall = await hook(s, 'prompt-recall', next);
  await hook(s, 'stage-prompt', next);
  assert.ok(!String(recall.json?.hookSpecificOutput?.additionalContext ?? '').includes(s.hA),
    'the second turn showed the lesson again, so this is not the case under test.');

  await outcome(s, { reference_id: 'global', outcome: 'failure', entry_ids: [`[${s.hA}]`] },
    { over: { turn_id: TURN_2 } });

  assert.deepEqual(explicitRows(s), [{ prompt_id: TURN_2, ids: [REF_A], outcome: 'failure' }],
    'a verdict on a lesson shown in the previous turn was dropped, misresolved, or filed under the '
    + 'wrong turn. The model judged it in this turn, which Codex names by its turn_id.');
  assert.equal(turnFile(s).explicit_ids, undefined,
    'the verdict was merged onto the earlier turn, whose outcome was already settled at its Stop.');
});

// ===========================================================================
// Stop
// ===========================================================================

test('an entry faulted explicitly is left out of the implicit credit, which still credits the rest', async (t) => {
  const s = await session(t);
  await outcome(s, { reference_id: 'global', outcome: 'failure', entry_ids: [`[${s.hA}]`] });
  const card = await finish(s, USES_BOTH);

  const posts = await implicitCredit(s);
  assert.equal(posts.length, 1, `expected the turn's one implicit outcome; saw ${JSON.stringify(posts)}`);
  assert.deepEqual(posts[0].entry_ids, [REF_B],
    'the implicit outcome credited an entry the model had just faulted, as a success, over its '
    + 'own verdict; or it dropped the entry the model never judged.');
  assert.equal(posts[0].outcome, 'success', 'the turn went fine; only the one entry was faulted.');

  const row = logRows(s).filter((r) => r.kind === 'turn').at(-1);
  assert.deepEqual(row?.used_refs, [REF_B],
    'the turn row\'s used_refs still names the entry the model judged, so a correction on the next '
    + 'prompt would fault it a second time.');

  assert.deepEqual(treeOf(card), ['  └ 2 used      1 failed · 1 waiting on your reply'],
    `the card does not show the model's failure verdict on the lesson it faulted:\n${card}`);
  assert.ok(card.includes(`review: "${titleOf(s, REF_A)}" failed on prompt 1`),
    `the card's review line does not name the lesson the model faulted:\n${card}`);
});

test('when every entry the reply used was credited explicitly, the implicit outcome posts nothing', async (t) => {
  const s = await session(t);
  await outcome(s, { reference_id: 'global', outcome: 'success', entry_ids: [`[${s.hA}]`, `[${s.hB}]`] });
  await finish(s, USES_BOTH);

  assert.deepEqual(decideOutcome(turnFile(s)), { post: false, reason: 'explicit_only' },
    'the turn Codex\'s hooks left behind asks for an implicit outcome on entries the model already '
    + 'judged. Each would be credited twice: once by the model, once by the plugin.');
  await implicitCredit(s);
  s.server.assertNotCalled('POST', '/v2/control/outcome');
});

test('the card verdict follows the explicit outcome, over what the reply showed', async (t) => {
  // The reply uses neither lesson, so the reply check alone says both were not used. A verdict
  // on REF_A says it was: success and partial worked, failure failed, and neutral only marks it
  // used, leaving the outcome to the next prompt, which has not come.
  const cases = /** @type {const} */ ([
    ['no call', null, ['  └ 2 not used']],
    ['success', 'success', ['  ├ 1 used      1 worked', '  └ 1 not used']],
    ['partial', 'partial', ['  ├ 1 used      1 worked', '  └ 1 not used']],
    ['failure', 'failure', ['  ├ 1 used      1 failed', '  └ 1 not used']],
    ['neutral', 'neutral', ['  ├ 1 used      1 waiting on your reply', '  └ 1 not used']],
  ]);
  for (const [name, verdict, tree] of cases) {
    const s = await session(t);
    if (verdict) await outcome(s, { reference_id: 'global', outcome: verdict, entry_ids: [`[${s.hA}]`] });
    const card = await finish(s, USES_NEITHER);
    assert.ok(card, `${name}: the turn showed two lessons with MUBIT_CC_SESSION_SCORE=full, and Stop printed no card`);
    assert.deepEqual(treeOf(card), [...tree],
      `${name}: the card does not follow the model's own verdict on the lesson it judged, so it `
      + `reports the reply check's guess instead:\n${card}`);
  }
});
