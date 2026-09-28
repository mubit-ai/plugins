// @ts-check
/**
 * Server `instructions` — what a model that never saw the SessionStart preamble is told.
 *
 * Under Claude Code's tool search only tool *names* and the server's `instructions` field
 * load at session start; a tool's description arrives after the model has already decided to
 * go looking. So `instructions` carries the whole "when is Mubit worth reaching for" argument
 * for two populations at once:
 *
 *   - every session with tool search on, where the seven descriptions are deferred;
 *   - every **subagent**. `hooks.json` registers `SessionStart` and `UserPromptSubmit` in the
 *     parent conversation only, so a subagent is handed no steer block and no per-turn
 *     injection. A subagent that does not search has no memory of this project at all.
 *
 * The bundled server cannot supply the field. `createServer()` in `mcp/dist/server.js` calls
 * `new McpServer({ name, version })` with no options object, and no `MUBIT_*` variable feeds
 * it — the only `instructions` in that 5.9 MB bundle are the SDK's own result schema and
 * `Server._instructions`, which nothing ever sets. There is no env hook to use, so the
 * launcher fills the field in on the outbound stdio frame instead (`mcp/src/instructions.mjs`),
 * the same seam discipline `mcp/src/egress.mjs` applies to `globalThis.fetch` — except that
 * `initialize` never crosses the network, so the wrapper goes on the frame rather than on fetch.
 *
 * This file speaks real stdio to the committed `mcp/dist/index.js`, the way
 * `test/mcp-surface.test.mjs` does. The launcher holding the right constant proves nothing
 * if the frame the host actually reads does not carry it.
 *
 * Offline by construction — `mcpDrive()` points the endpoint at port 1, and `initialize` is
 * answered from the server's own state without dialling anything.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { mcpDrive, mod, PLUGIN_ROOT } from './helpers/harness.mjs';

/** The remedy every failure over the shipped frame shares. Stated once. */
const REMEDY = '\n  `instructions` is filled in by mcp/src/instructions.mjs, installed from\n'
  + '  mcp/src/launch.mjs before it imports the server, and it reaches a user only through\n'
  + '  the committed bundle:\n'
  + '    MUBIT_CC_BUILD_SKIP_SERVER=1 npm run build';

/**
 * One `initialize`, shared. Four tests below ask different questions of the same frame, and
 * a 5.9 MB server bundle costs ~120 ms to start — nothing here mutates the answer.
 */
let _init;
const handshake = () => (_init ??= mcpDrive());

// ---------------------------------------------------------------------------
// The shipped frame
// ---------------------------------------------------------------------------

// The headline. Without this field a model under tool search is offered seven bare tool names
// and no statement of when any of them is worth reaching for.
test('initialize carries a non-empty instructions string', async () => {
  const { init, stderr } = await handshake();

  assert.equal(typeof init?.instructions, 'string',
    'the initialize result carried no `instructions` field, so under tool search the model '
    + 'meets seven bare tool names with nothing saying when to use one — and a subagent, which '
    + `sees no SessionStart preamble, meets nothing at all.${REMEDY}\n  server stderr:\n${stderr || '(silent)'}`);
  assert.ok(String(init.instructions).trim().length > 0,
    `\`instructions\` was present but blank, which the host renders as no guidance.${REMEDY}`);
});

// The launcher's constant is the editable copy; the frame is what ships. If these two ever
// drifted, editing the text in source would change nothing a user sees.
test('the instructions on the wire are the launcher\'s own constant', async () => {
  const { init } = await handshake();
  const { INSTRUCTIONS } = await mod('mcp/src/instructions.mjs');

  assert.equal(init.instructions, INSTRUCTIONS,
    'the text on the wire is not the INSTRUCTIONS constant in mcp/src/instructions.mjs — '
    + `editing that constant would then change nothing a user's model reads.${REMEDY}`);
});

// The preamble's own balance, minus the run-specific parts: recall is injected, so opening a
// turn with a search is pure cost — but a negative with no positive beside it trains a model
// to never call a memory tool at all (see the steer in `hooks/src/session-start.mjs`). Both
// halves have to be here, and the subagent case is the half the preamble cannot state.
test('instructions say when searching is wasted and when it is the only option', async () => {
  const { init } = await handshake();
  const text = String(init.instructions);

  assert.match(text, /inject/i,
    'the instructions never mention that memory is injected automatically, so a model pays '
    + 'for a recall call on turn one to fetch what it was already given');
  assert.match(text, /subagent/i,
    'the instructions never mention subagents, which are the population that receives no '
    + 'SessionStart preamble and no per-turn injection — for them this text is the only '
    + 'notice that a memory exists to search');
});

// The one thing a model gets wrong unprompted. `mubit_learned`'s own description says "a
// constraint, a fix that worked, a standing preference" but never says what is NOT a lesson,
// and under tool search that description is not even loaded when the model decides to write.
test('instructions say mubit_learned is for durable claims, not session narration', async () => {
  const { init } = await handshake();
  const text = String(init.instructions);

  assert.match(text, /mubit_learned/,
    'the instructions never name mubit_learned, the only lesson-writing tool a default '
    + 'install exposes');
  assert.match(text, /\bdurable\b/i,
    'the instructions never say a lesson has to be durable, so the model writes whatever the '
    + 'session happened to contain');
  assert.match(text, /\bnarrat|\bnot a session log\b|\bsession log\b/i,
    'the instructions never rule out narrating the session, which is the failure mode this '
    + 'text exists to pre-empt — a memory full of "the user asked me to refactor X" is a '
    + 'memory whose every future recall is noise');
});

// The plugin advertises four tools that all read from memory. Choosing between them is the thing
// nobody was helped with, and under tool search the descriptions that would help are deferred.
test('instructions name the retrieval tool for each shape of question', async () => {
  const { init } = await handshake();
  const text = String(init.instructions);

  for (const [tool, why] of [
    ['mubit_recall', 'a topic stated in words'],
    ['mubit_diagnose', 'an error message from a command that just failed'],
    ['mubit_dereference', 'a reference_id the model already holds'],
    ['mubit_outcome', 'crediting what actually helped, which is what makes good memory rank'],
  ]) {
    assert.match(text, new RegExp(tool),
      `the instructions never name ${tool}, so ${why} has no tool attached to it`);
  }
});

// The guard sits in `process.stdout.write`, which carries every JSON-RPC frame this server
// will ever send. A wrapper that mangled the second frame would be a far worse bug than the
// missing field it fixes, and `mcpDrive` fails outright on a byte that is not protocol.
test('filling in instructions leaves the rest of the protocol untouched', async () => {
  const { init, results } = await mcpDrive({ steps: [{ method: 'tools/list' }, { method: 'tools/list' }] });

  assert.ok(init?.serverInfo?.name,
    'the initialize result lost its serverInfo — the guard must add a field, never rebuild the frame');
  for (const [i, r] of results.entries()) {
    assert.ok(Array.isArray(r?.result?.tools) && r.result.tools.length > 0,
      `tools/list #${i + 1} came back empty or malformed after the stdout guard was installed; `
      + 'a guard that can corrupt a later frame is worse than the missing field it fixes');
  }
});

// Instructions load before the model does anything, on every session, so they are
// always-loaded surface exactly as the tool schemas are. A number measured before this field
// existed understates what the plugin costs.
test('context-cost.json bills for the instructions', async () => {
  const { INSTRUCTIONS } = await mod('mcp/src/instructions.mjs');
  const cost = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'scripts', 'context-cost.json'), 'utf8'));
  const billed = cost.breakdown?.serverInstructions;

  assert.ok(billed, 'context-cost.json has no `breakdown.serverInstructions`, so the declared '
    + 'contextCost omits a block of text every session loads before the model does anything '
    + '.\n  Re-measure: node scripts/measure-context-cost.mjs --write');
  assert.equal(billed.chars, INSTRUCTIONS.length,
    `context-cost.json bills ${billed.chars} characters of instructions against the ${INSTRUCTIONS.length} `
    + 'the launcher ships — the declared budget describes a text that is no longer the one '
    + 'sent.\n  Re-measure: node scripts/measure-context-cost.mjs --write');
  assert.ok(billed.tokens > 0, 'instructions were measured at zero tokens, which cannot be right');
});

// ---------------------------------------------------------------------------
// The guard itself — the fall-through rule, in isolation
// ---------------------------------------------------------------------------
//
// `mcp/src/egress.mjs` states the rule this file inherits: the guard sits in the path of
// every frame the server sends, including shapes it has never seen, and it must never be
// able to break one. Each case below is a shape it must decline to touch.

test('a frame that is not an initialize result is returned by identity', async () => {
  const { guardInitialize } = await mod('mcp/src/instructions.mjs');

  for (const [label, frame] of [
    ['a tool result', { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'hi' }] } }],
    ['an error reply', { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'no' } }],
    ['a notification', { jsonrpc: '2.0', method: 'notifications/message', params: {} }],
    ['a request', { jsonrpc: '2.0', id: 3, method: 'ping' }],
  ]) {
    const out = guardInitialize(frame, 'TEXT');
    assert.equal(out.changed, false, `${label} was rewritten — only the initialize result may be touched`);
    assert.equal(out.message, frame,
      `${label} was cloned rather than passed through; the caller distinguishes "nothing to do" `
      + 'from "rewritten to the same value" by identity, so a copy here re-serialises a frame '
      + 'this code did not author');
  }
});

test('instructions the server supplied itself are never displaced', async () => {
  const { guardInitialize } = await mod('mcp/src/instructions.mjs');
  const frame = {
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      serverInfo: { name: 'mubit-memory', version: '0.9.0' },
      instructions: 'the server has its own now',
    },
  };

  const out = guardInitialize(frame, 'TEXT');
  assert.equal(out.changed, false,
    'the launcher overwrote instructions the bundled server set for itself. A rebuilt '
    + '@mubit-ai/mcp that grows its own text must win: this guard exists to fill a hole, not '
    + 'to take the field over');
  assert.equal(out.message, frame, 'an untouched frame must come back by identity');
});

test('a frame the guard cannot read is never rewritten', async () => {
  const { guardInitialize } = await mod('mcp/src/instructions.mjs');
  const initLike = {
    jsonrpc: '2.0',
    id: 1,
    result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'x' } },
  };

  for (const [label, frame, text] of [
    ['null', null, 'TEXT'],
    ['a bare string', 'not a frame', 'TEXT'],
    ['an array', [1, 2, 3], 'TEXT'],
    ['a result with no protocolVersion', { jsonrpc: '2.0', id: 1, result: { serverInfo: {} } }, 'TEXT'],
    ['a result with no serverInfo', { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } }, 'TEXT'],
    ['an initialize result but no text to add', initLike, ''],
  ]) {
    const out = guardInitialize(frame, text);
    assert.equal(out.changed, false, `${label} was rewritten`);
    assert.equal(out.message, frame,
      `${label} did not come back by identity — a shape this guard does not understand is not `
      + 'a reason to reshape somebody else\'s frame');
  }
});

// ---------------------------------------------------------------------------
// Keeping the string in step with the set it describes
// ---------------------------------------------------------------------------
//
// `f3534e5` promoted `mubit_strategies`, `mubit_checkpoint` and `mubit_memory_health` out of
// the excluded eight and into the curated default. It touched twenty-three files doing it —
// both READMEs, six skills, five test files — and not this one. So the string that is the
// entire tool surface for a subagent went on describing the set it had replaced.
//
// The two tests below are the two halves of that miss: the counts it states, and the verbs it
// names.

/** The curated set, read from the module a real session resolves. */
const CURATED = [...(await import('../lib/config.mjs')).loadConfig({}).mcpTools];

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen', 'twenty'];

// A prose count is a claim like any other. These two files argue for the curated set by
// size — "thirteen of the server's twenty-one", "four of the curated ten read from memory" —
// and a stale number there is not a typo: it is the sentence still describing the old set,
// which is exactly the state this commit found them in.
test('every stated size of the curated set is the size it actually is', async () => {
  const want = NUMBER_WORDS[CURATED.length];
  const wrong = [];

  for (const rel of ['mcp/src/instructions.mjs', 'mcp/src/launch.mjs']) {
    const src = readFileSync(join(PLUGIN_ROOT, rel), 'utf8');
    for (const line of src.split('\n')) {
      const m = /curated ([a-z]+)/.exec(line);
      if (!m || !NUMBER_WORDS.includes(m[1])) continue;
      if (m[1] !== want) wrong.push(`${rel}: "curated ${m[1]}" — ${line.trim()}`);
    }
  }

  assert.deepEqual(wrong, [], `the curated set holds ${CURATED.length} tools (${want}), but these `
    + `sentences still count the set they replaced:\n    ${wrong.join('\n    ')}\n`
    + '  A promotion that leaves the prose behind is how the instructions came to describe a tool '
    + 'set the launcher no longer ships.');
});

/**
 * Which allowlisted verbs the "Which tool" paragraph has to name, and which it may leave to
 * their descriptions.
 *
 * The split is not importance, it is whether the tool answers *a question the model is already
 * holding*. That paragraph exists to route a question to a verb, and it is the only routing a
 * subagent ever gets: a subagent is handed no steer block, no per-turn injection and no skills,
 * so a retrieval verb this string never names is one it will not reach for. Under tool search
 * the same is true of every session, because descriptions arrive only after the model has
 * decided to go looking.
 *
 * Everything else is excluded here with its reason, and the reason is the point — a fourteenth
 * tool cannot be added to the curated set without someone deciding which side of this line it
 * falls on.
 */
const ANSWERS_A_QUESTION = {
  mubit_recall: 'a topic or question stated in words',
  mubit_diagnose: 'an error from a command that just failed',
  mubit_dereference: 'a reference_id the model already holds',
};
const ANSWERS_NO_QUESTION = {
  mubit_learned: 'a write — the paragraph after it is entirely about this one',
  mubit_outcome: 'a write; named beside mubit_learned as what credits the entries that helped',
  mubit_status: 'diagnostics — reached when memory is failing, not when it is being used',
  mubit_memory_health: 'diagnostics, for the same reason',
};
// The catalogue, the pattern across lessons, a checkpoint, a delete and an explicit reflect
// left the default surface for `bin/admin.mjs`. The instructions still have to say where they
// went: a model that wants the catalogue and finds no tool for it would otherwise search.
const LEFT_FOR_SKILLS = ['strategies', 'checkpoint', 'forget', 'reflect'];

test('the instructions name every curated verb that answers a question', async () => {
  const { init } = await handshake();
  const text = String(init.instructions);

  assert.deepEqual(
    [...Object.keys(ANSWERS_A_QUESTION), ...Object.keys(ANSWERS_NO_QUESTION)].sort(),
    [...CURATED].sort(),
    'the curated set and the two lists above have diverged. Every allowlisted tool has to sit on '
    + 'one side of this line with a stated reason, or the next promotion repeats f3534e5.');

  const missing = Object.entries(ANSWERS_A_QUESTION).filter(([t]) => !text.includes(t));

  assert.deepEqual(missing.map(([t]) => t), [], 'the instructions never name '
    + `${missing.map(([t, why]) => `${t} (${why})`).join(', ')}.\n`
    + '  This string is the whole tool surface for a subagent and for any session under tool '
    + 'search, so a retrieval verb it does not name is one they will not reach for.'
    + REMEDY);
  const unrouted = LEFT_FOR_SKILLS.filter((s) => !text.includes(`:${s}`));
  assert.deepEqual(unrouted, [], `the instructions do not route ${unrouted.join(', ')} at the skill `
    + 'that now reaches it. A verb that left the tool surface without a forwarding address is one '
    + `the model will search the tool list for and not find.${REMEDY}`);
});

// ---------------------------------------------------------------------------
// The outcome loop — ids the model can cite, and the tools to cite them with
// ---------------------------------------------------------------------------
//
// Claude rarely called mubit_outcome for three reasons: memory lines carried no id to cite,
// nothing asked at the moment it mattered, and the tool sat deferred behind ToolSearch, so
// reporting cost a lookup before the call. The instructions now say where the ids are, and
// the two write tools of the loop are marked always-loaded.

test('the instructions say memory lines carry a bracketed id that mubit_outcome takes', async () => {
  const { INSTRUCTIONS } = await mod('mcp/src/instructions.mjs');
  assert.match(INSTRUCTIONS, /id in brackets/i);
  assert.match(INSTRUCTIONS, /mubit_outcome/);
  assert.match(INSTRUCTIONS, /\bsuccess\b/);
  assert.match(INSTRUCTIONS, /\bfailure\b/);
  assert.match(INSTRUCTIONS, /misled/);
});

/** A `tools/list` result as the bundled server writes it. */
function toolsList(extra = {}) {
  return {
    jsonrpc: '2.0',
    id: 2,
    result: {
      tools: [
        { name: 'mubit_recall', description: 'r', inputSchema: { type: 'object' } },
        { name: 'mubit_outcome', description: 'o', inputSchema: { type: 'object' }, _meta: { keep: 1 } },
        { name: 'mubit_learned', description: 'l', inputSchema: { type: 'object' } },
      ],
      ...extra,
    },
  };
}

test('guardToolsList marks the named tools always-loaded and leaves the rest alone', async () => {
  const { guardToolsList, ALWAYS_LOAD_META } = await mod('mcp/src/instructions.mjs');
  assert.equal(ALWAYS_LOAD_META, 'anthropic/alwaysLoad');
  const frame = toolsList();
  const out = guardToolsList(frame, ['mubit_outcome', 'mubit_learned']);
  assert.equal(out.changed, true);
  const byName = Object.fromEntries(out.message.result.tools.map((t) => [t.name, t]));
  assert.deepEqual(byName.mubit_outcome._meta, { keep: 1, 'anthropic/alwaysLoad': true });
  assert.deepEqual(byName.mubit_learned._meta, { 'anthropic/alwaysLoad': true });
  assert.equal(byName.mubit_recall, frame.result.tools[0], 'an unnamed tool was rebuilt');
  assert.equal(frame.result.tools[1]._meta['anthropic/alwaysLoad'], undefined, 'the input frame was mutated');
});

test('guardToolsList returns anything it should not touch by identity', async () => {
  const { guardToolsList } = await mod('mcp/src/instructions.mjs');
  const already = toolsList();
  already.result.tools = already.result.tools.map((t) => ({ ...t, _meta: { 'anthropic/alwaysLoad': true } }));
  for (const [label, frame, names] of [
    ['no names', toolsList(), []],
    ['names absent from the list', toolsList(), ['mubit_status']],
    ['already marked', already, ['mubit_outcome', 'mubit_learned']],
    ['a tool result', { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'x' }] } }, ['mubit_outcome']],
    ['an initialize result', { jsonrpc: '2.0', id: 1, result: { protocolVersion: 'x', serverInfo: {} } }, ['mubit_outcome']],
    ['not json-rpc', { result: { tools: [{ name: 'mubit_outcome' }] } }, ['mubit_outcome']],
    ['null', null, ['mubit_outcome']],
  ]) {
    const out = guardToolsList(frame, /** @type {string[]} */ (names));
    assert.equal(out.changed, false, `${label} was rewritten`);
    assert.equal(out.message, frame, `${label} did not come back by identity`);
  }
});

test('alwaysLoadFor names the loop\'s write tools unless the review is off or the host is Codex', async () => {
  const { alwaysLoadFor } = await mod('mcp/src/instructions.mjs');
  assert.deepEqual(alwaysLoadFor({}), ['mubit_outcome', 'mubit_learned']);
  assert.deepEqual(alwaysLoadFor({ outcomeReview: 'stop', host: 'claude-code' }), ['mubit_outcome', 'mubit_learned']);
  assert.deepEqual(alwaysLoadFor({ outcomeReview: 'nudge' }), ['mubit_outcome', 'mubit_learned']);
  assert.deepEqual(alwaysLoadFor({ outcomeReview: 'off' }), []);
  assert.deepEqual(alwaysLoadFor({ host: 'codex' }), []);
  assert.deepEqual(alwaysLoadFor(undefined), ['mubit_outcome', 'mubit_learned']);
});

/** A stand-in for `process.stdout` that records what the guard forwards. */
function fakeStream() {
  /** @type {string[]} */
  const written = [];
  return { written, write(chunk) { written.push(String(chunk)); return true; } };
}

test('the stdout guard marks tools/list on every listing, after filling initialize, byte-exact elsewhere', async () => {
  const { installInstructionsGuard } = await mod('mcp/src/instructions.mjs');
  const stream = fakeStream();
  installInstructionsGuard({ instructions: 'TEXT', stream, alwaysLoad: ['mubit_outcome'] });
  assert.deepEqual(/** @type {any} */ (stream.write).mubitInstructionsGuard.alwaysLoad, ['mubit_outcome']);

  const init = `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 'v', serverInfo: { name: 's' } } })}\n`;
  const list = `${JSON.stringify(toolsList())}\n`;
  const call = `${JSON.stringify({ jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: '"tools":[ in text' }] } })}\n`;
  stream.write(init);
  stream.write(list);
  stream.write(call);
  stream.write(list);

  assert.equal(JSON.parse(stream.written[0]).result.instructions, 'TEXT');
  for (const i of [1, 3]) {
    const tools = JSON.parse(stream.written[i]).result.tools;
    assert.equal(tools.find((t) => t.name === 'mubit_outcome')._meta['anthropic/alwaysLoad'], true);
    assert.equal(tools.find((t) => t.name === 'mubit_learned')._meta, undefined);
    assert.ok(stream.written[i].endsWith('\n'), 'the frame lost its newline');
  }
  assert.equal(stream.written[2], call, 'a tool result was re-serialised');
});

test('with nothing to mark, tools/list goes out byte for byte', async () => {
  const { installInstructionsGuard } = await mod('mcp/src/instructions.mjs');
  const stream = fakeStream();
  installInstructionsGuard({ instructions: 'TEXT', stream, alwaysLoad: [] });
  const list = `${JSON.stringify(toolsList())}\n`;
  stream.write(list);
  assert.equal(stream.written[0], list);
});

// The shipped bundle. Passes once `mcp/dist/index.js` is rebuilt from this source.
test('the shipped server lists mubit_outcome and mubit_learned as always-loaded', async () => {
  const { results } = await mcpDrive({ steps: [{ method: 'tools/list' }] });
  const tools = results[0]?.result?.tools ?? [];
  for (const name of ['mubit_outcome', 'mubit_learned']) {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `${name} is not listed`);
    assert.equal(t._meta?.['anthropic/alwaysLoad'], true,
      `${name} is still deferred behind ToolSearch.${REMEDY}`);
  }
  const recall = tools.find((x) => x.name === 'mubit_recall');
  assert.notEqual(recall?._meta?.['anthropic/alwaysLoad'], true, 'only the loop\'s write tools are always loaded');
});
