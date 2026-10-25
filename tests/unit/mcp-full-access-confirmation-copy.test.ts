import { describe, expect, it } from "vitest";

import { mcpFullAccessConfirmationCopy } from "../../src/main/mcp-full-access-confirmation-copy";

describe("MCP Full Access confirmation copy", () => {
  it("describes the actual operation scope in Chinese", () => {
    expect(mcpFullAccessConfirmationCopy("示例客户端", "zh-CN")).toEqual({
      title: "确认开启完全权限",
      heading: "为这个 MCP 客户端开启完全权限？",
      message:
        "客户端“示例客户端”可以直接执行普通和可恢复操作；危险操作仍需 Agent 再次确认。",
      detail:
        "此设置只作用于当前客户端。你可以随时在设置中更改权限模式或删除该客户端。",
      confirmLabel: "开启完全权限",
    });
  });

  it("describes the actual operation scope in English", () => {
    expect(mcpFullAccessConfirmationCopy("Example client", "en")).toEqual({
      title: "Confirm full access",
      heading: "Enable Full Access for this MCP client?",
      message:
        "“Example client” can run routine and recoverable operations directly. Dangerous operations still need a second confirmation from the Agent.",
      detail:
        "This applies only to this client. You can change its access mode or remove it in Settings at any time.",
      confirmLabel: "Enable Full Access",
    });
  });
});
