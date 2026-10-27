import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_PRESETS, applySyncedPresets, defaultPrefs, presetsJson, syncedPresets } from '../../src/prefs.ts';

test('defaults: three pen and three highlighter presets', () => {
  const p = defaultPrefs();
  assert.equal(p.penPresets.length, 3);
  assert.equal(p.hlPresets.length, 3);
  assert.equal(p.touch, 'scroll');
});

test('synced presets round-trip', () => {
  const a = defaultPrefs();
  a.penPresets.push({ color: '#0aa5c9', width: 2.2 });
  const b = defaultPrefs();
  assert.equal(applySyncedPresets(b, { presets: syncedPresets(a) }), true);
  assert.equal(presetsJson(a), presetsJson(b));
  assert.equal(applySyncedPresets(b, { presets: syncedPresets(a) }), false, 'second apply changes nothing');
});

test('applying keeps the per-device selection in range and the active colour in step', () => {
  const p = defaultPrefs();
  p.penIdx = 2;
  applySyncedPresets(p, { presets: { v: 1, pen: [{ color: '#1f4fd8', width: 1.4 }] } });
  assert.equal(p.penPresets.length, 1);
  assert.equal(p.penIdx, 0);
  assert.equal(p.penColor, '#1f4fd8');
  assert.equal(p.hlPresets.length, 3, 'highlighters untouched when not provided');
});

test('invalid synced data is ignored', () => {
  const p = defaultPrefs();
  const before = presetsJson(p);
  for (const bad of [null, {}, { presets: 5 }, { presets: { pen: 'x', hl: [null, 7, { color: 'url(x)', width: 1 }, { color: '#fff', width: -3 }] } }]) {
    assert.equal(applySyncedPresets(p, bad as never), false);
  }
  assert.equal(presetsJson(p), before);
});

test('at most MAX_PRESETS presets are accepted', () => {
  const p = defaultPrefs();
  const many = Array.from({ length: 12 }, () => ({ color: '#123456', width: 1 }));
  applySyncedPresets(p, { presets: { pen: many } });
  assert.equal(p.penPresets.length, MAX_PRESETS);
});
