import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../web/theme.js', import.meta.url), 'utf8');

function harness({ dark = false, stored, blocked = false } = {}) {
  const listeners = {}, system = { matches: dark, addEventListener(name, fn) { listeners.system = fn; } }, data = {};
  const storage = new Map(stored ? [['resonate.theme', stored]] : []);
  const window = { matchMedia: () => system, dispatchEvent() {}, addEventListener(name, fn) { listeners[name] = fn; } };
  vm.runInNewContext(source, { window, document: { documentElement: { dataset: data } }, CustomEvent: class {},
    localStorage: { getItem(key) { if (blocked) throw Error(); return storage.get(key); }, setItem(key, value) { if (blocked) throw Error(); storage.set(key, value); } } });
  return { data, listeners, system, storage, theme: window.resonateTheme };
}
test('appearance follows the system by default and only follows system changes in System mode', () => {
  const ui = harness({ dark: true }); assert.equal(ui.data.theme, 'dark'); assert.equal(ui.theme.get(), 'system');
  ui.system.matches = false; ui.listeners.system(); assert.equal(ui.data.theme, 'light');
  ui.theme.set('dark'); assert.equal(ui.storage.get('resonate.theme'), 'dark'); ui.listeners.system(); assert.equal(ui.data.theme, 'dark');
  ui.theme.set('system'); assert.equal(ui.data.theme, 'light');
});
test('appearance persists before rendering and synchronizes across tabs without requiring storage', () => {
  const ui = harness({ dark: false, stored: 'dark' }); assert.equal(ui.data.theme, 'dark');
  ui.listeners.storage({ key: 'resonate.theme', newValue: 'light' }); assert.equal(ui.data.theme, 'light');
  ui.theme.set('invalid'); assert.equal(ui.theme.get(), 'light');
  const blocked = harness({ blocked: true, dark: true }); blocked.theme.set('light'); assert.equal(blocked.data.theme, 'light');
});
test('both themes keep normal text and semantic state labels readable against their surfaces', async () => {
  const css = await readFile(new URL('../web/theme.css', import.meta.url), 'utf8');
  const luminance = hex => {
    const values = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
    return .2126 * values[0] + .7152 * values[1] + .0722 * values[2];
  };
  for (const block of [css.match(/:root\s*\{([^}]+)/)[1], css.match(/:root\[data-theme="dark"\]\s*\{([^}]+)/)[1]]) {
    const colors = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/g)].map(m => [m[1], m[2]]));
    for (const [fg, bg] of [['text', 'page'], ['muted', 'surface'], ['subtle', 'stage'], ['on-accent', 'accent'], ...['success', 'warning', 'danger', 'info'].map(c => [c, c + '-bg'])]) {
      const a = luminance(colors[fg]), b = luminance(colors[bg]); assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, `${fg} on ${bg}`);
    }
  }
});
