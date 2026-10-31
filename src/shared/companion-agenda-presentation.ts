/** Read-only display text. Native execution always reloads its complete goal. */
export function companionAgendaActivityPresentation(input: { title: string; goal: string }): { title: string; intent: string } {
  const notice = '\n[这里仅展示目标摘要；完整目标仍从绑定的原生记录读取。]', goal = input.goal.trim();
  return { title: input.title.trim().slice(0, 160), intent: goal.length > 16000 ? goal.slice(0, 16000 - notice.length) + notice : goal };
}
