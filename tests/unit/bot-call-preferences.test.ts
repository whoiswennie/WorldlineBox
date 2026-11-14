// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { readBotCallPreferences, saveBotCallPreferences } from '../../src/renderer/companion-bot/call-preferences';

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
