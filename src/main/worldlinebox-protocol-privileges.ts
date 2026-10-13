/**
 * Privileges for the `worldlinebox://` artifact / source media scheme.
 *
 * Must be registered via `protocol.registerSchemesAsPrivileged` before
 * `app.ready`. `stream: true` is required so `<video>` / `<audio>` treat
 * Range responses as a streaming transport; without it Chromium buffers as if
 * the body were a single download, and seek/scrub against `createArtifactResponse`
 * frequently surfaces MEDIA_ERR_NETWORK / decode failures (WorldlineBox-jh2).
 */
export const WORLDLINEBOX_PROTOCOL_SCHEME = "worldlinebox" as const;
export const WORLDLINEBOX_PLUGIN_PROTOCOL_SCHEME = "worldlinebox-plugin" as const;

export const WORLDLINEBOX_PROTOCOL_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  stream: true,
  corsEnabled: true,
} as const;

export function worldlineboxProtocolSchemes() {
  return [
    {
      scheme: WORLDLINEBOX_PROTOCOL_SCHEME,
      privileges: { ...WORLDLINEBOX_PROTOCOL_PRIVILEGES },
    },
    {
      scheme: WORLDLINEBOX_PLUGIN_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
    {
      scheme: 'worldlinebox-companion',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ];
}
