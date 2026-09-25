// @ts-check
/**
 * `lib/correction.mjs` — does the user's next prompt say the previous turn went wrong?
 *
 * A hit marks the previous turn's used lessons failed and posts −0.3 against them, so the
 * table is conservative: a missed correction loses one signal, while a false one reports a
 * lesson that helped as a failure.
 *
 * Zero dependencies, synchronous, total.
 */

/** Only the opening of a prompt is read; a correction is said first. */
const SCAN_CHARS = 300;

const LEADING_NO = /^(?:no|nope)(?:\s*[,.!;:—–-]|\s*$)/;
const POLITE_NO = /^(?:no|nope)[\s,.!]*(?:problem|worries|thanks|thank you|need|rush|biggie)\b/;
const BARE_NO = /^(?:no|nope)[\s.!]*$/;

/** Phrases that read as a correction wherever they appear in the scanned opening. */
const PHRASES = [
  /^(?:wrong|incorrect)\b/,
  /\b(?:that'?s|that is|this is|it'?s|it is)\s+(?:wrong|incorrect|not right|not it|not what i (?:asked|wanted|meant))\b/,
  /\bnot what i (?:asked|wanted|meant)\b/,
  /\b(?:you|it|this|that) broke\b/,
  /\bstill (?:failing|fails|broken|erroring|crashing|not working|(?:doesn'?t|does not|isn'?t|is not) work(?:ing)?)\b/,
  /\b(?:doesn'?t|does not|didn'?t|did not) work\b/,
  /\b(?:revert|undo) (?:that|this|it|the (?:last|previous))\b/,
  /\broll back (?:that|this|it|the)\b/,
  /\byou misunderstood\b/,
  /\byou(?:'ve| have)? got it wrong\b/,
];

/**
 * @param {any} prompt
 * @param {{lastReplyEndedWithQuestion?: boolean}} [opts]
 * @returns {boolean}
 */
export function isCorrection(prompt, opts = {}) {
  try {
    if (typeof prompt !== 'string') return false;
    const trimmed = prompt.trim();
    if (!trimmed || trimmed.startsWith('/')) return false;

    const text = trimmed
      .replace(/```[\s\S]*?(?:```|$)/g, ' ')
      // Quoted text is the user citing words, not saying them.
      .replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g, ' ')
      .replace(/[‘’]/g, "'")
      .trim()
      .slice(0, SCAN_CHARS)
      .toLowerCase();
    if (!text) return false;

    const asked = opts?.lastReplyEndedWithQuestion === true;
    if (BARE_NO.test(text)) return !asked;
    // After a question a leading "no" answers it; only a correction phrase still counts.
    if (!asked && LEADING_NO.test(text) && !POLITE_NO.test(text)) return true;
    return PHRASES.some((re) => re.test(text));
  } catch {
    return false;
  }
}
