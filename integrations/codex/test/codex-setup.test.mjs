// @ts-check
/**
 * `scripts/setup.mjs`, executed.
 *
 * This is 212 lines that rewrite two files in the user's `$CODEX_HOME` — the file every other
 * tool's hook registrations live in, and the file carrying their model choice, their notify
 * hook and their per-project trust levels. Until this file existed the entire coverage of it
 * was five `assert.match(src, /…/)` greps over its own source, which is a test that the script
 * *contains a string*, not that running it does anything in particular. A grep cannot catch a
 * script that deletes another tool's trust entry, because deleting it is not a string.
 *
 * So every test here runs the real script against a throwaway `$CODEX_HOME` and reads the
 * files afterwards.
 *
 * Two of them need `codex` on PATH — the trust write goes through `codex app-server`, and the
 * MCP registration through `codex mcp add`. They skip **by name** when it is absent, because
 * the alternative is a green run that checked neither.
 *
 * The last section is the approval step. Codex asks the user to approve every MCP tool call,
 * so the outcome review would raise a prompt on every turn that showed a lesson. Setup
 * approves the two tools the review asks for, `mubit_outcome` and `mubit_learned`, in the
 * per-tool form recorded in `fixtures/observed/mcp-tool-approval.json`, and nothing else:
 * `mubit_recall` and every other tool keep asking, another server's settings and the user's
 * own lines are left as they were, an `approval_mode` the user already set on either of the
 * two is theirs and stays, and `--no-trust` — the flag that already means "the approving is
 * mine" — leaves every approval as it found it. Those tests need `codex` too, the real one:
 * the tables sit under the server `codex mcp add` registers, and the host's own
 * `codex mcp remove` is what a re-run has to survive. On 0.154.0 that command drops every
 * `[mcp_servers.mubit.tools.*]` table along with the registration, so whatever of them setup
 * means to keep, it has to read before the remove and write back after the add. And a tools
 * table with no `[mcp_servers.mubit]` beside it fails the whole file ("invalid transport"),
 * so none is written when the registration did not land.
 *
 * The section after it holds two promises the approval step rests on. Every setting the user
 * wrote is still theirs after a run, however TOML lets them write it: an `approval_mode` under
 * a quoted key, a decision made inline or as a dotted key inside `[mcp_servers.mubit]`, a
 * table in a CRLF file with a comment on its header, the server's own settings such as
 * `startup_timeout_sec`, which `codex mcp remove` deletes along with the rest of the table,
 * and the user's own entries in `[mcp_servers.mubit.env]` beside the two setup writes there.
 * And the file is always one the host loads: a failed `codex mcp add` puts back the file as
 * it was, and a write the host refuses is undone, reported, and ends the run with exit 1.
 * Undone means the whole file as it was before setup ran, the text read before
 * `codex mcp remove`: the file as `codex mcp add` left it has already lost whatever setup
 * could not carry. The report names no line of the text setup threw away.
 * What setup prints about the two tools matches what it did ("already approved", "kept"), and
 * the first `config.toml.before-mubit` is never overwritten by a later run. Those tests read
 * the result through the host's own `config/read`, which parses the file the way Codex will.
 * The user guide's setup transcript is the one a fresh `--no-trust` run prints.
 */

import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assert, CODEX_ROOT, lib } from './helpers/codex-fixtures.mjs';
import { codexVersion } from './helpers/codex-oracle.mjs';

const CODEX = codexVersion();
const needsCodex = {
  skip: CODEX.ok ? false
    : 'no `codex` on PATH — the trust write and the MCP registration could not be exercised. '
      + 'Those halves of setup are UNVERIFIED on this run.',
};

/** A throwaway `$CODEX_HOME`, optionally pre-seeded with a user's own files. */
function makeHome(files = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mubit-setup-home-')));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(home, name), body);
  return home;
}

/**
 * Run `scripts/setup.mjs` for real.
 *
 * @param {string} home
 * @param {string[]} [args]
 * @param {Record<string, string>} [env]  laid over the inherited environment, e.g. a `PATH`
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function runSetup(home, args = [], env = {}) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [join(CODEX_ROOT, 'scripts', 'setup.mjs'), CODEX_ROOT, ...args], {
      env: { ...process.env, ...env, CODEX_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => { child.kill('SIGKILL'); rej(new Error('setup.mjs did not exit')); }, 60000);
    child.on('close', (code) => { clearTimeout(t); res({ code, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(t); rej(e); });
  });
}

const readHooks = (home) => JSON.parse(readFileSync(join(home, 'hooks.json'), 'utf8'));
const readToml = (home) => (existsSync(join(home, 'config.toml')) ? readFileSync(join(home, 'config.toml'), 'utf8') : '');

/** Every `[hooks.state."…"]` key in a config.toml, in file order. */
const stateKeys = (toml) => [...toml.matchAll(/^\[hooks\.state\."(.+?)"\]$/gm)].map((m) => m[1]);

/** A foreign tool's registrations, in the shape another vendor would plausibly write them. */
const FOREIGN_HOOKS = {
  hooks: {
    PostToolUse: [{
      matcher: '*',
      hooks: [{ type: 'command', timeout: 5, command: 'node "/opt/othertool/hooks/dist/audit.mjs"' }],
    }],
    SessionStart: [{
      hooks: [{ type: 'command', timeout: 5, command: '/usr/local/bin/othertool session-start' }],
    }],
  },
};

// ===========================================================================
// The merge
// ===========================================================================

test('a foreign handler survives the merge', async () => {
  const home = makeHome({ 'hooks.json': `${JSON.stringify(FOREIGN_HOOKS, null, 2)}\n` });
  await runSetup(home, ['--no-trust']);

  const after = readHooks(home);
  const commands = JSON.stringify(after);

  assert.match(commands, /othertool session-start/,
    'the foreign SessionStart handler was dropped. $CODEX_HOME/hooks.json is the user`s file '
    + 'and other tools register in it; setup merges, it does not own the file.');
  assert.match(commands, /\/opt\/othertool\/hooks\/dist\/audit\.mjs/,
    'the foreign PostToolUse handler was deleted. Its command contains `/hooks/dist/`, which is '
    + 'the substring `isMubit()` matched on — so any vendor who lays out their bundles the way '
    + 'we do had their hook silently removed from their own config.');
});

test('a backup of the user`s hooks.json is taken before it is touched', async () => {
  const home = makeHome({ 'hooks.json': `${JSON.stringify(FOREIGN_HOOKS, null, 2)}\n` });
  await runSetup(home, ['--no-trust']);

  const backup = join(home, 'hooks.json.before-mubit');
  assert.ok(existsSync(backup), 'no hooks.json.before-mubit was written');
  assert.deepEqual(JSON.parse(readFileSync(backup, 'utf8')), FOREIGN_HOOKS,
    'the backup does not hold what the file held before the run.');
});

test('our own handlers are replaced, not stacked, on a second run', async () => {
  const home = makeHome();
  await runSetup(home, ['--no-trust']);
  const one = readHooks(home);
  await runSetup(home, ['--no-trust']);
  const two = readHooks(home);

  assert.deepEqual(two, one,
    'a second run produced a different hooks.json. Ours are replaced by path so that re-running '
    + 'after an upgrade is idempotent rather than additive.');
  for (const [event, groups] of Object.entries(two.hooks)) {
    const ours = groups.flatMap((g) => g.hooks).filter((h) => h.command.includes(CODEX_ROOT));
    const paths = ours.map((h) => /"([^"]+\.mjs)"/.exec(h.command)?.[1]);
    assert.equal(new Set(paths).size, paths.length, `${event} carries the same command twice`);
  }
});

test('only `description` and `hooks` reach the merged file', async () => {
  const home = makeHome({
    'hooks.json': `${JSON.stringify({ ...FOREIGN_HOOKS, someFutureKey: { a: 1 } }, null, 2)}\n`,
  });
  await runSetup(home, ['--no-trust']);

  const after = readHooks(home);
  assert.deepEqual(Object.keys(after).filter((k) => k !== 'hooks' && k !== 'description'), [],
    'hooks.json accepts exactly `description` and `hooks`; anything else fails the whole file, '
    + 'which would take the user`s other registrations down with ours.');
});

test('PreToolUse is registered only when asked for', async () => {
  const a = makeHome();
  await runSetup(a, ['--no-trust']);
  assert.equal(readHooks(a).hooks.PreToolUse, undefined,
    'PreToolUse exists for warnings that are off by default; registering it anyway spends a '
    + 'hook spawn per tool call for nothing.');

  const b = makeHome();
  await runSetup(b, ['--no-trust', '--with-pre-tool']);
  assert.ok(readHooks(b).hooks.PreToolUse, '--with-pre-tool did not register it');
});

test('--data-dir pins the directory it was given', async () => {
  const home = makeHome();
  const pinned = realpathSync(mkdtempSync(join(tmpdir(), 'mubit-pinned-data-')));
  await runSetup(home, ['--no-trust', `--data-dir=${pinned}`]);

  const commands = Object.values(readHooks(home).hooks).flatMap((gs) => gs.flatMap((g) => g.hooks))
    .map((h) => h.command);
  assert.ok(commands.length, 'nothing was registered');
  for (const command of commands) {
    assert.ok(command.startsWith(`MUBIT_CC_DATA_DIR=${JSON.stringify(pinned)} `),
      'the pin is what stops a Codex session and a Claude Code session in one directory deriving '
      + 'the same run id and writing it to two different places. Every hook command carries it, '
      + `and this one does not:\n  ${command}`);
  }
});

test('a data directory with a space in it stays one argument', async () => {
  const home = makeHome();
  const spaced = join(realpathSync(mkdtempSync(join(tmpdir(), 'mubit-spaced-'))), 'data dir');
  await runSetup(home, ['--no-trust', `--data-dir=${spaced}`]);

  for (const groups of Object.values(readHooks(home).hooks)) {
    for (const h of groups.flatMap((g) => g.hooks)) {
      assert.match(h.command, /^MUBIT_CC_DATA_DIR="[^"]*"\s+node\s/,
        `the pin is not quoted in: ${h.command}\n  Codex runs a hook command as a shell string, `
        + 'so an unquoted path with a space becomes two arguments and the pin becomes garbage.');
    }
  }
});

// ===========================================================================
// The trust rewrite
// ===========================================================================

test('a foreign [hooks.state] entry survives the rewrite', needsCodex, async () => {
  // § Another tool's hooks.json, trusted by the user in their own TUI. Its trust entry names
  //   ITS source file, not ours, so nothing about it is ours to revoke.
  const foreignSource = '/opt/othertool/hooks.json';
  const foreignKey = `${foreignSource}:post_tool_use:0:0`;
  const before = [
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "low"',
    '',
    `[hooks.state."${foreignKey}"]`,
    'trusted_hash = "sha256:1111111111111111111111111111111111111111111111111111111111111111"',
    '',
    '[projects."/Users/someone/work"]',
    'trust_level = "trusted"',
    '',
  ].join('\n');

  const home = makeHome({ 'config.toml': before });
  const r = await runSetup(home);
  assert.equal(r.code, 0, `setup exited ${r.code}:\n${r.stdout}\n${r.stderr}`);

  const after = readToml(home);
  assert.ok(stateKeys(after).includes(foreignKey),
    'setup revoked another tool`s hook trust. `stripHookState()` deleted every [hooks.state.*] '
    + 'table and rewrote only ours, and Codex silently skips an untrusted hook — so the other '
    + 'tool simply stops working, with no message, on our re-run.\n'
    + `  keys after: ${JSON.stringify(stateKeys(after), null, 2)}`);
  assert.match(after, /trusted_hash = "sha256:1111/,
    'the foreign table survived but lost its body, which leaves it as good as revoked.');
});

test('the user`s own settings are byte-identical across three runs', needsCodex, async () => {
  const before = [
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "low"',
    'notify = ["/usr/local/bin/notify-me", "--sound"]',
    '',
    '[projects."/Users/someone/work"]',
    'trust_level = "trusted"',
    '',
    '[projects."/Users/someone/other"]',
    'trust_level = "untrusted"',
    '',
  ].join('\n');

  const home = makeHome({ 'config.toml': before });
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const r = await runSetup(home);
    assert.equal(r.code, 0, `run ${i + 1} exited ${r.code}:\n${r.stdout}\n${r.stderr}`);
    seen.push(readToml(home));
  }

  assert.equal(seen[1], seen[2],
    'three runs did not converge — run 2 and run 3 differ, so the file grows or churns forever.');

  // § The user's half, extracted by dropping every line this script owns.
  const theirs = (toml) => toml
    .split('\n')
    .filter((l) => !/^\[hooks\.state\./.test(l) && !/^trusted_hash\s*=/.test(l) && !/^# Mubit/.test(l)
      && !/^# Every \[hooks\.state\]/.test(l))
    .join('\n');
  for (const line of ['model = "gpt-5.6-sol"', 'notify = ["/usr/local/bin/notify-me", "--sound"]',
    '[projects."/Users/someone/work"]', '[projects."/Users/someone/other"]']) {
    assert.ok(seen[2].includes(line),
      `the user's \`${line}\` did not survive three runs. This file is theirs; we add tables to `
      + 'it and must reformat none of it.');
  }
  assert.equal(theirs(seen[1]), theirs(seen[2]),
    'the user`s own lines moved between runs.');
});

test('no [hooks.state] table is ever defined twice', needsCodex, async () => {
  // § The regression that bricked a real config. A trust key does not change when its command
  //   does, so appending rather than replacing produced a SECOND table with the same name —
  //   TOML forbids that, so Codex refused to start at all: "failed to load bootstrap
  //   configuration". A user cannot recover from that without editing the file by hand.
  const home = makeHome();
  for (let i = 0; i < 3; i++) await runSetup(home);

  const keys = stateKeys(readToml(home));
  assert.ok(keys.length > 0, 'no trust tables were written at all');
  assert.equal(new Set(keys).size, keys.length,
    'a [hooks.state] key is defined more than once, so config.toml no longer parses and Codex '
    + `will not start:\n  ${keys.join('\n  ')}`);
});

test('a foreign handler is never trusted on the user`s behalf', needsCodex, async () => {
  // § `hooks/list` returns every hook Codex can see, ours and theirs. Writing the whole result
  //   into config.toml would approve someone else's hook on the user's behalf — which is
  //   exactly the control the trust mechanism exists to be.
  const home = makeHome({ 'hooks.json': `${JSON.stringify(FOREIGN_HOOKS, null, 2)}\n` });
  const r = await runSetup(home);
  assert.equal(r.code, 0, `setup exited ${r.code}:\n${r.stdout}\n${r.stderr}`);

  const merged = readHooks(home);
  const foreign = Object.values(merged.hooks).flatMap((gs) => gs.flatMap((g) => g.hooks))
    .filter((h) => !h.command.includes(CODEX_ROOT));
  assert.ok(foreign.length, 'the foreign handlers vanished before trust was even considered');

  // A trust key is <sourcePath>:<event>:<group>:<index>. The merge appends ours as a NEW group
  // rather than into theirs, so on a shared event theirs stays group 0 and ours becomes group 1.
  const source = join(home, 'hooks.json');
  const trusted = stateKeys(readToml(home));
  for (const event of ['post_tool_use', 'session_start']) {
    assert.ok(trusted.includes(`${source}:${event}:1:0`),
      `ours should be trusted as group 1 of ${event}:\n  ${trusted.join('\n  ')}`);
    assert.ok(!trusted.includes(`${source}:${event}:0:0`),
      `setup trusted the foreign ${event} handler in group 0. Trust is the user's decision `
      + `about someone else's code:\n  ${trusted.join('\n  ')}`);
  }
});

test('the MCP registration carries the data-dir pin', needsCodex, async () => {
  const home = makeHome();
  const pinned = realpathSync(mkdtempSync(join(tmpdir(), 'mubit-pinned-data-')));
  const r = await runSetup(home, [`--data-dir=${pinned}`]);
  assert.equal(r.code, 0, `setup exited ${r.code}:\n${r.stdout}\n${r.stderr}`);

  const toml = readToml(home);
  assert.match(toml, /\[mcp_servers\.mubit\]/, 'the MCP server was not registered');
  assert.ok(toml.includes(pinned),
    'the MCP server was registered without MUBIT_CC_DATA_DIR. The server derives the run id '
    + 'itself, so one reading a different data directory writes /mubit-memory:remember into a '
    + `run pre-prompt recall never reads.\n${toml}`);
});

test('the MCP registration carries the plugin-root pin', needsCodex, async () => {
  // § `mcp/src/launch.mjs` bridges three `MUBIT_CC_*` names onto the host names `lib/`
  //   reads. Codex registers the server itself, so whatever this script does not pass is
  //   simply absent — there is no host to supply it.
  //
  //   `MUBIT_CC_PLUGIN_ROOT` is the one that has to ride here. `lib/redact.mjs`'s
  //   `selfRoots()` builds the list of paths that mark an item as being about the plugin
  //   itself, and the install root is one of them. Unset, the MCP server cannot recognise
  //   its own install path — which under Codex sits inside `$CODEX_HOME`, and so carries
  //   the user's home directory into anything it fails to suppress.
  //
  //   `MUBIT_CC_PROJECT_DIR` deliberately does NOT ride here: `codex mcp add` writes to
  //   `$CODEX_HOME/config.toml`, one registration serving every project on the machine, so
  //   a pinned project directory would be wrong everywhere except the one it was taken in.
  //   Falling back to the launch cwd is the correct answer there, and the run id is
  //   unaffected either way because `directoryRunId` resolves through
  //   `git rev-parse --show-toplevel`.
  const home = makeHome();
  const r = await runSetup(home);
  assert.equal(r.code, 0, `setup exited ${r.code}:\n${r.stdout}\n${r.stderr}`);

  const toml = readToml(home);
  assert.match(toml, /\[mcp_servers\.mubit\]/, 'the MCP server was not registered');
  assert.ok(toml.includes('MUBIT_CC_PLUGIN_ROOT'),
    'the MCP server was registered without MUBIT_CC_PLUGIN_ROOT, so `lib/redact.mjs` cannot '
    + "put the plugin's own install root in `selfRoots()` and self-referential content goes "
    + `out unsuppressed:\n${toml}`);
  assert.ok(toml.includes(CODEX_ROOT),
    `MUBIT_CC_PLUGIN_ROOT was registered as something other than ${CODEX_ROOT}:\n${toml}`);
});

test('the MCP registration survives the trust rewrite that follows it', needsCodex, async () => {
  // § Ordering: step 2 runs `codex mcp add`, step 3 rewrites the same file. A rewrite that
  //   dropped what step 2 just wrote would leave the plugin with hooks and no tools.
  const home = makeHome({ 'config.toml': 'model = "gpt-5.6-sol"\n' });
  await runSetup(home);
  const toml = readToml(home);
  assert.match(toml, /\[mcp_servers\.mubit\]/);
  assert.match(toml, /^model = "gpt-5\.6-sol"$/m);
  assert.ok(stateKeys(toml).length >= 11, `only ${stateKeys(toml).length} hooks were trusted`);
});

test('a trust write that does not add up restores the file it found', needsCodex, async () => {
  // § setup counts the [hooks.state] tables it left behind and restores the original if the
  //   number is not the number of hooks it meant to trust. Feed it a config whose own content
  //   inflates that count: a table that is not ours and not removable.
  const foreign = [
    'model = "gpt-5.6-sol"',
    '',
    '[hooks.state."/opt/othertool/hooks.json:stop:0:0"]',
    'trusted_hash = "sha256:2222222222222222222222222222222222222222222222222222222222222222"',
    '',
  ].join('\n');
  const home = makeHome({ 'config.toml': foreign });
  const r = await runSetup(home);

  const after = readToml(home);
  if (r.code === 0) {
    // The intended outcome once the foreign entry is preserved: ours plus theirs, no duplicates.
    const keys = stateKeys(after);
    assert.equal(new Set(keys).size, keys.length, 'duplicate trust tables');
    assert.ok(keys.includes('/opt/othertool/hooks.json:stop:0:0'), 'the foreign entry was dropped');
  } else {
    // The refusal path: it must leave the file exactly as it found it.
    assert.equal(after, foreign,
      'setup refused to finish but did not restore config.toml, so it left the user with a file '
      + 'that is neither what they had nor what they asked for.');
  }
  assert.ok(existsSync(join(home, 'config.toml.before-mubit')), 'no config.toml backup was taken');
});

// ===========================================================================
// The two approvals
// ===========================================================================

/** The per-tool approval form, as the host was observed taking it. */
const APPROVAL = JSON.parse(readFileSync(
  join(CODEX_ROOT, 'test', 'fixtures', 'observed', 'mcp-tool-approval.json'), 'utf8'));

/** The approvals setup writes: `{mubit_outcome: 'approve', mubit_learned: 'approve'}`. */
const OURS = Object.fromEntries(APPROVAL.tools.map((t) => [t, APPROVAL.value]));

const unquote = (k) => (k.startsWith('"') ? JSON.parse(k) : k);

/**
 * Every table header in a config.toml, with the key/value lines under it, in file order.
 * Line-based on purpose: the tests have to see a table defined twice, which is exactly what a
 * TOML parser refuses to hand back.
 *
 * @param {string} toml
 * @returns {{header: string, body: string[]}[]}
 */
function tables(toml) {
  const out = [];
  let cur = null;
  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    if (/^\[[^[]/.test(line)) { cur = { header: line.replace(/\s*#.*$/, ''), body: [] }; out.push(cur); continue; }
    if (cur && line && !line.startsWith('#')) cur.body.push(line);
  }
  return out;
}

/** A `[mcp_servers.<server>.tools.<tool>]` header, bare or quoted keys. */
const TOOL_HEADER = /^\[\s*mcp_servers\.("[^"]+"|[\w-]+)\.tools\.("[^"]+"|[\w-]+)\s*\]$/;

/**
 * `{<tool>: <approval_mode>}` for one server, one entry per `[mcp_servers.<server>.tools.<tool>]`
 * table. A table with no `approval_mode` maps to `null`.
 *
 * @param {string} toml
 * @param {string} [server]
 */
function approvals(toml, server = APPROVAL.server) {
  /** @type {Record<string, string|null>} */
  const out = {};
  for (const t of tables(toml)) {
    const m = TOOL_HEADER.exec(t.header);
    if (!m || unquote(m[1]) !== server) continue;
    const mode = t.body.map((l) => /^approval_mode\s*=\s*"([^"]*)"/.exec(l)).find(Boolean);
    out[unquote(m[2])] = mode ? mode[1] : null;
  }
  return out;
}

/** Every per-tool table header of one server, duplicates kept. */
const toolHeaders = (toml, server = APPROVAL.server) => tables(toml)
  .map((t) => TOOL_HEADER.exec(t.header)).filter((m) => m && unquote(m[1]) === server)
  .map((m) => unquote(m[2]));

/** The key/value lines of `[mcp_servers.<server>]` itself. */
const serverBody = (toml, server = APPROVAL.server) => tables(toml)
  .filter((t) => t.header === `[mcp_servers.${server}]`).flatMap((t) => t.body);

/**
 * Does the host load this `$CODEX_HOME/config.toml` at all? A table defined twice, or a value
 * the host does not know, fails the whole file, and then Codex does not start.
 *
 * @param {string} home
 * @param {string} [server]
 */
function hostLoads(home, server = APPROVAL.server) {
  const r = spawnSync('codex', ['mcp', 'get', server, '--json'], {
    encoding: 'utf8', env: { ...process.env, CODEX_HOME: home }, timeout: 30000,
  });
  return { ok: r.status === 0, said: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** A registration of `mubit` as an earlier install at another path would have left it. */
const OLD_REGISTRATION = [
  '[mcp_servers.mubit]',
  'command = "node"',
  'args = ["/opt/old-install/mcp/dist/index.js"]',
  '',
].join('\n');

test('the two approved tools are the two the outcome review asks the model to call', async () => {
  // The approval exists so the review does not raise a prompt on every turn that showed a
  // lesson. If the review ever asks for a third tool, that one prompts; if the approval ever
  // covers a tool the review does not call, it runs unasked for no reason the user was given.
  const { reviewReason } = await lib('review.mjs');
  const reason = reviewReason([{ ref: 'r1', handle: 'mabcd', title: 'A lesson' }]);
  const asked = [...new Set(reason.match(/\bmubit_[a-z_]+\b/g) ?? [])].sort();
  assert.deepEqual([...APPROVAL.tools].sort(), asked,
    `the review asks the model to call ${asked.join(', ')}, and setup approves `
    + `${APPROVAL.tools.join(', ')}. The two lists have to be the same list.`);
});

test('the recorded approval form is one the host reads, and validates', needsCodex, () => {
  // The fixture says what the host takes. This holds the fixture to the host that is on PATH
  // now: the recorded tables load, and the same table carrying a value the host does not know
  // refuses to load, naming the key. That refusal is what shows the key is read at all; a key
  // the host ignored would load either way and approve nothing.
  assert.deepEqual(APPROVAL.tools, ['mubit_outcome', 'mubit_learned'],
    'the fixture must name exactly the two tools the outcome review asks the model to call.');
  assert.equal(APPROVAL.key, 'approval_mode');
  assert.equal(APPROVAL.value, 'approve');

  const good = makeHome({ 'config.toml': `${OLD_REGISTRATION}\n${APPROVAL.toml}` });
  const loaded = hostLoads(good);
  assert.ok(loaded.ok,
    `the host on PATH (${CODEX.version}) refused the recorded approval form, so setup would `
    + `write a config.toml Codex cannot start with. Re-verify the form and re-record the fixture:\n${loaded.said}`);
  assert.deepEqual(approvals(readToml(good)), OURS, 'the fixture`s own toml does not say what its fields say.');

  const bad = makeHome({
    'config.toml': `${OLD_REGISTRATION}\n${APPROVAL.toml.split(`"${APPROVAL.value}"`).join('"not-a-mode"')}`,
  });
  const refused = hostLoads(bad);
  assert.ok(!refused.ok,
    'the host loaded a per-tool approval_mode it cannot know, so it does not validate that key '
    + `and may not read it at all. The recorded form would approve nothing:\n${refused.said}`);
  assert.match(refused.said, /mcp_servers\.mubit\.tools\.mubit_outcome\.approval_mode/,
    `the host refused the file for some other reason than the approval key:\n${refused.said}`);
});

test('setup approves mubit_outcome and mubit_learned, and no other tool', needsCodex, async () => {
  const home = makeHome();
  const r = await runSetup(home);
  assert.equal(r.code, 0, `setup exited ${r.code}:\n${r.stdout}\n${r.stderr}`);

  const toml = readToml(home);
  assert.match(toml, /^\[mcp_servers\.mubit\]$/m, 'the MCP server was not registered, so there is nothing to approve under');
  assert.deepEqual(approvals(toml), OURS,
    'setup must leave exactly the two credit tools approved, in the recorded per-tool form '
    + '(`[mcp_servers.mubit.tools.<tool>]` with `approval_mode = "approve"`). Without them Codex '
    + 'raises an approval prompt every time the outcome review runs; with any other tool in the '
    + `list, a call the user never agreed to runs unasked.\n${toml}`);
  assert.deepEqual(serverBody(toml).filter((l) => l.startsWith(`${APPROVAL.serverWideKey}`)), [],
    `setup set ${APPROVAL.serverWideKey} on the mubit server, which approves every Mubit tool — `
    + `mubit_recall included — not the two the user was told about:\n${toml}`);
  const loaded = hostLoads(home);
  assert.ok(loaded.ok, `Codex cannot load the config.toml setup left, so it will not start:\n${loaded.said}`);
});

test('setup says which two tools it approved', needsCodex, async () => {
  // Approving on the user's behalf is the same kind of decision as trusting a hook, and setup
  // lists every hook it trusts. A tool approved without a word is one the user finds out about
  // when it runs unasked.
  const r = await runSetup(makeHome());
  assert.equal(r.code, 0, `setup exited ${r.code}:\n${r.stdout}\n${r.stderr}`);
  for (const tool of APPROVAL.tools) {
    assert.match(r.stdout, new RegExp(`\\b${tool}\\b`),
      `setup approved ${tool} without naming it in what it printed:\n${r.stdout}`);
  }
});

test('re-running setup leaves each approval defined once, and the file unchanged', needsCodex, async () => {
  // `codex mcp remove` drops the mubit tables on every run, and setup writes them back. A
  // write that appended instead of replacing would define a table twice, which TOML forbids:
  // the file stops parsing and Codex refuses to start.
  const home = makeHome({ 'config.toml': 'model = "gpt-5.6-sol"\n' });
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const r = await runSetup(home);
    assert.equal(r.code, 0, `run ${i + 1} exited ${r.code}:\n${r.stdout}\n${r.stderr}`);
    seen.push(readToml(home));
  }
  const headers = toolHeaders(seen[2]);
  assert.equal(new Set(headers).size, headers.length,
    `a mubit tool table is defined more than once after three runs, so config.toml no longer parses:\n  ${headers.join('\n  ')}`);
  assert.deepEqual(approvals(seen[2]), OURS, `three runs did not leave exactly the two approvals:\n${seen[2]}`);
  assert.equal(seen[2], seen[1], 'run 3 changed config.toml after run 2 had settled it, so every re-run churns the file.');
  const loaded = hostLoads(home);
  assert.ok(loaded.ok, `Codex cannot load config.toml after three runs:\n${loaded.said}`);
});

test('another server`s tools, and the user`s own setting for a Mubit tool, are left alone', needsCodex, async () => {
  // Two things that are not setup's to decide. Another server's per-tool approvals are the
  // user's settings for someone else's tools. And a user who told Codex how to treat
  // mubit_recall made a decision about a tool setup does not approve: the host's own
  // `codex mcp remove` drops it along with the registration, so setup has to put it back.
  const before = [
    'model = "gpt-5.6-sol"',
    '',
    '[mcp_servers.other]',
    'command = "other-mcp"',
    '',
    '[mcp_servers.other.tools.search]',
    'approval_mode = "approve"',
    '',
    '[mcp_servers.other.tools.write_file]',
    'approval_mode = "prompt"',
    '',
    OLD_REGISTRATION,
    '[mcp_servers.mubit.tools.mubit_recall]',
    'approval_mode = "prompt"',
    '',
  ].join('\n');
  const home = makeHome({ 'config.toml': before });
  const r = await runSetup(home);
  assert.equal(r.code, 0, `setup exited ${r.code}:\n${r.stdout}\n${r.stderr}`);

  const after = readToml(home);
  assert.deepEqual(approvals(after, 'other'), { search: 'approve', write_file: 'prompt' },
    `setup changed another server's per-tool approvals, which are the user's settings for `
    + `someone else's tools:\n${after}`);
  assert.ok(serverBody(after, 'other').includes('command = "other-mcp"'),
    `setup changed another server's registration:\n${after}`);
  assert.deepEqual(approvals(after), { ...OURS, mubit_recall: 'prompt' },
    'the user`s own setting for mubit_recall is gone or changed. Setup approves two tools; the '
    + `rest of the Mubit tools are the user's to decide, and they had decided:\n${after}`);
  const loaded = hostLoads(home);
  assert.ok(loaded.ok, `Codex cannot load the config.toml setup left:\n${loaded.said}`);
});

test('an approval_mode the user set on one of the two tools is kept, not overwritten', needsCodex, async () => {
  // A user who wrote `approval_mode = "prompt"` on mubit_outcome asked to be asked. Setup's
  // approval is a default for a user who has not decided, not an answer to one who has, and
  // re-running setup after an upgrade must not quietly take the decision back. The tool the
  // user left unset still gets the approval, and a second run changes nothing.
  const before = [
    'model = "gpt-5.6-sol"',
    '',
    OLD_REGISTRATION,
    '[mcp_servers.mubit.tools.mubit_outcome]',
    'approval_mode = "prompt"',
    '',
  ].join('\n');
  const home = makeHome({ 'config.toml': before });
  const seen = [];
  for (let i = 0; i < 2; i++) {
    const r = await runSetup(home);
    assert.equal(r.code, 0, `run ${i + 1} exited ${r.code}:\n${r.stdout}\n${r.stderr}`);
    seen.push(readToml(home));
  }
  const want = { mubit_outcome: 'prompt', mubit_learned: APPROVAL.value };
  assert.deepEqual(approvals(seen[0]), want,
    'setup overwrote the approval_mode the user had set on mubit_outcome, or did not approve '
    + `mubit_learned, which the user had left unset:\n${seen[0]}`);
  assert.deepEqual(approvals(seen[1]), want,
    `a second run did not leave the user's setting and the one approval where the first left them:\n${seen[1]}`);
  const loaded = hostLoads(home);
  assert.ok(loaded.ok, `Codex cannot load the config.toml setup left:\n${loaded.said}`);
});

/**
 * A directory holding a `codex` that is the real one for everything except `codex mcp add`,
 * which fails the way a refused registration does. The rest of setup, `codex mcp remove`
 * and the trust step's `codex app-server` included, runs against the real host.
 */
function codexWhoseAddFails() {
  const real = spawnSync('sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).stdout.trim();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mubit-codex-shim-')));
  writeFileSync(join(dir, 'codex'), [
    '#!/bin/sh',
    'if [ "$1" = mcp ] && [ "$2" = add ]; then echo "Error: registration refused" >&2; exit 1; fi',
    `exec ${JSON.stringify(real)} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return { PATH: `${dir}:${process.env.PATH ?? ''}` };
}

test('when the MCP registration does not land, no approval table is written', needsCodex, async () => {
  // A `[mcp_servers.mubit.tools.*]` table with no `[mcp_servers.mubit]` beside it is a server
  // with no transport, and the host refuses the whole file for it: Codex does not start, and
  // the user has to find the line by hand. Setup's own `codex mcp remove` has already taken the
  // old registration, so neither the two approvals nor a user's table put back after the
  // remove may be written unless the add succeeded.
  const listLoads = (home) => {
    const r = spawnSync('codex', ['mcp', 'list', '--json'], {
      encoding: 'utf8', env: { ...process.env, CODEX_HOME: home }, timeout: 30000,
    });
    return { ok: r.status === 0, said: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  };
  const cases = [
    { label: 'a fresh install', fresh: true, files: { 'config.toml': 'model = "gpt-5.6-sol"\n' }, args: [] },
    {
      label: 'a re-run with --no-trust over a user`s own tools table',
      files: {
        'config.toml': [
          OLD_REGISTRATION,
          '[mcp_servers.mubit.tools.mubit_recall]',
          'approval_mode = "prompt"',
          '',
        ].join('\n'),
      },
      args: ['--no-trust'],
    },
  ];
  for (const c of cases) {
    const home = makeHome(c.files);
    await runSetup(home, c.args, codexWhoseAddFails());
    const toml = readToml(home);
    const registered = /^\[mcp_servers\.mubit\]$/m.test(toml);
    // On a fresh install nothing else could have put a registration there, so one present
    // means the failing `codex mcp add` was never the one setup ran. On the re-run, putting
    // back the registration the remove took is a fair answer to a failed add, and allowed.
    if (c.fresh) {
      assert.ok(!registered, `${c.label}: the mubit server is registered, so the failing `
        + `\`codex mcp add\` was never the one setup ran and the checks below prove nothing:\n${toml}`);
    }
    if (!registered) {
      assert.deepEqual(toolHeaders(toml), [],
        `${c.label}: the registration failed and setup still wrote per-tool tables under a server `
        + `that is not there, which Codex refuses to load:\n${toml}`);
    }
    const loaded = listLoads(home);
    assert.ok(loaded.ok, `${c.label}: Codex cannot load the config.toml setup left:\n${loaded.said}\n${toml}`);
  }
});

test('the user`s own config.toml lines and comments survive, in order', needsCodex, async () => {
  // The file carries the user's model choice, their project trust and the comments they wrote
  // about both. Setup adds tables to it; reading it into a TOML library and writing it back out
  // would drop every comment and reorder the rest, all to add four lines.
  const mine = [
    '# my Codex settings, kept by hand',
    'model = "gpt-5.6-sol"   # the fast one',
    'model_reasoning_effort = "low"',
    '',
    '# projects I trust',
    '[projects."/Users/you/work"]',
    '# the main checkout',
    'trust_level = "trusted"',
    '',
    '# keep the warning off',
    '[notice]',
    'hide_full_access_warning = true',
    '',
  ];
  const home = makeHome({ 'config.toml': mine.join('\n') });
  for (let i = 0; i < 2; i++) {
    const r = await runSetup(home);
    assert.equal(r.code, 0, `run ${i + 1} exited ${r.code}:\n${r.stdout}\n${r.stderr}`);
  }
  const after = readToml(home).split('\n');
  let at = 0;
  for (const line of mine.filter((l) => l.trim())) {
    const found = after.indexOf(line, at);
    assert.ok(found !== -1,
      `the user's line \`${line}\` is missing or out of order after two runs. Setup adds tables to `
      + `this file and must rewrite none of the user's:\n${after.join('\n')}`);
    at = found + 1;
  }
  assert.deepEqual(approvals(after.join('\n')), OURS, 'the approvals were not written alongside the user`s lines.');
});

test('config.toml is backed up before the approvals are written', needsCodex, async () => {
  // `config.toml.before-mubit` is what a user restores when they want setup undone. A backup
  // taken after the approval write already holds the approvals, so restoring it undoes nothing.
  const home = makeHome({ 'config.toml': 'model = "gpt-5.6-sol"\n' });
  const r = await runSetup(home);
  assert.equal(r.code, 0, `setup exited ${r.code}:\n${r.stdout}\n${r.stderr}`);

  const backup = join(home, 'config.toml.before-mubit');
  assert.ok(existsSync(backup), 'no config.toml.before-mubit was written');
  const held = readFileSync(backup, 'utf8');
  assert.match(held, /^model = "gpt-5\.6-sol"$/m, 'the backup does not hold the user`s file.');
  assert.deepEqual(approvals(held), {},
    `the backup already carries the approvals, so it was taken after they were written:\n${held}`);
});

test('--no-trust writes no approval', needsCodex, async () => {
  // `--no-trust` is the flag that already means "I will approve things myself". An approval
  // is the same decision about a tool that trust is about a hook.
  const home = makeHome();
  const r = await runSetup(home, ['--no-trust']);
  assert.equal(r.code, 0, `setup exited ${r.code}:\n${r.stdout}\n${r.stderr}`);
  const toml = readToml(home);
  assert.match(toml, /^\[mcp_servers\.mubit\]$/m, 'the MCP server was not registered, so the absence below proves nothing');
  assert.deepEqual(approvals(toml), {},
    `--no-trust approved Mubit tools on the user's behalf, which is what the flag exists to prevent:\n${toml}`);
});

test('--no-trust leaves existing approvals exactly as it found them', needsCodex, async () => {
  // A re-run with `--no-trust`, after an earlier run approved the two tools and the user set a
  // third by hand. Leaving approvals alone means neither adding nor removing: the host's
  // `codex mcp remove` takes the mubit tables with the registration, so leaving them alone
  // takes putting them back.
  const prior = { ...OURS, mubit_recall: 'prompt' };
  const before = [
    OLD_REGISTRATION,
    ...Object.entries(prior).flatMap(([tool, mode]) => [
      `[mcp_servers.mubit.tools.${tool}]`, `approval_mode = "${mode}"`, '',
    ]),
  ].join('\n');
  const home = makeHome({ 'config.toml': before });
  const r = await runSetup(home, ['--no-trust']);
  assert.equal(r.code, 0, `setup exited ${r.code}:\n${r.stdout}\n${r.stderr}`);

  const after = readToml(home);
  assert.ok(after.includes(join(CODEX_ROOT, 'mcp/dist/index.js')),
    `the MCP server was not re-registered at this install's path:\n${after}`);
  assert.deepEqual(approvals(after), prior,
    '--no-trust changed the Mubit tool approvals. It must leave them as it found them — the '
    + `user's earlier yes to the two tools and their own setting for mubit_recall alike:\n${after}`);
  const loaded = hostLoads(home);
  assert.ok(loaded.ok, `Codex cannot load the config.toml setup left:\n${loaded.said}`);
});

// ===========================================================================
// Every user setting survives, and the file always loads
// ===========================================================================

/**
 * The `mubit` server as the host reads it: `config/read` over `codex app-server`, the channel
 * the trust step already drives, which answers with the parsed, effective config. An
 * `approval_mode` written as a quoted key, a dotted key or an inline table reads the same here
 * as one written as a table, which no line-based reading of the file can promise. `ok` is
 * false when the host refuses the file, and `said` carries its reason.
 *
 * @param {string} home
 * @returns {Promise<{ok: boolean, said: string, mubit: Record<string, any>|null}>}
 */
function hostView(home) {
  return new Promise((res) => {
    const child = spawn('codex', ['app-server'], {
      cwd: home, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buf = '';
    let settled = false;
    /** @param {{ok: boolean, said: string, mubit: Record<string, any>|null}} v */
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      res(v);
    };
    const timer = setTimeout(() => done({ ok: false, said: '`codex app-server` never answered config/read', mubit: null }), 30000);
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    child.stdin.on('error', () => { /* the host exited first; `done` has the answer or the timeout */ });
    child.on('error', (e) => done({ ok: false, said: String(e), mubit: null }));
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          send({ jsonrpc: '2.0', method: 'initialized', params: {} });
          send({ jsonrpc: '2.0', id: 2, method: 'config/read', params: {} });
        } else if (m.id === 2) {
          done(m.error ? { ok: false, said: String(m.error.message), mubit: null }
            : { ok: true, said: '', mubit: m.result?.config?.mcp_servers?.mubit ?? null });
        }
      }
    });
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: 'mubit-setup-test', title: 'mubit-setup-test', version: '1' } },
    });
  });
}

/**
 * One tool's `approval_mode` as the host reads it, or `null` when the host sees none.
 *
 * @param {{mubit: Record<string, any>|null}} view
 * @param {string} tool
 */
const hostApproval = (view, tool) => view.mubit?.tools?.[tool]?.approval_mode ?? null;

/** Everything setup printed, both streams. */
const printed = (r) => `${r.stdout}\n${r.stderr}`;

/**
 * The printed lines that name `tool`.
 *
 * @param {string} text
 * @param {string} tool
 */
const linesNaming = (text, tool) => text.split('\n').filter((l) => new RegExp(`\\b${tool}\\b`).test(l));

/** `[mcp_servers.mubit]` as an earlier install left it, one key/value line per entry. */
const OLD_SERVER_LINES = OLD_REGISTRATION.split('\n').filter(Boolean);

test('an approval_mode the user wrote as a quoted key is theirs, and is not written twice', needsCodex, async () => {
  // `"approval_mode" = "prompt"` is the same key as `approval_mode = "prompt"`; TOML only
  // spells it differently. Appending an unquoted `approval_mode = "approve"` beside it defines
  // the key twice, and the host refuses the whole file ("duplicate key"): Codex does not start.
  for (const key of ['"approval_mode"', "'approval_mode'"]) {
    const before = [
      'model = "gpt-5.6-sol"',
      '',
      OLD_REGISTRATION,
      '[mcp_servers.mubit.tools.mubit_outcome]',
      `${key} = "prompt"`,
      '',
    ].join('\n');
    const home = makeHome({ 'config.toml': before });
    const r = await runSetup(home);
    const after = readToml(home);
    const seen = await hostView(home);
    assert.ok(seen.ok,
      `with ${key} on mubit_outcome, Codex cannot load the config.toml setup left, so it does not `
      + `start. A second approval_mode beside the user's quoted one is a duplicate key:\n${seen.said}\n${after}`);
    assert.equal(r.code, 0, `setup exited ${r.code}:\n${r.stdout}\n${r.stderr}`);
    assert.equal(hostApproval(seen, 'mubit_outcome'), 'prompt',
      `the host no longer reads the user's ${key} = "prompt" on mubit_outcome, so setup took back a `
      + `decision the user had made:\n${after}`);
    assert.equal(hostApproval(seen, 'mubit_learned'), APPROVAL.value,
      `mubit_learned, which the user left unset, was not approved, so the review prompts every turn:\n${after}`);
    const keys = tables(after)
      .filter((t) => { const m = TOOL_HEADER.exec(t.header); return m && unquote(m[1]) === 'mubit' && unquote(m[2]) === 'mubit_outcome'; })
      .flatMap((t) => t.body)
      .filter((l) => /^(?:approval_mode|"approval_mode"|'approval_mode')\s*=/.test(l));
    assert.equal(keys.length, 1,
      `mubit_outcome carries ${keys.length} approval_mode keys after setup; the user wrote one, and `
      + `setup must add none:\n${after}`);
  }
});

test('a config.toml the host will not load is never left behind: setup puts it back, says so, and exits 1', needsCodex, async () => {
  // The last-resort guard. Setup edits the user's config.toml line by line, and some valid TOML
  // defeats that: here a multi-line array inside a mubit tools table, one of whose lines starts
  // with `[` and so reads as a table header. Whatever setup writes, a file the host refuses
  // means Codex does not start at all, so setup checks the file loads after its write, puts
  // back the file as it was before setup ran when it does not, says so, and exits 1: the tools
  // were not set up as asked, and a caller that reads 0 as done would say they were.
  const before = [
    'model = "gpt-5.6-sol"',
    '',
    OLD_REGISTRATION,
    '[mcp_servers.mubit.tools.mubit_outcome]',
    'approval_mode = "prompt"',
    'note = [',
    '  "why I ask first",',
    '["see", "the thread"],',
    ']',
    '',
  ].join('\n');
  const was = await hostView(makeHome({ 'config.toml': before }));
  assert.ok(was.ok, `the input itself does not load, so this test proves nothing:\n${was.said}`);

  const home = makeHome({ 'config.toml': before });
  const r = await runSetup(home);
  const after = readToml(home);
  const seen = await hostView(home);
  assert.ok(seen.ok,
    'setup left a config.toml Codex refuses to load, so Codex does not start and the user has to '
    + `find the broken line by hand:\n${seen.said}\n${after}`);
  assert.ok(seen.mubit, `the mubit server is gone from the config.toml setup put back, so Codex starts with no Mubit tools:\n${after}`);
  assert.equal(r.code, 1,
    `setup put config.toml back and exited ${r.code}. The approvals it was run for were not written, `
    + `so anything reading its status as success tells the user they were:\n${r.stdout}\n${r.stderr}`);
  assert.match(printed(r), /config\.toml/,
    `setup did not name config.toml when it put the file back, so the user cannot tell which file changed:\n${printed(r)}`);
  assert.match(printed(r), /\b(?:restor(?:e|ed|ing)|put(?:s|ting)? back)\b/i,
    `setup put config.toml back without saying so, so the user believes the approvals landed:\n${printed(r)}`);
  assert.match(after, /^model = "gpt-5\.6-sol"$/m, `putting the file back cost the user their own model setting:\n${after}`);
  assert.notEqual(hostApproval(seen, 'mubit_outcome'), APPROVAL.value,
    `mubit_outcome is approved over the user's "prompt", so it runs unasked though they asked to be asked:\n${after}`);
  assert.equal(readFileSync(join(home, 'config.toml.before-mubit'), 'utf8'), before,
    'config.toml.before-mubit does not hold the file as the user had it, and it is the only copy '
    + 'of the table setup could not carry: restoring it would not bring that table back.');
});

test('a failed load check puts back the whole file as it was before setup ran, not as `codex mcp add` left it', needsCodex, async () => {
  // A re-run over a file an earlier run wrote, to which the user has since added a mubit_recall
  // table setup cannot carry: a line of its multi-line array opens with `[`, and a line-based
  // reading takes that for a table header. The write fails the load check. The text just before
  // that write is the file as `codex mcp add` left it, and `codex mcp remove` had already taken
  // the user's table out of it; putting that back loses the setting for good, since
  // config.toml.before-mubit is the first run's copy and never held it. The text setup read
  // before its remove is the file the user had, and the one that goes back.
  const home = makeHome({ 'config.toml': 'model = "m"\n' });
  const first = await runSetup(home);
  assert.equal(first.code, 0, `the first run exited ${first.code}, so there is no earlier setup to re-run over:\n${first.stdout}\n${first.stderr}`);
  const before = `${readToml(home).replace(/\s+$/, '')}\n\n${[
    '[mcp_servers.mubit.tools.mubit_recall]',
    'approval_mode = "prompt"',
    'note = [',
    '  [1],',
    ']',
    '',
  ].join('\n')}`;
  writeFileSync(join(home, 'config.toml'), before);
  const was = await hostView(home);
  assert.equal(hostApproval(was, 'mubit_recall'), 'prompt',
    `the input does not load with mubit_recall at "prompt", so this test proves nothing:\n${was.said}\n${before}`);

  const r = await runSetup(home);
  assert.equal(r.code, 1,
    `setup exited ${r.code}, so the load check never refused its write and this test proves nothing. If setup `
    + `now carries this table, the test needs an input setup cannot carry:\n${r.stdout}\n${r.stderr}`);
  assert.equal(readToml(home), before,
    'the load check failed and config.toml is not the file the user had before this run: setup put back the '
    + 'file as `codex mcp add` left it, which `codex mcp remove` had already stripped of the user`s mubit_recall '
    + 'table, so their "prompt" on it is gone and config.toml.before-mubit, from the first run, never held it.');
  assert.match(printed(r), /\b(?:restor(?:e|ed|ing)|put(?:s|ting)? back)\b/i,
    `setup put config.toml back without saying so, so the user believes the run landed:\n${printed(r)}`);
  assert.match(printed(r), /\bregistration\b[^\n]*\b(?:not (?:been )?updated|unchanged|not changed)\b/i,
    'setup did not say the MCP registration was left as it was, so the user believes the server is now '
    + `registered at this install's path when Codex still launches the one from before:\n${printed(r)}`);
});

test('the load-check report names no line of the text setup threw away', needsCodex, async () => {
  // The host's refusal gives a line and column in the text setup wrote. Setup then puts other
  // text back, so the user who opens config.toml at that line finds some other line, or none,
  // and goes looking for a fault in their own file that is not there.
  const before = [
    'model = "gpt-5.6-sol"',
    '',
    OLD_REGISTRATION,
    '[mcp_servers.mubit.tools.mubit_outcome]',
    'approval_mode = "prompt"',
    'note = [',
    '  "why I ask first",',
    '["see", "the thread"],',
    ']',
    '',
  ].join('\n');
  const home = makeHome({ 'config.toml': before });
  const r = await runSetup(home);
  assert.equal(r.code, 1,
    `setup exited ${r.code}, so the load check never refused its write and there is no report to read:\n${printed(r)}`);
  const out = printed(r);
  for (const [form, re] of /** @type {const} */ ([
    ['`line <n>`', /\bline \d+/i],
    ['`column <n>`', /\bcolumn \d+/i],
    ['`config.toml:<line>:<column>`', /config\.toml:\d+/],
    ['a numbered source excerpt', /^\s*\d+\s*\|/m],
  ])) {
    assert.doesNotMatch(out, re,
      `setup's report cites a position in the text it discarded (${form}). The file on disk is not that `
      + `text, so the position sends the user to a line that is not the fault:\n${out}`);
  }
});

test('a failed registration leaves config.toml exactly as it was, and says the registration is unchanged', needsCodex, async () => {
  // `codex mcp remove` runs before `codex mcp add`, so an add that fails has already cost the
  // user their registration, their tools tables and their other server settings. Setup has the
  // text it read before the remove; putting it back is the whole of the answer. The file is
  // then byte-for-byte the user's, and the output says the registration was left unchanged
  // rather than letting the user find a missing server at the next session.
  const before = [
    '# mine',
    'model = "gpt-5.6-sol"',
    '',
    ...OLD_SERVER_LINES,
    'startup_timeout_sec = 30',
    '',
    '[mcp_servers.mubit.tools.mubit_recall]',
    'approval_mode = "prompt"',
    '',
    '[mcp_servers.mubit.tools.mubit_outcome]',
    'approval_mode = "approve"',
    '',
  ].join('\n');
  const was = await hostView(makeHome({ 'config.toml': before }));
  assert.ok(was.ok && was.mubit, `the input itself does not load, so this test proves nothing:\n${was.said}`);

  // --no-trust: nothing else writes to config.toml, so the file must come back byte-identical.
  const home = makeHome({ 'config.toml': before });
  const r = await runSetup(home, ['--no-trust'], codexWhoseAddFails());
  assert.equal(readToml(home), before,
    'the failed `codex mcp add` left config.toml changed. Setup`s own `codex mcp remove` took the '
    + 'registration, the user`s tools tables and startup_timeout_sec, and nothing put them back, so '
    + 'the next Codex session starts with no Mubit server at all.');
  assert.match(printed(r), /\bunchanged\b/i,
    'setup did not say the registration was left unchanged after the add failed, so the user '
    + `cannot tell whether Codex still has a Mubit server:\n${printed(r)}`);
  assert.equal(readFileSync(join(home, 'config.toml.before-mubit'), 'utf8'), before,
    'config.toml.before-mubit does not hold the file as the user had it, so restoring it does not undo setup.');

  // A normal run: the trust step still adds its tables after the failure, but the server the
  // host reads is the one the user had, tools tables and timeout included.
  const trusted = makeHome({ 'config.toml': before });
  await runSetup(trusted, [], codexWhoseAddFails());
  const seen = await hostView(trusted);
  assert.ok(seen.ok, `Codex cannot load the config.toml a failed add left:\n${seen.said}\n${readToml(trusted)}`);
  assert.deepEqual(seen.mubit, was.mubit,
    'after a failed add, the mubit server the host reads is not the one the user had, so the failure '
    + `cost them their registration or their settings on it:\n${readToml(trusted)}`);
});

test('the first config.toml backup is the one kept: no later run overwrites it', needsCodex, async () => {
  // `config.toml.before-mubit` is what a user restores to undo setup. A run that overwrites it
  // replaces the file as the user had it with whatever the previous run left, and after a
  // failed run that is a file with the registration missing: the original is then gone for
  // good. So the first backup wins, across failed and successful runs alike.
  const before = [
    'model = "gpt-5.6-sol"',
    '',
    OLD_REGISTRATION,
    '[mcp_servers.mubit.tools.mubit_recall]',
    'approval_mode = "prompt"',
    '',
  ].join('\n');
  const home = makeHome({ 'config.toml': before });
  const backup = join(home, 'config.toml.before-mubit');
  const runs = [
    { label: 'a failed add', env: codexWhoseAddFails() },
    { label: 'a second failed add', env: codexWhoseAddFails() },
    { label: 'a successful run', env: {} },
    { label: 'a second successful run', env: {} },
  ];
  for (const run of runs) {
    await runSetup(home, ['--no-trust'], run.env);
    assert.ok(existsSync(backup), `no config.toml.before-mubit after ${run.label}, so there is nothing to undo setup from`);
    assert.equal(readFileSync(backup, 'utf8'), before,
      `${run.label} overwrote config.toml.before-mubit, so the file as the user had it before setup `
      + `is gone:\n${readFileSync(backup, 'utf8')}`);
  }
  assert.notEqual(readToml(home), before,
    'config.toml is still the original after two successful runs, so the backup checks above could '
    + 'not have seen an overwrite.');
});

test('an approval the user set inline or as a dotted key under [mcp_servers.mubit] is theirs', needsCodex, async () => {
  // `[mcp_servers.mubit.tools.<tool>]` is one of three ways to write a tool's approval. The
  // other two live inside `[mcp_servers.mubit]` itself, and a `[mcp_servers.mubit.tools.<tool>]`
  // table beside either defines the tool twice: the host refuses the file and Codex does not
  // start. Setup writes no approval for a tool the user decided about in either form, leaves
  // the decision standing, and prints a warning naming the tool.
  const cases = [
    { form: 'an inline table', line: 'tools = { mubit_outcome = { approval_mode = "prompt" } }' },
    { form: 'a dotted key', line: 'tools.mubit_outcome.approval_mode = "prompt"' },
  ];
  for (const c of cases) {
    const before = ['model = "gpt-5.6-sol"', '', ...OLD_SERVER_LINES, c.line, ''].join('\n');
    const was = await hostView(makeHome({ 'config.toml': before }));
    assert.equal(hostApproval(was, 'mubit_outcome'), 'prompt',
      `${c.form}: the host does not read the input as "prompt", so this case proves nothing:\n${was.said}`);

    const home = makeHome({ 'config.toml': before });
    const r = await runSetup(home);
    const after = readToml(home);
    const seen = await hostView(home);
    assert.ok(seen.ok,
      `${c.form}: Codex cannot load the config.toml setup left, so it does not start:\n${seen.said}\n${after}`);
    assert.equal(hostApproval(seen, 'mubit_outcome'), 'prompt',
      `${c.form}: the host reads mubit_outcome as ${JSON.stringify(hostApproval(seen, 'mubit_outcome'))}, `
      + `not the "prompt" the user set, so setup overrode or dropped a decision the user had made:\n${after}`);
    assert.ok(linesNaming(printed(r), 'mubit_outcome').some((l) => /warn/i.test(l)),
      `${c.form}: setup printed no warning naming mubit_outcome, so the user is not told the tool `
      + `was left out of the approvals:\n${printed(r)}`);
  }
});

test('a CRLF config.toml with a comment on the tools header: the user`s value is recognised and kept, with and without --no-trust', needsCodex, async () => {
  // A file saved on Windows ends each line with `\r\n`, and a header may carry a comment. Both
  // are valid TOML. Setup has to recognise the user's table in that file before its own
  // `codex mcp remove` takes it, or the value is gone: a normal run then approves the tool
  // over the user's "prompt", and `--no-trust` drops it while saying it kept it.
  const before = [
    'model = "gpt-5.6-sol"',
    '',
    ...OLD_SERVER_LINES,
    '',
    '[mcp_servers.mubit.tools.mubit_outcome] # mine',
    'approval_mode = "prompt"',
    '',
  ].join('\r\n');
  const was = await hostView(makeHome({ 'config.toml': before }));
  assert.equal(hostApproval(was, 'mubit_outcome'), 'prompt', `the input does not load as "prompt":\n${was.said}`);

  for (const args of [[], ['--no-trust']]) {
    const flag = args.length ? '--no-trust' : 'a normal run';
    const home = makeHome({ 'config.toml': before });
    const r = await runSetup(home, args);
    const after = readToml(home);
    const seen = await hostView(home);
    assert.ok(seen.ok, `${flag}: Codex cannot load the config.toml setup left:\n${seen.said}\n${after}`);
    assert.equal(r.code, 0, `${flag}: setup exited ${r.code}:\n${r.stdout}\n${r.stderr}`);
    assert.equal(hostApproval(seen, 'mubit_outcome'), 'prompt',
      `${flag}: the host reads mubit_outcome as ${JSON.stringify(hostApproval(seen, 'mubit_outcome'))}, `
      + `so the user's "prompt" in a CRLF file with a commented header was not recognised, and was `
      + `lost or overwritten:\n${JSON.stringify(after)}\n${r.stdout}`);
    if (!args.length) {
      assert.ok(linesNaming(printed(r), 'mubit_outcome').some((l) => /\bkept\b/i.test(l)),
        `setup did not report the user's approval_mode on mubit_outcome as kept, so the user cannot tell it was seen:\n${r.stdout}`);
    }
  }
});

test('what setup says matches what it did: "already approved" on a re-run, "kept" for the user`s own value', needsCodex, async () => {
  // Setup reports each of the two tools. A tool whose approval_mode is already "approve" is
  // already approved: telling the user setup "kept the approval_mode you set" credits them
  // with a setting setup itself wrote on the last run. A value of their own that is not
  // "approve" is theirs, and is reported as kept.
  const home = makeHome();
  const first = await runSetup(home);
  assert.equal(first.code, 0, `run 1 exited ${first.code}:\n${first.stdout}\n${first.stderr}`);
  const again = await runSetup(home);
  assert.equal(again.code, 0, `run 2 exited ${again.code}:\n${again.stdout}\n${again.stderr}`);
  for (const tool of APPROVAL.tools) {
    const lines = linesNaming(printed(again), tool);
    assert.ok(lines.some((l) => /\balready approved\b/i.test(l)),
      `the re-run did not say ${tool} was already approved, so the user cannot tell the approval is in place:\n${again.stdout}`);
    assert.ok(!lines.some((l) => /\bkept\b/i.test(l)),
      `the re-run told the user it kept an approval_mode they set on ${tool}, which setup itself `
      + `wrote on the last run:\n${again.stdout}`);
  }

  const theirs = makeHome({
    'config.toml': [OLD_REGISTRATION, '[mcp_servers.mubit.tools.mubit_outcome]', 'approval_mode = "prompt"', ''].join('\n'),
  });
  for (let i = 0; i < 2; i++) {
    const r = await runSetup(theirs);
    assert.equal(r.code, 0, `run ${i + 1} exited ${r.code}:\n${r.stdout}\n${r.stderr}`);
    const outcome = linesNaming(printed(r), 'mubit_outcome');
    assert.ok(outcome.some((l) => /\bkept\b/i.test(l)),
      `run ${i + 1} did not report the user's own approval_mode on mubit_outcome as kept, so the user `
      + `cannot tell setup saw their setting:\n${r.stdout}`);
    assert.ok(!outcome.some((l) => /\balready approved\b/i.test(l)),
      `run ${i + 1} called mubit_outcome already approved, but the user set it to "prompt", so the report `
      + `contradicts the file:\n${r.stdout}`);
    assert.ok(linesNaming(printed(r), 'mubit_learned').some((l) => /\bapproved\b/i.test(l)),
      `run ${i + 1} did not report mubit_learned as approved, so an approval setup holds goes unmentioned:\n${r.stdout}`);
  }
});

test('the user`s other settings on [mcp_servers.mubit] survive setup', needsCodex, async () => {
  // `codex mcp remove` deletes the whole server table and `codex mcp add` writes back only
  // `command`, `args` and `env`. A user who raised `startup_timeout_sec` for a slow start, or
  // `tool_timeout_sec` for a long recall, set it on this table, and setup re-registering the
  // server is no reason for it to go. They are saved before the remove and put back after the
  // add, the way the tools tables are, on every run and under `--no-trust` alike.
  const before = [
    'model = "gpt-5.6-sol"',
    '',
    ...OLD_SERVER_LINES,
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 120',
    '',
  ].join('\n');
  const home = makeHome({ 'config.toml': before });
  for (const args of [[], [], ['--no-trust']]) {
    const r = await runSetup(home, args);
    const after = readToml(home);
    const seen = await hostView(home);
    const run = args.length ? 'the --no-trust re-run' : 'a normal run';
    assert.ok(seen.ok, `${run}: Codex cannot load the config.toml setup left:\n${seen.said}\n${after}`);
    assert.equal(r.code, 0, `${run}: setup exited ${r.code}:\n${r.stdout}\n${r.stderr}`);
    assert.deepEqual(seen.mubit?.args, [join(CODEX_ROOT, 'mcp/dist/index.js')],
      `${run}: the server was not re-registered at this install's path, so Codex launches some other server:\n${after}`);
    assert.equal(seen.mubit?.startup_timeout_sec, 30,
      `${run}: the user's startup_timeout_sec on [mcp_servers.mubit] is gone, so a slow server start `
      + `times out again after setup:\n${after}`);
    assert.equal(seen.mubit?.tool_timeout_sec, 120,
      `${run}: the user's tool_timeout_sec on [mcp_servers.mubit] is gone, so a long call times out at the `
      + `host default again:\n${after}`);
  }
});

test('the user`s own entries in [mcp_servers.mubit.env] survive setup, and setup`s two take this run`s values', needsCodex, async () => {
  // `[mcp_servers.mubit.env]` is the server's environment. Setup writes two keys there,
  // MUBIT_CC_DATA_DIR and MUBIT_CC_PLUGIN_ROOT; a user who chose the server's tools with
  // MUBIT_MCP_TOOLS, or set any other variable it reads, wrote that in the same table.
  // `codex mcp remove` deletes the table and `codex mcp add` writes back only setup's two, so
  // the user's entries have to be read first and put back, on every run and under
  // `--no-trust` alike. Setup's own two carry this run's values, not an earlier install's.
  const pinned = realpathSync(mkdtempSync(join(tmpdir(), 'mubit-pinned-data-')));
  const before = [
    'model = "gpt-5.6-sol"',
    '',
    ...OLD_SERVER_LINES,
    '',
    '[mcp_servers.mubit.env]',
    'MUBIT_CC_DATA_DIR = "/opt/old-data"',
    'MUBIT_MCP_TOOLS = "mubit_recall"',
    'MUBIT_CC_PLUGIN_ROOT = "/opt/old-install"',
    'MUBIT_MCP_LESSON_SCOPE = "run"',
    '',
  ].join('\n');
  const was = await hostView(makeHome({ 'config.toml': before }));
  assert.equal(was.mubit?.env?.MUBIT_MCP_TOOLS, 'mubit_recall',
    `the input does not load with the user's MUBIT_MCP_TOOLS, so this test proves nothing:\n${was.said}`);

  const home = makeHome({ 'config.toml': before });
  for (const args of [[], ['--no-trust']]) {
    const run = args.length ? 'the --no-trust re-run' : 'a normal run';
    const r = await runSetup(home, [...args, `--data-dir=${pinned}`]);
    const after = readToml(home);
    const seen = await hostView(home);
    assert.ok(seen.ok, `${run}: Codex cannot load the config.toml setup left:\n${seen.said}\n${after}`);
    assert.equal(r.code, 0, `${run}: setup exited ${r.code}:\n${r.stdout}\n${r.stderr}`);
    const env = seen.mubit?.env ?? {};
    assert.equal(env.MUBIT_MCP_TOOLS, 'mubit_recall',
      `${run}: the user's MUBIT_MCP_TOOLS in [mcp_servers.mubit.env] is gone, so the server offers its `
      + `default tools again rather than the list the user chose:\n${after}`);
    assert.equal(env.MUBIT_MCP_LESSON_SCOPE, 'run',
      `${run}: the user's MUBIT_MCP_LESSON_SCOPE in [mcp_servers.mubit.env] is gone, so a lesson the model `
      + `writes may claim a wider scope than the user allowed:\n${after}`);
    assert.equal(env.MUBIT_CC_DATA_DIR, pinned,
      `${run}: MUBIT_CC_DATA_DIR is not the directory this run pinned, so the server reads another data `
      + `directory than the hooks and writes into a run pre-prompt recall never reads:\n${after}`);
    assert.equal(env.MUBIT_CC_PLUGIN_ROOT, CODEX_ROOT,
      `${run}: MUBIT_CC_PLUGIN_ROOT is not this install's root, so the server cannot recognise its own `
      + `install path as self-referential:\n${after}`);
  }
});

// ===========================================================================
// The user guide's transcript
// ===========================================================================

test('the user guide`s setup transcript is what a fresh --no-trust run prints', needsCodex, async () => {
  // The guide shows what a first run prints, so a user can tell their run went as it should by
  // comparing the two. A line there that setup does not print sends them looking for a fault
  // that is not there, or past one that is. The paths are the user's own and differ; the guide
  // writes $CODEX_HOME as ~/.codex and shows a sample data directory, and those stand in here.
  const guide = readFileSync(join(CODEX_ROOT, 'docs', 'user-guide.md'), 'utf8');
  const block = [...guide.matchAll(/^```\n([\s\S]*?)^```$/gm)].map((m) => m[1])
    .find((b) => b.includes('skipping trust (--no-trust)'));
  assert.ok(block, 'the user guide no longer shows the --no-trust setup transcript, so a user has nothing '
    + 'to compare a first run against.');
  const shownData = /^data directory: (.+)$/m.exec(block)?.[1];
  assert.ok(shownData, `the guide's transcript has no \`data directory:\` line, the first thing setup prints:\n${block}`);

  const home = makeHome();
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'mubit-guide-data-')));
  const r = await runSetup(home, ['--no-trust', `--data-dir=${data}`]);
  assert.equal(r.code, 0, `setup exited ${r.code}:\n${r.stdout}\n${r.stderr}`);
  const lines = (/** @type {string} */ s) => s.split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean);
  const ran = lines(r.stdout.split(data).join(shownData).split(home).join('~/.codex'));
  assert.deepEqual(lines(block), ran,
    'the user guide`s setup transcript is not what a fresh --no-trust run prints, so a user comparing '
    + 'their first run against it sees a difference that is not a fault, or trusts one that is.');
});

// ===========================================================================
// Refusals
// ===========================================================================

test('setup refuses a root that is not a plugin', async () => {
  const home = makeHome();
  const notAPlugin = mkdtempSync(join(tmpdir(), 'mubit-not-a-plugin-'));
  const r = await new Promise((res, rej) => {
    const child = spawn(process.execPath, [join(CODEX_ROOT, 'scripts', 'setup.mjs'), notAPlugin], {
      env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => res({ code, stderr }));
    child.on('error', rej);
  });
  assert.equal(r.code, 2, 'a directory with no hooks.json is not a plugin root');
  assert.match(r.stderr, /usage:/);
  assert.ok(!existsSync(join(home, 'hooks.json')),
    'it wrote to the user`s $CODEX_HOME before deciding the input was invalid');
});
