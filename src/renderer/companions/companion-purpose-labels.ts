const labels: Record<string, string> = {
  '*': '共同原则', common: '共同原则', default: '默认职能', chat: '交流', companion_reply: '交流', companion_structured_repair: '结构化输出修复',
  vcp_experience_journal: '经历编码', vcp_sleep_reflection: '经历反思', vcp_sleep_memory_maintenance: '经历整合',
  companion_dream_wave_narrative: '梦境联想', companion_learning: '资料学习', companion_learning_goal: '定向学习',
  vcp_aimemo: '原版记忆聚焦', vcp_focus_guidance: '记忆聚焦指导', vcp_tagmaster: '自动标签',
  native_timeline: '月度时间线', native_summary: '时间线摘要', world_social: '伙伴交流', companion_social_initiative: '主动交往',
  world_message_authorization: '交流授权核验', visit_peer_speech: '拜访交流', world_decision: '世界行动', world_attention: '当前关注',
  companion_action_feedback: '任务结果反馈', companion_persona_integration: '人格整合', companion_internal_work: '内部工作', activity_task_step: '持续任务',
  activity_resource_feasibility: '任务资源核验', companion_collaboration_authorization: '协作授权', companion_collaboration_offer: '协作约定',
  companion_isolated_thought: '私下反思', companion_loop_compaction: '工作上下文整理', companion_management_authorization: '管理操作核验',
  companion_social_progress_review: '交往进展核对', game_goal_completion: '目标完成核验', game_public_reply_privacy: '公开回复范围核验', game_shared_state_privacy: '共享资料范围核验',
  topic_context_compaction: '话题上下文整理', topic_continuity_issue_adjudication: '话题连续性判断', topic_continuity_review: '话题连续性复核',
  topic_moderator_transfer_consent: '话题主持交接', topic_narrative_reference_extract: '叙事依据提取', topic_narrative_reference_review: '叙事依据复核',
  topic_summary_canon_audit: '话题摘要核对', topic_summary_canon_issue_adjudication: '摘要争议核对', topic_user_canon_extract: '用户明确约定提取',
  vcp_memory_prohibition_check: '记忆记录范围核验', host_policy: '记忆运行规则',
};
/** Display labels only; never a capability or purpose admission map. */
export function companionPurposeLabel(purpose: string): string { return labels[purpose] ?? purpose; }
