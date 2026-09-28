// @ts-check
/**
 * Record what the host actually sends a hook, and what it makes of what one answers.
 *
 * This is the oracle for `codex-payload.test.mjs`, and the reason it exists is the reason
 * that file exists: **a fixture written beside an implementation cannot falsify that
 * implementation.** Whatever shape the code reads, the fixture will have — the two are
 * written by the same person in the same hour, and they agree by construction. What breaks
 * that circle is an artefact the implementation did not write, and the only one available is
 * a payload the host itself produced.
 *
 * So this drives a real session and writes down what arrived:
 *
 *   1. A throwaway `$CODEX_HOME` with a `hooks.json` registering one recorder on every event,
 *      `Interrupt` included, and a tiny stdio MCP server named `mubit` that exposes
 *      `mubit_outcome`. Nothing touches the real home.
 *   2. Trust granted the way `scripts/setup.mjs` grants it — `hooks/list` for each handler's
 *      key and current hash, then `[hooks.state."<key>"] trusted_hash` in `config.toml`.
 *      Untrusted hooks are skipped in silence, so an ungranted run records nothing and looks
 *      like a host that changed.
 *   3. One `codex exec` turn, prompted to run one shell command and make one call to the MCP
 *      tool, because a tool call is what puts `PreToolUse` and `PostToolUse` on the wire, and
 *      the MCP call is what puts `PermissionRequest` there. The recorder answers that ask with
 *      an allow, so the call runs and its `PostToolUse` is recorded too.
 *   4. Machine-specific values swapped for placeholders, so two machines record the same
 *      bytes. Ids, paths and the working directory go; every field name and every shape
 *      stays, and those are what the tests assert on.
 *
 * Each firing is filed under `<Event>.json`, or `<Event>.<variant>.json` for a shape the plain
 * one does not show — see `recordingName()`. The first firing of each name wins.
 *
 * ---------------------------------------------------------------------------
 * What this replaces, and why
 * ---------------------------------------------------------------------------
 * The previous oracle was twenty-one JSON Schema documents lifted out of the host's compiled
 * binary. They were a stronger oracle than this one — closed schemas, both directions, every
 * event — and they were the vendor's own artefact, republished in a public tree along with
 * the recipe for lifting them out. That is not ours to publish however useful it is.
 *
 * A recording is the weaker instrument honestly obtained: it pins the fields an event was
 * *seen* to carry rather than the fields it *may* carry, so it cannot prove a field optional
 * and cannot reject one the host would. What it can still do is the thing that mattered —
 * catch a builder that invents a field the host has never sent, or drops one it always does.
 *
 * ---------------------------------------------------------------------------
 * Running it
 * ---------------------------------------------------------------------------
 *
 *     node test/helpers/codex-record.mjs --update
 *     node test/helpers/codex-record.mjs --update --probe block-once
 *     node test/helpers/codex-record.mjs --update --probe systemMessage
 *     node test/helpers/codex-record.mjs --update --probe card
 *     node test/helpers/codex-record.mjs --update --probe suppressOutput
 *
 * Each re-records what its session reaches into `test/fixtures/observed/payloads/`. With
 * `--probe`, the recorder also answers with an output and files the host's verdict on it into
 * `output-acceptance.json`: `block-once`, `systemMessage` and `card` answer the first `Stop` only (see
 * `PROBES`), and any other name answers every event with `{"<name>": true}`. `block-once` is
 * also the only session that reaches `Stop.continuation.json`, so run it last. `--verbose`
 * echoes what the host printed, which is where the verdicts are read from.
 *
 * Two recordings need the interactive TUI, which `codex exec` cannot drive — a message typed
 * while a turn is running, and Esc. For those:
 *
 *     node test/helpers/codex-record.mjs --tui-home
 *     node test/helpers/codex-record.mjs --import <recorded file> --as <Event>[.<variant>]
 *
 * The first builds a recorder home and prints how to start the TUI in it; the second puts one
 * of its captures through the same placeholder substitution and files it.
 *
 * **Recording costs a model turn per `--update`**, which is why it is a script you run
 * deliberately and not something the suite does. It needs a logged-in `codex` on PATH.
 *
 * Node >= 20 built-ins only.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { askHost } from './codex-oracle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path to `integrations/codex/`. */
export const CODEX_ROOT = resolve(HERE, '..', '..');

/** Where the recordings live. */
export const OBSERVED_DIR = join(CODEX_ROOT, 'test', 'fixtures', 'observed');
export const PAYLOAD_DIR = join(OBSERVED_DIR, 'payloads');
export const ACCEPTANCE_PATH = join(OBSERVED_DIR, 'output-acceptance.json');

/**
 * The events the recorder registers: the eleven a plugin's `hooks.json` may register, and
 * `Interrupt`, which the host dispatches in place of a `Stop` when Esc cuts a turn short. The
 * plugin does not listen for it; the recorder does, because what the host sends instead of a
 * `Stop` is something the plugin has to know about.
 */
export const ALL_EVENTS = [
  'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact',
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop',
  'Interrupt',
];

/**
 * The events a `codex exec` recording session reaches, and therefore the ones `--update`
 * regenerates.
 *
 * `Interrupt` is reached only by pressing Esc in the TUI, so it is recorded by hand. The rest
 * need a session shape one scripted turn does not produce: a context window full enough to
 * compact, or a spawned subagent. They are listed as uncovered rather than assumed, so the gap
 * is something a reader can see and close instead of something the suite quietly passes over.
 */
export const RECORDED_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop',
  'SessionEnd',
];

/** Values that differ per machine and per run. The shape is the fixture; these are not. */
const PLACEHOLDERS = {
  session_id: '{{SESSION_ID}}',
  turn_id: '{{TURN_ID}}',
  transcript_path: '{{TRANSCRIPT_PATH}}',
  cwd: '{{CWD}}',
  tool_use_id: '{{TOOL_USE_ID}}',
};

/**
 * One payload with its per-run values swapped out, key order preserved.
 *
 * The placeholder fields are replaced outright. The same values are also replaced wherever
 * they turn up inside another string — a reply that quotes the working directory, a tool
 * output that echoes it — so a recording cannot carry one by way of a field nobody thought to
 * list. Applying it twice changes nothing, which is how `codex-payload.test.mjs` checks that a
 * committed recording, a hand-made one included, went through it.
 *
 * @param {Record<string, any>} raw
 * @returns {Record<string, any>}
 */
export function normalizePayload(raw) {
  // Longest first, so a path is replaced before an id that sits inside it.
  const swaps = Object.keys(PLACEHOLDERS)
    .filter((k) => typeof raw[k] === 'string' && raw[k].length >= 8 && raw[k] !== PLACEHOLDERS[k])
    .map((k) => [raw[k], PLACEHOLDERS[k]])
    .sort((a, b) => b[0].length - a[0].length);
  const scrub = (v) => {
    if (typeof v === 'string') return swaps.reduce((s, [from, to]) => s.split(from).join(to), v);
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
    }
    return v;
  };
  const out = {};
  for (const k of Object.keys(raw)) out[k] = k in PLACEHOLDERS ? PLACEHOLDERS[k] : scrub(raw[k]);
  return out;
}

/**
 * The name a recorded payload is filed under in `payloads/`, or `''` when the corpus keeps no
 * file for it.
 *
 * `<Event>` is the plain case. A shape the plain one does not show gets its own
 * `<Event>.<variant>`:
 *
 * - `PostToolUse.mcp` — a call to an MCP tool, whose `tool_response` is the result object
 *   where a shell call's is a string. The plain `PostToolUse` stays the shell call.
 * - `Stop.continuation` — the `Stop` after a hook blocked, with `stop_hook_active: true`.
 *
 * The MCP call's `PreToolUse` is not kept: its shape is the shell one with other arguments,
 * and the plain `PreToolUse` has to stay the shell call every pre-tool test is built on. The
 * corpus's `PermissionRequest` is the ask for the MCP call, which is the one a scripted turn
 * puts to approval.
 *
 * @param {Record<string, any>} p
 * @returns {string}
 */
export function recordingName(p) {
  const event = p?.hook_event_name;
  if (typeof event !== 'string' || !/^\w+$/.test(event)) return '';
  const mcp = /^mcp__/.test(String(p.tool_name ?? ''));
  if (event === 'PostToolUse' && mcp) return 'PostToolUse.mcp';
  if (event === 'PreToolUse' && mcp) return '';
  if (event === 'PermissionRequest' && !mcp) return '';
  if (event === 'Stop' && p.stop_hook_active === true) return 'Stop.continuation';
  return event;
}

/** Read the recorded corpus, keyed by file name without `.json`. */
export function readObservedPayloads() {
  if (!existsSync(PAYLOAD_DIR)) return {};
  const out = {};
  for (const f of readdirSync(PAYLOAD_DIR)) {
    if (!f.endsWith('.json')) continue;
    out[f.slice(0, -'.json'.length)] = JSON.parse(readFileSync(join(PAYLOAD_DIR, f), 'utf8'));
  }
  return out;
}

/** Read the observed accept/reject table. */
export function readOutputAcceptance() {
  if (!existsSync(ACCEPTANCE_PATH)) return null;
  return JSON.parse(readFileSync(ACCEPTANCE_PATH, 'utf8'));
}

/**
 * The outputs the recorder can answer the first `Stop` with, to record whether the host takes
 * them. Every other event, and every later `Stop`, is answered with `{}`, so the verdict is on
 * this output and nothing else.
 *
 * - `systemMessage` — a multi-line string, the shape a session scorecard would be delivered
 *   in. The TUI shows it under the reply; `codex exec` never prints it, so the verdict is all a
 *   scripted session can confirm.
 * - `card` — the pair the session scorecard is actually sent as: a multi-line `systemMessage`
 *   and `suppressOutput: true`, in one object. The two probes that each carry one half are not
 *   a verdict on both together, because the host reads the output as one object.
 * - `block-once` — `decision:block` with a reason. A marker file in the recorder home makes it
 *   block the first `Stop` only, so the model continues the turn and the next `Stop` is the
 *   continuation, recorded as `Stop.continuation.json`.
 */
export const PROBES = {
  systemMessage: {
    event: 'Stop',
    output: { systemMessage: 'Recorder probe, line one\nline two\nline three' },
  },
  card: {
    event: 'Stop',
    output: {
      systemMessage: 'Recorder card probe, line one\nline two\nline three',
      suppressOutput: true,
    },
  },
  'block-once': {
    event: 'Stop',
    output: {
      decision: 'block',
      reason: 'Before you finish, reply once more with just the word AGAIN.',
    },
  },
};

/**
 * A probe by name: one from `PROBES`, or any other name as the key probe, which answers every
 * event with `{"<name>": true}`.
 *
 * @param {string} name
 * @returns {{event: string, output: Record<string, any>}}  `event` is `'*'` for every event
 */
export function probeOf(name) {
  return PROBES[name] ?? { event: '*', output: { [name]: true } };
}

/**
 * The host's verdicts, per event, out of what `codex exec` printed.
 *
 * Each firing prints `hook: <Event> Completed`, `… Blocked` or `… Failed`; `Failed` is the host
 * refusing the output, and the other two are it taking the output. For an every-event probe an
 * event is rejected if any firing failed. For a `Stop` probe only the first `Stop` is read,
 * because only the first one was answered with the probe.
 *
 * @param {string} printed  the run's stdout and stderr
 * @param {string} event    the probed event, or `'*'`
 * @returns {Record<string, 'accepted'|'rejected'>}
 */
export function hostVerdicts(printed, event) {
  /** @type {Record<string, 'accepted'|'rejected'>} */
  const verdict = {};
  for (const m of String(printed).matchAll(/^hook: (\w+) (Completed|Blocked|Failed)\s*$/gm)) {
    const [, name, word] = m;
    if (event !== '*' && (name !== event || name in verdict)) continue;
    verdict[name] = verdict[name] === 'rejected' || word === 'Failed' ? 'rejected' : 'accepted';
  }
  return verdict;
}

// ---------------------------------------------------------------------------
// Recording — only reached under `--update`, `--tui-home` and `--import`
// ---------------------------------------------------------------------------

/**
 * The hook registered on every event. It writes what it was handed to
 * `<home>/recorded/NNN-<Event>.json`, numbered in firing order, and answers:
 *
 * - `REC_ALL_OUTPUT` on every event, when set (the key probe);
 * - `REC_STOP_OUTPUT` on the first `Stop` only, when set (a `Stop` probe);
 * - an allow on a `PermissionRequest` for the `mubit` server, so the call runs and its
 *   `PostToolUse` fires;
 * - `{}` otherwise.
 */
const RECORDER = `
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HOME = dirname(fileURLToPath(import.meta.url));
const OUT = join(HOME, 'recorded');
let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch {}
let p = {};
try { p = JSON.parse(raw); } catch {}
const name = /^\\w+$/.test(String(p.hook_event_name)) ? p.hook_event_name : 'unknown';
try {
  mkdirSync(OUT, { recursive: true });
  for (let n = readdirSync(OUT).length + 1; n < 10000; n++) {
    try {
      writeFileSync(join(OUT, String(n).padStart(3, '0') + '-' + name + '.json'), raw, { flag: 'wx' });
      break;
    } catch (err) { if (err.code !== 'EEXIST') break; }
  }
} catch {}
let answer = {};
const all = process.env.REC_ALL_OUTPUT || '';
const stop = process.env.REC_STOP_OUTPUT || '';
if (all) {
  answer = JSON.parse(all);
} else if (name === 'Stop' && stop) {
  // Created exclusively, so only the first Stop blocks even if two race here.
  let first = false;
  try {
    writeFileSync(join(HOME, 'stop-probed'), '', { flag: 'wx' });
    first = true;
  } catch (err) { if (err.code !== 'EEXIST') throw err; }
  if (first) answer = JSON.parse(stop);
} else if (name === 'PermissionRequest' && /^mcp__mubit__/.test(String(p.tool_name))) {
  answer = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
}
process.stdout.write(JSON.stringify(answer));
process.exit(0);
`;

/**
 * A stdio MCP server named `mubit` with one tool, `mubit_outcome`, taking the arguments the
 * plugin's own tool of that name takes. It answers every call with one text item: the
 * recording is about the shape the host hands a hook, not about what the tool does.
 */
const MCP_SERVER = `
let buf = '';
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined) continue;
    if (m.method === 'initialize') {
      reply(m.id, {
        protocolVersion: m.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'mubit', version: '0.0.0' },
      });
    } else if (m.method === 'tools/list') {
      reply(m.id, { tools: [{
        name: 'mubit_outcome',
        description: 'Say whether recalled memory helped.',
        inputSchema: {
          type: 'object',
          properties: {
            reference_id: { type: 'string' },
            outcome: { type: 'string', enum: ['success', 'failure', 'partial', 'neutral'] },
            entry_ids: { type: 'array', items: { type: 'string' } },
          },
          required: ['reference_id', 'outcome'],
        },
      }] });
    } else if (m.method === 'tools/call') {
      reply(m.id, { content: [{ type: 'text', text: 'Outcome recorded.' }] });
    } else {
      reply(m.id, {});
    }
  }
});
`;

/** What the recording session is asked to do: one shell call, then one MCP call. */
const PROMPT = 'Do exactly these steps and nothing else. 1) Use the shell tool to run: head '
  + 'note.txt   2) Call the mubit_outcome tool of the mubit MCP server once, with reference_id '
  + '"global", outcome "success" and entry_ids ["entry-1"].   3) Reply with just the word the '
  + 'shell command printed.';

/**
 * A `$CODEX_HOME` of our own, with one recorder on every event, trust already granted, and the
 * `mubit` MCP server configured. The caller removes it: it holds a copy of the credential.
 *
 * Every `codex` this script starts runs inside it, `codex --version` included: even that
 * writes scratch files under its `CODEX_HOME`, and the real one is only ever read.
 *
 * @returns {Promise<{home: string, granted: number, version: string}>}
 */
async function seedRecorderHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mubit-record-home-')));
  try {
    const v = spawnSync('codex', ['--version'], {
      encoding: 'utf8', env: { ...process.env, CODEX_HOME: home },
    });
    if (v.error || v.status !== 0) {
      throw new Error('no `codex` on PATH — this script records against the real host.');
    }
    const version = String(v.stdout || '').trim();

    const recorder = join(home, 'recorder.mjs');
    const server = join(home, 'mcp-server.mjs');
    writeFileSync(recorder, RECORDER);
    writeFileSync(server, MCP_SERVER);

    const hooks = {};
    for (const e of ALL_EVENTS) {
      hooks[e] = [{ hooks: [{ type: 'command', timeout: 10, command: `node ${recorder}` }] }];
    }
    // The one matcher the real manifest carries. Without it SessionStart never fires.
    hooks.SessionStart[0].matcher = 'startup|resume|clear|compact';
    writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks }, null, 2));

    // Auth is per-CODEX_HOME, so the throwaway home needs the real one's credential to reach
    // a model at all. Copied rather than symlinked: a session must not be able to write back.
    const realAuth = join(process.env.HOME || '', '.codex', 'auth.json');
    if (existsSync(realAuth)) writeFileSync(join(home, 'auth.json'), readFileSync(realAuth));

    const answer = await askHost(home, { timeoutMs: 15_000 });
    const lines = ['[hooks]', 'enabled = true', ''];
    for (const h of answer.hooks) {
      lines.push(`[hooks.state.${JSON.stringify(h.key)}]`, `trusted_hash = "${h.currentHash}"`, '');
    }
    lines.push('[mcp_servers.mubit]', 'command = "node"', `args = [${JSON.stringify(server)}]`, '');
    writeFileSync(join(home, 'config.toml'), lines.join('\n'));
    return { home, granted: answer.hooks.length, version };
  } catch (err) {
    rmSync(home, { recursive: true, force: true });
    throw err;
  }
}

/** A throwaway project for the session to run in, removed again if seeding it fails. */
function seedProject() {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'mubit-record-proj-')));
  try {
    writeFileSync(join(project, 'note.txt'), 'hello\n');
    spawnSync('git', ['init', '-q'], { cwd: project });
    return project;
  } catch (err) {
    rmSync(project, { recursive: true, force: true });
    throw err;
  }
}

/**
 * File what a recorder home captured into `payloads/`, first firing of each name first.
 *
 * @param {string} out  `<home>/recorded`
 * @returns {string[]}  the names written
 */
function fileRecordings(out) {
  mkdirSync(PAYLOAD_DIR, { recursive: true });
  const written = [];
  for (const f of readdirSync(out).filter((n) => /^\d+-\w+\.json$/.test(n)).sort()) {
    let raw;
    try { raw = JSON.parse(readFileSync(join(out, f), 'utf8')); } catch { continue; }
    const name = recordingName(raw);
    if (!name || written.includes(name)) continue;
    written.push(name);
    writeFileSync(join(PAYLOAD_DIR, `${name}.json`), `${JSON.stringify(normalizePayload(raw), null, 2)}\n`);
  }
  return written;
}

/**
 * Put one probe's verdict into `output-acceptance.json`, replacing an earlier verdict on the
 * same output, and stamp the file with the build that gave it.
 */
function fileVerdict(output, verdict, version, probeName) {
  const doc = readOutputAcceptance() ?? { probes: [] };
  const probes = doc.probes ?? [];
  const entry = { output, verdict };
  const i = probes.findIndex((p) => JSON.stringify(p.output) === JSON.stringify(output));
  if (i === -1) probes.push(entry); else probes[i] = entry;
  doc.probes = probes;
  doc._provenance = {
    ...doc._provenance,
    codex_version: version,
    recorded: new Date().toISOString().slice(0, 10),
    how: 'node test/helpers/codex-record.mjs --update --probe <name>, once per probe',
  };
  writeFileSync(ACCEPTANCE_PATH, `${JSON.stringify(doc, null, 2)}\n`);
  process.stderr.write(`[record] ${probeName}: ${JSON.stringify(verdict)}\n`);
}

/** `--update [--probe <name>] [--verbose]`: one scripted session, recorded. */
async function update(probeName, verbose) {
  const probe = probeName ? probeOf(probeName) : null;
  const { home, granted, version } = await seedRecorderHome();
  let project = '';
  try {
    project = seedProject();
    const out = join(home, 'recorded');
    process.stderr.write(`[record] ${version}, ${granted} handlers trusted\n`);
    const run = spawnSync('codex', [
      'exec', '-s', 'read-only', '--skip-git-repo-check', '-C', project, PROMPT,
    ], {
      encoding: 'utf8',
      input: '',
      timeout: 600_000,
      env: {
        ...process.env,
        CODEX_HOME: home,
        REC_ALL_OUTPUT: probe && probe.event === '*' ? JSON.stringify(probe.output) : '',
        REC_STOP_OUTPUT: probe && probe.event === 'Stop' ? JSON.stringify(probe.output) : '',
      },
    });
    const printed = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    if (!existsSync(out)) throw new Error(`no hook fired. Host said:\n${printed}`);

    if (verbose) process.stderr.write(`[record] the host printed:\n${printed}\n`);
    const written = fileRecordings(out);
    process.stderr.write(`[record] payloads: ${written.sort().join(', ')}\n`);

    if (probe) {
      const verdict = hostVerdicts(printed, probe.event);
      if (!Object.keys(verdict).length) {
        throw new Error(`no verdict for ${probeName} in what the host printed:\n${printed}`);
      }
      // An event that fired and printed no verdict is absent from the table, not assumed.
      const fired = [...new Set(readdirSync(out).map((f) => f.replace(/^\d+-|\.json$/g, '')))];
      const silent = fired.filter((e) => (probe.event === '*' || e === probe.event) && !(e in verdict));
      if (silent.length) {
        process.stderr.write(`[record] fired with no verdict printed: ${silent.sort().join(', ')}\n`);
      }
      fileVerdict(probe.output, verdict, version, probeName);
    }
  } finally {
    if (project) rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

/** `--tui-home`: a recorder home to drive by hand, left in place for the caller. */
async function tuiHome() {
  const { home, granted, version } = await seedRecorderHome();
  let project;
  try {
    project = seedProject();
  } catch (err) {
    rmSync(home, { recursive: true, force: true });
    throw err;
  }
  process.stderr.write([
    `[record] ${version}, ${granted} handlers trusted`,
    '',
    'Start the interactive TUI in the recorder home:',
    '',
    `  CODEX_HOME=${home} codex -C ${project}`,
    '',
    `Every firing lands in ${join(home, 'recorded')}/NNN-<Event>.json, in order. File one with:`,
    '',
    '  node test/helpers/codex-record.mjs --import <that file> --as <Event>[.<variant>]',
    '',
    `Then delete ${home} and ${project}: the home holds a copy of your auth.json.`,
    '',
  ].join('\n'));
}

/**
 * `--import <file> --as <name>`: one hand-made capture, through the same placeholder
 * substitution, into `payloads/<name>.json`.
 *
 * @param {string} file
 * @param {string} name  `<Event>` or `<Event>.<variant>`
 */
export function importRecording(file, name) {
  if (!/^\w+(\.\w+)?$/.test(name)) throw new Error(`--as wants <Event>[.<variant>], got "${name}"`);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const event = name.split('.')[0];
  if (raw.hook_event_name !== event) {
    throw new Error(`${file} is a ${raw.hook_event_name} payload, not ${event}.`);
  }
  mkdirSync(PAYLOAD_DIR, { recursive: true });
  const target = join(PAYLOAD_DIR, `${name}.json`);
  writeFileSync(target, `${JSON.stringify(normalizePayload(raw), null, 2)}\n`);
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = (flag) => { const i = argv.indexOf(flag); return i === -1 ? '' : argv[i + 1] || ''; };
  if (argv.includes('--update')) {
    await update(arg('--probe'), argv.includes('--verbose'));
  } else if (argv.includes('--tui-home')) {
    await tuiHome();
  } else if (argv.includes('--import') && arg('--import') && arg('--as')) {
    process.stderr.write(`[record] wrote ${importRecording(arg('--import'), arg('--as'))}\n`);
  } else {
    process.stderr.write('usage: node test/helpers/codex-record.mjs --update [--probe <name>] [--verbose]\n'
      + '       node test/helpers/codex-record.mjs --tui-home\n'
      + '       node test/helpers/codex-record.mjs --import <file> --as <Event>[.<variant>]\n');
    process.exit(2);
  }
}
