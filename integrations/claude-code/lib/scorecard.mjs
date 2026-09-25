// @ts-check
/**
 * `lib/scorecard.mjs` — the session scorecard: a pure fold over the session log
 * (`lib/scorecard-log.mjs`) and the exact text the Stop hook prints under Claude's reply.
 *
 * Units: a turn is one non-slash prompt and Claude's reply; lessons are distinct
 * `entry_type: lesson` entries. Per lesson and turn the state is used, not used or unknown;
 * a used lesson's verdict is, first match wins: Claude's explicit `mubit_outcome` verdict
 * (success/partial worked, failure failed; neutral only marks it used),
 * a correction in the next prompt, a failed last non-read-only tool call, a next prompt
 * existing (worked), otherwise waiting. Counts always add up:
 * shown = used + notUsed + unknown and used = worked + failed + waiting.
 *
 * Zero dependencies, synchronous, total.
 */

const DOT = ' · ';
const MAX_TURN_TITLES = 2;
const NEVER_USED_AFTER = 3;
const READ_ONLY_INTENTS = new Set(['read', 'search']);
const USED_LABEL_WIDTH = 12;

/**
 * @typedef {object} TurnLessonView
 * @property {string} ref
 * @property {string} handle
 * @property {string} title
 * @property {boolean} pointer
 * @property {boolean|null} used     what the reply check said this turn
 * @property {string} explicit       Claude's `mubit_outcome` verdict this turn, or ''
 *
 * @typedef {object} ScoreSummary
 * @property {number} prompts
 * @property {number} lessonPrompts
 * @property {number} learned
 * @property {number} tokens
 * @property {{shown: number, used: number, notUsed: number, unknown: number,
 *   worked: number, failed: number, waiting: number}} lessons
 * @property {{promptId: string, shown: number, used: string[], checkable: boolean,
 *   lessons: TurnLessonView[]}} thisTurn
 * @property {{failed: {ref: string, title: string, prompt: number}[], neverUsed: number}} review
 */

/**
 * @param {any[]} rows  the session log, in file order
 * @param {string} currentPromptId  the turn the card is rendered for
 * @returns {ScoreSummary}
 */
export function foldScorecard(rows, currentPromptId) {
  const list = Array.isArray(rows) ? rows.filter(isObject) : [];

  /** @type {string[]} */
  const order = [];
  /** @type {Map<string, {slash: boolean, correction: boolean, pos: number, standing: Record<string, any>|null}>} */
  const prompts = new Map();
  /** @type {Map<string, Record<string, any>>} */
  const shown = new Map();
  /** @type {Map<string, {intent: string, failed: boolean}[]>} */
  const tools = new Map();
  /** @type {Map<string, Map<string, string>>} */
  const explicit = new Map();
  /** @type {Map<string, Record<string, any>>} */
  const turns = new Map();
  /** @type {number[]} */
  const clears = [];
  let learned = 0;
  let tokens = 0;
  /** @type {Record<string, any>|null} */
  let pendingStanding = null;

  const seePrompt = (/** @type {string} */ id, /** @type {number} */ pos) => {
    if (!prompts.has(id)) {
      prompts.set(id, { slash: false, correction: false, pos, standing: null });
      order.push(id);
    }
    return /** @type {any} */ (prompts.get(id));
  };

  list.forEach((row, pos) => {
    const id = str(row.prompt_id);
    switch (row.kind) {
      case 'start':
        tokens += num(row.tokens);
        pendingStanding = isObject(row.lessons) ? row.lessons : {};
        if (str(row.source) === 'clear') clears.push(pos);
        break;
      case 'prompt': {
        if (!id) break;
        const fresh = !prompts.has(id);
        const p = seePrompt(id, pos);
        if (fresh) {
          p.slash = row.slash === true;
          p.correction = row.correction === true;
        }
        if (!p.slash && pendingStanding) {
          p.standing = pendingStanding;
          pendingStanding = null;
        }
        break;
      }
      case 'shown':
        if (!id) break;
        seePrompt(id, pos);
        tokens += num(row.tokens);
        if (isObject(row.lessons)) shown.set(id, { ...(shown.get(id) ?? {}), ...row.lessons });
        break;
      case 'tool':
        if (!id) break;
        tools.set(id, [...(tools.get(id) ?? []), { intent: str(row.intent), failed: row.failed === true }]);
        break;
      case 'explicit': {
        if (!id || !Array.isArray(row.ids)) break;
        const m = explicit.get(id) ?? new Map();
        for (const ref of row.ids) if (typeof ref === 'string' && ref) m.set(ref, str(row.outcome).toLowerCase());
        explicit.set(id, m);
        break;
      }
      case 'learned':
        learned++;
        break;
      case 'turn':
        if (!id) break;
        seePrompt(id, pos);
        turns.set(id, row);
        break;
      default:
        break;
    }
  });

  const turnIds = order.filter((id) => !prompts.get(id)?.slash);
  const ordinal = new Map(turnIds.map((id, i) => [id, i + 1]));

  /** @type {Map<string, {title: string, times: number, states: string[], verdicts: {v: string, prompt: number}[]}>} */
  const byLesson = new Map();
  let lessonPrompts = 0;
  /** @type {ScoreSummary['thisTurn']} */
  let thisTurn = { promptId: str(currentPromptId), shown: 0, used: [], checkable: false, lessons: [] };

  turnIds.forEach((id, i) => {
    const lessons = lessonsOf(prompts.get(id)?.standing ?? null, shown.get(id) ?? null);
    const refs = Object.keys(lessons);
    if (refs.length) lessonPrompts++;
    const turn = turns.get(id) ?? null;
    const verdicts = explicit.get(id) ?? new Map();
    const next = turnIds[i + 1] ?? '';
    /** @type {TurnLessonView[]} */
    const views = [];
    /** @type {string[]} */
    const usedTitles = [];
    let checkable = false;

    for (const ref of refs) {
      const l = lessons[ref];
      const echo = turn && !str(turn.api_error) && isObject(turn.lessons) && isObject(turn.lessons[ref])
        ? triState(turn.lessons[ref].used)
        : null;
      const ex = verdicts.get(ref) ?? '';
      /** @type {'used'|'not'|'unknown'} */
      let state = echo === true ? 'used' : echo === false ? 'not' : 'unknown';
      let verdict = '';
      if (ex === 'success' || ex === 'partial') { state = 'used'; verdict = 'worked'; }
      else if (ex === 'failure') { state = 'used'; verdict = 'failed'; }
      // Naming a lesson counts as using it; a neutral verdict leaves the outcome to rules 2–5.
      else if (ex === 'neutral') state = 'used';
      if (state === 'used' && !verdict) verdict = settle(id, next);

      const entry = byLesson.get(ref) ?? { title: '', times: 0, states: [], verdicts: [] };
      entry.title = l.title || entry.title;
      entry.times++;
      entry.states.push(state);
      if (state === 'used') entry.verdicts.push({ v: verdict, prompt: num(ordinal.get(id)) });
      byLesson.set(ref, entry);

      if (state !== 'unknown') checkable = true;
      if (state === 'used') usedTitles.push(l.title);
      views.push({
        ref, handle: l.handle, title: l.title, pointer: l.pointer,
        used: echo, explicit: ex,
      });
    }

    if (id === str(currentPromptId)) {
      thisTurn = { promptId: id, shown: refs.length, used: usedTitles, checkable, lessons: views };
    }
  });

  const counts = { shown: 0, used: 0, notUsed: 0, unknown: 0, worked: 0, failed: 0, waiting: 0 };
  /** @type {{ref: string, title: string, prompt: number}[]} */
  const failed = [];
  let neverUsed = 0;
  for (const [ref, l] of byLesson) {
    counts.shown++;
    if (l.states.includes('used')) {
      counts.used++;
      const bad = l.verdicts.filter((v) => v.v === 'failed');
      if (bad.length) {
        counts.failed++;
        failed.push({ ref, title: l.title, prompt: Math.max(...bad.map((v) => v.prompt)) });
      } else if (l.verdicts.some((v) => v.v === 'waiting')) counts.waiting++;
      else counts.worked++;
    } else if (l.states.includes('not')) {
      counts.notUsed++;
      if (l.times >= NEVER_USED_AFTER) neverUsed++;
    } else {
      counts.unknown++;
    }
  }
  failed.sort((a, b) => b.prompt - a.prompt);

  return {
    prompts: turnIds.length,
    lessonPrompts,
    learned,
    tokens,
    lessons: counts,
    thisTurn,
    review: { failed, neverUsed },
  };

  /**
   * Rules 2–5 for a used lesson with no explicit verdict.
   * @param {string} id @param {string} next
   */
  function settle(id, next) {
    const nextPrompt = next ? prompts.get(next) : null;
    const from = num(prompts.get(id)?.pos);
    const to = num(nextPrompt?.pos);
    if (nextPrompt?.correction && !clears.some((c) => c > from && c < to)) return 'failed';
    const acting = (tools.get(id) ?? []).filter((t) => !READ_ONLY_INTENTS.has(t.intent));
    if (acting.length && acting[acting.length - 1].failed) return 'failed';
    return nextPrompt ? 'worked' : 'waiting';
  }
}

/**
 * @param {ScoreSummary|null|undefined} summary
 * @param {string} mode  'full' | 'compact'; anything else renders nothing
 * @returns {string}
 */
export function renderScorecard(summary, mode) {
  if (!isObject(summary) || !summary.thisTurn || num(summary.thisTurn.shown) <= 0) return '';
  if (mode !== 'full' && mode !== 'compact') return '';
  const s = /** @type {ScoreSummary} */ (summary);
  const l = s.lessons;
  const verdicts = [
    l.worked ? `${l.worked} worked` : '',
    l.failed ? `${l.failed} failed` : '',
    l.waiting ? `${l.waiting} waiting` : '',
  ].filter(Boolean);
  const tail = [
    s.learned ? `+${s.learned} learned` : '',
    s.tokens ? `memory added ${formatTokens(s.tokens)} tok` : '',
  ].filter(Boolean);
  const head = `mubit · this session · lessons on ${s.lessonPrompts} of ${s.prompts} ${plural(s.prompts, 'prompt')}`;

  if (mode === 'compact') {
    return [head, `${l.used} of ${l.shown} ${plural(l.shown, 'lesson')} used`, ...verdicts, ...tail].join(DOT);
  }

  const lines = [[head, ...tail].join(DOT), `  ${l.shown} ${plural(l.shown, 'lesson')} shown`];
  const usedDetail = verdicts.map((v) => (v.endsWith(' waiting') ? `${v} on your reply` : v)).join(DOT);
  const usedLabel = `${l.used} used`;
  const tree = [
    l.used ? `${usedLabel.padEnd(Math.max(USED_LABEL_WIDTH, usedLabel.length + 2))}${usedDetail}` : '',
    l.notUsed ? `${l.notUsed} not used` : '',
    l.unknown ? `${l.unknown} unknown` : '',
  ].filter(Boolean);
  tree.forEach((row, i) => lines.push(`  ${i === tree.length - 1 ? '└' : '├'} ${row}`));

  const t = s.thisTurn;
  if (t.used.length) {
    const named = t.used.slice(0, MAX_TURN_TITLES).map(quote).join(', ');
    const more = t.used.length - MAX_TURN_TITLES;
    lines.push(`  this turn: used ${named}${more > 0 ? ` +${more} more` : ''}`);
  } else {
    lines.push(`  this turn: shown ${t.shown}, none ${t.checkable ? 'used' : 'checkable'}`);
  }

  const review = [];
  const failed = s.review?.failed ?? [];
  if (failed.length) {
    review.push(`${quote(failed[0].title)} failed on prompt ${failed[0].prompt}`);
    if (failed.length > 1) review.push(`+${failed.length - 1} more failed`);
  }
  const never = num(s.review?.neverUsed);
  if (never) review.push(`${never} ${plural(never, 'lesson')} shown ${NEVER_USED_AFTER}+ times and never used`);
  if (review.length) lines.push(`  review: ${review.join(DOT)}`);

  return lines.join('\n');
}

/**
 * This turn's lessons: the standing ones when this is the first prompt after a session start,
 * then the recalled ones. A lesson in both counts once, as a pointer only if both say so.
 *
 * @param {Record<string, any>|null} standing
 * @param {Record<string, any>|null} recalled
 * @returns {Record<string, {title: string, handle: string, pointer: boolean}>}
 */
function lessonsOf(standing, recalled) {
  /** @type {Record<string, {title: string, handle: string, pointer: boolean}>} */
  const out = {};
  for (const [ref, v] of Object.entries(standing ?? {})) {
    if (!ref || !isObject(v)) continue;
    out[ref] = { title: str(v.title), handle: str(v.handle), pointer: false };
  }
  for (const [ref, v] of Object.entries(recalled ?? {})) {
    if (!ref || !isObject(v)) continue;
    const prev = out[ref];
    out[ref] = {
      title: str(v.title) || prev?.title || '',
      handle: str(v.handle) || prev?.handle || '',
      pointer: v.pointer === true && (prev ? prev.pointer : true),
    };
  }
  return out;
}

/** `1187` → `1.2k`; small counts stay exact. @param {number} n */
function formatTokens(n) {
  const t = Math.max(0, Math.trunc(num(n)));
  return t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);
}

/** @param {number} n @param {string} word */
function plural(n, word) {
  return n === 1 ? word : `${word}s`;
}

/** @param {string} title */
function quote(title) {
  return `"${String(title ?? '').replace(/"/g, "'")}"`;
}

/** @param {any} v @returns {boolean|null} */
function triState(v) {
  return v === true ? true : v === false ? false : null;
}

/** @param {any} v @returns {v is Record<string, any>} */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** @param {any} v */
function str(v) {
  return typeof v === 'string' ? v : '';
}

/** @param {any} v */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
