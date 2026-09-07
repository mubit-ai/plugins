#!/usr/bin/env node
// @ts-check
/**
 * `labs/import-fixtures.mjs` — lay the Lab 13 transcripts out the way the two hosts do.
 *
 * The templates under `labs/payloads/import/` carry `__PROJECT_DIR__` where a record names
 * the directory it happened in, because the importer resolves the run id from that field
 * and the demo app's absolute path differs per checkout. This writes them out with the real
 * path in, into the layouts the importers walk:
 *
 *   labs/.work/transcripts/claude/<encoded project dir>/<session>.jsonl
 *   labs/.work/transcripts/claude/<encoded project dir>/<session>/subagents/agent-1.jsonl
 *   labs/.work/codex/sessions/2026/09/07/rollout-*.jsonl
 *
 *   node labs/import-fixtures.mjs             # into labs/.work, for the demo app there
 *   node labs/import-fixtures.mjs --out <dir> --project <dir>
 *
 * Nothing here is copied from a real `~/.claude/projects` or `~/.codex/sessions`; the
 * records are synthetic, built to the shapes `lib/import.mjs` and `lib/codex-import.mjs`
 * document in their headers.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LAB_ROOT = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(LAB_ROOT, 'payloads', 'import');

/** The session id the Claude Code template records carry. */
export const IMPORT_SESSION = '7a3088f2-e5c4-4308-b17f-863fd7889341';
/** The three Codex thread ids: the pre-0.149 thread, the 0.153 thread, and its subagent. */
export const CODEX_THREADS = Object.freeze({ legacy: '01a0-lab-0146', modern: '01a0-lab-0153', subagent: '01a0-lab-0153-sub' });

/** The host's own lossy encoding of a project directory — `lib/import.mjs`'s `encodeProjectDir`. */
const encode = (dir) => String(dir).replace(/[/._]/g, '-');

/**
 * @param {{out: string, projectDir: string}} o
 * @returns {{claudeRoot: string, codexRoot: string, files: string[]}}
 */
export function materialise(o) {
  const projectDir = resolve(o.projectDir);
  const claudeRoot = join(o.out, 'transcripts', 'claude');
  const codexRoot = join(o.out, 'codex', 'sessions');
  const fill = (rel) => readFileSync(join(TEMPLATES, rel), 'utf8').split('__PROJECT_DIR__').join(projectDir);
  const files = [];
  const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); files.push(path); };

  const dir = join(claudeRoot, encode(projectDir));
  put(join(dir, `${IMPORT_SESSION}.jsonl`), fill('claude/session.jsonl'));
  put(join(dir, IMPORT_SESSION, 'subagents', 'agent-1.jsonl'), fill('claude/agent-1.jsonl'));
  // The offload the session's `<persisted-output>` marker points at: never imported.
  put(join(dir, IMPORT_SESSION, 'tool-results', 'toolu_lab_i004.txt'), 'x'.repeat(4096));

  for (const f of readdirSync(join(TEMPLATES, 'codex')).filter((n) => n.endsWith('.jsonl')).sort()) {
    put(join(codexRoot, '2026', '09', '07', f), fill(`codex/${f}`));
  }
  return { claudeRoot, codexRoot, files };
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === selfPath) {
  const argv = process.argv.slice(2);
  const pick = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
  const out = resolve(pick('--out') || join(LAB_ROOT, '.work'));
  const projectDir = resolve(pick('--project') || join(LAB_ROOT, '.work', 'demo-app'));
  const r = materialise({ out, projectDir });
  process.stdout.write(`claude transcripts  ${r.claudeRoot}\ncodex rollouts      ${r.codexRoot}\n${r.files.length} files written for ${projectDir}\n`);
}
