#!/usr/bin/env node
// @ts-check
/**
 * `mcp/src/launch.mjs` — the Codex entry point `mcp/dist/index.js` is built from.
 *
 * Same two lines, same order, same reason as `hooks/src/*.mjs`: `lib/boot.mjs` declares
 * `MUBIT_CC_HOST=codex` before the shared launcher resolves its configuration at module scope.
 * Without it the server takes the Claude Code defaults, including the `anthropic/alwaysLoad`
 * marking Codex does nothing with. Nothing puts the host in this process's environment.
 *
 * The three `CLAUDE_*` names the shim also fills agree with what setup registers: the plugin
 * root is found from this bundle's own location, `MUBIT_CC_DATA_DIR` still outranks the data
 * directory it synthesises, and the project directory is the launch cwd either way.
 */

import '../../lib/boot.mjs';

await import('../../../claude-code/mcp/src/launch.mjs');
