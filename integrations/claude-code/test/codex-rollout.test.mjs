// @ts-check
/**
 * `lib/codex-rollout.mjs` — the injected-text filter, and `firstUserText` reading through it.
 *
 * From Codex 0.149 the first `user` record of every thread is the host's own preamble — a
 * `<recommended_plugins>` listing and an `<environment_context>` block — and the prompt the
 * person typed is the record after it. `firstUserText` is the `Q:` of every Codex subagent
 * capture, so without the filter every subagent since that version has been stored as an
 * answer to a plugin listing. The outcome reader in this module is covered by the Codex
 * suite (`integrations/codex/test/codex-outcome.test.mjs`); this file is about the filter.
 *
 * The same holds for Stop-hook feedback. When a Stop hook blocks with a reason, Codex (seen on
 * 0.154.0) stores the reason as a `user` record wrapped in
 * `<hook_prompt hook_run_id="stop:…">REASON</hook_prompt>`. Nobody typed it, and once the
 * outcome review runs on Codex every review would read as the user's own words.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { lib, makeDataDir } from './helpers/harness.mjs';

let _mod;
const R = async () => (_mod ??= await lib('codex-rollout.mjs'));

const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

const META = {
  type: 'session_meta',
  payload: { id: '01a0-thread', cwd: '/r/app', cli_version: '0.153.4', thread_source: 'subagent' },
};

/** A `user` record with one `input_text` block per argument, the way Codex writes one. */
const user = (...texts) => ({
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: texts.map((text) => ({ type: 'input_text', text })) },
});

const PREAMBLE = [
  '<recommended_plugins>\nHere is a list of plugins that are available but not installed.\n</recommended_plugins>',
  '<environment_context>\n  <cwd>/r/app</cwd>\n  <shell>zsh</shell>\n</environment_context>',
];

function rollout(records) {
  const p = join(makeDataDir(), 'rollout-2026-09-07T12-00-00-01a0-thread.jsonl');
  writeFileSync(p, jsonl(records));
  return p;
}

describe('isInjectedUserText', () => {
  it('recognises every envelope the host writes in a user\'s voice', async () => {
    const { isInjectedUserText } = await R();
    for (const text of [
      '<environment_context>\n  <cwd>/r/app</cwd>\n</environment_context>',
      '<recommended_plugins>\nHere is a list',
      '<turn_aborted>\nThe previous turn was aborted',
      '<user_shell_command>ls -la</user_shell_command>',
      '<skill name="x">…',
      '<image src="…"/>',
      '# AGENTS.md instructions for /r/app\n\n…',
      '# Files mentioned by the user\n…',
      '  <environment_context>leading whitespace is still the host',
    ]) {
      assert.equal(isInjectedUserText(text), true, `should be injected: ${JSON.stringify(text.slice(0, 40))}`);
    }
  });

  it('leaves what a person typed alone, including a quoted tag mid-sentence', async () => {
    const { isInjectedUserText } = await R();
    for (const text of [
      'fix the auth bug',
      'why does <environment_context> show the wrong cwd?',
      'AGENTS.md says to run the linter first',
      '',
      /** @type {any} */ (null),
      /** @type {any} */ (42),
    ]) {
      assert.equal(isInjectedUserText(text), false, `should be a person: ${JSON.stringify(text)}`);
    }
  });

  it('stripInjectedBlocks removes whole blocks and keeps the rest in order', async () => {
    const { stripInjectedBlocks } = await R();
    const content = [
      { type: 'input_text', text: PREAMBLE[0] },
      { type: 'input_text', text: 'do the thing' },
      { type: 'input_text', text: PREAMBLE[1] },
      { type: 'input_image', image_url: 'data:…' },
    ];
    assert.deepEqual(stripInjectedBlocks(content), [content[1], content[3]]);
    assert.equal(stripInjectedBlocks(PREAMBLE[0]), '', 'a string is one block');
    assert.equal(stripInjectedBlocks('do the thing'), 'do the thing');
    assert.equal(stripInjectedBlocks(undefined), undefined, 'anything unrecognised passes through');
  });
});

describe('firstUserText', () => {
  it('skips the 0.149+ preamble and returns the task on the record after it', async () => {
    const { firstUserText } = await R();
    const path = rollout([META, user(...PREAMBLE), user('Find every call site of drain() and list them.')]);
    assert.equal(firstUserText(path), 'Find every call site of drain() and list them.');
  });

  it('keeps a task that shares its record with an injected block', async () => {
    const { firstUserText } = await R();
    const path = rollout([META, user(PREAMBLE[1], 'do the thing')]);
    assert.equal(firstUserText(path), 'do the thing');
  });

  it('answers nothing when the only user text is the host\'s', async () => {
    const { firstUserText } = await R();
    const path = rollout([META, user(...PREAMBLE)]);
    assert.equal(firstUserText(path), '', 'the caller falls back to the parent\'s staged prompt');
  });

  it('still reads a pre-0.149 rollout, whose first user record is the prompt', async () => {
    const { firstUserText } = await R();
    const path = rollout([
      { ...META, payload: { ...META.payload, cli_version: '0.146.0' } },
      user('Summarise the failing tests.'),
    ]);
    assert.equal(firstUserText(path), 'Summarise the failing tests.');
  });
});

// ---------------------------------------------------------------------------
// Stop-hook feedback: `<hook_prompt>` on a `user` record
// ---------------------------------------------------------------------------

/** The observed hook run id shape, `stop:<n>:<hooks.json>`, with a placeholder path. */
const HOOK_RUN_ID = 'stop:0:/tmp/codex/plugins/mubit-memory/hooks.json';

/** The text Codex writes for a blocked Stop's reason. `lead` is whatever precedes the tag. */
const hookPromptText = (reason, lead = '') =>
  `${lead}<hook_prompt hook_run_id="${HOOK_RUN_ID}">${reason}</hook_prompt>`;

/** The whole `user` record, with the metadata the host adds to it. */
const hookPrompt = (reason, lead = '') => ({
  type: 'response_item',
  payload: {
    type: 'message',
    id: 'msg_0a0a0a0a-0000-4000-8000-000000000000',
    role: 'user',
    content: [{ type: 'input_text', text: hookPromptText(reason, lead) }],
    internal_chat_message_metadata_passthrough: {
      turn_id: '0a0a0a0a-0000-4000-8000-000000000001', create_time: 1790000000.5, content_item_kinds: ['unknown'],
    },
  },
});

const assistant = (text) => ({
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
});

const REVIEW = 'Before you finish: say which of the lessons in context helped.';

describe('Stop-hook feedback is the host talking, not the user', () => {
  it('isInjectedUserText recognises the wrapper, whatever precedes the tag or orders its attributes', async () => {
    const { isInjectedUserText } = await R();
    // Only the first is the shape observed on 0.154.0. The rest are margins a host update could
    // plausibly produce: whitespace around the block, another attribute, or none. The attribute
    // is not what makes it the host's; a block that is one whole element is.
    for (const text of [
      hookPromptText(REVIEW),
      hookPromptText(REVIEW, '\n'),
      hookPromptText(REVIEW, '  \n\t'),
      `${hookPromptText(REVIEW)}\n`,
      `<hook_prompt source="stop" hook_run_id="${HOOK_RUN_ID}">${REVIEW}</hook_prompt>`,
      `<hook_prompt\n  hook_run_id="${HOOK_RUN_ID}">${REVIEW}</hook_prompt>`,
      `<hook_prompt>${REVIEW}</hook_prompt>`,
      hookPromptText('Line one of the reason.\nLine two of the reason.'),
    ]) {
      assert.equal(isInjectedUserText(text), true,
        `Stop-hook feedback read as typed text: ${JSON.stringify(text.slice(0, 60))}. Every `
        + 'reader that walks user messages would take the review for something the user asked.');
    }
  });

  it('isInjectedUserText leaves a person who mentions the wrapper alone', async () => {
    const { isInjectedUserText } = await R();
    // Codex writes the feedback as a block that is one whole element, open tag to close tag.
    // A person who opens a message with the tag, or quotes a whole element inside a sentence,
    // is asking about it.
    for (const text of [
      `why does <hook_prompt hook_run_id="${HOOK_RUN_ID}"> show up in my rollout?`,
      'the `<hook_prompt>` wrapper is how Codex stores Stop feedback',
      '`<hook_prompt>` is what Codex writes, right?',
      'hook_prompt records should be skipped by the importer',
      '<hook_prompts>a different tag is a different thing</hook_prompts>',
      '<hook_prompt> keeps showing up after every turn. What writes it?',
      `<hook_prompt hook_run_id="${HOOK_RUN_ID}"> is the line I see; what writes it?`,
      `Codex wrote <hook_prompt hook_run_id="${HOOK_RUN_ID}">${REVIEW}</hook_prompt> after my turn. Why?`,
    ]) {
      assert.equal(isInjectedUserText(text), false,
        `a person's message was filtered as host text: ${JSON.stringify(text)}. Only a block `
        + 'that is one whole <hook_prompt …>…</hook_prompt> element is the host\'s; a user who '
        + 'quotes the tag, or opens a message with it, is still a user.');
    }
  });

  it('stripInjectedBlocks drops the feedback block and keeps what the user said beside it', async () => {
    const { stripInjectedBlocks } = await R();
    const content = [
      { type: 'input_text', text: hookPromptText(REVIEW) },
      { type: 'input_text', text: 'and also fix the flaky test' },
    ];
    assert.deepEqual(stripInjectedBlocks(content), [content[1]],
      'a block is filtered whole and only when it is the host\'s; the user\'s block beside it stays');
    assert.equal(stripInjectedBlocks(hookPromptText(REVIEW)), '', 'a string is one block');
  });

  it('firstUserText returns the real prompt when only feedback follows it', async () => {
    const { firstUserText } = await R();
    const path = rollout([
      META, user(...PREAMBLE), user('Find every call site of drain() and list them.'),
      assistant('Three call sites.'), hookPrompt(REVIEW), assistant('Reviewed.'), hookPrompt(REVIEW),
    ]);
    assert.equal(firstUserText(path), 'Find every call site of drain() and list them.');
  });

  it('firstUserText skips feedback that is the first user record', async () => {
    const { firstUserText } = await R();
    const path = rollout([META, hookPrompt(REVIEW), user('Summarise the failing tests.')]);
    assert.equal(firstUserText(path), 'Summarise the failing tests.',
      'the feedback was returned as the task. A subagent captured from this rollout would be '
      + 'stored as having been asked to review its lessons.');
  });

  it('firstUserText skips feedback between the preamble and the task', async () => {
    const { firstUserText } = await R();
    const path = rollout([META, user(...PREAMBLE), hookPrompt(REVIEW), user('Summarise the failing tests.')]);
    assert.equal(firstUserText(path), 'Summarise the failing tests.',
      'the feedback was returned as the task, in place of what the user actually asked');
  });

  it('firstUserText skips several in a row, with or without whitespace before the tag', async () => {
    const { firstUserText } = await R();
    const path = rollout([
      META, hookPrompt('first reason', '\n'), hookPrompt('second reason', '  '), hookPrompt('third reason'),
      user('Summarise the failing tests.'),
    ]);
    assert.equal(firstUserText(path), 'Summarise the failing tests.',
      'a run of Stop-hook blocks is still the host talking, each one of them');
  });

  it('firstUserText answers nothing when the only user text is feedback', async () => {
    const { firstUserText } = await R();
    const path = rollout([META, user(...PREAMBLE), hookPrompt(REVIEW), assistant('Reviewed.'), hookPrompt(REVIEW)]);
    assert.equal(firstUserText(path), '',
      'with no typed text the caller falls back to the parent\'s staged prompt; returning the '
      + 'feedback instead stores the review as the task');
  });

  it('firstUserText keeps a task that shares its record with feedback', async () => {
    const { firstUserText } = await R();
    const path = rollout([META, user(hookPromptText(REVIEW), 'Summarise the failing tests.')]);
    assert.equal(firstUserText(path), 'Summarise the failing tests.',
      'the feedback block must be dropped and the user\'s block beside it kept, not the two joined');
  });

  it('firstUserText keeps a prompt that mentions the wrapper, verbatim, wherever it sits', async () => {
    const { firstUserText } = await R();
    for (const said of [
      `why does <hook_prompt hook_run_id="${HOOK_RUN_ID}"> show up after every turn?`,
      '<hook_prompt> keeps showing up after every turn. What writes it?',
      `Codex wrote <hook_prompt hook_run_id="${HOOK_RUN_ID}">${REVIEW}</hook_prompt> after my turn. Why?`,
    ]) {
      const path = rollout([META, user(...PREAMBLE), user(said)]);
      assert.equal(firstUserText(path), said,
        'a user asking about the wrapper was skipped or edited. Only a block that is one whole '
        + '<hook_prompt …>…</hook_prompt> element is the host\'s, and it is dropped whole, never cut out of a sentence.');
    }
  });

  it('firstUserText still reads a Claude Code transcript\'s first user text, unchanged', async () => {
    const { firstUserText } = await R();
    const said = 'why does <hook_prompt> appear in the Codex rollout but not here?';
    const path = rollout([
      { type: 'user', uuid: 'u-1', sessionId: '0a0a0a0a-0000-4000-8000-000000000002',
        message: { role: 'user', content: [{ type: 'text', text: said }] } },
      { type: 'assistant', uuid: 'u-2', sessionId: '0a0a0a0a-0000-4000-8000-000000000002',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Codex wraps Stop feedback; Claude Code does not.' }] } },
    ]);
    assert.equal(firstUserText(path), said,
      'the Claude Code envelope stopped answering. Its transcripts never carry the wrapper, and '
      + 'the fix for Codex must leave them reading exactly as before.');
  });
});

// ---------------------------------------------------------------------------
// Several feedback elements in one block
// ---------------------------------------------------------------------------

// Two Stop hooks that block on the same turn can leave both reasons in one text block, one
// element after the other. That block is still nothing but the host talking.

/** The given reasons as consecutive elements of one block, `sep` between them. */
const hookPromptsText = (reasons, sep = '\n') => reasons.map((r) => hookPromptText(r)).join(sep);

/** An element quoted without a run id, for a text that has to come back verbatim. */
const QUOTED = '<hook_prompt hook_run_id="stop:0">run the tests first</hook_prompt>';

describe('several feedback elements in one block are the host talking', () => {
  it('isInjectedUserText recognises two or three elements in one block, whatever separates them', async () => {
    const { isInjectedUserText } = await R();
    for (const text of [
      hookPromptsText(['first reason', REVIEW]),
      hookPromptsText(['first reason', REVIEW], ''),
      hookPromptsText(['first reason', REVIEW], '\n\n'),
      hookPromptsText(['first reason', 'second reason', REVIEW]),
      `\n  ${hookPromptsText(['first reason', REVIEW], ' \n')}\n`,
      `<hook_prompt>first reason</hook_prompt>\n<hook_prompt source="stop" hook_run_id="${HOOK_RUN_ID}">${REVIEW}</hook_prompt>`,
      hookPromptsText(['Line one of the first.\nLine two of the first.', 'Line one of the second.\nLine two.']),
    ]) {
      assert.equal(isInjectedUserText(text), true,
        `a block of several Stop-hook reasons read as typed text: ${JSON.stringify(text.slice(0, 80))}. `
        + 'When two hooks block at once, every reader that walks user messages would take both '
        + 'reviews for something the user asked.');
    }
  });

  it('isInjectedUserText leaves an element followed, split or preceded by the user\'s own words alone', async () => {
    const { isInjectedUserText } = await R();
    for (const text of [
      `${hookPromptText(REVIEW)}\nand also fix the flaky test`,
      `${hookPromptText(REVIEW)} Why did Codex send me this?`,
      `${hookPromptsText(['first reason', REVIEW])}\nwhy did both of these fire?`,
      `${hookPromptText('first reason')}\nthese two came together:\n${hookPromptText(REVIEW)}`,
      `these came together:\n${hookPromptsText(['first reason', REVIEW])}`,
      `${hookPromptText(REVIEW)}\n<hook_prompt> is what I keep seeing; why?`,
    ]) {
      assert.equal(isInjectedUserText(text), false,
        `a person's message was filtered as host text: ${JSON.stringify(text.slice(0, 80))}. A block `
        + 'is the host\'s only when it is nothing but whole feedback elements; a word of the user\'s '
        + 'anywhere in it makes it the user\'s, and it is kept whole.');
    }
  });

  it('stripInjectedBlocks drops a block of several elements whole', async () => {
    const { stripInjectedBlocks } = await R();
    const content = [
      { type: 'input_text', text: hookPromptsText(['first reason', REVIEW]) },
      { type: 'input_text', text: 'and also fix the flaky test' },
    ];
    assert.deepEqual(stripInjectedBlocks(content), [content[1]],
      'the block of two reasons was kept, so it would be read as the user\'s beside what they typed');
    assert.equal(stripInjectedBlocks(hookPromptsText(['first reason', REVIEW])), '', 'a string is one block');
  });

  it('firstUserText skips a block of several elements and returns the task after it', async () => {
    const { firstUserText } = await R();
    const path = rollout([
      META, user(...PREAMBLE), user(hookPromptsText(['first reason', REVIEW])), user('Summarise the failing tests.'),
    ]);
    assert.equal(firstUserText(path), 'Summarise the failing tests.',
      'two Stop-hook reasons in one block were returned as the task. A subagent captured from this '
      + 'rollout would be stored as having been asked to review its lessons.');
  });

  it('firstUserText answers nothing when the only user text is a block of several elements', async () => {
    const { firstUserText } = await R();
    const path = rollout([META, user(...PREAMBLE), user(hookPromptsText(['first reason', REVIEW], ''))]);
    assert.equal(firstUserText(path), '',
      'with no typed text the caller falls back to the parent\'s staged prompt; returning the '
      + 'feedback instead stores the review as the task');
  });

  it('firstUserText keeps an element followed by the user\'s words, verbatim', async () => {
    const { firstUserText } = await R();
    const said = `${QUOTED}\nWhy did Codex send me this?`;
    const path = rollout([META, user(...PREAMBLE), user(said)]);
    assert.equal(firstUserText(path), said,
      'a user who pasted a feedback element and asked about it lost the prompt, or had the element '
      + 'cut out of it. Words after the elements make the whole block the user\'s.');
  });
});

// ---------------------------------------------------------------------------
// A feedback block of any size is classified, and nothing throws
// ---------------------------------------------------------------------------

/** Eight mebibytes of reason text, with the `<` and `>` a real reason can carry. */
const EIGHT_MB = (() => {
  const line = '- the lesson that helped: <drain> leaves the spool in place on a 500.\n';
  return line.repeat(Math.ceil((8 * 1024 * 1024) / line.length));
})();

describe('a feedback block of any size is classified without throwing', () => {
  it('a single element with an 8 MB body is the host\'s', async () => {
    const { isInjectedUserText, stripInjectedBlocks } = await R();
    const text = hookPromptText(EIGHT_MB);
    const started = performance.now();
    /** @type {any} */
    let injected;
    /** @type {any} */
    let stripped;
    assert.doesNotThrow(() => { injected = isInjectedUserText(text); },
      'classifying one large feedback block threw. Every reader of a rollout calls this on each '
      + 'user block, and a throw there costs the whole read, not just the block.');
    assert.doesNotThrow(() => { stripped = stripInjectedBlocks([{ type: 'input_text', text }, { type: 'input_text', text: 'fix it' }]); },
      'stripping one large feedback block threw, and with it the read of the record the user typed beside it');
    assert.equal(injected, true,
      'a large Stop-hook reason read as typed text. Its size does not make the user its author.');
    assert.deepEqual(stripped, [{ type: 'input_text', text: 'fix it' }],
      'the large feedback block was kept, or the user\'s block beside it was lost');
    const ms = performance.now() - started;
    assert.ok(ms < 1000,
      `classifying an 8 MB block took ${Math.round(ms)} ms. The readers run inside a hook's time `
      + 'budget, and a cost that grows faster than the text runs out of it.');
  });

  it('an 8 MB message that opens with the tag and never closes it is the user\'s', async () => {
    const { isInjectedUserText, stripInjectedBlocks } = await R();
    const started = performance.now();
    for (const text of [`<hook_prompt> ${EIGHT_MB}`, `<hook_prompt hook_run_id="stop:0">${EIGHT_MB}`]) {
      /** @type {any} */
      let injected;
      /** @type {any} */
      let stripped;
      assert.doesNotThrow(() => { injected = isInjectedUserText(text); },
        'classifying a large message that opens with the tag threw. A user who pastes a long log '
        + 'costs every reader of the rollout its read.');
      assert.doesNotThrow(() => { stripped = stripInjectedBlocks(text); },
        'stripping a large message that opens with the tag threw');
      assert.equal(injected, false,
        'a large message that opens with the tag but is not one whole element was taken for the '
        + 'host\'s. It is the user\'s, and it was dropped from every reader.');
      assert.equal(stripped, text, 'the user\'s large message was not returned as it came');
    }
    const ms = performance.now() - started;
    assert.ok(ms < 1000,
      `classifying two unclosed 8 MB messages took ${Math.round(ms)} ms. The readers run inside a `
      + 'hook\'s time budget, and a cost that grows faster than the text runs out of it.');
  });
});

// ---------------------------------------------------------------------------
// A shell command the user ran, and an interrupted turn: never the task
// ---------------------------------------------------------------------------

// The checkpoint keeps these two, because after compaction they are what the user did. Every
// other reader goes on treating them as the host's, as it did before Stop-hook feedback was
// recognised: neither is a task a subagent was given, nor a prompt an import files a turn under.

/** Only the openings are what the code recognises; the layout inside is illustrative. */
const USER_SHELL = '<user_shell_command>\n<command>\nnpm test\n</command>\n<result>\nExit code: 1\nOutput:\n2 failing\n</result>\n</user_shell_command>';
const ABORTED = '<turn_aborted>\nThe previous turn was aborted by the user.\n</turn_aborted>';

describe('a shell command the user ran, and an interrupted turn, are not the task', () => {
  it('isInjectedUserText and stripInjectedBlocks still treat both as the host\'s', async () => {
    const { isInjectedUserText, stripInjectedBlocks } = await R();
    for (const text of [USER_SHELL, ABORTED, '<user_shell_command>ls -la</user_shell_command>', '<turn_aborted>\nThe previous turn was aborted']) {
      assert.equal(isInjectedUserText(text), true,
        `${JSON.stringify(text.slice(0, 40))} read as typed text. Only the checkpoint keeps it; every `
        + 'other reader would start filing it as something the user asked.');
    }
    const content = [
      { type: 'input_text', text: USER_SHELL },
      { type: 'input_text', text: ABORTED },
      { type: 'input_text', text: 'do the thing' },
    ];
    assert.deepEqual(stripInjectedBlocks(content), [content[2]],
      'the filter the importer and firstUserText share started keeping these blocks. The '
      + 'checkpoint\'s decision to keep them must not leak into the readers that look for a prompt.');
  });

  it('firstUserText skips both and returns the task after them', async () => {
    const { firstUserText } = await R();
    const path = rollout([META, user(...PREAMBLE), user(USER_SHELL), user(ABORTED), user('Summarise the failing tests.')]);
    assert.equal(firstUserText(path), 'Summarise the failing tests.',
      'a shell command or an aborted-turn marker was returned as the task. A subagent captured from '
      + 'this rollout would be stored as having been asked to run npm test.');
  });

  it('firstUserText answers nothing when they are the only user text', async () => {
    const { firstUserText } = await R();
    const path = rollout([META, user(...PREAMBLE), user(USER_SHELL), assistant('Two tests fail.'), user(ABORTED)]);
    assert.equal(firstUserText(path), '',
      'with no typed text the caller falls back to the parent\'s staged prompt; returning a shell '
      + 'command or an abort marker instead stores it as the task');
  });
});
