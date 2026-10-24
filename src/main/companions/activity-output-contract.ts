import { activityDecisionSchema } from '../../shared/companion-activity-task';

/** This describes the domain proposal; it does not dispatch or rewrite one. */
export const COMPANION_ACTIVITY_FINAL_CONTRACT = '领域final按outputSchema直接返回：顶层action是一个world原子动作对象或null，wait是等待对象或null，这两个必填字段不能省略。memory、topic、planningState不使用时可省略或null，仅表示本轮没有该提案，不会删除已有计划。话题操作使用独立顶层topic，topic.action选择其真实read/update/close等操作；update的roomId、topicId、expectedRevision、patch与topic.action同级，实际值取本步真实端口、最新revision和作者拟写内容。此时顶层action=null且wait=null，不能同时附memory。原生world工具的action="topic"加parameters包装不属于这里的final结构，不能放在final.action内；不要重复同名JSON键。字段结构不决定本步该做什么，仍须按当前实际资料选择必要行动。';

export function parseCompanionActivityDecision(value: unknown) {
  const parsed = activityDecisionSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 8).map(issue => {
    let received = value;
    for (const key of issue.path) received = received !== null && typeof received === 'object'
      && Object.hasOwn(received, key) ? (received as Record<PropertyKey, unknown>)[key] : undefined;
    return { path: issue.path.length ? issue.path.join('.') : '(root)', receivedType: received === null ? 'null' : Array.isArray(received) ? 'array' : typeof received,
      message: issue.message };
  });
  // The author gets the exact failing path and the existing contract, rather
  // than a host-normalized action that could accidentally execute a proposal.
  throw new Error('活动final字段校验失败，提案没有保存或执行。实际错误：' + JSON.stringify(issues).slice(0, 1100)
    + '\n' + COMPANION_ACTIVITY_FINAL_CONTRACT);
}
