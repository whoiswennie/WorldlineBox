import { expect, it } from 'vitest';
import { externalBrowserUrl, isRestrictedBrowserSignIn } from '../../src/shared/browser-compatibility';

it('recognizes the real Google sign-in origin without accepting lookalike or credential URLs', () => {
  expect(isRestrictedBrowserSignIn('https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fwww.google.com')).toBe(true);
  for (const url of ['https://accounts.google.com.evil.test/', 'https://evil.test/accounts.google.com', 'http://accounts.google.com/', 'https://accounts.google.com:8443/', 'https://user@accounts.google.com/', 'about:blank']) expect(isRestrictedBrowserSignIn(url)).toBe(false);
});

it('only allows explicit web pages to reach the operating system browser', () => {
  const url = 'https://example.com/login?state=a%2Bb&continue=%2Faccount#next';
  expect(externalBrowserUrl(url)).toBe(url);
  for (const value of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'data:text/html,test', 'ms-settings:privacy', 'https://user:secret@example.com', 'about:blank', 'https://example.com/' + 'a'.repeat(8192)]) expect(externalBrowserUrl(value)).toBeUndefined();
});
