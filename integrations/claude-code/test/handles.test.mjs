// @ts-check
/**
 * `lib/handles.mjs` — the short id printed on every injected memory line.
 *
 * A reference id is a 36-character UUID, which is ~20 tokens a line. The handle is ~3: `m` and
 * four characters hashed from the reference id, so any process renders the same handle for
 * the same entry without sharing state. It is resolved back to the reference id wherever the
 * model hands it over (the MCP egress guard, the capture hook), against the refs the session
 * log says were shown.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { lib } from './helpers/harness.mjs';

const REF_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const REF_B = '0b0b0b0b-0000-4000-8000-00000000000b';

test('handles: handleFor is deterministic, short, and in the documented shape', async () => {
  const H = await lib('handles.mjs');
  const h = H.handleFor(REF_A);
  assert.equal(h, H.handleFor(REF_A));
  assert.match(h, /^m[a-z2-9]{4}$/);
  assert.notEqual(H.handleFor(REF_A), H.handleFor(REF_B));
  assert.equal(H.handleTag(REF_A), `[${h}]`);
});

test('handles: blank and non-string refs have no handle', async () => {
  const H = await lib('handles.mjs');
  for (const v of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(H.handleFor(/** @type {any} */ (v)), '');
    assert.equal(H.handleTag(/** @type {any} */ (v)), '');
  }
});

test('handles: the alphabet leaves out characters that read alike (0 o 1 l i)', async () => {
  const H = await lib('handles.mjs');
  for (let i = 0; i < 2000; i++) {
    assert.doesNotMatch(H.handleFor(randomUUID()).slice(1), /[01oli]/);
  }
});

test('handles: 200 random refs almost never collide', async () => {
  const H = await lib('handles.mjs');
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(H.handleFor(randomUUID()));
  assert.ok(seen.size >= 198, `only ${seen.size} distinct handles for 200 refs`);
});

test('handles: isHandle accepts a handle bare or bracketed, and nothing else', async () => {
  const H = await lib('handles.mjs');
  const h = H.handleFor(REF_A);
  assert.equal(H.isHandle(h), true);
  assert.equal(H.isHandle(`[${h}]`), true);
  assert.equal(H.isHandle(` ${h} `), true);
  for (const v of [REF_A, 'global', 'm12', 'mabcde', '[m]', '', null, 'M' + h.slice(1)]) {
    assert.equal(H.isHandle(/** @type {any} */ (v)), false, String(v));
  }
});

test('handles: stripHandles removes bracketed handles and leaves ordinary words', async () => {
  const H = await lib('handles.mjs');
  const h = H.handleFor(REF_A);
  const out = H.stripHandles(`[${h}] run vitest with --pool=forks, see [rule] too`);
  assert.doesNotMatch(out, new RegExp(h));
  assert.match(out, /run vitest with --pool=forks/);
  assert.match(out, /\[rule\]/);
});

test('handles: resolveHandles maps a handle to the ref that produced it and passes real ids through', async () => {
  const H = await lib('handles.mjs');
  const known = [REF_A, REF_B];
  const r = H.resolveHandles([`[${H.handleFor(REF_B)}]`, REF_A, 'global', ` ${H.handleFor(REF_A)} `], known);
  assert.deepEqual(r.ids, [REF_B, REF_A, 'global', REF_A]);
  assert.deepEqual(r.unresolved, []);
});

test('handles: a handle nothing in the session produced is left as typed and reported', async () => {
  const H = await lib('handles.mjs');
  const stranger = H.handleFor('not-shown-in-this-session');
  const r = H.resolveHandles([stranger], [REF_A]);
  assert.deepEqual(r.ids, [stranger]);
  assert.deepEqual(r.unresolved, [stranger]);
});

test('handles: when two known refs share a handle, the most recently shown wins', async () => {
  const H = await lib('handles.mjs');
  // Find two refs that collide; the space is ~920k so a few thousand tries is plenty.
  const by = new Map();
  let pair = null;
  for (let i = 0; i < 200000 && !pair; i++) {
    const ref = `ref-${i}`;
    const h = H.handleFor(ref);
    if (by.has(h)) pair = [by.get(h), ref];
    else by.set(h, ref);
  }
  assert.ok(pair, 'no collision found to test with');
  const [first, second] = /** @type {string[]} */ (pair);
  assert.deepEqual(H.resolveHandles([H.handleFor(first)], [first, second]).ids, [second]);
  assert.deepEqual(H.resolveHandles([H.handleFor(first)], [second, first]).ids, [first]);
});

test('handles: knownRefsFromRows collects every ref the session showed, oldest first', async () => {
  const H = await lib('handles.mjs');
  const rows = [
    { kind: 'start', lessons: { s1: { title: 'x' } }, refs: ['s1'] },
    { kind: 'prompt', prompt_id: 'p1' },
    { kind: 'shown', prompt_id: 'p1', lessons: { l1: {} }, refs: ['l1', 'f1', 's1'] },
    { kind: 'refs', source: 'subagent', refs: ['sub1'] },
    { kind: 'turn', prompt_id: 'p1', lessons: { l1: { used: true } } },
    { kind: 'shown', prompt_id: 'p2', lessons: {}, refs: ['bogus', 42, ''] },
  ];
  assert.deepEqual(H.knownRefsFromRows(/** @type {any} */ (rows)), ['l1', 'f1', 's1', 'sub1', 'bogus']);
});
