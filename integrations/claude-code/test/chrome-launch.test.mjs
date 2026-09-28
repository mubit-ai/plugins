// @ts-check
/**
 * `launchChrome` when the browser does not come up.
 *
 * A Chrome that misses its launch deadline, or publishes an endpoint nothing can connect to,
 * used to be left running with its stderr piped into the test file. That pipe kept the file's
 * event loop alive, so every browser case failed and then `node --test` waited on the file
 * forever. These cases stand in a shell script for Chrome, one that also leaves a helper process
 * holding its stderr the way Chrome's crash handler does, and assert that a failed launch kills
 * what it started, removes its profile, and lets the process exit.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

import { launchChrome } from './helpers/chrome.mjs';

const HELPER = fileURLToPath(new URL('./helpers/chrome.mjs', import.meta.url));
const skip = process.platform === 'win32' ? 'the stand-in browser is a shell script' : false;

/** @type {number[]} */
const started = [];
after(() => {
  for (const pid of started) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

/**
 * A stand-in browser: records its pid, its helper's pid and its arguments, optionally prints a
 * line on stderr, then sleeps with a background helper that shares its stderr.
 * @param {string} [say]
 */
function fakeChrome(say = '') {
  const dir = mkdtempSync(join(tmpdir(), 'mubit-fake-chrome-'));
  const bin = join(dir, 'chrome');
  writeFileSync(bin, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > '${join(dir, 'args')}'`,
    'sleep 30 &',
    `echo $! > '${join(dir, 'helper')}'`,
    `echo $$ > '${join(dir, 'pid')}'`,
    say ? `echo '${say}' >&2` : '',
    'exec sleep 30',
    '',
  ].join('\n'), { mode: 0o755 });
  const pids = () => ['pid', 'helper'].map((f) => Number(readFileSync(join(dir, f), 'utf8')));
  const profile = () => readFileSync(join(dir, 'args'), 'utf8').split('\n')
    .find((a) => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length) ?? '';
  return { dir, bin, pids, profile };
}

/** @param {number} pid */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** @param {number} pid @param {number} ms */
async function goneWithin(pid, ms) {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await new Promise((r) => { setTimeout(r, 25); });
  return !alive(pid);
}

/** A loopback port with nothing listening on it. */
async function closedPort() {
  const srv = createServer();
  await new Promise((r) => { srv.listen(0, '127.0.0.1', () => r(undefined)); });
  const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address());
  await new Promise((r) => { srv.close(() => r(undefined)); });
  return port;
}

test('a Chrome that never publishes an endpoint is killed and its profile removed', { skip }, async () => {
  const fake = fakeChrome();
  await assert.rejects(launchChrome({ bin: fake.bin, launchMs: 400 }), /did not publish a DevTools endpoint within 400 ms/);
  const [pid, helper] = fake.pids();
  started.push(pid, helper);
  assert.ok(await goneWithin(pid, 2000), 'the browser is still running after its launch failed');
  assert.equal(existsSync(fake.profile()), false, 'the profile directory was left behind');
  rmSync(fake.dir, { recursive: true, force: true });
});

test('a Chrome whose endpoint cannot be connected to is killed and its profile removed', { skip }, async () => {
  const fake = fakeChrome(`DevTools listening on ws://127.0.0.1:${await closedPort()}/devtools/browser/x`);
  await assert.rejects(launchChrome({ bin: fake.bin, launchMs: 2000 }), /could not connect to ws:/);
  const [pid, helper] = fake.pids();
  started.push(pid, helper);
  assert.ok(await goneWithin(pid, 2000), 'the browser is still running after its launch failed');
  assert.equal(existsSync(fake.profile()), false, 'the profile directory was left behind');
  rmSync(fake.dir, { recursive: true, force: true });
});

test('a process whose Chrome never came up still exits, though a helper holds the browser\'s stderr', { skip }, async () => {
  const fake = fakeChrome();
  const script = [
    `const { launchChrome } = await import(${JSON.stringify(HELPER)});`,
    `await launchChrome({ bin: ${JSON.stringify(fake.bin)}, launchMs: 400 }).then(`,
    `  () => { console.log('launched'); },`,
    `  (e) => { console.log(String(e.message).split('\\n')[0]); },`,
    ');',
  ].join('\n');
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 });
  const took = Date.now() - t0;
  const [pid, helper] = fake.pids();
  started.push(pid, helper);
  assert.equal(r.signal, null, `the process did not exit on its own; it was killed after ${took} ms`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /did not publish a DevTools endpoint within 400 ms/);
  assert.ok(took < 5000, `the process took ${took} ms to exit`);
  rmSync(fake.dir, { recursive: true, force: true });
});
