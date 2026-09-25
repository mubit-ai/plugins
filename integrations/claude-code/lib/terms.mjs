// @ts-check
/**
 * `lib/terms.mjs` — memory vocabulary, and the per-entry used-signal.
 *
 * The v1 signal (`capture --stop`, `memory-term-echo/v1`) pools the injected block's words and
 * calls a turn used on one hit. `evaluateUse` asks per entry instead: words two entries share
 * are dropped, and an entry needs several of its own words in the reply before it counts.
 * It measures an observable proxy — echoed vocabulary — not attention; see `capture.mjs`.
 *
 * Pure, synchronous, zero dependencies beyond `lib/`, and total.
 */

import { firstClause, isPointerLine } from './assemble.mjs';
import { stripHandles } from './handles.mjs';
import { redactText } from './redact.mjs';

/** A term: 4-24 characters starting with a letter. The upper bound keeps credentials out. */
export const TERM_RE = /[A-Za-z][A-Za-z0-9_]{3,23}/g;

/** Words that pass the shape test and mean nothing. Deliberately short. */
export const TERM_STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'also', 'always', 'another', 'because', 'been',
  'before', 'being', 'between', 'both', 'called', 'does', 'doing', 'done', 'each', 'else',
  'even', 'ever', 'every', 'from', 'have', 'here', 'html', 'http', 'https', 'into',
  'just', 'like', 'made', 'make', 'many', 'more', 'most', 'much', 'must', 'need', 'never',
  'next', 'once', 'only', 'other', 'over', 'part', 'same', 'says', 'send', 'sent', 'should',
  'since', 'some', 'such', 'take', 'than', 'that', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'thing', 'time', 'under', 'until', 'very', 'want',
  'well', 'were', 'what', 'when', 'where', 'which', 'while', 'will', 'with', 'without',
  'would', 'your',
]);

/** v1: how many pooled terms a turn carries. */
export const MAX_RECALL_TERMS = 48;

/** How much of the prompt is tokenised for subtraction. */
export const MAX_PROMPT_SCAN = 16 * 1024;

/** The reply is scanned, never stored; this bounds the scan. */
export const MAX_ANSWER_SCAN = 64 * 1024;

const TERM_MIN = 4;
const TERM_MAX = 24;
const MAX_ENTRY_TERMS = 32;
const MAX_MATCHED = 12;
const MAX_TITLE_CHARS = 48;
const PLACEHOLDER_RE = /\[REDACTED:[^\]]*\]/gi;

/** @param {any} s @returns {Set<string>} every term in `s`, lowercased */
export function termSet(s) {
  const set = new Set();
  for (const m of String(s ?? '').matchAll(TERM_RE)) set.add(m[0].toLowerCase());
  return set;
}

/**
 * The rendered entries' own text: bullets only, pointer lines excluded, and the leading
 * handle and `(stale)` mark stripped, so none of them is vocabulary.
 * @param {string} block
 * @returns {string}
 */
export function vocabularyOf(block) {
  const lines = String(block ?? '').split('\n');
  const bullets = lines.filter((l) => l.startsWith('- '));
  // A block with no bullets was assembled somewhere else (rung 3): drop only the headings.
  if (bullets.length === 0) return stripHandles(lines.filter((l) => !l.startsWith('#')).join('\n'));
  return bullets
    .filter((l) => !isPointerLine(l))
    .map((l) => stripHandles(l.slice(2)).trimStart().replace(/^\(stale\)\s+/, ''))
    .join('\n');
}

/**
 * v1: the words the memory contributed and the prompt did not, pooled across `blocks`, in
 * render order, scrubbed before anything is kept.
 * @param {Record<string, any>} cfg
 * @param {string[]} blocks
 * @param {string} prompt
 * @returns {string[]}
 */
export function memoryTerms(cfg, blocks, prompt) {
  try {
    let text = (Array.isArray(blocks) ? blocks : []).filter(Boolean).map(vocabularyOf)
      .filter(Boolean).join('\n');
    if (!text) return [];
    try {
      text = String(redactText(text, cfg, 'output')?.text ?? '');
    } catch {
      return [];
    }
    text = text.replace(PLACEHOLDER_RE, ' ');

    const fromPrompt = termSet(String(prompt ?? '').slice(0, MAX_PROMPT_SCAN));
    /** @type {string[]} */
    const out = [];
    const seen = new Set();
    for (const m of text.matchAll(TERM_RE)) {
      const t = m[0].toLowerCase();
      if (seen.has(t) || fromPrompt.has(t) || TERM_STOPWORDS.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= MAX_RECALL_TERMS) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * One entry's distinct terms: handle stripped, scrubbed, placeholders, stopwords and the
 * prompt's own terms removed, capped.
 * @param {Record<string, any>} cfg
 * @param {string} text
 * @param {Set<string>} [promptTerms]
 * @param {number} [max]
 * @returns {string[]}
 */
export function entryTerms(cfg, text, promptTerms = new Set(), max = MAX_ENTRY_TERMS) {
  try {
    const raw = stripHandles(String(text ?? ''));
    if (!raw.trim()) return [];
    const scrubbed = String(redactText(raw, cfg, 'output')?.text ?? '').replace(PLACEHOLDER_RE, ' ');
    const skip = promptTerms instanceof Set ? promptTerms : new Set();
    const cap = Number.isFinite(max) && max > 0 ? Math.trunc(max) : MAX_ENTRY_TERMS;
    /** @type {string[]} */
    const out = [];
    const seen = new Set();
    for (const m of scrubbed.matchAll(TERM_RE)) {
      const t = m[0].toLowerCase();
      if (seen.has(t) || skip.has(t) || TERM_STOPWORDS.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= cap) break;
    }
    return out;
  } catch {
    // A scrub that threw is not a licence to write raw words down.
    return [];
  }
}

/**
 * An entry as the scorecard names it: its first clause, scrubbed and capped. A clause that
 * only lost the sentence's final stop gets no ellipsis.
 * @param {Record<string, any>} cfg
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function entryTitle(cfg, text, max = MAX_TITLE_CHARS) {
  try {
    const whole = String(text ?? '').replace(/\s+/g, ' ').trim();
    let clause = firstClause(whole);
    if (clause.endsWith('…') && whole.replace(/[.;!?]+$/, '') === clause.slice(0, -1)) {
      clause = clause.slice(0, -1);
    }
    const t = String(redactText(clause, cfg, 'output')?.text ?? '').trim();
    const cap = Number.isFinite(max) && max > 1 ? Math.trunc(max) : MAX_TITLE_CHARS;
    return t.length > cap ? `${t.slice(0, cap - 1).trimEnd()}…` : t;
  } catch {
    return '';
  }
}

/**
 * Which of `terms` the text carries, at a left word boundary (so `queue` matches `queued`).
 * @param {string[]} terms  lowercased
 * @param {string} text
 * @returns {string[]}
 */
export function matchTerms(terms, text) {
  return matchIn(haystackOf(text), terms);
}

/**
 * @typedef {{used: boolean|null, matched: string[], candidates: number, reason?: string}} EntryUse
 */

/**
 * The per-entry used-signal (`memory-term-echo/v2-entry`).
 *
 * @param {{ref: string, terms: string[]}[]} entries
 * @param {string} reply
 * @param {{exclude?: Set<string>|string[]}} [opts]  terms that never count (the prompt's)
 * @returns {Record<string, EntryUse>}
 */
export function evaluateUse(entries, reply, opts = {}) {
  /** @type {Record<string, EntryUse>} */
  const out = {};
  try {
    const exclude = new Set([...(opts?.exclude ?? [])].filter((t) => typeof t === 'string')
      .map((t) => t.toLowerCase()));
    /** @type {{ref: string, terms: string[]}[]} */
    const list = [];
    for (const e of Array.isArray(entries) ? entries : []) {
      if (!e || typeof e !== 'object' || typeof e.ref !== 'string' || !e.ref) continue;
      const terms = [...new Set((Array.isArray(e.terms) ? e.terms : [])
        .filter((t) => typeof t === 'string' && t.length >= TERM_MIN && t.length <= TERM_MAX)
        .map((t) => t.toLowerCase()))];
      list.push({ ref: e.ref, terms });
    }

    // A term in two different entries cannot say which one the reply used.
    /** @type {Map<string, number>} */
    const owners = new Map();
    for (const e of list) for (const t of e.terms) owners.set(t, (owners.get(t) ?? 0) + 1);

    const text = typeof reply === 'string' ? reply : '';
    const hay = text.trim() ? haystackOf(text.slice(0, MAX_ANSWER_SCAN)) : '';

    for (const e of list) {
      const candidates = e.terms.filter((t) => owners.get(t) === 1 && !exclude.has(t));
      const n = candidates.length;
      if (n === 0) {
        out[e.ref] = { used: null, matched: [], candidates: 0, reason: 'no_distinct_terms' };
        continue;
      }
      if (!hay) {
        out[e.ref] = { used: null, matched: [], candidates: n, reason: 'no_reply' };
        continue;
      }
      const matched = matchIn(hay, candidates);
      const threshold = n <= 2 ? n : Math.max(2, Math.ceil(n / 4));
      out[e.ref] = { used: matched.length >= threshold, matched: matched.slice(0, MAX_MATCHED), candidates: n };
    }
  } catch {
    // Unmeasured beats a thrown Stop hook.
  }
  return out;
}

/** @param {string} text @returns {string} space-delimited lowercase words */
function haystackOf(text) {
  return ` ${String(text ?? '').toLowerCase().replace(/[^a-z0-9_]+/g, ' ')} `;
}

/** @param {string} hay @param {string[]} terms @returns {string[]} */
function matchIn(hay, terms) {
  return terms.filter((t) => hay.includes(` ${t}`));
}
