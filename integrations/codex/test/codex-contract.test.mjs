// @ts-check
/**
 * The contract gates the suite did not have.
 *
 * Every check here exists because something the host enforces was going unasserted, and the
 * suite could not have told the difference. They are grouped by what they protect:
 *
 *   1. **One JSON object on stdout, and nothing else.** Codex injects non-JSON stdout into the
 *      model's context as *developer context*. A stray `console.log` on any hook path is
 *      therefore not a debugging artefact, it is text pasted into every turn of every session.
 *      Nothing gated this.
 *   2. **`additionalContextLimit`, declared where it applies and nowhere else.** The host
 *      defaults it to 2500 tokens and, over the limit, **spills rather than truncates** — the
 *      full text goes to `<temp>/hook_outputs/` and the model gets a head-and-tail stub. Only
 *      five events can emit context at all; setting it elsewhere is warned about and discarded.
 *   3. **`tool_response` is schema-`true`** — any JSON type — and the code handled the string
 *      and object cases it had seen.
 *   4. **The rule table**, which nothing held to a size or to the events it must cover.
 *   5. **`assertWithinBudget` was exported and called zero times.** A budget nothing measures
 *      is a comment.
 */

import test from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assert, assertOutputAccepted, assertValid, assertWithinBudget, baseEnv, CODEX_ROOT,
  CODEX_EVENTS, evidence, fakeMubit, makeDataDir, makeProjectDir, mcpPostToolUse,
  outputAcceptance, outputCapabilities, queryResponse, runHook, schemaSlug,
  postToolUse, preToolUse, permissionRequest, sessionStart, sessionEnd, stop, stopContinuation,
  subagentStart, subagentStop, userPromptSubmit, preCompact, postCompact,
} from './helpers/codex-fixtures.mjs';
import { recordedAnswer } from './helpers/codex-oracle.mjs';

const RUN_ID = 'codex-contract-test';

function contractEnv(dataDir, projectDir, endpoint, extra = {}) {
  return baseEnv({
    dataDir,
    projectDir,
    endpoint,
    extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: RUN_ID, ...extra },
  });
}

/**
 * Every registration in `hooks.json`, as something this file can actually run: the script, the
 * argv it is registered with, the event it answers, and a payload of that event's shape.
 *
 * Derived from the manifest rather than listed, so a registration added without a payload
 * builder fails here instead of going untested.
 */
function registrations() {
  const tpl = JSON.parse(readFileSync(join(CODEX_ROOT, 'hooks.json'), 'utf8'));
  const builders = {
    PreToolUse: preToolUse,
    PermissionRequest: permissionRequest,
    PostToolUse: postToolUse,
    PreCompact: preCompact,
    PostCompact: postCompact,
    SessionStart: sessionStart,
    SessionEnd: sessionEnd,
    UserPromptSubmit: userPromptSubmit,
    SubagentStart: subagentStart,
    SubagentStop: subagentStop,
    Stop: stop,
  };
  const out = [];
  for (const [event, groups] of Object.entries(tpl.hooks)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        const m = /"[^"]*\/([a-z-]+)\.mjs"(.*)$/.exec(h.command);
        assert.ok(m, `cannot read a script name out of: ${h.command}`);
        assert.ok(builders[event], `no payload builder for ${event}`);
        out.push({
          event,
          script: m[1],
          args: m[2].trim() ? m[2].trim().split(/\s+/) : [],
          limit: h.additionalContextLimit,
          payload: builders[event](),
        });
      }
    }
  }
  return out;
}

// ===========================================================================
// 1. One JSON object on stdout, and nothing else
// ===========================================================================

test('every registered handler writes one JSON object and nothing else', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const projectDir = makeProjectDir({ git: true });

  for (const reg of registrations()) {
    const env = contractEnv(makeDataDir(), projectDir, server.url);
    const r = await runHook(reg.script, reg.payload, { env, args: reg.args });
    const what = `${reg.event} -> ${reg.script}${reg.args.length ? ` ${reg.args.join(' ')}` : ''}`;

    assert.equal(r.code, 0, `${what} exited ${r.code}. stderr:\n${r.stderr}`);
    const raw = r.stdout;
    if (!raw.trim()) continue;   // silence is a valid answer on every event

    // § Not `JSON.parse(raw.trim())`. That would accept `{"a":1}\nleaked line` if the leak
    //   happened to be dropped by trim, and would accept two concatenated objects on some
    //   inputs. The whole of stdout has to BE the object.
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      assert.fail(`${what} wrote stdout that is not a single JSON value. Codex injects `
        + `non-JSON stdout into the model's context as developer context, so this is pasted `
        + `into every turn:\n---\n${raw}\n---\n(${e.message})`);
    }
    assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed),
      `${what} wrote a JSON ${Array.isArray(parsed) ? 'array' : typeof parsed}, not an object:\n${raw}`);

    assertOutputAccepted(reg.event, parsed, what);
    if (reg.event !== 'SessionEnd') {
      assertValid(parsed, `${schemaSlug(reg.event)}.command.output`, what);
    }
  }
});

test('a hook that fails still writes nothing but JSON', async (t) => {
  // § The path where a stray diagnostic is most likely, and where it does most harm: the
  //   plugin is already degraded and now it is also editing the model's context.
  const server = await fakeMubit({ 'POST /v2/control/query': { status: 500, json: { error: 'nope' } } });
  t.after(() => server.close());
  const projectDir = makeProjectDir({ git: true });

  for (const reg of registrations()) {
    const env = contractEnv(makeDataDir(), projectDir, 'http://127.0.0.1:1');   // nothing listening
    const r = await runHook(reg.script, reg.payload, { env, args: reg.args });
    const what = `${reg.event} -> ${reg.script} against a dead endpoint`;
    assert.equal(r.code, 0, `${what} exited ${r.code}`);
    if (!r.stdout.trim()) continue;
    try {
      JSON.parse(r.stdout);
    } catch (e) {
      assert.fail(`${what} leaked non-JSON to stdout:\n---\n${r.stdout}\n---\n(${e.message})`);
    }
  }
});

// ---------------------------------------------------------------------------
// 1b. The same contract with the shipped defaults, on a turn that shows lessons
// ---------------------------------------------------------------------------

/**
 * The key set of an output, sorted and joined, so two outputs can be compared by shape.
 * @param {any} out
 */
const shapeOf = (out) => Object.keys(out ?? {}).sort().join(',');

/**
 * Whether the host was recorded taking an output of this exact key set on this event
 * (`observed/output-acceptance.json`). The rule table says what may not be sent; this says
 * what a real session was seen taking, and the two outputs below are new to Codex users.
 *
 * @param {string} event
 * @param {any} out
 */
function recordedAccepting(event, out) {
  return (outputAcceptance().probes ?? []).filter((p) => shapeOf(p.output) === shapeOf(out)
    && p.verdict?.[event] === 'accepted');
}

test('with the shipped defaults, a turn that showed lessons gets the review, then the card, and the host takes both', async (t) => {
  // `sessionScore` and `outcomeReview` are deliberately absent from the environment: this is
  // what a Codex user who never set them gets. The other contract tests run on payloads that
  // show no lesson, where neither the review nor the card has anything to say, so they cannot
  // see the two outputs the new defaults add to Stop.
  const server = await fakeMubit({
    'POST /v2/control/query': {
      json: queryResponse({
        evidence: [evidence({
          id: 'e1', reference_id: 'c0de0001-0000-4000-8000-000000000001', entry_type: 'lesson', score: 0.9,
          content: 'Run vitest with --pool=forks; the threads pool hangs on the native module.',
        })],
      }),
    },
  });
  t.after(() => server.close());
  const dataDir = makeDataDir();
  // Held, so the Stop hook's detached drain does not dial the fake server mid-test.
  mkdirSync(join(dataDir, 'runs', RUN_ID), { recursive: true });
  writeFileSync(join(dataDir, 'runs', RUN_ID, 'drain.lock'), JSON.stringify({ pid: process.pid, ts: Date.now() }));
  const env = contractEnv(dataDir, makeProjectDir({ git: true }), server.url);
  for (const k of ['MUBIT_CC_SESSION_SCORE', 'MUBIT_CC_OUTCOME_REVIEW']) {
    assert.ok(!(k in env), `${k} is set in the test environment, so this is not the shipped default.`);
  }

  /** Run one hook, hold its stdout to the contract, and return the parsed object. */
  async function step(script, payload, event, args = []) {
    const what = `${event} -> ${script}${args.length ? ` ${args.join(' ')}` : ''}, shipped defaults`;
    const r = await runHook(script, payload, { env, args });
    assert.equal(r.code, 0, `${what} exited ${r.code}. stderr:\n${r.stderr}`);
    if (!r.stdout.trim()) return {};
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch (e) {
      assert.fail(`${what} wrote stdout that is not one JSON value, and Codex pastes non-JSON `
        + `stdout into the model's context:\n---\n${r.stdout}\n---\n(${e.message})`);
    }
    assertOutputAccepted(event, parsed, what);
    assertValid(parsed, `${schemaSlug(event)}.command.output`, what);
    return parsed;
  }

  await step('session-start', sessionStart(), 'SessionStart');
  const prompt = userPromptSubmit({ prompt: 'why does the test runner hang on CI?' });
  await step('stage-prompt', prompt, 'UserPromptSubmit');
  const recalled = await step('prompt-recall', prompt, 'UserPromptSubmit');
  const handle = /\[(m[a-z0-9]{4})\]/.exec(String(recalled.hookSpecificOutput?.additionalContext ?? ''))?.[1];
  assert.ok(handle, 'prompt-recall injected no lesson with an id, so the turn below shows nothing '
    + `and neither the review nor the card has anything to say:\n${JSON.stringify(recalled)}`);

  // The first Stop: the review, as a block with a reason.
  const first = await step('capture', stop({
    last_assistant_message: 'Use vitest with --pool=forks: the threads pool hangs on the native module.',
  }), 'Stop', ['--stop']);
  assert.equal(first.decision, 'block',
    'under the shipped defaults the first Stop of a turn that showed a lesson must ask for the '
    + 'review (`outcomeReview: stop`). It did not, so a Codex user who never touched the setting '
    + `gets no review:\n${JSON.stringify(first)}`);
  assert.ok(recordedAccepting('Stop', first).length > 0,
    `no recorded session took a Stop output shaped {${shapeOf(first)}}, so nothing says the host `
    + 'continues a turn on it. Record one with `codex-record.mjs --update --probe block-once`.');

  // The model credits the lesson through the tool setup approves, then ends the continuation.
  await step('capture', mcpPostToolUse({
    tool_input: { reference_id: 'global', outcome: 'success', entry_ids: [handle] },
  }), 'PostToolUse');
  const second = await step('capture', stopContinuation({
    last_assistant_message: `Memory review: credited [${handle}].`,
  }), 'Stop', ['--stop']);
  assert.deepEqual(Object.keys(second).sort(), ['suppressOutput', 'systemMessage'],
    'under the shipped defaults the Stop that closes the review must carry the scorecard '
    + '(`sessionScore: full`) as {systemMessage, suppressOutput} and nothing else. Without it a '
    + `Codex user never sees the card:\n${JSON.stringify(second)}`);
  assert.equal(second.suppressOutput, true, 'the card must be sent with suppressOutput: true.');
  assert.match(second.systemMessage, /\n/, 'the card is several lines; a one-line systemMessage is not the card.');
  assert.ok(recordedAccepting('Stop', second).length > 0,
    'no recorded session took a Stop output of exactly {systemMessage, suppressOutput}, the '
    + 'pair the card is sent as, so nothing says Codex shows it rather than marking the hook '
    + 'failed on every turn. Record it with `codex-record.mjs --update --probe card`.');
});

// ===========================================================================
// 2. additionalContextLimit
// ===========================================================================

/** The five events whose output schema carries `additionalContext` at all. */
const CAN_EMIT_CONTEXT = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SubagentStart', 'UserPromptSubmit'];

test('the five events that can emit context are the five the contract lists', () => {
  // § Read off the output contract rather than asserted from memory, so the list above cannot
  //   drift away from it. `codex-payload.test.mjs` is where the contract itself is held to
  //   what a real session was recorded accepting.
  for (const event of CODEX_EVENTS) {
    if (event === 'SessionEnd') continue;               // no output wire type at all
    const emits = outputCapabilities(event).emitsAdditionalContext;
    assert.equal(emits, CAN_EMIT_CONTEXT.includes(event),
      `${event}: the contract ${emits ? 'DOES' : 'does not'} carry additionalContext, and the `
      + `list in this file says ${CAN_EMIT_CONTEXT.includes(event) ? 'it does' : 'it does not'}.`);
  }
});

test('additionalContextLimit is declared on the handlers that emit, and nowhere else', () => {
  const rec = recordedAnswer();
  // The four handlers that actually build an additionalContext block. `capture` answers
  // PostToolUse — an event that *can* emit context — and never does, so a limit there would
  // declare a budget for something that does not exist.
  const EMITTERS = ['pre-tool.mjs', 'session-start.mjs', 'prompt-recall.mjs', 'subagent-start.mjs'];

  for (const h of rec.hooks) {
    const emits = EMITTERS.some((n) => h.command.includes(n));
    if (emits) {
      assert.equal(h.additionalContextLimit, 2500,
        `${h.eventName} emits additionalContext and the host reports no explicit limit for it. `
        + 'Over the limit Codex SPILLS rather than truncates — the full block goes to a temp '
        + 'file and the model gets a head-and-tail stub — so the margin above our own 1500-token '
        + 'budget is worth stating rather than inheriting.');
    } else {
      assert.equal(h.additionalContextLimit, null,
        `${h.eventName} -> ${h.command} declares additionalContextLimit and emits no context. `
        + 'On an event that cannot emit context at all the host warns and discards it.');
    }
  }
});

test('the host accepted every limit we set, silently', () => {
  const rec = recordedAnswer();
  assert.deepEqual(rec.warnings, [],
    'the host warned about our manifest. Its warnings are how it reports a setting it '
    + 'understood and threw away — `ignoring additionalContextLimit for <event> hook: this '
    + 'event cannot emit additionalContext` is the one this gate exists for.');
});

test('the block each hook emits fits under the limit it declared', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const projectDir = makeProjectDir({ git: true });
  const dataDir = makeDataDir();
  const env = contractEnv(dataDir, projectDir, server.url);

  // A staged parent turn, so `subagent-start` has something to query against — without it that
  // hook returns early and this test would measure nothing while passing.
  await runHook('stage-prompt', userPromptSubmit(), { env });

  const cases = [
    { script: 'session-start', payload: sessionStart(), event: 'SessionStart' },
    { script: 'prompt-recall', payload: userPromptSubmit(), event: 'UserPromptSubmit' },
    { script: 'subagent-start', payload: subagentStart(), event: 'SubagentStart' },
  ];
  let measured = 0;
  for (const c of cases) {
    const r = await runHook(c.script, c.payload, { env });
    const block = r.json?.hookSpecificOutput?.additionalContext;
    if (typeof block !== 'string' || !block) continue;
    measured += 1;

    // The plugin's own estimate: four characters to a token. The point is not precision, but
    // nothing here is anywhere near a limit that would make the host spill.
    const tokens = Math.ceil(block.length / 4);
    assert.ok(tokens < 2500,
      `${c.script} emitted about ${tokens} tokens against a declared limit of 2500. Over it, `
      + 'Codex writes the block to a temp file and hands the model a stub of it — so the '
      + 'memory is technically delivered and effectively gone.');
  }
  assert.ok(measured >= 2,
    `only ${measured} of ${cases.length} hooks emitted a block, so this measured almost `
    + 'nothing. Arrange the fixtures so at least the recall paths inject.');
});

// ===========================================================================
// 3. tool_response is any JSON type
// ===========================================================================

test('every JSON type of tool_response is survivable', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const projectDir = makeProjectDir({ git: true });

  // § `"tool_response": true` in post-tool-use.command.input — the bare `true` schema, which
  //   accepts any JSON value. The code handled the string and object shapes it had seen.
  const shapes = [
    ['a number', 42],
    ['zero', 0],
    ['an array', ['one', 2, { three: true }]],
    ['a boolean', false],
    ['null', null],
    ['an empty string', ''],
    ['a nested object', { stdout: 'out', nested: { deep: [1, 2, 3] } }],
  ];

  for (const [what, value] of shapes) {
    const payload = postToolUse({ tool_response: value });
    assertValid(payload, 'post-tool-use.command.input',
      `a PostToolUse carrying ${what} as tool_response`);

    const r = await runHook('capture', payload,
      { env: contractEnv(makeDataDir(), projectDir, server.url) });
    assert.equal(r.code, 0, `capture exited ${r.code} on ${what}. stderr:\n${r.stderr}`);
    if (r.stdout.trim()) {
      assertOutputAccepted('PostToolUse', JSON.parse(r.stdout), `capture on ${what}`);
    }
  }
});

// ===========================================================================
// 4. The rule table, against a session that actually ran
// ===========================================================================

const RULES_PATH = join(CODEX_ROOT, 'test', 'fixtures', 'codex-output-rules.json');
const rulesDoc = () => JSON.parse(readFileSync(RULES_PATH, 'utf8'));

test('the rule table still covers every event that has a rule', () => {
  const doc = rulesDoc();
  const all = Object.values(doc.rules).reduce((n, rs) => n + rs.length, 0);

  // § A count floor, because the failure mode this replaces was a table that shrank without
  //   anyone noticing and went on passing every test written under it. The cross-check that
  //   the table is *right* is in codex-payload.test.mjs, against a recorded session.
  assert.ok(all >= 20, `only ${all} rules — the table has held at least 20 since it was written.`);
  for (const event of ['PreToolUse', 'PostToolUse', 'PermissionRequest']) {
    assert.ok((doc.rules[event] ?? []).length > 0,
      `${event} lost its rules. It is one of the events whose output the host refuses, so an `
      + 'empty row means nothing here can see that refusal coming.');
  }
});

test('every event has its output channels recorded', () => {
  const caps = rulesDoc().capabilities ?? {};
  for (const event of CODEX_EVENTS) {
    assert.ok(caps[event], `${event} has no capability row, so outputCapabilities() throws on `
      + 'it and any test that asks about its channels fails for the wrong reason.');
  }
});

// ===========================================================================
// 5. assertWithinBudget, actually called
// ===========================================================================

test('capture stays inside its budget', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const projectDir = makeProjectDir({ git: true });

  const run = async () => {
    const r = await runHook('capture', postToolUse(),
      { env: contractEnv(makeDataDir(), projectDir, server.url) });
    assert.equal(r.code, 0, r.stderr);
    return r.ms;
  };

  // § capture is budgeted at ~40 ms of its own work, on top of starting node. The helper
  //   subtracts a spawn floor it measures under the same load, so this is the hook's own cost
  //   and not the runner's. 120 ms is a gross-regression guard — a sleep, a retry loop, a
  //   directory walk — not a stopwatch. Note capture now reads a bounded transcript tail on
  //   this host, which is exactly the kind of addition worth a number.
  await assertWithinBudget('capture (PostToolUse)', 120, await run(), run);
});

test('prompt-recall stays inside its budget', async (t) => {
  const server = await fakeMubit();
  t.after(() => server.close());
  const projectDir = makeProjectDir({ git: true });

  const run = async () => {
    const r = await runHook('prompt-recall', userPromptSubmit(),
      { env: contractEnv(makeDataDir(), projectDir, server.url) });
    assert.equal(r.code, 0, r.stderr);
    return r.ms;
  };

  // § This one blocks the user's prompt, and the recall it performs is a network round trip
  //   against a server on loopback. Codex allows the registration 3 s; this asserts the hook
  //   is not spending them.
  await assertWithinBudget('prompt-recall (UserPromptSubmit)', 900, await run(), run);
});

// ---------------------------------------------------------------------------

