// @ts-check
/**
 * The cheap canary: everything the walkthrough names must still exist. A renamed hook, a
 * dropped payload, a retired tool or a new route turns a lab into a dead end silently -
 * this file is what turns it into a red test instead.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { LAB_ROOT, REPO_ROOT, labState, startFake, driveMcp, deriveLabRunId } from './helpers.mjs';

const README = readFileSync(join(LAB_ROOT, 'README.md'), 'utf8');

test('every hooks/src file the README names exists', () => {
  const named = new Set([...README.matchAll(/hooks\/src\/([a-z-]+\.mjs)/g)].map((m) => m[1]));
  assert.ok(named.size >= 7, `the file map names the hooks (found ${named.size})`);
  for (const f of named) {
    assert.ok(existsSync(join(REPO_ROOT, 'integrations/claude-code/hooks/src', f)),
      `hooks/src/${f} is named in the README and must exist`);
  }
});

test('every lib module the README names exists', () => {
  const named = new Set([...README.matchAll(/lib\/([a-z-]+\.mjs)/g)].map((m) => m[1]));
  for (const f of named) {
    assert.ok(existsSync(join(REPO_ROOT, 'integrations/claude-code/lib', f)),
      `lib/${f} is named in the README and must exist`);
  }
});

test('every payload the README names exists and parses', () => {
  const named = new Set([...README.matchAll(/(\d\d-[a-z-]+\.json)/g)].map((m) => m[1]));
  assert.ok(named.size >= 9, `the labs use the payloads (found ${named.size})`);
  for (const f of named) {
    const p = join(LAB_ROOT, 'payloads', f);
    assert.ok(existsSync(p), `labs/payloads/${f} is named in the README and must exist`);
    assert.doesNotThrow(() => JSON.parse(readFileSync(p, 'utf8')), `${f} parses as JSON`);
  }
  assert.ok(existsSync(join(LAB_ROOT, 'payloads', 'transcript.jsonl')), 'the Lab 9 transcript exists');
});

test('every route the README shows is one the fake instance serves', () => {
  const fakeSrc = readFileSync(join(LAB_ROOT, 'fake-mubit.mjs'), 'utf8');
  const named = new Set([...README.matchAll(/\/v2\/[a-z/]+/g)].map((m) => m[0]));
  assert.ok(named.size >= 8, `the walkthrough shows the wire (found ${named.size} routes)`);
  for (const route of named) {
    assert.ok(fakeSrc.includes(route), `${route} appears in the README but not in fake-mubit's route table`);
  }
});

test('the fake instance covers every route lib/http.mjs can dial', () => {
  const httpSrc = readFileSync(join(REPO_ROOT, 'integrations/claude-code/lib/http.mjs'), 'utf8');
  const fakeSrc = readFileSync(join(LAB_ROOT, 'fake-mubit.mjs'), 'utf8');
  const dialable = new Set([...httpSrc.matchAll(/['"`](\/v2\/[a-z/]+)/g)].map((m) => m[1]));
  assert.ok(dialable.size >= 8, `lib/http.mjs names its routes (found ${dialable.size})`);
  for (const route of dialable) {
    assert.ok(fakeSrc.includes(route),
      `lib/http.mjs can dial ${route} but fake-mubit does not serve it - a lab would 404`);
  }
});

test('the default tool count the prose claims holds, and every mubit_* tool the README names can be served', async () => {
  const st = labState();
  st.env.LAB_RUN_ID = deriveLabRunId(st.env);
  const fake = await startFake(st);
  try {
    const list = driveMcp(st, '--list');
    assert.equal(list.code, 0, list.stderr);
    const served = [...list.stdout.matchAll(/^ {2}· (\S+)/gm)].map((m) => m[1]);
    assert.equal(served.length, 7, 'the README prose pins the curated seven');

    // Guard objects ride on results; they are fields, not tools. Everything else the README
    // names must exist on the server - retired from the default set is fine, gone is not:
    // an allowlist is used verbatim, so naming them all is the way to ask for all of them.
    const named = [...new Set([...README.matchAll(/\bmubit_[a-z_]+\b/g)].map((m) => m[0]))]
      .filter((t) => !t.endsWith('_guard'));
    assert.ok(named.length >= 7, `the walkthrough names the tools (found ${named.length})`);
    const all = driveMcp({ ...st, env: { ...st.env, MUBIT_MCP_TOOLS: named.join(',') } }, '--list');
    assert.equal(all.code, 0, all.stderr);
    const servedAll = new Set([...all.stdout.matchAll(/^ {2}· (\S+)/gm)].map((m) => m[1]));
    for (const tool of named) {
      assert.ok(servedAll.has(tool), `${tool} is named in the README but the server cannot serve it`);
    }
  } finally {
    await fake.stop();
    st.cleanup();
  }
});

test('every labs/test file the README points at exists', () => {
  const named = new Set([...README.matchAll(/labs\/test\/([a-z-]+\.test\.mjs)/g)].map((m) => m[1]));
  for (const f of named) {
    assert.ok(existsSync(join(LAB_ROOT, 'test', f)), `labs/test/${f} is named in the README and must exist`);
  }
});
