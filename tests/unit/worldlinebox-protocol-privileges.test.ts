import { describe, expect, it } from "vitest";

import {
  WORLDLINEBOX_PROTOCOL_PRIVILEGES,
  WORLDLINEBOX_PROTOCOL_SCHEME,
  WORLDLINEBOX_PLUGIN_PROTOCOL_SCHEME,
  worldlineboxProtocolSchemes,
} from "../../src/main/worldlinebox-protocol-privileges";

describe("worldlinebox protocol privileges", () => {
  it("enables streaming media for seekable Range playback", () => {
    expect(WORLDLINEBOX_PROTOCOL_SCHEME).toBe("worldlinebox");
    expect(WORLDLINEBOX_PROTOCOL_PRIVILEGES.stream).toBe(true);
    expect(WORLDLINEBOX_PROTOCOL_PRIVILEGES.standard).toBe(true);
    expect(WORLDLINEBOX_PROTOCOL_PRIVILEGES.secure).toBe(true);
    expect(WORLDLINEBOX_PROTOCOL_PRIVILEGES.supportFetchAPI).toBe(true);

    const schemes = worldlineboxProtocolSchemes();
    expect(schemes).toHaveLength(2);
    expect(schemes[0]?.scheme).toBe("worldlinebox");
    expect(schemes[0]?.privileges.stream).toBe(true);
    expect(schemes[1]?.scheme).toBe(WORLDLINEBOX_PLUGIN_PROTOCOL_SCHEME);
    expect(schemes[1]?.privileges.stream).toBe(true);
  });
});
