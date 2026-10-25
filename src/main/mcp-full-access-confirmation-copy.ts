export interface McpFullAccessConfirmationCopy {
  readonly title: string;
  readonly heading: string;
  readonly message: string;
  readonly detail: string;
  readonly confirmLabel: string;
}

export function mcpFullAccessConfirmationCopy(
  label: string,
  locale: "en" | "zh-CN",
): McpFullAccessConfirmationCopy {
  const english = locale === "en";
  return {
    title: english ? "Confirm full access" : "确认开启完全权限",
    heading: english
      ? "Enable Full Access for this MCP client?"
      : "为这个 MCP 客户端开启完全权限？",
    message: english
      ? `“${label}” can run routine and recoverable operations directly. Dangerous operations still need a second confirmation from the Agent.`
      : `客户端“${label}”可以直接执行普通和可恢复操作；危险操作仍需 Agent 再次确认。`,
    detail: english
      ? "This applies only to this client. You can change its access mode or remove it in Settings at any time."
      : "此设置只作用于当前客户端。你可以随时在设置中更改权限模式或删除该客户端。",
    confirmLabel: english ? "Enable Full Access" : "开启完全权限",
  };
}
