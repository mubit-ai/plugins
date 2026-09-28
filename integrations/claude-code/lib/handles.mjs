// @ts-check
/**
 * `lib/handles.mjs` — the short id printed on every injected memory line, e.g. `[m7k2q]`.
 *
 * The model can only credit an entry with `mubit_outcome` if it can name it, and a reference
 * id is a 36-character UUID (~20 tokens a line). A handle is `m` plus four characters hashed
 * from the reference id, so every process renders the same handle for the same entry with no
 * shared state. It is turned back into the reference id where the model hands it over (the MCP
 * egress guard, the capture hook), against the refs the session log records as shown.
 */

/** Lowercase letters and digits minus the ones that read alike: 0 o 1 l i. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const LEN = 4;
const BODY = `[${ALPHABET}]{${LEN}}`;
const BARE_RE = new RegExp(`^m${BODY}$`);
const TAG_RE = new RegExp(`\\[m${BODY}\\]`, 'g');

/**
 * @param {any} ref
 * @returns {string} '' for a blank or non-string ref
 */
export function handleFor(ref) {
  const s = typeof ref === 'string' ? ref.trim() : '';
  if (!s) return '';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let out = 'm';
  for (let i = 0; i < LEN; i++) {
    out += ALPHABET[h % ALPHABET.length];
    h = Math.floor(h / ALPHABET.length);
  }
  return out;
}

/** @param {any} ref @returns {string} `[mxxxx]`, or '' */
export function handleTag(ref) {
  const h = handleFor(ref);
  return h ? `[${h}]` : '';
}

/** @param {any} v @returns {boolean} a handle, bare or in brackets */
export function isHandle(v) {
  return BARE_RE.test(bareOf(v));
}

/** @param {string} text @returns {string} the text with every `[mxxxx]` removed */
export function stripHandles(text) {
  return String(text ?? '').replace(TAG_RE, ' ');
}

/**
 * Map each handle in `ids` to the known ref that hashes to it; pass everything else through.
 * When two known refs share a handle the one later in `knownRefs` (shown more recently) wins.
 *
 * @param {any[]} ids
 * @param {string[]} knownRefs  oldest first
 * @returns {{ids: string[], unresolved: string[]}}
 */
export function resolveHandles(ids, knownRefs) {
  /** @type {Map<string, string>} */
  const byHandle = new Map();
  for (const ref of Array.isArray(knownRefs) ? knownRefs : []) {
    const h = handleFor(ref);
    if (h) byHandle.set(h, ref);
  }
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const unresolved = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    if (typeof raw !== 'string') continue;
    const bare = bareOf(raw);
    if (BARE_RE.test(bare)) {
      const ref = byHandle.get(bare);
      if (ref) out.push(ref);
      else { out.push(bare); unresolved.push(bare); }
    } else if (raw.trim()) {
      out.push(raw.trim());
    }
  }
  return { ids: out, unresolved };
}

/**
 * Every reference id the session log records as shown, oldest first, deduplicated by last
 * appearance.
 *
 * @param {Record<string, any>[]} rows
 * @returns {string[]}
 */
export function knownRefsFromRows(rows) {
  /** @type {Map<string, number>} */
  const last = new Map();
  let n = 0;
  const note = (/** @type {any} */ ref) => {
    if (typeof ref === 'string' && ref.trim()) last.set(ref.trim(), n++);
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    if (row.kind !== 'start' && row.kind !== 'shown' && row.kind !== 'refs') continue;
    if (row.lessons && typeof row.lessons === 'object') for (const ref of Object.keys(row.lessons)) note(ref);
    if (Array.isArray(row.refs)) for (const ref of row.refs) note(ref);
  }
  return [...last.entries()].sort((a, b) => a[1] - b[1]).map(([ref]) => ref);
}

/** @param {any} v @returns {string} */
function bareOf(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1).trim() : s;
}
