// @ts-check
/**
 * What the Codex docs say about the scorecard, the outcome review and the approval step is
 * what the plugin does.
 *
 * Codex has no settings screen for a plugin, so `README.md`'s options table and
 * `docs/user-guide.md` are the only places a Codex user learns that the card and the review
 * exist, what they default to, and how to turn each off. Both used to say the two were off (or
 * a nudge) under Codex and "not verified" there. Now that both are on by default and setup
 * approves the two tools the review calls, a stale sentence tells the user the opposite of
 * what they are about to see.
 *
 * These assert facts, not wording: the default a row states is the default `loadConfig`
 * resolves under Codex, no row or section still calls the feature unverified, and the guide's
 * scorecard section names the settings, the two approved tools, the key that approves them and
 * the flag that leaves approvals alone.
 */

import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { assert, CODEX_ROOT, lib, makeDataDir } from './helpers/codex-fixtures.mjs';

const README = readFileSync(join(CODEX_ROOT, 'README.md'), 'utf8');
const GUIDE = readFileSync(join(CODEX_ROOT, 'docs', 'user-guide.md'), 'utf8');
const APPROVAL = JSON.parse(readFileSync(
  join(CODEX_ROOT, 'test', 'fixtures', 'observed', 'mcp-tool-approval.json'), 'utf8'));

/** A sentence that calls a feature unverified under Codex, a line break anywhere in it. */
const UNVERIFIED = /not\s+(been\s+)?verified/i;

/** The options-table row for one variable, as its cells. */
function row(variable) {
  const line = README.split('\n').find((l) => l.startsWith(`| \`${variable}\` |`));
  assert.ok(line, `README.md has no options-table row for ${variable}, so a Codex user has nowhere to `
    + 'learn the setting exists.');
  return { line, cells: line.split('|').slice(1, -1).map((c) => c.trim()) };
}

/** What `loadConfig` resolves under Codex with nothing set. */
async function codexDefaults() {
  const { loadConfig } = await lib('config.mjs');
  const dir = makeDataDir();
  return loadConfig({
    PATH: process.env.PATH ?? '', HOME: dir, CLAUDE_PLUGIN_DATA: dir, MUBIT_CC_DATA_DIR: dir,
    CLAUDE_PROJECT_DIR: dir, MUBIT_CC_HOST: 'codex',
  });
}

for (const [variable, key] of /** @type {const} */ ([
  ['MUBIT_CC_SESSION_SCORE', 'sessionScore'],
  ['MUBIT_CC_OUTCOME_REVIEW', 'outcomeReview'],
])) {
  test(`README: the ${variable} row states the Codex default and no longer calls it unverified`, async () => {
    const { line, cells } = row(variable);
    const stated = /`([^`]+)`/.exec(cells[1] ?? '')?.[1];
    const actual = (await codexDefaults())[key];
    assert.equal(stated, actual,
      `README.md says ${variable} defaults to ${JSON.stringify(stated)} under Codex, and the plugin `
      + `resolves ${JSON.stringify(actual)}. A user reading the table is told the opposite of what `
      + `they see after the reply.\n  ${line}`);
    assert.doesNotMatch(line, UNVERIFIED,
      `README.md still calls ${variable} unverified under Codex, which is what kept it off by `
      + `default; it is now recorded on the host and on by default.\n  ${line}`);
  });
}

/**
 * The guide's section whose heading names the scorecard, down to the next heading of the same
 * or a higher level.
 */
function scorecardSection() {
  const lines = GUIDE.split('\n');
  const start = lines.findIndex((l) => /^#{2,4} .*scorecard/i.test(l));
  assert.ok(start !== -1,
    'docs/user-guide.md has no section whose heading names the scorecard, so a Codex user has no '
    + 'account of what the card under the reply is or how to turn it off.');
  const level = /^#+/.exec(lines[start])?.[0].length ?? 2;
  let end = lines.findIndex((l, i) => i > start && /^#+ /.test(l) && (/^#+/.exec(l)?.[0].length ?? 9) <= level);
  if (end === -1) end = lines.length;
  return lines.slice(start, end).join('\n');
}

test('user guide: the scorecard section says how to turn the card and the review off', () => {
  const section = scorecardSection();
  for (const variable of ['MUBIT_CC_SESSION_SCORE', 'MUBIT_CC_OUTCOME_REVIEW']) {
    assert.ok(section.includes(variable),
      `the scorecard section does not name ${variable}, the one way a Codex user turns it off.\n${section}`);
  }
  assert.ok(section.includes('`off`'),
    `the scorecard section does not give \`off\` as a value, so it never says how to turn either off.\n${section}`);
  for (const value of ['`full`', '`stop`']) {
    assert.ok(section.includes(value),
      `the scorecard section does not name ${value}, the Codex default it has to state.\n${section}`);
  }
  assert.doesNotMatch(section, UNVERIFIED,
    `the scorecard section still calls the card or the review unverified under Codex.\n${section}`);
});

test('user guide: the scorecard section names the approval step, and how to leave it out', () => {
  const section = scorecardSection();
  for (const tool of APPROVAL.tools) {
    assert.ok(section.includes(tool),
      `the scorecard section does not name ${tool}, which setup approves on the user's behalf. `
      + `A tool that runs unasked has to be written down where the feature that calls it is.\n${section}`);
  }
  assert.ok(section.includes(APPROVAL.key),
    `the scorecard section does not name \`${APPROVAL.key}\`, the config.toml key that approves `
    + `the two tools, so a user who wants to be asked again has nothing to look for.\n${section}`);
  assert.ok(section.includes('--no-trust'),
    `the scorecard section does not say that setup's \`--no-trust\` leaves the approvals out.\n${section}`);
});
