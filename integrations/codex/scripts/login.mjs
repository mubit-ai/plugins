#!/usr/bin/env node
/**
 * Store a Mubit API key for a Codex install.
 *
 * `bin/auth.mjs` is shared with the Claude Code build, and on its own it writes to the bare
 * `~/.claude/plugins/data/mubit-memory`. Under Codex that is frequently the wrong directory:
 * `scripts/setup.mjs` resolves the one this machine actually uses — the suffix varies with the
 * install (`mubit-memory-<marketplace>`, `mubit-memory-inline`, …) — and PINS it as
 * MUBIT_CC_DATA_DIR in every registration it writes into `$CODEX_HOME/hooks.json`.
 *
 * So the hooks read one directory and a hand-run auth writes another, silently, with no error
 * anywhere. This script closes that gap: it reads the pin back out of the live registrations
 * and writes the credentials exactly where the hooks look.
 *
 * usage: node scripts/login.mjs [--key=mbt_...] [--endpoint=<url>] [--data-dir=<path>] [--status] [--json]
 *        key also accepted from MUBIT_AUTH_KEY / MUBIT_API_KEY, or a prompt.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { claudeCodeDataDir } from '../lib/boot.mjs';
import { authenticateWithKey, currentCredentials, normalizeEndpoint, DEFAULT_ENDPOINT } from '../bin/auth.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '';
};
const json = argv.includes('--json');
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');

/**
 * The pin `setup` wrote, which is what the hooks actually run with. Authoritative over any
 * search: a search is a guess about which install is live, this is the recorded answer.
 * @returns {string}
 */
function pinnedDataDir() {
  const path = join(CODEX_HOME, 'hooks.json');
  if (!existsSync(path)) return '';
  try {
    const found = JSON.stringify(JSON.parse(readFileSync(path, 'utf8')))
      .match(/MUBIT_CC_DATA_DIR=\\"([^\\"]+)\\"/);
    return found ? found[1] : '';
  } catch {
    return '';
  }
}

const explicit = flag('data-dir');
const pinned = pinnedDataDir();
const dataDir = resolve(explicit || process.env.MUBIT_CC_DATA_DIR || pinned || claudeCodeDataDir(process.env));
const source = explicit ? 'from --data-dir'
  : process.env.MUBIT_CC_DATA_DIR ? 'from MUBIT_CC_DATA_DIR'
  : pinned ? 'pinned by setup in $CODEX_HOME/hooks.json'
  : 'resolved — setup has not run, so this is a guess';

const emit = (payload, text) => console.log(json ? JSON.stringify({ ...payload, dataDir }) : text);

if (argv.includes('--status')) {
  const cur = currentCredentials(dataDir);
  emit(
    { ok: cur.hasKey, state: cur.hasKey ? 'configured' : 'unconfigured', endpoint: cur.endpoint },
    cur.hasKey
      ? `Signed in to ${cur.endpoint || DEFAULT_ENDPOINT}.\n  credentials: ${dataDir} (${source})`
      : `No Mubit credentials in ${dataDir} (${source}).`,
  );
  process.exit(cur.hasKey ? 0 : 1);
}

/** @returns {Promise<string>} */
async function readKey() {
  const given = flag('key') || process.env.MUBIT_AUTH_KEY || process.env.MUBIT_API_KEY || '';
  if (given) return given.trim();
  if (!process.stdin.isTTY) return '';
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question('Mubit API key (mbt_…): ')).trim();
  } finally {
    rl.close();
  }
}

const apiKey = await readKey();
if (!apiKey) {
  console.error('No key supplied. Pass --key=mbt_…, set MUBIT_AUTH_KEY, or run this in a terminal.');
  process.exit(1);
}

const endpoint = normalizeEndpoint(flag('endpoint') || process.env.MUBIT_ENDPOINT || '');
console.error(`data directory: ${dataDir}\n  ${source}`);

const res = await authenticateWithKey({ dataDir, endpoint, apiKey });
emit(
  { ok: res.ok, state: res.state, endpoint: res.endpoint, stored: res.stored },
  res.ok
    ? `${res.detail}\nStored in ${dataDir}. Start a NEW Codex session.`
    : `${res.detail}`,
);
process.exit(res.ok ? 0 : 1);
