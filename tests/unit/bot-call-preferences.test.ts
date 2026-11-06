// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { readBotCallPreferences, saveBotCallPreferences } from '../../src/renderer/companion-bot/call-preferences';

afterEach(() => localStorage.clear());
it('uses the existing global scene and speech choices until a companion has its own saved preferences', () => {
  localStorage.setItem('worldlinebox.companion-call.scene.v1', 'plain'); localStorage.setItem('worldlinebox.companion-call.speech.v1', 'off');
  expect(readBotCallPreferences('alice')).toEqual({ scene: 'plain', readAloud: false, gazeEnabled: true, idleEnabled: true });
  expect(saveBotCallPreferences('alice', { readAloud: true, gazeEnabled: false })).toBe(true);
  expect(readBotCallPreferences('alice')).toEqual({ scene: 'plain', readAloud: true, gazeEnabled: false, idleEnabled: true });
  expect(readBotCallPreferences('bob')).toEqual({ scene: 'plain', readAloud: false, gazeEnabled: true, idleEnabled: true });
});
it('falls back safely for malformed stored preferences and rejects unsafe scene URLs', () => {
  localStorage.setItem('worldlinebox.companion-call.preferences.v1:alice', JSON.stringify({ scene: 'https://untrusted/background.png', gazeEnabled: 'no', idleEnabled: false, readAloud: true }));
  expect(readBotCallPreferences('alice')).toEqual({ scene: 'evening', readAloud: true, gazeEnabled: true, idleEnabled: false });
  localStorage.setItem('worldlinebox.companion-call.preferences.v1:bob', 'broken-json');
  expect(readBotCallPreferences('bob')).toEqual({ scene: 'evening', readAloud: true, gazeEnabled: true, idleEnabled: true });
});
