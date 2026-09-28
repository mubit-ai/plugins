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
 * own lines are left as they were, and `--no-trust` — the flag that already means "the
 * approving is mine" — leaves every approval as it found it. Those tests need `codex` too:
 * the tables sit under the server `codex mcp add` registers, and the host's own
 * `codex mcp remove` is what a re-run has to survive.
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
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function runSetup(home, args = []) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [join(CODEX_ROOT, 'scripts', 'setup.mjs'), CODEX_ROOT, ...args], {
      env: { ...process.env, CODEX_HOME: home },
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
