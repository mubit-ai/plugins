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
  assertHookContract, rolloutJsonl, HOOK_RUN_ID,
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
