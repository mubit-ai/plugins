# Mubit Memory — Quickstart

Persistent memory for **Claude Code** and the **Codex CLI**. It captures your work
automatically, injects the relevant past lessons before each prompt, and learns which
memories actually helped.

It is one plugin built twice. A Codex session and a Claude Code session started in the
**same directory are one Mubit run, sharing one memory** — that is the point, not a
side effect.

**Requirements:** Node >= 20, and Codex CLI >= 0.146.0 if you use that side. No build step,
no `npm install` — the bundles ship committed.

You need two values before you start:

| Value | Example |
| --- | --- |
| endpoint | `https://eu.mubit.ai` — your Mubit instance URL |
| API key | `mbt_...` — issued in the [Mubit console](https://console.mubit.ai) |

---

## Part 1 — Claude Code

### Install

```
/plugin marketplace add mubit-ai/plugins
/plugin install mubit-memory@mubit
/reload-plugins
```

Then **start a new Claude Code session.**

`/reload-plugins` registers the hooks but does not fire `SessionStart`, so until a new
session begins the plugin has never actually run — no run id, nothing on the status line.
It looks broken and it is fine.

### Connect it

Easiest route — opens the console in a browser, signs you in, stores a key for this machine:

```
/mubit-memory:auth
```

Or set the endpoint and key yourself, one of three ways:

**A. Plugin settings — recommended.** `/plugin` → **Mubit Memory** → **configure**, then fill
in `endpoint` and `apiKey`. The key field is marked sensitive, so it goes into your OS keychain
rather than any file. Best home for a long-lived install, and it takes precedence over
everything else.

**B. Environment variables — good for CI, containers, SSH.**

```bash
export MUBIT_ENDPOINT='https://eu.mubit.ai'
export MUBIT_API_KEY='mbt_...'
```

Set these in your shell profile (or CI secrets) before starting Claude Code.

**C. Per-project file.** `${CLAUDE_PROJECT_DIR}/.mubit-cc.json`:

```json
{
  "endpoint": "https://eu.mubit.ai",
  "apiKey": "mbt_..."
}
```

Lowest precedence of the three. Do not commit it — the key is a secret.

**Precedence, highest first:** plugin settings → `MUBIT_*` env vars → what
`mubit-memory:auth` stored → `.mubit-cc.json` → defaults.

---

## Part 2 — Codex CLI

### Install

Same shape as Claude Code — the marketplace is fetched straight from GitHub, no clone:

```bash
codex plugin marketplace add mubit-ai/plugins
codex plugin add mubit-memory@mubit
```

Requires Codex CLI >= 0.146.0, which is where Git marketplace sources landed. Pin a ref with
`--ref <tag>` if you want a specific release rather than `main`.

### Then run setup — this step is not optional

```bash
node ~/.codex/plugins/cache/mubit/mubit-memory/0.12.0/scripts/setup.mjs \
     ~/.codex/plugins/cache/mubit/mubit-memory/0.12.0
```

(Or just ask a Codex session to run `mubit-memory:setup`.)

Skipping it gives you a plugin that installs perfectly and **captures nothing**. Two facts
about Codex make it necessary: a plugin-bundled `hooks.json` is inert — Codex copies it and
never reads it — and a plugin-declared MCP server cannot resolve its own entry point, since
there is no `${VAR}` substitution and relative paths resolve against the *project* directory.

So `hooks.json` and `.mcp.json` ship as **templates**, and `setup` installs them into the user
layer with absolute paths substituted: registrations merge into `$CODEX_HOME/hooks.json`, and
the server is registered with `codex mcp add mubit`. It merges rather than overwrites, backs up
what it touches to `<name>.before-mubit`, and is idempotent — **re-run it after every upgrade.**

**Trust the hooks.** A registered hook does not run until trusted, and under `codex exec` an
untrusted hook is skipped *silently* — no prompt, no warning, exit 0. `setup` offers to record
trust and asks first; otherwise run `/hooks` in the TUI and approve the Mubit entries. Trust
must be re-granted after an upgrade, because editing a registration changes its content hash.

### Connect it

Codex has no plugin settings UI, so configuration is three rungs, highest first:

1. `MUBIT_*` environment variables
2. `<data-dir>/credentials.json` — what `mubit-memory:auth` writes
3. `<project>/.mubit-cc.json`

The straightforward route:

```bash
export MUBIT_ENDPOINT='https://eu.mubit.ai'
export MUBIT_API_KEY='mbt_...'
```

Codex runs hook commands through a **login shell**, so anything exported in `.zshrc` or
`.bashrc` reaches the plugin. Convenient, and occasionally surprising: a stale `MUBIT_ENDPOINT`
left over from a local-server session outranks the key you signed in with.

### Two Codex-specific things

- **State lives under `~/.claude/plugins/data/`** — yes, `.claude`, deliberately: that shared
  data dir is what makes one memory rather than two. Which subdirectory is not a constant
  (`mubit-memory-<marketplace>`, `mubit-memory-inline`, …); `setup` resolves it and pins it as
  `MUBIT_CC_DATA_DIR`. Getting it wrong is quiet and total — two half-memories, no error. Check
  with `ls ~/.claude/plugins/data/` and pass `--data-dir=<path>` if it picked wrong.
- **`SessionEnd` is clamped to three seconds** by Codex. The end-of-session flush is handed to a
  detached process, which is why `MUBIT_CC_SESSION_END_DETACH` defaults on. On a long session,
  run `mubit-memory:reflect` yourself rather than relying on the exit path.
- The status line defaults **off** under Codex — its status line is a fixed list of built-in
  items with nothing scriptable in it.

---

## Part 3 — Confirm it works (both)

Claude Code: `/mubit-memory:setup` · Codex: `mubit-memory:setup`

A `ready` state plus your endpoint and a run id means you are done. Anything else:

| Result | Meaning |
| --- | --- |
| `auth_failed` | Key missing, wrong, or revoked. Not a network problem. |
| `unreachable` | Wrong endpoint, or the instance is not running. |
| `warming` | Instance still starting. Wait and retry — not a failure. |
| `not_responding` | Timeouts, usually load. Retry before concluding anything. |

Stuck? `mubit-memory:doctor` runs the full diagnosis, cheapest check first. Under Codex its
step 0 is the Codex-specific one: hooks that were never trusted.

---

## Part 4 — Daily use

Most of it is automatic. After setup you should not have to think about memory:

- **Capture** — every tool call and turn is redacted and spooled, then sent in the background.
  Zero network per tool call.
- **Recall** — relevant lessons are injected before each prompt, at zero LLM cost.
- **Reflect** — at session end, lessons are extracted and promoted beyond the run.

Secrets are scrubbed before anything leaves the machine, and a denylisted subject (`.env`, a
key file) is dropped rather than scrubbed. No hook ever blocks, rewrites, or fails a tool call:
a dead server costs you a memory, never a turn.

### The commands you will actually use

In Claude Code these are `/mubit-memory:<name>`; in Codex, `mubit-memory:<name>`.

| Command | Use it for |
| --- | --- |
| `remember` | Save a durable lesson, rule, or standing preference. |
| `recall` | Search memory for detail beyond what was injected this turn. |
| `pin` | Pin a constraint for the rest of this run ("don't touch the vendored server"). |
| `forget` | Delete a lesson, or down-weight one that is merely wrong. |
| `dashboard` | Local page: browse lessons, recall cost per prompt, ingest health. Loopback only. |
| `doctor` | Diagnose connectivity and memory health when something looks off. |
| `setup` | Confirm endpoint and key are set and the instance answers. |

Less often: `reflect` (extract lessons mid-session), `strategies` (the pattern across many
lessons), `checkpoint` (named snapshot before risky work), `memory-health` (what is actually
stored), `activity` (audit and export the record as JSONL).

Claude Code only: `@mubit-memory:mubit-recall`, a subagent that searches memory in an isolated
context. Codex has no plugin-defined agent types — point a generic sub-agent at the `recall`
skill instead; the isolation is the part that mattered.

### The tools the model uses on its own

You do not call these — the model does, mid-task. Thirteen registered by default, the same on
both harnesses:

`mubit_recall` (search by topic) · `mubit_learned` (save a lesson) ·
`mubit_outcome` (credit what helped) · `mubit_diagnose` (match a failure against past ones) ·
`mubit_lessons` · `mubit_status` · `mubit_reflect` · `mubit_dereference` ·
`mubit_forget` · `mubit_archive` · `mubit_strategies` · `mubit_checkpoint` ·
`mubit_memory_health`

The bundled server carries 21; the other eight cost nothing until you name them in
`MUBIT_MCP_TOOLS` (a list you supply is used verbatim, not unioned with the default).

### Status line (Claude Code)

```
● mubit: cc-my-project-9f2a11c4 · hosted · recall 6/1.2k tok · saved 12t/1q · lessons 3g
```

Run id, connection, what recall cost this prompt, what has been saved.

---

## Worth knowing

- **Runs are per-directory by default.** One project = one memory — and it is what makes a
  Claude Code session and a Codex session in that directory share one. Change it with
  `runStrategy` / `MUBIT_CC_RUN_STRATEGY` (`git-branch`, `per-conversation`, `static`).
- **The recall token budget (default 1500)** is the largest recurring cost — the ceiling on
  tokens injected per prompt. Lower it if context is tight.
- **`recallAsync`** (Claude Code) makes recall never block a prompt, at the cost of one turn
  of staleness.
- **Which harness wrote an entry is recorded** as its agent role, `codex` or `claude-code`, so
  the two stay distinguishable where it matters.
- Full configuration and troubleshooting:
  [`integrations/claude-code/README.md`](integrations/claude-code/README.md) ·
  [`integrations/codex/README.md`](integrations/codex/README.md)

## License

Apache-2.0. See [`LICENSE`](LICENSE).
