// This small entry paints before React, fonts and the feature module graph load.
import './startup.css';
import { retryStartup, startupRetryCount } from './startup-retry';
import { notifyStartupState } from './startup-lifecycle';
const shell = document.getElementById('startup-shell');
// Screen tools have their own native readiness handshake. Never draw the main
// application's launch shell into a desktop-sized capture overlay.
if (new URLSearchParams(location.search).get('window') === 'capture-tools') shell?.remove();
if (new URLSearchParams(location.search).get('window') === 'companion-world') shell?.classList.add('is-world');
const started = performance.now();
try {
  const preference = JSON.parse(localStorage.getItem('worldlinebox.theme-prefs.v1') ?? 'null');
  if (preference?.theme === 'light' || preference?.theme === 'dark') document.documentElement.dataset.theme = preference.theme;
} catch { /* Appearance storage must never prevent startup. */ }
const tick = setInterval(() => {
  const elapsed = shell?.querySelector('[data-startup-elapsed]');
  if (elapsed) elapsed.textContent = `${((performance.now() - started) / 1000).toFixed(1)} 秒`;
  if (!shell?.isConnected) clearInterval(tick);
}, 250);
void import('./main').catch(error => {
  clearInterval(tick);
  if (!shell) return;
  shell.querySelector('.boot-shell')?.classList.add('is-error');
  shell.querySelector('[data-startup-title]')!.textContent = '界面未能打开';
  shell.querySelector('[data-startup-detail]')!.textContent = '请重试，或查看本次启动的诊断日志。';
  const detail = document.createElement('p'); detail.className = 'startup-error'; detail.textContent = String(error instanceof Error ? error.message : error).slice(0, 600);
  shell.querySelector('.startup-card')?.append(detail);
  console.error('startup.renderer.module', error);
  const button = document.createElement('button'); button.className = 'startup-retry'; button.textContent = startupRetryCount() >= 2 ? '已达重试上限，请查看诊断日志' : '重新加载'; button.disabled = startupRetryCount() >= 2;
  button.onclick = () => retryStartup(); shell.querySelector('.startup-card')?.append(button);
  notifyStartupState('failed');
});
