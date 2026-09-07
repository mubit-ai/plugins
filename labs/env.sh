# labs/env.sh — source this from the repo root:   source labs/env.sh
#
# Everything the plugin reads is set here explicitly, exactly as Claude Code would set it
# for a real install. Nothing leaks in from your shell, and nothing here touches your real
# ~/.claude data directory.

if [ -f "$PWD/labs/env.sh" ]; then
  LAB_REPO_ROOT="$PWD"
elif [ -f "$PWD/env.sh" ] && [ -d "$PWD/../integrations" ]; then
  LAB_REPO_ROOT="$(cd "$PWD/.." && pwd)"
else
  echo "source this from the repo root:  source labs/env.sh" >&2
  return 1 2>/dev/null || exit 1
fi

export LAB_ROOT="$LAB_REPO_ROOT/labs"

# --- what Claude Code exports for a plugin ---------------------------------------------
export CLAUDE_PLUGIN_ROOT="$LAB_REPO_ROOT/integrations/claude-code"
export CLAUDE_PLUGIN_DATA="$LAB_ROOT/.work/data"
export CLAUDE_PROJECT_DIR="$LAB_ROOT/.work/demo-app"

# --- what the plugin itself reads (§6.1) -----------------------------------------------
export MUBIT_CC_DATA_DIR="$CLAUDE_PLUGIN_DATA"
export MUBIT_ENDPOINT="http://127.0.0.1:${LAB_PORT:-8787}"
export MUBIT_API_KEY="mbt_lab_0123456789abcdef0123456789abcdef"
export MUBIT_CC_LOG_LEVEL="debug"
# The MCP server's poisoned default. Blanked so nothing can inherit it (§4.3).
export MUBIT_DEFAULT_SESSION_ID=""

export HOOKS="$CLAUDE_PLUGIN_ROOT/hooks/src"
export PAYLOADS="$LAB_ROOT/payloads"

# Where `bin/import.mjs` reads (Lab 13). `node labs/import-fixtures.mjs` lays synthetic
# transcripts out here in both hosts' layouts; the real ~/.claude and ~/.codex are never read.
export MUBIT_CC_TRANSCRIPT_ROOT="$LAB_ROOT/.work/transcripts/claude"
export MUBIT_CC_CODEX_SESSIONS_ROOT="$LAB_ROOT/.work/codex/sessions"

# The run id these settings derive. The fake instance reads it to decide which of its lessons
# belong to "your" run: the activity feed is asked for the whole account and filtered by the
# client, so that request names no run at all. The id is a hash of the project path, so it
# differs per worktree and cannot be hardcoded anywhere.
LAB_RUN_ID="$(node "$LAB_ROOT/runid.mjs" 2>/dev/null | awk '/^run_id/ { print $2 }')"
export LAB_RUN_ID

# ---------------------------------------------------------------------------------------
# hook <name> <payload.json> [args...]
#
# Runs a hook exactly the way Claude Code does: a fresh node process, the payload on
# stdin, JSON on stdout. Prints stdout, then the exit code — which is 0 in every mode,
# including every failure mode.
# ---------------------------------------------------------------------------------------
hook() {
  local name="$1"; shift
  local payload="$1"; shift
  local file="$PAYLOADS/$payload"
  [ -f "$file" ] || { echo "no such payload: $file" >&2; return 1; }
  echo "--- $name  <  $payload  $* ---"
  node "$HOOKS/$name.mjs" "$@" < "$file"
  local code=$?
  echo ""
  echo "--- exit $code ---"
}

# peek [section] — what the hooks left on disk. `peek --help` lists the sections.
peek() { node "$LAB_ROOT/peek.mjs" "$@"; }

# mcp <tool> ['<args json>'] [--routes] [--session <id>] — call one MCP tool as one conversation
# (or as none), and show the routes it dialled.
mcp() {
  local tool="$1"; shift
  local args="{}"
  case "${1:-}" in --*|'') ;; *) args="$1"; shift ;; esac
  node "$LAB_ROOT/mcp-drive.mjs" --tool "$tool" --args "$args" "$@"
}

# admin <command> [args] — bin/admin.mjs against the lab store, the way the skills run it.
# The flag is not decoration: a Bash tool call inside Claude Code does not inherit
# CLAUDE_PLUGIN_DATA, and without it the script searches ~/.claude/plugins/data/ for a store
# and can pick one the hooks are not writing to (Lab 12e).
admin() { node "$CLAUDE_PLUGIN_ROOT/bin/admin.mjs" "$@" --data-dir "$CLAUDE_PLUGIN_DATA"; }

# wire <command...> — run any command and print the routes it dialled: the request-log diff
# `mcp --routes` does, for anything that can dial.
wire() {
  local log="$LAB_ROOT/.work/requests.ndjson"
  local before=0
  [ -f "$log" ] && before=$(wc -l < "$log" | tr -d ' ')
  "$@"
  local code=$?
  echo ""
  node -e '
    const fs = require("node:fs");
    const [log, before] = process.argv.slice(1);
    let rows = [];
    try { rows = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).slice(Number(before)); } catch {}
    console.log(rows.length ? "routes dialled by that call:" : "routes dialled by that call: (none — no request left the process)");
    for (const l of rows) { try { const d = JSON.parse(l); console.log(`  ${d.key} → ${d.status}`); } catch {} }
  ' "$log" "$before"
  return $code
}

# runid ['<payload json>'] — the run id these settings derive, without running a hook.
runid() { node "$LAB_ROOT/runid.mjs" "$@"; }

echo "lab ready"
echo "  endpoint     $MUBIT_ENDPOINT"
echo "  project      $CLAUDE_PROJECT_DIR"
echo "  data dir     $MUBIT_CC_DATA_DIR"
echo "  run id       ${LAB_RUN_ID:-(underived)}"
echo "  helpers      hook <name> <payload.json> [args]   peek [section]   runid   mcp <tool>   admin <command>   wire <command…>"
