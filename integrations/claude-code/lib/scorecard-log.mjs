// @ts-check
/**
 * `lib/scorecard-log.mjs` — one append-only log per host session:
 * `<dataDir>/scorecard/<session_id>.jsonl`.
 *
 * Keyed by session rather than run so a mid-session `cd` (which moves the run) does not split
 * it. Several hooks append concurrently, so every row is a single `O_APPEND` write, exactly as
 * `lib/ledger.mjs` does it, and nothing ever rewrites the file. The session scorecard is a pure
 * fold over these rows at render time (`lib/scorecard.mjs`).
 *
 * Zero dependencies, synchronous, and total: nothing here throws.
 */

import {
  closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { ensureDir, resolveDataDir, safeSegment } from './state.mjs';

export const SCORE_LOG_VERSION = 1;
export const SCORE_DIR = 'scorecard';
export const SCORE_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A whole-file read stops here; a session log this big is a bug, not a session. */
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_ID = 128;

/**
 * @typedef {{title: string, terms: string[], handle: string}} StandingLesson
 * @typedef {{title: string, terms: string[], handle: string, pointer: boolean}} ShownLesson
 * @typedef {{used: boolean|null, matched: string[]}} TurnLesson
 *
 * Every row also carries `v` (SCORE_LOG_VERSION) and `at` (ms), stamped on append.
 *
 * @typedef {{kind: 'start', source: string, lessons: Record<string, StandingLesson>,
 *   refs: string[], tokens: number}} StartRow
 *   session-start: `source` is startup | resume | clear | compact. Standing lessons count as
 *   shown on the first prompt after this row.
 * @typedef {{kind: 'prompt', prompt_id: string, correction: boolean, slash: boolean}} PromptRow
 *   stage-prompt, one per user prompt.
 * @typedef {{kind: 'shown', prompt_id: string, lessons: Record<string, ShownLesson>,
 *   refs: string[], tokens: number}} ShownRow
 *   prompt-recall: `lessons` are the `entry_type: lesson` entries rendered this turn, `refs`
 *   every rendered reference id of any type (for handle resolution), `tokens` what this turn's
 *   injection cost.
 * @typedef {{kind: 'refs', source: string, refs: string[]}} RefsRow
 *   Refs shown somewhere the scorecard does not count (a subagent), kept so their handles
 *   still resolve.
 * @typedef {{kind: 'tool', prompt_id: string, failed: boolean, intent: string}} ToolRow
 *   capture tool / --failure, main agent only. `intent` is `toolIntent` from lib/classify.mjs.
 * @typedef {{kind: 'explicit', prompt_id: string, ids: string[], outcome: string}} ExplicitRow
 *   capture, the plugin's own `mubit_outcome`: resolved reference ids and the outcome given.
 * @typedef {{kind: 'learned', prompt_id: string}} LearnedRow
 *   capture, the plugin's own `mubit_learned`, on success.
 * @typedef {{kind: 'turn', prompt_id: string, run_id: string,
 *   lessons: Record<string, TurnLesson>, used_refs: string[], api_error?: string,
 *   ended_with_question: boolean}} TurnRow
 *   capture --stop / --stop-failure. The latest row per prompt_id wins: Stop can fire twice.
 *   `used_refs` is every entry (any type) the reply used minus those Claude gave an explicit
 *   verdict on, which is what a correction on the next prompt is posted against.
 * @typedef {{kind: 'review', prompt_id: string, ids: string[]}} ReviewRow
 *   capture --stop, when it asked Claude to review this turn's lessons.
 *
 * @typedef {StartRow|PromptRow|ShownRow|RefsRow|ToolRow|ExplicitRow|LearnedRow|TurnRow|ReviewRow} ScoreRow
 */

/**
 * What the scorecard adds to `runs/<run_id>/turns/<prompt_id>.json`.
 *
 * @typedef {{ref: string, handle: string, type: string, pointer: boolean, terms: string[]}} ShownEntry
 *   prompt-recall stages one per rendered entry of ANY type; resume and rung-3 blocks have
 *   no per-entry data and contribute none.
 * @typedef {{used: boolean|null, matched: string[], candidates: number}} EntryUse
 * @typedef {object} TurnFileScorecard
 * @property {ShownEntry[]} [shown]
 * @property {{entry_method?: string, entries?: Record<string, EntryUse>}} [used_evidence]
 *   `entry_method` is 'memory-term-echo/v2-entry'; the turn-level v1 fields stay as they were.
 * @property {string[]} [explicit_ids]  refs Claude named in `mubit_outcome` this turn
 * @property {Record<string, string>} [explicit]  ref -> the outcome Claude gave it
 * @property {string} [failure_reason]  'tool_failure' beside `outcome: 'failure'`
 * @property {number} [review_requested_at]  capture --stop asked Claude to review lessons
 * @property {string[]} [review_ids]
 * @property {number} [correction_sent_at]  drain --correct posted the correction
 */

/**
 * @param {Record<string, any>} cfg
 * @param {any} sessionId
 * @returns {string} '' when there is no usable session id
 */
export function scorecardPath(cfg, sessionId) {
  const id = safeSegment(typeof sessionId === 'string' ? sessionId.trim() : '', MAX_ID);
  if (!id) return '';
  return join(resolveDataDir(cfg), SCORE_DIR, `${id}.jsonl`);
}

/**
 * Append one row. `v` and `at` are stamped unless the row already carries them.
 *
 * @param {Record<string, any>} cfg
 * @param {any} sessionId
 * @param {Record<string, any>|null|undefined} row
 * @returns {boolean} true when the row landed
 */
export function appendScoreRow(cfg, sessionId, row) {
  try {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    if (typeof row.kind !== 'string' || !row.kind) return false;
    const p = scorecardPath(cfg, sessionId);
    if (!p || !ensureDir(dirname(p))) return false;

    const line = `${JSON.stringify({ v: SCORE_LOG_VERSION, at: Date.now(), ...row })}\n`;
    const fd = openSync(p, 'a+');
    try {
      // A torn line left by a crashed writer would otherwise swallow this row too.
      const st = fstatSync(fd);
      let prefix = '';
      if (st.size > 0) {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, st.size - 1);
        if (last[0] !== 0x0a) prefix = '\n';
      }
      writeSync(fd, prefix + line);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Every parseable row, in file order. `tailBytes` reads only the end of the file and drops
 * the first (possibly partial) line, for hooks on a tight budget.
 *
 * @param {Record<string, any>} cfg
 * @param {any} sessionId
 * @param {{tailBytes?: number}} [opts]
 * @returns {Record<string, any>[]}
 */
export function readScoreRows(cfg, sessionId, opts = {}) {
  const p = scorecardPath(cfg, sessionId);
  if (!p) return [];
  return readRowsAt(p, opts);
}

/**
 * @param {string} p
 * @param {{tailBytes?: number}} [opts]
 * @returns {Record<string, any>[]}
 */
export function readRowsAt(p, opts = {}) {
  try {
    const size = statSync(p).size;
    const tail = Number(opts?.tailBytes);
    const want = Number.isFinite(tail) && tail > 0 ? Math.min(tail, MAX_READ_BYTES) : MAX_READ_BYTES;
    let text;
    let partialHead = false;
    if (size > want) {
      const fd = openSync(p, 'r');
      try {
        const buf = Buffer.alloc(want);
        readSync(fd, buf, 0, want, size - want);
        text = buf.toString('utf8');
      } finally {
        closeSync(fd);
      }
      partialHead = true;
    } else {
      text = readFileSync(p, 'utf8');
    }
    const lines = text.split('\n');
    if (partialHead) lines.shift();
    /** @type {Record<string, any>[]} */
    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row === 'object' && !Array.isArray(row) && typeof row.kind === 'string') {
          out.push(row);
        }
      } catch { /* a torn line costs itself */ }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Session logs under `scorecard/`, newest first — for resolving a handle when the caller does
 * not know which session it belongs to (the MCP server outlives `/clear`, and Codex gives it no
 * session id at all).
 *
 * @param {Record<string, any>} cfg
 * @param {{maxAgeMs?: number, limit?: number}} [opts]
 * @returns {string[]}
 */
export function recentScoreLogs(cfg, opts = {}) {
  try {
    const dir = join(resolveDataDir(cfg), SCORE_DIR);
    const now = Date.now();
    const maxAge = Number(opts?.maxAgeMs) > 0 ? Number(opts.maxAgeMs) : SCORE_LOG_TTL_MS;
    const limit = Number(opts?.limit) > 0 ? Math.trunc(Number(opts.limit)) : 20;
    /** @type {{p: string, m: number}[]} */
    const found = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (st.isFile() && now - st.mtimeMs <= maxAge) found.push({ p, m: st.mtimeMs });
      } catch { /* raced with the sweep */ }
    }
    found.sort((a, b) => b.m - a.m);
    return found.slice(0, limit).map((f) => f.p);
  } catch {
    return [];
  }
}
