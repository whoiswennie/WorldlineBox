/* eslint-disable @typescript-eslint/no-require-imports -- Isolated Electron main process decrypts the existing global key only in memory. */
/* global require, process, Buffer */
'use strict';
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.disableHardwareAcceleration();
const profile = process.env.WORLDLINEBOX_CONTENT_EVAL_PROFILE;
const source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT;
if (!profile || !source || !path.isAbsolute(profile) || !path.isAbsolute(source) || profile === source) process.exit(1);
app.setPath('userData', profile); app.setPath('sessionData', profile);
// Windows safeStorage's AES key is itself OS-encrypted in Chromium Local State.
// Copy only that encrypted metadata into our disposable profile. Plaintext API
// keys never enter this file, and the original profile remains read-only.
try {
  const metadata = JSON.parse(fs.readFileSync(path.join(source, 'Local State'), 'utf8'));
  if (metadata.os_crypt) { fs.mkdirSync(profile, { recursive: true }); fs.writeFileSync(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: metadata.os_crypt })); }
} catch { /* Older profiles can use an OS encryption backend without Local State. */ }
app.whenReady().then(() => {
  let result;
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(source, 'ai-profiles.json'), 'utf8'));
    const profileId = catalog.activeProfileId;
    if (!/^ai_[a-f0-9]{24}$/u.test(profileId)) throw new Error('No active connection profile.');
    const stored = catalog.profiles.find(profile => profile.id === profileId);
    if (!stored) throw new Error('Active connection profile is missing.');
    if (!safeStorage.isEncryptionAvailable()) throw Object.assign(new Error(), { code: 'DECRYPT_UNAVAILABLE' });
    const key = safeStorage.decryptString(Buffer.from(fs.readFileSync(path.join(source, 'ai-profile-keys', profileId + '.bin'))));
    result = { ok: true, stored: { apiFormat: stored.apiFormat, provider: stored.provider, model: stored.model, baseUrl: stored.baseUrl }, apiKey: key };
  } catch (error) { result = { ok: false, code: ['ENOENT', 'DECRYPT_UNAVAILABLE'].includes(error.code) ? error.code : 'GLOBAL_CHAT_CONFIG_UNREADABLE' }; }
  // No credential is printed, written to a fixture file, or included in errors.
  if (process.send) process.send(result, () => app.exit(0)); else app.exit(1);
});
