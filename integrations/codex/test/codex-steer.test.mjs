// @ts-check
/**
 * The Codex session-start block explains the memory ids, and the Claude Code one does not
 * change.
 *
 * Every injected memory line starts with a short id in brackets, such as `[m7k2q]`
 * (`lib/handles.mjs`), and that id is what the model passes in `entry_ids` of `mubit_outcome`
 * to credit or fault the entry. On Claude Code the MCP server's `instructions` say so
 * (`mcp/src/instructions.mjs`). Codex never shows the model those instructions, so the
 * SessionStart block is the only standing text a Codex model gets, and until now it never
 * said what the ids are for. Standing lessons are printed with ids, and nothing told the model
 * why.
 *
 * The claims, each against the real Codex entry point (`hooks/src/session-start.mjs`, or the
 * committed bundle under `MUBIT_CC_TEST_TARGET=dist`) run as a subprocess:
 *
 *   - with the outcome review on (`nudge` or `stop`), the block says that the bracketed id on a
 *     memory line goes in `entry_ids` of `mubit_outcome`, in one host-neutral sentence;
 *   - with the review `off`, or capture off, it does not. With capture off the session log
 *     that turns an id back into its entry is never written, so an id passed back resolves to
 *     nothing;
 *   - the sentence appears exactly once, on every source and whether or not standing lessons
 *     came back;
 *   - it costs one short sentence, measured on the rendered block;
 *   - the blocks that say no memory will be injected (unconfigured, offline) do not explain ids
 *     that will never appear;
 *   - skill references keep the Codex spelling, `mubit-memory:<name>`, with no leading slash;
 *   - the Claude Code session-start output is byte-identical to what it was before this
 *     sentence existed, because that host already gets it from the MCP instructions.
 *
 * The wording is the implementer's. These tests pin the facts the sentence has to carry (a
 * bracketed id, `entry_ids`, `mubit_outcome`), not its prose.
 *
 * `MUBIT_CC_OUTCOME_REVIEW` is set explicitly in every case, because the Codex default for it
 * is due to move from `nudge` to `stop`, and a test that leant on the default would change
 * meaning when it does.
 */

import test from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assert, assertHookContract, baseEnv, fakeMubit, makeDataDir, makeProjectDir, runHook,
  sessionStart, CODEX_ROOT, SHARED_ROOT,
} from './helpers/codex-fixtures.mjs';
import { sessionStart as ccSessionStart } from '../../claude-code/test/helpers/fixtures.mjs';
import { estimateTokens } from '../../claude-code/lib/assemble.mjs';

const RUN_ID = 'codex-steer-test';

/** The one checkpoint a `compact` source re-anchors to. */
const CHECKPOINT_ID = 'ckpt_steer_1';

/**
 * What the id sentence may add to the block, in the plugin's own estimate
 * (`lib/assemble.mjs`, four characters a token, the estimator `appendStart` and
 * `scripts/measure-context-usage.mjs` bill this block with).
 *
 * One short sentence. For scale: the per-prompt nudge in `prompt-recall.mjs` that says the same
 * thing for recalled lines costs 37, and a form that also spells out success and failure, as
 * the MCP instructions do, costs 50.
 */
const SENTENCE_TOKENS = 50;

/**
 * The whole Codex block, with no standing lessons, on `startup`.
 *
 * Measured on this tree before the sentence existed: 124 tokens (495 characters), which is the
 * three lines of tool guidance, the heading and the run line. The budget is that measurement
 * plus one sentence. Growing the block past it is a decision, not a side effect: this block is
 * injected on every startup, resume, clear and compaction.
 */
const MEASURED_BLOCK_TOKENS = 124;
const STEER_BLOCK_TOKENS = MEASURED_BLOCK_TOKENS + SENTENCE_TOKENS;

/** A bracketed handle-shaped example, such as `[m7k2q]`, or the word that names the convention. */
const BRACKET_FACT = /\[m[a-z0-9]{4}\]|bracket/i;

/** A standing-lesson bullet. It carries a real handle and explains nothing. */
const LESSON_BULLET = /^- \[m[a-z2-9]{4}\] /;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * One global lesson on the activity feed, in the shape the feed serves it: scope and type
 * nested in `metadata_json`.
 *
 * @param {string} id
 * @param {string} content
 */
function globalLesson(id, content) {
  return {
    id,
    created_at: '2026-01-01T00:00:00Z',
    entry_type: 'lesson',
    run_id: 'some-other-run',
    content,
    source: 'reflection:some-other-run',
    metadata_json: JSON.stringify({ scope: 'global', lesson_type: 'rule', importance: 'high' }),
  };
}

const LESSONS = {
  /** Nothing standing: the ids still arrive on every recalled line, so the sentence still earns its place. */
  none: { entries: [], next_page_token: '', total_visible: 0 },
  /** Two standing lessons, each rendered with its own handle. */
  some: {
    entries: [
      globalLesson('les_steer_a', 'Pin the lockfile before bumping a dependency.'),
      globalLesson('les_steer_b', 'Run the migrations before starting the dev server.'),
    ],
    next_page_token: '',
    total_visible: 2,
  },
  /** A page with more behind it: the block adds the "may be incomplete" line and a skill reference. */
  partial: {
    entries: [globalLesson('les_steer_a', 'Pin the lockfile before bumping a dependency.')],
    next_page_token: 'more',
    total_visible: 400,
  },
};

/** `runs/<run>/checkpoints.json`, as `checkpoint --pre` leaves it. */
function seedCheckpoint(dataDir) {
  const dir = join(dataDir, 'runs', RUN_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'checkpoints.json'),
    JSON.stringify([{ checkpoint_id: CHECKPOINT_ID, token_estimate: 1200, at: 1765000000000 }]));
}

/**
 * Run session-start once and return what it injected.
 *
 * @param {object} o
 * @param {'codex'|'claude-code'} [o.host]
 * @param {'off'|'nudge'|'stop'} o.review   always explicit, see the header
 * @param {keyof typeof LESSONS} [o.lessons]
 * @param {string} [o.source]
 * @param {boolean} [o.capture]
 * @param {Record<string, any>} [o.routes]  extra fake-server routes
 * @param {string} [o.endpoint]             overrides the fake server, `''` for none
 */
async function start(o) {
  const host = o.host ?? 'codex';
  const root = host === 'codex' ? CODEX_ROOT : SHARED_ROOT;
  const server = await fakeMubit({
    'POST /v2/control/activity': { json: LESSONS[o.lessons ?? 'some'] },
    ...(o.routes ?? {}),
  });
  try {
    const dataDir = makeDataDir();
    if (o.source === 'compact') seedCheckpoint(dataDir);
    const env = baseEnv({
      dataDir,
      projectDir: makeProjectDir(),
      pluginRoot: root,
      endpoint: o.endpoint ?? server.url,
      extra: {
        MUBIT_CC_RUN_STRATEGY: 'static',
        MUBIT_CC_RUN_ID: RUN_ID,
        MUBIT_CC_OUTCOME_REVIEW: o.review,
        ...(o.capture === false ? { MUBIT_CC_CAPTURE: '0' } : {}),
      },
    });
    const source = o.source ?? 'startup';
    const payload = host === 'codex' ? sessionStart({ source }) : ccSessionStart({ source });
    const r = await runHook('session-start', payload, { root, env });
    assertHookContract(r);
    const ctx = String(r.json?.hookSpecificOutput?.additionalContext ?? '');
    return { r, ctx };
  } finally {
    await server.close();
  }
}

/** Every line that names `entry_ids`: the id sentence, when there is one. */
function idLines(ctx) {
  return ctx.split('\n').filter((l) => /entry_ids/.test(l));
}

/** Lines, other than lesson bullets, that point at a bracketed id. */
function bracketLines(ctx) {
  return ctx.split('\n').filter((l) => !LESSON_BULLET.test(l) && BRACKET_FACT.test(l));
}

/**
 * The block is an active Codex steer block, so an absence asserted against it means something.
 * @param {string} ctx
 * @param {string} label
 */
function assertActiveCodexBlock(ctx, label) {
  assert.match(ctx, /^# Mubit memory is active/,
    `${label}: session-start did not inject the active steer block at all, so the absence of `
    + `the id sentence below would prove nothing. Block was:\n${ctx}`);
  assert.match(ctx, /mubit_outcome/,
    `${label}: the Codex tool guidance is missing from the block, so the absence of the id `
    + `sentence below would prove nothing. Block was:\n${ctx}`);
}

/**
 * The sentence is there, once, and carries the three facts.
 * @param {string} ctx
 * @param {string} label
 */
function assertIdSentence(ctx, label) {
  const lines = idLines(ctx);
  assert.equal(lines.length, 1,
    `${label}: the block should explain the memory ids in exactly one sentence that names `
    + '`entry_ids`. With none, a Codex model sees `[m7k2q]` on every memory line and nothing '
    + 'tells it that this is what mubit_outcome takes, so the entries that helped are never '
    + `credited and the ones that misled are never faulted. Found ${lines.length}. Block was:\n${ctx}`);
  const [line] = lines;
  assert.ok(!LESSON_BULLET.test(line),
    `${label}: the only mention of entry_ids is inside a lesson bullet, which is data, not an `
    + `instruction:\n${line}`);
  assert.match(line, /mubit_outcome/,
    `${label}: the id sentence does not name mubit_outcome, so the model is told about a `
    + `parameter without the tool it belongs to:\n${line}`);
  assert.match(line, BRACKET_FACT,
    `${label}: the id sentence does not say the id is the bracketed one on a memory line (an `
    + 'example such as [m7k2q], or the word "bracket"), so the model cannot tell which token on '
    + `the line to pass:\n${line}`);
  assert.doesNotMatch(line, /codex|claude/i,
    `${label}: the id sentence names a host. The issue asks for host-neutral wording; the same `
    + `sentence must read correctly whichever harness renders it:\n${line}`);
}

/**
 * No id sentence, and nothing else that explains the brackets.
 * @param {string} ctx
 * @param {string} label
 * @param {string} why  the consequence, for the message
 */
function assertNoIdSentence(ctx, label, why) {
  assert.deepEqual(idLines(ctx), [], `${label}: the block explains entry_ids, but ${why}. `
    + `Block was:\n${ctx}`);
  assert.deepEqual(bracketLines(ctx), [], `${label}: the block explains the bracketed ids, but `
    + `${why}. Block was:\n${ctx}`);
}

// ===========================================================================
// Present when the review is on
// ===========================================================================

// The two settings under which the plugin asks the model to credit entries by id. Under
// either, the session-start block is the only place a Codex model is told what the id is.
for (const review of /** @type {const} */ (['nudge', 'stop'])) {
  test(`outcomeReview=${review}: the block says the bracketed id goes in entry_ids of mubit_outcome`, async () => {
    const { ctx } = await start({ review });
    assertActiveCodexBlock(ctx, `outcomeReview=${review}`);
    assertIdSentence(ctx, `outcomeReview=${review}`);
  });
}

// ===========================================================================
// Absent when the review or capture is off
// ===========================================================================

// With the review off, nothing asks the model to credit by id; the sentence would be tokens
// on every session start spent on a loop the user switched off.
test('outcomeReview=off: the block does not explain the ids', async () => {
  const { ctx } = await start({ review: 'off' });
  assertActiveCodexBlock(ctx, 'outcomeReview=off');
  assertNoIdSentence(ctx, 'outcomeReview=off',
    'the user switched the outcome review off, and the sentence asks for exactly that review');
});

// With capture off the session log is never written, and that log is what turns a short id
// back into its entry. An id passed back resolves to nothing, so the sentence would ask for
// work that cannot land. The steer block itself still renders, because recall is on.
for (const review of /** @type {const} */ (['nudge', 'stop'])) {
  test(`capture off, outcomeReview=${review}: the block does not explain the ids`, async () => {
    const { ctx } = await start({ review, capture: false });
    assertActiveCodexBlock(ctx, `capture off, outcomeReview=${review}`);
    assertNoIdSentence(ctx, `capture off, outcomeReview=${review}`,
      'with capture off no session log is written, so an id passed back cannot be resolved '
      + 'to the entry it names');
  });
}

// ===========================================================================
// Exactly once
// ===========================================================================

// The block fires on every source Codex sends, and it grows sections on some of them: the
// compaction anchor on `compact`, the standing lessons when there are any, and the
// "may be incomplete" line on a partial listing. The sentence belongs to the guidance, not to
// any of those sections, so it must appear once in every shape, including with no standing
// lessons at all (the ids also arrive on every recalled line).
const SHAPES = /** @type {const} */ ([
  { source: 'startup', lessons: 'none', review: 'nudge' },
  { source: 'startup', lessons: 'some', review: 'stop' },
  { source: 'startup', lessons: 'partial', review: 'nudge' },
  { source: 'resume', lessons: 'some', review: 'nudge' },
  { source: 'clear', lessons: 'some', review: 'stop' },
  { source: 'compact', lessons: 'some', review: 'stop' },
]);

for (const shape of SHAPES) {
  const label = `source=${shape.source}, lessons=${shape.lessons}, outcomeReview=${shape.review}`;
  test(`${label}: the id sentence appears exactly once`, async () => {
    const { ctx } = await start(shape);
    assertActiveCodexBlock(ctx, label);
    if (shape.source === 'compact') {
      assert.ok(ctx.includes(CHECKPOINT_ID),
        `${label}: the compaction anchor did not render, so this case does not cover the `
        + `block it claims to. Block was:\n${ctx}`);
    }
    if (shape.lessons !== 'none') {
      assert.match(ctx, /## Standing lessons/,
        `${label}: the standing lessons did not render, so this case does not cover the block `
        + `it claims to. Block was:\n${ctx}`);
    }
    assertIdSentence(ctx, label);
    assert.equal((ctx.match(/entry_ids/g) ?? []).length, 1,
      `${label}: entry_ids is named more than once. One sentence says it; a second copy is `
      + `paid for on every session start and says nothing new. Block was:\n${ctx}`);
    assert.equal(bracketLines(ctx).length, 1,
      `${label}: more than one line explains the bracketed ids. Block was:\n${ctx}`);
  });
}

// ===========================================================================
// The budget
// ===========================================================================

// Measured on the rendered block, not on the source string: the sentence's own cost is the
// difference between the same session with the review on and off, and the whole block is held
// to the size it was measured at plus that one sentence.
test('the id sentence costs one short sentence, and the block stays within its budget', async () => {
  const off = await start({ review: 'off', lessons: 'none' });
  const on = await start({ review: 'nudge', lessons: 'none' });
  assertActiveCodexBlock(off.ctx, 'outcomeReview=off');
  assertActiveCodexBlock(on.ctx, 'outcomeReview=nudge');

  const offTokens = estimateTokens(off.ctx);
  const onTokens = estimateTokens(on.ctx);
  const added = onTokens - offTokens;

  assert.ok(added > 0,
    `the block costs ${onTokens} tokens with the review on and ${offTokens} with it off: the `
    + 'id sentence adds nothing, so it is not there.');
  assert.ok(added <= SENTENCE_TOKENS,
    `the id sentence adds ${added} tokens; the budget for it is ${SENTENCE_TOKENS}. This block `
    + 'is injected on every startup, resume, clear and compaction, so every token here is paid '
    + `on every session. Shorten the sentence.\n  Block was:\n${on.ctx}`);
  assert.ok(offTokens <= MEASURED_BLOCK_TOKENS,
    `with the review off the block costs ${offTokens} tokens, above the ${MEASURED_BLOCK_TOKENS} `
    + 'it was measured at before the id sentence existed. Only one sentence was meant to be '
    + `added, and only when the review is on.\n  Block was:\n${off.ctx}`);
  assert.ok(onTokens <= STEER_BLOCK_TOKENS,
    `the block costs ${onTokens} tokens with the review on; its budget is ${STEER_BLOCK_TOKENS} `
    + `(${MEASURED_BLOCK_TOKENS} measured, plus one sentence of ${SENTENCE_TOKENS}).\n`
    + `  Block was:\n${on.ctx}`);
});

// ===========================================================================
// The blocks that inject nothing
// ===========================================================================

// These two blocks tell the model that no memory will be injected this session. An id sentence
// in either would describe lines that are never going to appear.
test('an unconfigured install does not explain the ids', async () => {
  const { r, ctx } = await start({ review: 'stop', endpoint: '' });
  assert.match(ctx, /not configured/i,
    `with no endpoint the hook should inject the "not configured" block. Got:\n${r.stdout}`);
  assertNoIdSentence(ctx, 'unconfigured',
    'no memory will be injected this session, so there are no ids to pass back');
});

test('an offline instance does not explain the ids', async () => {
  const { r, ctx } = await start({
    review: 'stop',
    routes: { 'GET /v2/core/health': { status: 503, text: 'unavailable' } },
  });
  assert.match(ctx, /offline/i,
    `with health failing the hook should inject the offline block. Got:\n${r.stdout}`);
  assertNoIdSentence(ctx, 'offline',
    'no memory will be injected this session, so there are no ids to pass back');
});

// ===========================================================================
// Skill spelling
// ===========================================================================

// Codex lists a skill as `mubit-memory:<name>` and has no slash form. Every skill reference
// the block can carry is rendered here (the explicit forms in the guidance, the compaction
// anchor, the partial-listing line), with the id sentence in place, so a sentence that points
// at a skill has to use the Codex spelling too.
for (const review of /** @type {const} */ (['nudge', 'stop'])) {
  test(`outcomeReview=${review}: every skill reference keeps the Codex spelling`, async () => {
    const { ctx } = await start({ review, source: 'compact', lessons: 'partial' });
    assertActiveCodexBlock(ctx, `outcomeReview=${review}`);
    assert.ok(ctx.includes(CHECKPOINT_ID) && /may be incomplete/.test(ctx),
      'the compaction anchor and the partial-listing line did not both render, so this case '
      + `does not reach every skill reference the block can carry. Block was:\n${ctx}`);
    assert.doesNotMatch(ctx, /\/mubit-memory:/,
      'the block offers a Claude Code slash command to a Codex session. Codex invokes a skill as '
      + `\`mubit-memory:<name>\` and has no slash form. Block was:\n${ctx}`);
    assert.match(ctx, /(^|[^/])mubit-memory:recall\b/,
      'the block no longer names mubit-memory:recall, which is how a Codex session learns the '
      + `explicit form exists before its first turn. Block was:\n${ctx}`);
  });
}

// ===========================================================================
// Claude Code does not change
// ===========================================================================

/**
 * What the Claude Code session-start hook printed on this tree before the id sentence
 * existed, byte for byte. Claude Code already carries the convention in the MCP server's
 * `instructions`, which load into every session, so restating it here would be paid twice on
 * the most frequent injection the plugin makes.
 *
 * If you changed the Claude Code block on purpose, for a reason of its own, update these
 * literals in the same change. If you only meant to change the Codex block, the change leaked.
 */
const CLAUDE_CODE_STDOUT = {
  startup: `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: '# Mubit memory is active\n'
        + '\n'
        + `Run: ${RUN_ID} (hosted)\n`
        + '\n'
        + '## Standing lessons (global)\n'
        + 'Learned from earlier work — they may be out of date, so verify before relying on one.\n'
        + '- [mknsk] [rule] Pin the lockfile before bumping a dependency.\n'
        + '- [m6w7q] [rule] Run the migrations before starting the dev server.\n',
    },
    systemMessage: `mubit: hosted · run ${RUN_ID} · 2 global lessons`,
  })}\n`,
  compact: `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: '# Mubit memory is active\n'
        + '\n'
        + `Run: ${RUN_ID} (hosted)\n`
        + '\n'
        + '## Compacted context\n'
        + `Mubit checkpoint ${CHECKPOINT_ID} holds this run's context from before the compaction `
        + 'that just happened. Ask /mubit-memory:recall if you need detail that was compacted away.\n',
    },
    systemMessage: `mubit: hosted · run ${RUN_ID} · 0 global lessons`,
  })}\n`,
};

// All three review settings, because the setting exists on both hosts and a sentence gated on
// it alone, rather than on the host, would reach Claude Code under `nudge` and `stop`.
for (const review of /** @type {const} */ (['off', 'nudge', 'stop'])) {
  test(`Claude Code, outcomeReview=${review}: session-start output is byte-identical to before`, async () => {
    const withLessons = await start({ host: 'claude-code', review, lessons: 'some' });
    const compacted = await start({ host: 'claude-code', review, lessons: 'none', source: 'compact' });

    for (const [label, got] of [['startup', withLessons], ['compact', compacted]]) {
      assert.deepEqual(idLines(got.ctx), [],
        `Claude Code, ${label}: the block explains entry_ids. That host already gets the `
        + 'convention from the MCP instructions on every session, so the sentence is paid twice '
        + `on its most frequent injection. It belongs to the Codex branch only. Block was:\n${got.ctx}`);
    }
    assert.equal(withLessons.r.stdout, CLAUDE_CODE_STDOUT.startup,
      'the Claude Code session-start output changed on startup. This issue changes the Codex '
      + 'block only; Claude Code must print exactly what it printed before.');
    assert.equal(compacted.r.stdout, CLAUDE_CODE_STDOUT.compact,
      'the Claude Code session-start output changed on compact. This issue changes the Codex '
      + 'block only; Claude Code must print exactly what it printed before.');
  });
}
