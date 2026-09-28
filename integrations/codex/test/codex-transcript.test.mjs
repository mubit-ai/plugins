// @ts-check
/**
 * `checkpoint.mjs`'s transcript reader, against a Codex rollout.
 *
 * This is the only real parser work in the port. The two hosts write conversation to disk in
 * different envelopes:
 *
 *   Claude Code  {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":…}]}}
 *   Codex        {"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":…}]}}
 *
 * Two differences, and both of them matter. The message sits under `payload` rather than
 * `message`, and the content item's own `type` is `input_text` / `output_text` where Claude
 * Code writes `text` — so a reader that keys off the item type drops every line even after it
 * finds the right envelope.
 *
 * What fails if this is wrong is quiet and expensive: `PreCompact` is the one event where the
 * plugin cannot recover later, because once the host compacts, the transcript is gone. A
 * reader that renders nothing produces a checkpoint that says "0 messages" and a session
 * whose pre-compaction context was never saved at all.
 *
 * The three properties that carry over unchanged from the Claude Code side, and are asserted
 * here rather than assumed: the window is a **tail**, it is bounded, and it is **scrubbed
 * before it is capped**.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  preCompact, runHook, baseEnv, makeDataDir, makeProjectDir, fakeMubit, tempDir,
  assertHookContract, rolloutJsonl, hookPromptText, HOOK_RUN_ID,
} from './helpers/codex-fixtures.mjs';

const RUN_ID = 'codex-transcript-test';

/** Write a rollout file and hand back its path. */
function rollout(messages) {
  const path = join(tempDir('codex-rollout-'), 'rollout.jsonl');
  writeFileSync(path, rolloutJsonl(messages));
  return path;
}

function env(dataDir, projectDir, endpoint) {
  return baseEnv({
    dataDir, projectDir, endpoint,
    extra: { MUBIT_CC_RUN_STRATEGY: 'static', MUBIT_CC_RUN_ID: RUN_ID },
  });
}

async function checkpoint(t, messages, over = {}) {
  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  const projectDir = makeProjectDir({ git: true });
  const path = rollout(messages);
  const r = await runHook('checkpoint', preCompact({ transcript_path: path, ...over }), {
    args: ['--pre'], env: env(dataDir, projectDir, server.url),
  });
  return { r, server, dataDir, path };
}

// ===========================================================================
// It reads a Codex rollout at all
// ===========================================================================

test('the reader renders a Codex rollout, not an empty snapshot', async (t) => {
  const { r, server } = await checkpoint(t, [
    { role: 'user', text: 'Port the plugin to Codex.' },
    { role: 'assistant', text: 'Starting with the probe spike.' },
  ]);

  assertHookContract(r);
  const call = server.lastCall('POST', '/v2/control/checkpoint');
  // § The failure this catches is silent: `renderEntry` finds no `message` key, falls back to
  //   the whole envelope, finds no `content` there either, and returns '' for every line. The
  //   hook exits 0, reports "no readable transcript text", and the session's pre-compaction
  //   context is gone for good.
  assert.ok(call, 'nothing was checkpointed. A Codex rollout read as zero messages is the '
    + 'default failure of this port, and PreCompact is the one event with no second chance.');
  const text = String(call.body?.context ?? call.body?.text ?? JSON.stringify(call.body));
  assert.match(text, /Port the plugin to Codex/, 'the user turn is missing from the snapshot.');
  assert.match(text, /Starting with the probe spike/, 'the assistant turn is missing.');
});

test('each line is rendered as "<role>: <text>", the same shape both hosts produce', async (t) => {
  const { server } = await checkpoint(t, [
    { role: 'user', text: 'alpha-marker' },
    { role: 'assistant', text: 'beta-marker' },
  ]);
  const body = JSON.stringify(server.lastCall('POST', '/v2/control/checkpoint')?.body ?? {});
  // § The rendering is what the server stores and what a later recall shows a model. Two hosts
  //   producing two shapes would make one project's checkpoints unreadable next to the other's.
  assert.match(body, /user: alpha-marker/, 'the user role prefix is missing.');
  assert.match(body, /assistant: beta-marker/, 'the assistant role prefix is missing.');
});

test('the content item type is input_text / output_text, and both are read', async (t) => {
  const path = join(tempDir('codex-rollout-'), 'rollout.jsonl');
  writeFileSync(path, [
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'in-marker' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'out-marker' }] } }),
  ].join('\n') + '\n');

  const server = await fakeMubit();
  t.after(() => server.close());
  const dataDir = makeDataDir();
  await runHook('checkpoint', preCompact({ transcript_path: path }), {
    args: ['--pre'], env: env(dataDir, makeProjectDir({ git: true }), server.url),
  });
  const body = JSON.stringify(server.lastCall('POST', '/v2/control/checkpoint')?.body ?? {});
  // § `messageText` rejects any block whose `type` it does not recognise — deliberately, so a
  //   tool_use or an image block does not spend the 200 KB window. `input_text`/`output_text`
  //   fall into that rejection unless they are named, which is the second half of the port's
  //   only parser change.
  assert.match(body, /in-marker/, 'input_text blocks were dropped — that is every user turn.');
  assert.match(body, /out-marker/, 'output_text blocks were dropped — that is every assistant turn.');
});

// ===========================================================================
// What it must NOT render
// ===========================================================================

test('the machinery lines are skipped', async (t) => {
  const { server } = await checkpoint(t, [{ role: 'user', text: 'a real turn' }]);
  const body = JSON.stringify(server.lastCall('POST', '/v2/control/checkpoint')?.body ?? {});
  // § A rollout is mostly not conversation: session_meta, turn_context, world_state,
  //   token_count, and a `reasoning` item carrying an encrypted blob. Rendering them spends the
  //   window on the one part of the session that is not being thrown away — and the encrypted
  //   reasoning payload is a base64 wall that would fill 200 KB on its own.
  assert.doesNotMatch(body, /session_meta|turn_context|world_state|token_count/,
    'rollout machinery was rendered into the snapshot.');
  assert.doesNotMatch(body, /gAAAA/,
    'the encrypted reasoning blob was rendered. It carries no readable content and would fill '
    + 'the whole window.');
});

test('a Claude Code transcript still reads correctly', async (t) => {
  const path = join(tempDir('cc-transcript-'), 'transcript.jsonl');
  writeFileSync(path, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'cc-user-marker' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'cc-assistant-marker' }] } }),
  ].join('\n') + '\n');

  const server = await fakeMubit();
  t.after(() => server.close());
  await runHook('checkpoint', preCompact({ transcript_path: path }), {
    args: ['--pre'], env: env(makeDataDir(), makeProjectDir({ git: true }), server.url),
  });
  const body = JSON.stringify(server.lastCall('POST', '/v2/control/checkpoint')?.body ?? {});
  // § The sniff is per line, not per file, and it has to leave the existing shape alone. The
  //   1067-test Claude Code suite is the real net for this; the assertion is here because this
  //   is the file that introduced the branch — and because a Codex session and a Claude Code
  //   session share a data directory, so one run really can hold both kinds of checkpoint.
  assert.match(body, /user: cc-user-marker/, 'the Claude Code envelope stopped rendering.');
  assert.match(body, /assistant: cc-assistant-marker/, 'the Claude Code envelope stopped rendering.');
});

// ===========================================================================
// Stop-hook feedback is not a user turn
// ===========================================================================

// When a Stop hook blocks, Codex (0.154.0) writes the reason as a `user` record wrapped in
// `<hook_prompt hook_run_id="stop:…">…</hook_prompt>`. A snapshot that renders it as
// `user: …` hands a later recall the outcome review as though the person had asked for it.

const REVIEW = 'Before you finish: say which of the lessons in context helped.';

/** The snapshot the hook posted, as text. */
function snapshotOf(server) {
  return String(server.lastCall('POST', '/v2/control/checkpoint')?.body?.context_snapshot ?? '');
}

/**
 * The snapshot's entries that are rendered as the user's. An entry is `<role>: <text>`, and a
 * text can run over several lines, so an entry ends where the next `<role>: ` begins.
 */
function userTurns(snapshot) {
  return snapshot.split(/\n(?=[A-Za-z_]+: )/).filter((e) => e.startsWith('user:'));
}

test('Stop-hook feedback is never rendered as a user turn, and the conversation around it is', async (t) => {
  const { server } = await checkpoint(t, [
    { role: 'user', text: 'Port the plugin to Codex.' },
    { role: 'assistant', text: 'Ported.' },
    { hookPrompt: REVIEW },
    { role: 'assistant', text: 'Reviewed: the drain lesson helped.' },
  ]);
  const snapshot = snapshotOf(server);
  assert.ok(snapshot, `nothing was checkpointed; saw ${server.summary()}`);
  for (const turn of userTurns(snapshot)) {
    assert.ok(!turn.includes('hook_prompt') && !turn.includes(REVIEW),
      `Stop-hook feedback was rendered as the user's: ${JSON.stringify(turn.slice(0, 160))}. The `
      + 'snapshot is what a later session is briefed from, and it would read the review as a request.');
  }
  assert.match(snapshot, /^user: Port the plugin to Codex\.$/m, 'the real user turn is missing.');
  assert.match(snapshot, /^assistant: Ported\.$/m, 'the answer before the feedback is missing.');
  assert.match(snapshot, /^assistant: Reviewed: the drain lesson helped\.$/m,
    'the answer after the feedback is missing. Only the feedback is the host\'s; what the '
    + 'assistant said next is still the conversation.');
});

test('several in a row, whitespace before the tag, another attribute order: none is a user turn', async (t) => {
  const { server } = await checkpoint(t, [
    { role: 'user', text: 'real-user-marker' },
    { role: 'assistant', text: 'first answer' },
    { hookPrompt: 'reason-one', lead: '\n' },
    { hookPrompt: 'reason-two', attrs: `source="stop" hook_run_id="${HOOK_RUN_ID}"` },
    { hookPrompt: 'reason-three', lead: '  ' },
    { role: 'assistant', text: 'second answer' },
  ]);
  const snapshot = snapshotOf(server);
  const users = userTurns(snapshot);
  assert.deepEqual(users, ['user: real-user-marker'],
    'every user entry but the typed one is Stop-hook feedback rendered in the user\'s voice: '
    + JSON.stringify(users.map((u) => u.slice(0, 80))));
  assert.match(snapshot, /^assistant: second answer$/m, 'the assistant turn after the feedback is missing.');
});

test('a user who mentions hook_prompt, mid-message or opening it, is still the user', async (t) => {
  // No run id in the mention: the snapshot is redacted, and a path in one reads as high-entropy.
  const said = 'why does my rollout show a <hook_prompt hook_run_id="stop:0"> line after every turn?';
  const opens = '<hook_prompt> keeps showing up after every turn. What writes it?';
  const { server } = await checkpoint(t, [
    { role: 'user', text: said },
    { role: 'assistant', text: 'That is how Codex stores Stop-hook feedback.' },
    { role: 'user', text: opens },
    { role: 'assistant', text: 'Codex does, when a Stop hook blocks.' },
  ]);
  assert.deepEqual(userTurns(snapshotOf(server)), [`user: ${said}`, `user: ${opens}`],
    'a person asking about the wrapper lost their turn. Only a block that is one whole '
    + '<hook_prompt …>…</hook_prompt> element is the host\'s.');
});

test('a Claude Code transcript that mentions hook_prompt still renders as before', async (t) => {
  const path = join(tempDir('cc-transcript-'), 'transcript.jsonl');
  const said = 'why does <hook_prompt> appear in the Codex rollout but not here?';
  writeFileSync(path, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: said }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'cc-assistant-marker' }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'cc-user-marker' } }),
  ].join('\n') + '\n');

  const server = await fakeMubit();
  t.after(() => server.close());
  await runHook('checkpoint', preCompact({ transcript_path: path }), {
    args: ['--pre'], env: env(makeDataDir(), makeProjectDir({ git: true }), server.url),
  });
  const snapshot = snapshotOf(server);
  // Claude Code never writes the wrapper, and a Codex session and a Claude Code session can share
  // one data directory — so the Codex filter has to leave this envelope exactly as it was.
  assert.deepEqual(userTurns(snapshot), [`user: ${said}`, 'user: cc-user-marker'],
    'the Claude Code envelope stopped rendering its user turns.');
  assert.match(snapshot, /^assistant: cc-assistant-marker$/m, 'the Claude Code envelope stopped rendering.');
});

test('several feedback elements in one block are dropped whole, however they are separated', async (t) => {
  // Two Stop hooks that block on the same turn can leave both reasons in one text block.
  const { server } = await checkpoint(t, [
    { role: 'user', text: 'real-user-marker' },
    { role: 'assistant', text: 'first answer' },
    { role: 'user', text: `${hookPromptText('reason-one')}\n${hookPromptText('reason-two')}` },
    { role: 'user', text: `\n${hookPromptText('reason-three')}${hookPromptText('reason-four')}\n` },
    { role: 'user', text: [hookPromptText('reason-five'), hookPromptText('reason-six')] },
    { role: 'assistant', text: 'second answer' },
  ]);
  const snapshot = snapshotOf(server);
  assert.deepEqual(userTurns(snapshot), ['user: real-user-marker'],
    'a block holding more than one Stop-hook reason was rendered in the user\'s voice: '
    + `${JSON.stringify(userTurns(snapshot).map((u) => u.slice(0, 80)))}. A later session briefed `
    + 'from this snapshot would read both reviews as requests the user made.');
  assert.doesNotMatch(snapshot, /reason-(?:one|two|three|four|five|six)/,
    'a Stop-hook reason survived into the snapshot under some other role');
  assert.match(snapshot, /^assistant: second answer$/m, 'the assistant turn after the feedback is missing.');
});

test('a feedback element followed by the user\'s own words is the user\'s turn, verbatim', async (t) => {
  // No run id in the element: the snapshot is redacted, and a path in one reads as high-entropy.
  const said = '<hook_prompt hook_run_id="stop:0">run the tests first</hook_prompt>\nWhy did Codex send me this?';
  const { server } = await checkpoint(t, [
    { role: 'user', text: said },
    { role: 'assistant', text: 'A Stop hook blocked with that reason.' },
  ]);
  assert.deepEqual(userTurns(snapshotOf(server)), [`user: ${said}`],
    'the user\'s question was dropped because it opens with a whole feedback element. Only a block '
    + 'that is nothing but feedback elements is the host\'s; words after them are the user\'s.');
});

// ===========================================================================
// The rest of what the host writes in the user's voice
// ===========================================================================

// A Codex `user` record carries two kinds of text nobody typed. The preamble — the plugin
// listing, the environment block, AGENTS.md, a mentioned file, a skill body — is the host
// briefing the model, and a session is briefed afresh after compaction anyway. A shell command
// the user ran from the composer, and a turn the user interrupted, are things the user did:
// after compaction they are what explains why the work went the way it did, and this snapshot
// is the only place they survive it.

const PREAMBLE = [
  '<recommended_plugins>\nrecommended-plugins-marker: available but not installed.\n</recommended_plugins>',
  '<environment_context>\n  <shell>zsh</shell>\n  environment-context-marker\n</environment_context>',
];
const AGENTS_MD = '# AGENTS.md instructions for the project\n\nagents-md-marker: run the linter before a commit.';
const FILES_MENTIONED = '# Files mentioned by the user\n\nfiles-mentioned-marker: the body of a file the user named.';
const SKILL = '<skill name="release-notes">\nskill-body-marker: write the notes in the past tense.\n</skill>';
const PREAMBLE_MARKERS = [
  'recommended_plugins', 'recommended-plugins-marker', 'environment_context', 'environment-context-marker',
  'AGENTS.md instructions', 'agents-md-marker', 'Files mentioned', 'files-mentioned-marker',
  '<skill', 'skill-body-marker',
];

/**
 * A shell command the user ran, and what it printed. What the code recognises is the opening
 * `<user_shell_command>`; the layout inside it is illustrative, and what is asserted is that
 * the command and its output both reach the snapshot.
 */
const SHELL_COMMAND = 'npm test -- --grep drain';
const SHELL_OUTPUT = 'shell-output-marker: 2 failing';
const USER_SHELL = '<user_shell_command>\n<command>\n' + SHELL_COMMAND + '\n</command>\n<result>\n'
  + 'Exit code: 1\nOutput:\n' + SHELL_OUTPUT + '\n</result>\n</user_shell_command>';
const ABORTED = '<turn_aborted>\nThe previous turn was aborted by the user.\n</turn_aborted>';

/** One session with every kind of host text in it, in the order a real one would carry them. */
const HOST_TEXT_SESSION = [
  { role: 'user', text: [...PREAMBLE, AGENTS_MD] },
  { role: 'user', text: 'Find out why the drain stops.' },
  { role: 'assistant', text: 'Looking at the drain.' },
  { role: 'user', text: USER_SHELL },
  { role: 'assistant', text: 'Two tests fail in the drain suite.' },
  { role: 'user', text: ABORTED },
  { role: 'user', text: [SKILL, FILES_MENTIONED, 'Fix only the first failure.'] },
  { hookPrompt: REVIEW },
  { role: 'assistant', text: 'Fixed the first failure.' },
];

test('the host preamble and Stop-hook feedback are dropped from the snapshot, the typed turns kept', async (t) => {
  const { server } = await checkpoint(t, HOST_TEXT_SESSION);
  const snapshot = snapshotOf(server);
  assert.ok(snapshot, `nothing was checkpointed; saw ${server.summary()}`);
  for (const marker of PREAMBLE_MARKERS) {
    assert.ok(!snapshot.includes(marker),
      `the host preamble reached the snapshot (${JSON.stringify(marker)}). It is the host briefing the `
      + 'model, which happens again after compaction, and here it spends the window and reads as '
      + 'something the user said.');
  }
  assert.ok(!snapshot.includes('hook_prompt') && !snapshot.includes(REVIEW),
    'Stop-hook feedback reached the snapshot beside the shell command and the aborted turn. Keeping '
    + 'what the user did must not bring back what the host said.');
  assert.match(snapshot, /^user: Find out why the drain stops\.$/m, 'the typed prompt is missing.');
  assert.match(snapshot, /^user: Fix only the first failure\.$/m,
    'the prompt that shared its record with a skill body and a mentioned file is missing. The '
    + 'preamble blocks are dropped one by one, not the record they ride on.');
  assert.match(snapshot, /^assistant: Fixed the first failure\.$/m, 'the last assistant turn is missing.');
});

test('a shell command the user ran stays in the snapshot, with what it printed', async (t) => {
  const { server } = await checkpoint(t, HOST_TEXT_SESSION);
  const snapshot = snapshotOf(server);
  assert.ok(snapshot, `nothing was checkpointed; saw ${server.summary()}`);
  assert.ok(snapshot.includes(SHELL_COMMAND),
    'the shell command the user ran was dropped from the snapshot. After compaction nothing else '
    + 'records that the user ran it, and the next turn\'s "two tests fail" loses its cause.');
  assert.ok(snapshot.includes(SHELL_OUTPUT),
    'the output of the user\'s shell command was dropped from the snapshot. It is what the '
    + 'assistant was answering, and the session cannot re-anchor on it once compaction runs.');
});

test('a turn the user interrupted stays in the snapshot', async (t) => {
  const { server } = await checkpoint(t, HOST_TEXT_SESSION);
  const snapshot = snapshotOf(server);
  assert.ok(snapshot, `nothing was checkpointed; saw ${server.summary()}`);
  assert.ok(snapshot.includes('<turn_aborted>'),
    'the aborted-turn marker was dropped from the snapshot. Without it a later session reads the '
    + 'interrupted work as finished and picks up after it, instead of where the user stopped it.');
});

// ===========================================================================
// Redaction and bounds
// ===========================================================================

test('a secret in the rollout never reaches the wire', async (t) => {
  const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
  const { server } = await checkpoint(t, [
    { role: 'user', text: `deploy with OPENAI_API_KEY=${key}` },
    { role: 'assistant', text: 'done' },
  ]);
  const raw = server.lastCall('POST', '/v2/control/checkpoint')?.raw ?? '';
  // § The transcript is the densest secret surface the plugin ever touches, and a
  //   rollout is no different — Codex records the same shell commands. Every stage of the
  //   snapshot is individually caught, and a stage that fails yields no snapshot at all: an
  //   unredacted transcript is not an acceptable degraded mode.
  assert.ok(!raw.includes(key),
    'an API key from the rollout reached the wire. Nothing about the Codex envelope may skip '
    + 'the scrub — the redaction runs after the tail is picked and before it is capped.');
});

test('the snapshot is a tail, and it is bounded', async (t) => {
  const filler = 'x'.repeat(2_000);
  const messages = [];
  for (let i = 0; i < 200; i++) messages.push({ role: 'user', text: `msg-${i} ${filler}` });
  messages.push({ role: 'assistant', text: 'LAST-MESSAGE-MARKER' });

  const { server } = await checkpoint(t, messages);
  const body = JSON.stringify(server.lastCall('POST', '/v2/control/checkpoint')?.body ?? {});
  // § Backwards is what makes it a tail. A forward walk with a cap yields the beginning of the
  //   session, which is the half compaction is least likely to throw away.
  assert.match(body, /LAST-MESSAGE-MARKER/, 'the newest message is missing — this is not a tail.');
  assert.doesNotMatch(body, /msg-0 /, 'the oldest message survived a 400 KB transcript with a 200 KB window.');
  assert.ok(body.length < 400_000,
    `the snapshot is ${body.length} bytes. The window is 200 KB, and PreCompact is a hook the `
    + 'user is waiting on.');
});

// ===========================================================================
// Degenerate transcripts
// ===========================================================================

const DEGENERATE = [
  ['an absent file', '/tmp/definitely-not-a-file-8f3a2b.jsonl'],
  ['a directory where a file is expected', '/tmp'],
];

for (const [label, path] of DEGENERATE) {
  test(`${label} costs the checkpoint, not the compaction`, async (t) => {
    const server = await fakeMubit();
    t.after(() => server.close());
    const r = await runHook('checkpoint', preCompact({ transcript_path: path }), {
      args: ['--pre'], env: env(makeDataDir(), makeProjectDir({ git: true }), server.url),
    });
    // § The compaction happens whatever this hook does. Exiting non-zero would surface an
    //   error to the user in the middle of it, over a checkpoint they did not ask for.
    assertHookContract(r);
    server.assertNotCalled('POST', '/v2/control/checkpoint');
    assert.match(String(r.json?.systemMessage ?? ''), /\S/,
      'a checkpoint that could not be saved must say so: systemMessage is the only channel '
      + 'PreCompact has under Codex, and losing the context silently is the worse failure.');
  });
}

test('a rollout of nothing but machinery is reported, not invented', async (t) => {
  const path = join(tempDir('codex-rollout-'), 'rollout.jsonl');
  writeFileSync(path, [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'x' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
  ].join('\n') + '\n');

  const server = await fakeMubit();
  t.after(() => server.close());
  const r = await runHook('checkpoint', preCompact({ transcript_path: path }), {
    args: ['--pre'], env: env(makeDataDir(), makeProjectDir({ git: true }), server.url),
  });
  assertHookContract(r);
  // § "No messages" and "a snapshot of zero messages" have to be different outcomes. Posting
  //   the second tells the user their context was saved when it was not.
  server.assertNotCalled('POST', '/v2/control/checkpoint');
});
