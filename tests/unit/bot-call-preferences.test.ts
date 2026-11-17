// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { readBotCallFraming, readBotCallPreferences, saveBotCallFraming, saveBotCallPreferences } from '../../src/renderer/companion-bot/call-preferences';

afterEach(() => localStorage.clear());
it('keeps legacy scenes, enables idle and requires opt-in for pointer tracking', () => {
  localStorage.setItem('worldlinebox.companion-call.scene.v1', 'plain');
  localStorage.setItem('worldlinebox.companion-call.preferences.v1:alice', JSON.stringify({ gazeEnabled: true, idleEnabled: true }));
  expect(readBotCallPreferences('alice')).toEqual({ scene: 'plain', gazeEnabled: false, idleEnabled: true });
  expect(saveBotCallPreferences('alice', { gazeEnabled: true })).toBe(true);
  expect(readBotCallPreferences('alice')).toEqual({ scene: 'plain', gazeEnabled: true, idleEnabled: true });
  expect(readBotCallPreferences('bob')).toEqual({ scene: 'plain', gazeEnabled: false, idleEnabled: true });
});
it('falls back safely for malformed stored preferences and rejects unsafe scene URLs', () => {
  localStorage.setItem('worldlinebox.companion-call.preferences.v1:alice', JSON.stringify({ scene: 'https://untrusted/background.png', gazeEnabled: 'no', idleEnabled: false, readAloud: true }));
  expect(readBotCallPreferences('alice')).toEqual({ scene: 'evening', gazeEnabled: false, idleEnabled: false });
  localStorage.setItem('worldlinebox.companion-call.preferences.v1:bob', 'broken-json');
  expect(readBotCallPreferences('bob')).toEqual({ scene: 'evening', gazeEnabled: false, idleEnabled: true });
});

it('restores framing only for the same companion and installed model', () => {
  const model = { model: 'model/character.model3.json', modelUrl: 'worldlinebox://call-model/imports/first/model/character.model3.json', assets: { expressions: [], motions: [], credits: '', license: '' } };
  const defaults = { fullBody: false, scale: 1, x: 0, y: 0 };
  const adjusted = { fullBody: true, scale: 1.25, x: -.2, y: .1 };
  expect(readBotCallFraming('alice', model)).toEqual(defaults);
  expect(saveBotCallFraming('alice', model, adjusted)).toBe(true);
  expect(readBotCallFraming('alice', model)).toEqual(adjusted);
  expect(readBotCallFraming('bob', model)).toEqual(defaults);
  expect(readBotCallFraming('alice', { ...model, modelUrl: model.modelUrl.replace('first', 'replacement') })).toEqual(defaults);
  const storageKey = localStorage.key(0)!;
  localStorage.setItem(storageKey, JSON.stringify({ fullBody: 'yes', scale: 100, x: -99, y: .2 }));
  expect(readBotCallFraming('alice', model)).toEqual({ ...defaults, y: .2 });
});
