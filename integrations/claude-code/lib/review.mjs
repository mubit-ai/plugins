// @ts-check
/**
 * `lib/review.mjs` — the once-per-turn memory review (`outcomeReview: stop`).
 *
 * Claude rarely calls `mubit_outcome` on its own because nothing asks at the moment it matters.
 * Under `stop`, capture's Stop hook blocks the turn once and hands Claude `reviewReason(...)`
 * as "Stop hook feedback": which lessons were in context, and how to credit or fault them.
 * Pure: no I/O, no clock, never throws.
 */

const DEFAULT_MAX = 6;

/** Verdicts Claude can already have given this turn; any of them settles the lesson. */
const VERDICTS = new Set(['success', 'failure', 'partial', 'neutral']);

/** A title is data, not instructions: one line, bounded. */
const MAX_TITLE_CHARS = 64;

/**
 * @typedef {object} ReviewLesson
 * @property {string} ref
 * @property {string} handle
 * @property {string} title
 * @property {boolean} pointer   shown only as a "(seen earlier)" line this turn
 * @property {boolean|null} used  the reply's term check; null when it could not be measured
 * @property {string} explicit   the outcome Claude already gave it this turn, or ''
 */

/**
 * This turn's lessons worth asking about: no verdict yet, and either shown in full this turn
 * or used by the reply. Used ones first, then input order, at most `max`.
 *
 * @param {ReviewLesson[]} lessons
 * @param {{max?: number}} [opts]
 * @returns {ReviewLesson[]}
 */
export function reviewCandidates(lessons, opts = {}) {
  try {
    const max = Number(opts?.max) > 0 ? Math.trunc(Number(opts.max)) : DEFAULT_MAX;
    const keep = (Array.isArray(lessons) ? lessons : []).filter((l) => l && typeof l === 'object'
      && str(l.ref) && str(l.handle)
      && !VERDICTS.has(str(l.explicit).toLowerCase())
      && (l.pointer !== true || l.used === true));
    const used = keep.filter((l) => l.used === true);
    const rest = keep.filter((l) => l.used !== true);
    return [...used, ...rest].slice(0, max);
  } catch {
    return [];
  }
}

/**
 * Whether capture's Stop hook should block this turn for a review.
 *
 * @param {{outcomeReview?: string, outcomeMode?: string, stopHookActive?: boolean,
 *   alreadyRequested?: boolean, apiError?: string, isSubagent?: boolean,
 *   candidates?: ReviewLesson[]}} o
 * @returns {boolean}
 */
export function shouldReview(o) {
  if (!o || typeof o !== 'object') return false;
  if (str(o.outcomeReview) !== 'stop') return false;
  if (str(o.outcomeMode) === 'off') return false;
  // Claude Code sets this once any Stop hook has blocked; blocking again risks a loop.
  if (o.stopHookActive === true) return false;
  if (o.alreadyRequested === true) return false;
  if (str(o.apiError)) return false;
  if (o.isSubagent === true) return false;
  return Array.isArray(o.candidates) && o.candidates.length > 0;
}

/**
 * The text Claude receives. Ends by asking for one visible line: telling Claude to stop
 * silently makes Claude Code inject a "no visible output" nudge and costs another round.
 *
 * @param {ReviewLesson[]} candidates
 * @returns {string} '' when there is nothing to review
 */
export function reviewReason(candidates) {
  const list = (Array.isArray(candidates) ? candidates : [])
    .filter((l) => l && typeof l === 'object' && str(l.handle));
  if (!list.length) return '';
  const lines = ['Mubit memory review (once per turn). Lessons in your context this turn:'];
  for (const l of list) {
    lines.push(`- [${oneLine(l.handle, 16)}] ${oneLine(l.title, MAX_TITLE_CHARS)}`
      + `${l.used === true ? ' (your reply appears to use it)' : ''}`);
  }
  lines.push(
    'Call mubit_outcome with reference_id "global", outcome "success" and entry_ids set to the '
      + 'ids that helped; for any that were wrong or misled you, a second call with outcome '
      + '"failure" and a one-line rationale. Skip the rest.',
    'If a lesson was wrong or incomplete, also save a corrected one with mubit_learned.',
    'Then end with one short line starting "Memory review:" naming what you credited; do not '
      + 'repeat your answer.',
  );
  return lines.join('\n');
}

/** @param {any} v @returns {string} */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** @param {any} v @param {number} max @returns {string} */
function oneLine(v, max) {
  const s = str(v).replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
