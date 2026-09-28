#!/usr/bin/env node
// @ts-check
/**
 * `scripts/setup.mjs` — install Mubit's registrations into the Codex user layer.
 *
 *   node scripts/setup.mjs <plugin-root> [--with-pre-tool] [--no-trust]
 *
 * This is the mechanical half of `mubit-memory:setup`, extracted so it can be read before it
 * is run and so the skill has one thing to invoke rather than a JSON-RPC handshake to
 * hand-roll. The skill still owns the judgement: which of these steps to take, whether the
 * user wants the `PreToolUse` warnings, and — the one that matters — asking before trust.
 *
 * ---------------------------------------------------------------------------
 * Why a Codex plugin needs an install step at all
 * ---------------------------------------------------------------------------
 * Codex ignores a `hooks.json` bundled in a plugin, and cannot resolve a path in a plugin's
 * `.mcp.json` — no `${VAR}` layer, and a relative path resolves against the project
 * directory. Both are recorded against a live host. So the
 * plugin ships both files as templates carrying `{{PLUGIN_ROOT}}`, and this substitutes the
 * real install path and writes them where Codex actually reads.
 *
 * ---------------------------------------------------------------------------
 * The four things it is careful about
 * ---------------------------------------------------------------------------
 * 1. **It merges, it does not overwrite.** `$CODEX_HOME/hooks.json` is the user's, and other
 *    tools register there. Every handler that is not ours is preserved; ours are replaced by
 *    path, so re-running is idempotent rather than additive.
 * 2. **It trusts only its own hooks.** The `hooks/list` result is filtered to commands under
 *    this plugin root before anything is written to `config.toml`. Trusting the whole file
 *    would silently approve another tool's hook on the user's behalf.
 * 3. **It backs up both files** it touches, to `<name>.before-mubit`, before touching them.
 *    The first run's copy is the one kept: a later run never overwrites it.
 * 4. **It never leaves a `config.toml` Codex cannot load.** A failed `codex mcp add` puts
 *    back the file as it was before setup ran. After each of its own writes it asks the host
 *    to load the file. If the host refuses the tool settings, the file as it was before setup
 *    ran goes back; if it refuses the hook trust, the text from before that write. Either way
 *    the run exits 1.
 *
 * `codex mcp remove` deletes all of `[mcp_servers.mubit]`, and `codex mcp add` writes back
 * only `command`, `args` and the `env` it is given. Every other setting on it
 * (`startup_timeout_sec`, the tools tables, a `tools` key inline or dotted) is read first and
 * put back after the add, and the user's own `env` entries are passed to the add.
 *
 * It also approves the two tools the outcome review asks the model to call, `mubit_outcome`
 * and `mubit_learned`, with `approval_mode = "approve"` on each one's
 * `[mcp_servers.mubit.tools.<tool>]` table. Every other Mubit tool keeps the host's default.
 * An `approval_mode` the user already set on either of the two, under any spelling of the
 * key, is kept; one set inline or as a dotted key under `[mcp_servers.mubit]` gets no table
 * of ours (it would define the tool twice) and a warning naming the tool.
 *
 * A CRLF `config.toml` is read with `\r` stripped and written back with CRLF.
 *
 * `--no-trust` records no hook trust and approves no tool, for anyone who would rather
 * approve the hooks themselves in the TUI's `/hooks` screen. Tool settings already in
 * `config.toml` are put back as they were. `--data-dir=<path>` overrides step 0's resolution.
 *
 * Node >= 20 built-ins only, and it shells out to `codex` for the two things Codex owns.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { claudeCodeDataDir } from '../lib/boot.mjs';

// Resolved, because everything downstream compares against it: the merge decides which
// handlers are ours by matching this prefix, and a relative `../codex` would match nothing.
const root = process.argv[2] ? resolve(process.argv[2]) : process.argv[2];
const withPreTool = process.argv.includes('--with-pre-tool');
const noTrust = process.argv.includes('--no-trust');
const dataArg = (process.argv.find((a) => a.startsWith('--data-dir=')) ?? '').slice('--data-dir='.length);
const HOME = process.env.CODEX_HOME || join(homedir(), '.codex');

if (!root || !existsSync(join(root, 'hooks.json'))) {
  console.error('usage: node scripts/setup.mjs <plugin-root> [--data-dir=<path>] [--with-pre-tool] [--no-trust]');
  console.error('  <plugin-root> is the directory containing hooks.json and .mcp.json');
  process.exit(2);
}
for (const need of ['hooks/dist/capture.mjs', 'mcp/dist/index.js', 'mcp/dist/server.js']) {
  if (!existsSync(join(root, need))) {
    console.error(`missing ${need} under ${root} — the install is damaged; reinstall the plugin.`);
    process.exit(2);
  }
}

/**
 * `config.toml` with **the named** `[hooks.state."…"]` tables removed, bodies and all.
 *
 * Line-based rather than a TOML parse, because this file is the user's: it carries their
 * project trust levels, their model choice, their notify hook. Round-tripping it through a
 * parser and a serialiser would reformat all of that to rewrite eleven tables. Removing the
 * lines leaves every byte we do not own exactly as it was.
 *
 * A `[hooks.state]` table's body is a single `trusted_hash` line, so the state machine only
 * has to survive that and the blank lines between tables; anything else ends the skip.
 *
 * ---------------------------------------------------------------------------
 * Why it takes a set, and not simply "everything"
 * ---------------------------------------------------------------------------
 * It used to remove every `[hooks.state.*]` table and write ours back. Every *other* tool's
 * hook trust went with them — and Codex skips an untrusted hook in silence, so the other tool
 * simply stopped working on our re-run, with nothing anywhere saying why.
 *
 * The obvious fix — keep the tables whose key is not under this plugin root — cannot be
 * written, because a trust key is `<sourcePath>:<event>:<group>:<index>` and carries no
 * command. Ours and another vendor's handler in the same `$CODEX_HOME/hooks.json` have the
 * same `sourcePath`, differing only in an index. The key alone cannot tell you whose it is.
 *
 * What can is `hooks/list`: the host reports every live handler with its key *and* its
 * command, so the caller resolves ours there and passes the keys down. Two kinds go:
 *
 *   1. **Ours**, which are about to be written back with a current hash.
 *   2. **Keys naming the file we rewrite that the host no longer lists at all** — provably
 *      dead, since a key is a position and the host just enumerated every position in that
 *      file. Without this, a reinstall at a new path leaves its old tables behind forever.
 *
 * Everything else is preserved byte-for-byte, including a live foreign handler's trust and
 * any key belonging to another file entirely.
 *
 * @param {string} text
 * @param {(key: string) => boolean} shouldRemove
 * @returns {string}
 */
function stripHookState(text, shouldRemove) {
  const out = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    if (/^\[hooks\.state[.[]/.test(line)) {
      // A table header we cannot parse is one we do not own: keep it, and stop skipping so
      // its body survives with it. Deleting what we failed to understand is how the last
      // version of this function revoked other tools' trust.
      const table = /^\[hooks\.state\."(.+)"\]\s*$/.exec(line);
      skipping = !!table && shouldRemove(table[1]);
      if (skipping) continue;
    }
    if (skipping) {
      if (/^trusted_hash\s*=/.test(line)) continue;
      if (/^\s*$/.test(line)) continue;
      skipping = false;
    }
    out.push(line);
  }
  // Also drop the header this script writes, so re-running does not stack comment blocks.
  const kept = out.filter((l) => !/^# Mubit Memory — hook trust/.test(l)
    && !/^# Every \[hooks\.state\] table below is regenerated/.test(l)
    && !/^# Only the \[hooks\.state\] tables below are ours/.test(l));
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return kept.length ? `${kept.join('\n')}\n` : '';
}

/** The two tools the outcome review asks the model to call. */
const APPROVE = ['mubit_outcome', 'mubit_learned'];

/** A TOML key: bare, basic-quoted or literal-quoted. */
const TOML_KEY = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const MUBIT = String.raw`\[\s*mcp_servers\s*\.\s*(?:mubit|"mubit"|'mubit')\s*`;
/** `[mcp_servers.mubit]` itself. */
const SERVER_HEADER = new RegExp(String.raw`^\s*${MUBIT}\]\s*(?:#.*)?$`);
/** `[mcp_servers.mubit.tools]` or `[mcp_servers.mubit.tools.<tool>]`, with the tool captured. */
const TOOLS_HEADER = new RegExp(String.raw`^\s*${MUBIT}\.\s*tools\s*(?:\.\s*(${TOML_KEY})\s*)?\]\s*(?:#.*)?$`);
/** Any `[mcp_servers.mubit.<key>…]` subtable, with `<key>` captured. */
const SUB_HEADER = new RegExp(String.raw`^\s*${MUBIT}\.\s*(${TOML_KEY}).*\]\s*(?:#.*)?$`);
/** A key/value line, with its first key and, when dotted, its second. */
const KEY_LINE = new RegExp(String.raw`^\s*(${TOML_KEY})\s*(?:\.\s*(${TOML_KEY})\s*)?(?:\.\s*${TOML_KEY}\s*)*=`);
/** `approval_mode = <value>`, the key bare or quoted, a string value captured. */
const APPROVAL_LINE = /^\s*(?:approval_mode|"approval_mode"|'approval_mode')\s*=\s*(?:"([^"]*)"|'([^']*)')?/;
/** The `[mcp_servers.mubit]` keys `codex mcp add` writes itself. */
const ADD_WRITES = new Set(['command', 'args', 'env']);
/** `[mcp_servers.mubit.env]` itself. */
const ENV_HEADER = new RegExp(String.raw`^\s*${MUBIT}\.\s*(?:env|"env"|'env')\s*\]\s*(?:#.*)?$`);
/** A one-line TOML string, basic or literal. */
const TOML_STRING = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*')`;
const ENV_VALUE = new RegExp(String.raw`^\s*(${TOML_STRING})\s*(?:#.*)?$`);
const ENV_INLINE = new RegExp(String.raw`^\s*\{(\s*(?:${TOML_KEY}\s*=\s*${TOML_STRING}\s*(?:,\s*${TOML_KEY}\s*=\s*${TOML_STRING}\s*)*,?\s*)?)\}\s*(?:#.*)?$`);
const ENV_PAIR = new RegExp(String.raw`(${TOML_KEY})\s*=\s*(${TOML_STRING})`, 'g');
/** The env keys setup writes itself, with this run's values. */
const SETUP_ENV = new Set(['MUBIT_CC_DATA_DIR', 'MUBIT_CC_PLUGIN_ROOT']);

/** @param {string} k */
function unquoteKey(k) {
  if (k.startsWith("'")) return k.slice(1, -1);
  if (k.startsWith('"')) { try { return JSON.parse(k); } catch { return k.slice(1, -1); } }
  return k;
}

/** @param {string} s  a TOML string; `null` for an escape JSON does not share */
function tomlString(s) {
  if (s.startsWith("'")) return s.slice(1, -1);
  try { return JSON.parse(s); } catch { return null; }
}

/** Is this line the header of a `[mcp_servers.mubit.*]` subtable `codex mcp add` does not write? */
const isSavedSub = (line) => {
  const m = SUB_HEADER.exec(line);
  return !!m && unquoteKey(m[1]) !== 'env';
};

/**
 * @typedef {{key: string, sub: string|null, lines: string[]}} Entry  one key/value of `[mcp_servers.mubit]`
 * @typedef {{header: string, tool: string|null, body: string[]}} Table  `tool` is `''` for
 *   `[mcp_servers.mubit.tools]`, `null` for a subtable that is not a tools table
 */

/**
 * What `codex mcp remove mubit` deletes and `codex mcp add` does not write back: the entries of
 * `[mcp_servers.mubit]` other than `command`, `args` and `env`, and every subtable but `env`, in
 * file order, comments dropped. Line-based over LF text, so a value line opening with `[` reads
 * as a header; the load check after the write catches what that gets wrong.
 *
 * `env` is the server's environment, from `[mcp_servers.mubit.env]`, an inline `env = {…}` or
 * dotted `env.<key>`; `envLost` names the keys whose value is not a one-line string.
 *
 * @param {string} text
 * @returns {{entries: Entry[], tables: Table[], env: Map<string, string>, envLost: string[]}}
 */
function readServer(text) {
  /** @type {Entry[]} */
  const entries = [];
  /** @type {Table[]} */
  const tables = [];
  const env = new Map();
  /** @type {string[]} */
  const envLost = [];
  /** @param {string} key @param {string} raw */
  const setEnv = (key, raw) => {
    const m = ENV_VALUE.exec(raw);
    const v = m ? tomlString(m[1]) : null;
    if (v === null || key.includes('=')) envLost.push(key); else env.set(key, v);
  };
  /** @type {'server'|'env'|Table|null} */
  let cur = null;
  let skip = false;
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) {
      const tools = TOOLS_HEADER.exec(line);
      cur = SERVER_HEADER.test(line) ? 'server'
        : ENV_HEADER.test(line) ? 'env'
          : isSavedSub(line) ? { header: line.trim(), tool: tools ? unquoteKey(tools[1] ?? '') : null, body: [] }
            : null;
      if (cur && typeof cur === 'object') tables.push(cur);
      continue;
    }
    const kept = line.replace(/\s+$/, '');
    if (!cur || !kept.trim() || kept.trim().startsWith('#')) continue;
    // A line with no key continues the entry above it, e.g. a multi-line array.
    const k = KEY_LINE.exec(kept);
    if (cur === 'env') { if (k) setEnv(unquoteKey(k[1]), kept.slice(k[0].length)); continue; }
    if (cur !== 'server') { cur.body.push(kept); continue; }
    if (k) {
      skip = ADD_WRITES.has(unquoteKey(k[1]));
      if (!skip) entries.push({ key: unquoteKey(k[1]), sub: k[2] ? unquoteKey(k[2]) : null, lines: [] });
      else if (unquoteKey(k[1]) === 'env') {
        const rest = kept.slice(k[0].length);
        const inline = ENV_INLINE.exec(rest);
        if (k[2]) setEnv(unquoteKey(k[2]), rest);
        else if (inline) for (const p of inline[1].matchAll(ENV_PAIR)) setEnv(unquoteKey(p[1]), p[2]);
        else envLost.push('env');
      }
    }
    if (!skip && entries.length) entries[entries.length - 1].lines.push(kept);
  }
  return { entries, tables, env, envLost };
}

/**
 * `text` without its saved kind of `[mcp_servers.mubit.*]` subtable, so writing them back can
 * never define one twice. A no-op after `codex mcp remove` on the host this was recorded
 * against; the comment lines just above the next table stay with it.
 *
 * @param {string} text
 * @returns {string}
 */
function dropSubtables(text) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]|null} */
  let span = null;
  const flush = () => {
    if (!span) return;
    let i = span.length;
    while (i && (!span[i - 1].trim() || span[i - 1].trim().startsWith('#'))) i--;
    out.push(...span.slice(i));
    span = null;
  };
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) {
      flush();
      if (isSavedSub(line)) { span = []; continue; }
    }
    if (span) span.push(line); else out.push(line);
  }
  flush();
  return out.join('\n');
}

/**
 * `text` with the saved `entries` put back at the end of its `[mcp_servers.mubit]` table, less
 * any key the add already wrote there. `lost` holds the entries there was no table for.
 *
 * @param {string} text
 * @param {Entry[]} entries
 */
function putServerKeys(text, entries) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => SERVER_HEADER.test(l));
  if (!entries.length || at < 0) return { text, lost: entries };
  let end = at + 1;
  const has = new Set();
  for (let i = at + 1; i < lines.length && !/^\s*\[/.test(lines[i]); i++) {
    if (lines[i].trim()) end = i + 1;
    const k = KEY_LINE.exec(lines[i]);
    if (k) has.add(unquoteKey(k[1]));
  }
  lines.splice(end, 0, ...entries.filter((e) => !has.has(e.key)).flatMap((e) => e.lines));
  return { text: lines.join('\n'), lost: [] };
}

/**
 * The saved tables as TOML, plus `approval_mode = "approve"` on each tool in `approve` the user
 * has not decided about, and what became of each of those tools.
 *
 * A tool named as `tools.<tool>…` or inside `tools = {…}` in `[mcp_servers.mubit]`, or as a
 * key of `[mcp_servers.mubit.tools]`, is the user's, and gets no table of ours: a second
 * definition of it stops the file loading. An inline `tools` takes no table at all.
 *
 * @param {{entries: Entry[], tables: Table[]}} saved
 * @param {string[]} approve
 */
function planTools(saved, approve) {
  const tables = saved.tables.map((t) => ({ ...t, body: [...t.body] }));
  const inline = saved.entries.find((e) => e.key === 'tools' && e.sub === null);
  const elsewhere = new Set([
    ...saved.entries.filter((e) => e.key === 'tools' && e.sub !== null).map((e) => String(e.sub)),
    ...tables.filter((t) => t.tool === '').flatMap((t) => t.body)
      .map((l) => KEY_LINE.exec(l)?.[1]).filter(Boolean).map((k) => unquoteKey(String(k))),
    ...approve.filter((tool) => inline && new RegExp(`\\b${tool}\\b`).test(inline.lines.join('\n'))),
  ]);
  const r = {
    /** @type {string[]} */ approved: [],
    /** @type {string[]} */ already: [],
    /** @type {{tool: string, mode: string}[]} */ kept: [],
    /** @type {string[]} */ elsewhere: [],
    /** @type {string[]} */ blocked: [],
  };
  for (const tool of approve) {
    if (elsewhere.has(tool)) { r.elsewhere.push(tool); continue; }
    if (inline) { r.blocked.push(tool); continue; }
    let t = tables.find((x) => x.tool === tool);
    const set = t?.body.map((l) => APPROVAL_LINE.exec(l)).find(Boolean);
    const mode = set ? set[1] ?? set[2] ?? '' : null;
    if (mode === 'approve') r.already.push(tool);
    else if (mode !== null) r.kept.push({ tool, mode });
    else {
      if (!t) {
        const key = /^[A-Za-z0-9_-]+$/.test(tool) ? tool : JSON.stringify(tool);
        t = { header: `[mcp_servers.mubit.tools.${key}]`, tool, body: [] };
        tables.push(t);
      }
      t.body.push('approval_mode = "approve"');
      r.approved.push(tool);
    }
  }
  const text = tables.map((t) => `${t.header}\n${t.body.map((l) => `${l}\n`).join('')}`).join('\n');
  return { text, ...r };
}

// --- 0. resolve the data directory, and PIN it -----------------------------------
//
// This is the step whose absence made a Codex session and a Claude Code session in one
// directory derive the same run id and then write it to two different places. Claude Code
// names its data directory with a suffix — `mubit-memory-<marketplace>` for a marketplace
// install, `-inline` for `--plugin-dir` — so the bare default is only one of several, and
// picking wrong costs the user their credentials and every memory the other harness holds.
//
// `lib/boot.mjs` can find it at runtime, and does. But a search is a guess, and this is the
// one moment where the answer can be resolved once, shown to the user, and written down.
// Pinning it as MUBIT_CC_DATA_DIR in the registrations outranks every other input on both
// hosts, so nothing downstream ever has to guess again.
const dataDir = dataArg || claudeCodeDataDir(process.env);
const shared = existsSync(join(dataDir, 'credentials.json'));
console.log(`data directory: ${dataDir}`);
console.log(shared
  ? '  shared with your Claude Code install — same run ids, same memory, same credentials.'
  : '  no credentials.json here yet. If you already use the Claude Code plugin, check this is '
    + 'the same directory it uses (ls ~/.claude/plugins/data/) and pass --data-dir=<path> if not.');

// --- 1. merge the registrations ------------------------------------------------
const tpl = JSON.parse(readFileSync(join(root, 'hooks.json'), 'utf8'));
const target = join(HOME, 'hooks.json');
const existing = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : { hooks: {} };
backUp(target);

/**
 * Copy `file` to `<file>.before-mubit`, unless an earlier run already did. That copy is what a
 * user restores to undo setup, and a later run's copy holds what the earlier run left instead.
 *
 * @param {string} file
 */
function backUp(file) {
  if (!existsSync(file)) return;
  const to = `${file}.before-mubit`;
  if (existsSync(to)) { console.log(`${to} is from an earlier run, and left as it is`); return; }
  copyFileSync(file, to);
  console.log(`backed up ${file} -> ${to}`);
}
/**
 * Is this handler one of ours, and therefore ours to replace?
 *
 * It used to be `command.includes('/hooks/dist/')`, which is not a fact about this plugin at
 * all — it is a fact about a directory layout, and a common one. Any other vendor who ships
 * `<their-root>/hooks/dist/*.mjs` had their registration deleted from the user's own
 * `hooks.json` the first time this script ran.
 *
 * Two things count as ours, and nothing else does:
 *
 *   1. A command under **this** install root.
 *   2. A command carrying the `MUBIT_CC_DATA_DIR=` pin that this script itself writes — which
 *      is what still recognises the registrations of a previous install at a *different* path,
 *      so upgrading in place replaces them rather than stacking a second copy.
 */
const OUR_DIST = `${join(root, 'hooks', 'dist')}/`;
const isMubit = (h) => {
  const command = String(h?.command ?? '');
  return command.includes(OUR_DIST) || command.startsWith('MUBIT_CC_DATA_DIR=');
};
// Codex runs a hook command as a shell string, so the pin rides in front of `node` — which is
// also why it is quoted: a data directory with a space in it is otherwise two arguments.
const sub = (s) => `MUBIT_CC_DATA_DIR=${JSON.stringify(dataDir)} ${s.split('{{PLUGIN_ROOT}}').join(root)}`;
const merged = { ...existing, hooks: { ...(existing.hooks ?? {}) } };
let added = 0;
for (const [event, groups] of Object.entries(tpl.hooks)) {
  if (event === 'PreToolUse' && !withPreTool) continue;
  const ours = groups.map((g) => ({ ...g, hooks: g.hooks.map((h) => ({ ...h, command: sub(h.command) })) }));
  const theirs = (merged.hooks[event] ?? [])
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isMubit(h)) }))
    .filter((g) => g.hooks.length);
  merged.hooks[event] = [...theirs, ...ours];
  added += ours.reduce((n, g) => n + g.hooks.length, 0);
}
// hooks.json accepts exactly `description` and `hooks`; anything else fails the whole file.
for (const k of Object.keys(merged)) if (k !== 'hooks' && k !== 'description') delete merged[k];
writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`);
console.log(`merged ${added} handler(s) across ${Object.keys(tpl.hooks).length - (withPreTool ? 0 : 1)} events into ${target}`);
if (!withPreTool) console.log('  (PreToolUse omitted: the warnings it exists for are off by default)');

// --- 2. register the MCP server ------------------------------------------------
// Read and backed up here, before anything below writes to it: `original` is the file as the
// user had it, and what a failed add puts back.
const cfg = join(HOME, 'config.toml');
const original = existsSync(cfg) ? readFileSync(cfg, 'utf8') : null;
// `codex mcp` writes LF whatever the file had, so setup's own writes restore the user's endings.
const eol = original?.includes('\r\n') ? '\r\n' : '\n';
/** @param {string} s */
const lf = (s) => s.replace(/\r\n/g, '\n');
/** @param {string} s */
const withEol = (s) => (eol === '\n' ? s : s.replace(/\n/g, eol));
backUp(cfg);
const saved = readServer(lf(original ?? ''));
/** Put config.toml back as it was before setup ran. */
const restore = () => { if (original === null) rmSync(cfg, { force: true }); else writeFileSync(cfg, original); };
spawnSync('codex', ['mcp', 'remove', 'mubit'], { stdio: 'ignore' });
// `--env` matters as much here as the pin in the hook commands does. Codex registers the
// server itself, so whatever is not passed here is simply absent — there is no host putting
// `CLAUDE_*` variables in its environment the way Claude Code does, and `mcp/src/launch.mjs`
// bridges exactly three `MUBIT_CC_*` names onto the host names `lib/` reads.
//
// Two of the three ride here, and the third deliberately does not:
//
//   `MUBIT_CC_DATA_DIR` — the MCP server derives the run id itself, with the same strategy
//   the hooks use, so a server reading a different data directory would write
//   /mubit-memory:remember into a run pre-prompt recall never reads.
//
//   `MUBIT_CC_PLUGIN_ROOT` — `lib/redact.mjs`'s `selfRoots()` builds the list of paths that
//   mark an item as being about the plugin itself, and the install root is one of them.
//   Unset, the server cannot recognise its own install path; under Codex that path lives
//   inside `$CODEX_HOME`, so it carries the user's home directory into anything the
//   suppression fails to catch.
//
//   `MUBIT_CC_PROJECT_DIR` — NOT passed, on purpose. `codex mcp add` writes to
//   `$CODEX_HOME/config.toml`: one registration serves every project on the machine, so a
//   project directory pinned at setup time would be wrong everywhere except the directory it
//   was taken in. Falling back to the launch cwd is the correct answer, and the run id is
//   unaffected either way because `directoryRunId` resolves through
//   `git rev-parse --show-toplevel` before it hashes.
//
// The user's own entries (MUBIT_MCP_TOOLS and the like) ride too, or the remove loses them.
const userEnv = [...saved.env].filter(([k]) => !SETUP_ENV.has(k));
const add = spawnSync('codex', [
  'mcp', 'add', 'mubit',
  ...userEnv.flatMap(([k, v]) => ['--env', `${k}=${v}`]),
  '--env', `MUBIT_CC_DATA_DIR=${dataDir}`,
  '--env', `MUBIT_CC_PLUGIN_ROOT=${root}`,
  '--', 'node', join(root, 'mcp/dist/index.js'),
], { encoding: 'utf8' });
console.log((add.stdout || add.stderr || '').trim());

// --- 2a. the two approvals -------------------------------------------------------
// Only after an add that landed: a tools table with no `[mcp_servers.mubit]` beside it fails
// the whole config load, and Codex does not start.
if (add.status !== 0) {
  // Setup's own `codex mcp remove` has already taken the registration and every setting on it.
  restore();
  console.log('\nthe MCP registration failed, so it was left unchanged: config.toml is as it was '
    + 'before setup ran, and no tool settings were written.');
} else {
  const post = existsSync(cfg) ? readFileSync(cfg, 'utf8') : '';
  const plan = planTools(saved, noTrust ? [] : APPROVE);
  const { text, lost } = putServerKeys(dropSubtables(lf(post)), saved.entries);
  const next = withEol(plan.text ? `${text.trim() ? `${text.replace(/\s+$/, '')}\n\n` : ''}${plan.text}` : text);
  if (next !== post) {
    writeFileSync(cfg, next);
    // `post` has already lost what the remove took and setup could not carry; `original` has not.
    keepLoadable(restore, 'config.toml was restored to what it was before setup ran, so the MCP '
      + 'registration was not updated and no tool settings were written.');
  }
  const keys = (/** @type {Entry[]} */ es) => [...new Set(es.map((e) => e.key))].join(', ');
  const carried = saved.entries.filter((e) => !lost.includes(e));
  if (carried.length) console.log(`\ncarried over your ${keys(carried)} on [mcp_servers.mubit].`);
  if (userEnv.length) console.log(`\ncarried over your ${userEnv.map(([k]) => k).join(', ')} in [mcp_servers.mubit.env].`);
  if (lost.length) console.log(`\nwarning: ${keys(lost)} on [mcp_servers.mubit] could not be put back; ${cfg}.before-mubit has them.`);
  if (saved.envLost.length) {
    console.log(`\nwarning: ${saved.envLost.join(', ')} in [mcp_servers.mubit.env] could not be put back; `
      + `${cfg}.before-mubit has them.`);
  }
  if (noTrust) {
    const keptTools = saved.tables.some((t) => t.tool !== null) || carried.some((e) => e.key === 'tools');
    console.log(`\nno tools approved (--no-trust)${keptTools ? '; the Mubit tool settings already in config.toml were kept' : ''}.`);
    console.log(`To stop Codex asking before ${APPROVE.join(' and ')}, set approval_mode = "approve"`);
    console.log('under [mcp_servers.mubit.tools.<tool>] in config.toml.');
  } else {
    // One line per outcome, so no line names a tool it does not describe.
    console.log('');
    if (plan.approved.length) {
      console.log(`approved ${plan.approved.join(' and ')} in ${cfg} (approval_mode = "approve"), so the outcome `
        + `review's calls to ${plan.approved.length > 1 ? 'them' : 'it'} raise no prompt. Every other Mubit tool still asks.`);
    }
    if (plan.already.length) console.log(`${plan.already.join(' and ')} already approved (approval_mode = "approve").`);
    for (const { tool, mode } of plan.kept) console.log(`kept the approval_mode you set on ${tool}${mode ? ` ("${mode}")` : ''}.`);
    for (const tool of plan.elsewhere) {
      console.log(`warning: ${tool} is set inline or as a dotted key, not in its own [mcp_servers.mubit.tools.${tool}] `
        + 'table; kept as you set it, and setup wrote no approval for it.');
    }
    for (const tool of plan.blocked) {
      console.log(`warning: ${tool} not approved: [mcp_servers.mubit] sets tools inline, which takes no table. `
        + `Add ${tool} = { approval_mode = "approve" } to it to stop the prompts.`);
    }
  }
}

/**
 * The last-resort guard. Setup edits config.toml line by line, and some valid TOML defeats that;
 * a file the host refuses stops Codex starting at all. So after each write the host loads it,
 * and if it will not, `undo` puts back a file it loads and the run exits 1. The host's reason is
 * not quoted: its lines and columns are in the text `undo` just threw away.
 *
 * @param {() => void} undo
 * @param {string} undone  what `undo` put back, for the message
 */
function keepLoadable(undo, undone) {
  const r = spawnSync('codex', ['mcp', 'list', '--json'], { cwd: HOME, encoding: 'utf8', timeout: 30000 });
  if (r.status === 0) return;
  undo();
  console.error(`\nCodex refused to load ${cfg} as setup wrote it.\n${undone}`);
  process.exit(1);
}

// --- 3. trust ------------------------------------------------------------------
if (noTrust) {
  console.log('\nskipping trust (--no-trust). Run /hooks in the Codex TUI and approve the Mubit entries,');
  console.log('or Codex will silently skip every one of them.');
  process.exit(0);
}
const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; const msgs = [];
child.stdout.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) { try { msgs.push(JSON.parse(line)); } catch { /* not a frame */ } }
  }
});
const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'mubit-setup', title: 'mubit-setup', version: '1' } } });
setTimeout(() => send({ jsonrpc: '2.0', method: 'initialized', params: {} }), 500);
setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'hooks/list', params: {} }), 900);
setTimeout(() => {
  child.kill();
  const listed = msgs.find((m) => m.id === 2)?.result?.data?.[0]?.hooks ?? [];
  const hooks = listed.filter((h) => isMubit(h));
  if (!hooks.length) {
    console.error('\nno Mubit hooks found by `hooks/list` — nothing trusted. Check the merge above.');
    process.exit(1);
  }
  console.log(`\nAbout to record trust for ${hooks.length} hook(s) in ${join(HOME, 'config.toml')}:`);
  for (const h of hooks) console.log(`  ${h.eventName.padEnd(18)} ${h.command}`);

  const beforeRaw = existsSync(cfg) ? readFileSync(cfg, 'utf8') : '';
  const before = lf(beforeRaw);

  // Replace, never append. A hook's trust key is `<sourcePath>:<event>:<group>:<index>` and
  // does not change when its command does — so re-running setup after any edit produces a
  // SECOND `[hooks.state."<same key>"]` table. TOML forbids redefining a table, so the file
  // stops parsing and Codex refuses to start at all: "failed to load bootstrap configuration".
  //
  // Not hypothetical. This is what the first version of this script did on its second run.
  //
  // Replace **ours**, though, and not the file's. `hooks/list` has just enumerated every live
  // handler in every source file, so the two removable classes can be named exactly: the keys
  // we are about to rewrite, and keys naming a file we rewrite that the host no longer lists
  // at all. Another tool's trust entry is neither, and survives untouched.
  const ourKeys = new Set(hooks.map((h) => h.key));
  const liveKeys = new Set(listed.map((h) => h.key));
  const ourSources = new Set(hooks.map((h) => h.sourcePath).filter(Boolean));
  const isStale = (key) => {
    if (liveKeys.has(key)) return false;
    // `<sourcePath>:<event>:<group>:<index>` — the path is everything before the last three.
    const source = key.split(':').slice(0, -3).join(':');
    return ourSources.has(source);
  };
  const preserved = [...(before.matchAll(/^\[hooks\.state\."(.+)"\]\s*$/gm))]
    .map((m) => m[1]).filter((k) => !ourKeys.has(k) && !isStale(k));

  const kept = stripHookState(before, (key) => ourKeys.has(key) || isStale(key));
  let toml = '\n# Mubit Memory — hook trust, rewritten in full by scripts/setup.mjs.\n';
  toml += '# Only the [hooks.state] tables below are ours; any other tool`s are left alone.\n';
  for (const h of hooks) toml += `[hooks.state."${h.key}"]\ntrusted_hash = "${h.currentHash}"\n`;
  const after = `${kept}${toml}`;
  writeFileSync(cfg, withEol(after));

  // The self-check. It used to be a bare count against `hooks.length`, which cannot survive
  // preserving a foreign entry — and, worse, could only ever have passed by deleting one.
  // What actually has to hold is: no key twice (TOML would refuse the file), every key of ours
  // present, and nothing preserved that went missing.
  const finalKeys = [...after.matchAll(/^\[hooks\.state\."(.+)"\]\s*$/gm)].map((m) => m[1]);
  const dupes = finalKeys.filter((k, i) => finalKeys.indexOf(k) !== i);
  const missing = [...ourKeys].filter((k) => !finalKeys.includes(k));
  const lost = preserved.filter((k) => !finalKeys.includes(k));
  if (dupes.length || missing.length || lost.length) {
    console.error('\nrefusing to leave config.toml in this state — restoring:');
    if (dupes.length) console.error(`  defined twice: ${dupes.join(', ')}`);
    if (missing.length) console.error(`  ours, not written: ${missing.join(', ')}`);
    if (lost.length) console.error(`  another tool's, dropped: ${lost.join(', ')}`);
    writeFileSync(cfg, beforeRaw);
    process.exit(1);
  }
  keepLoadable(() => writeFileSync(cfg, beforeRaw),
    'config.toml was restored to the text it had before that write, so it holds no hook trust.'
    + `${existsSync(`${cfg}.before-mubit`) ? ` ${cfg}.before-mubit holds the file as it was before setup first ran.` : ''}`);
  console.log(`\nrecorded ${hooks.length}.${preserved.length ? ` Left ${preserved.length} other trust entr`
    + `${preserved.length === 1 ? 'y' : 'ies'} alone.` : ''}`
    + ' Start a NEW Codex session — hooks and MCP servers are read at session start.');
  process.exit(0);
}, 3000);
