/** Durable bot state is independent of the retired companion cognition schema. */
import type { BotMediaRef } from '../../shared/companion-bot-media';
import type { BotReplyProgress, BotReplyTiming, BotReplyPart } from '../../shared/companion-bot';
export type BotConversationKind = 'direct' | 'group' | 'world' | 'peer';
export type BotMessageStatus = 'queued' | 'running' | 'sent' | 'failed' | 'cancelled';
export type BotEventStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type BotSource = 'user' | 'companion' | 'group' | 'world' | 'task' | 'gateway';
export type BotSenderType = 'user' | 'companion' | 'service' | 'world';
export interface BotCompanion {
  id: string; name: string; persona: string; createdAt: string; updatedAt: string; activePersonaId?: string; enabled?: boolean; workerConcurrency?: number;
}
export interface BotConversation {
  id: string; title: string; kind: BotConversationKind; memberIds: string[];
  audienceScopeId: string; securityDomainId: string; revision: number; createdAt: string;
  participationMode?: 'automatic' | 'all' | 'mentions';
  peerConversation?: boolean;
  userRole?: 'observer';
  ownerId?: 'user'; dissolvedAt?: string;
  announcement?: { text: string; updatedAt: string };
}
export interface BotMessage {
  id: string; eventId: string; conversationId: string; senderId: string; senderName: string;
  senderType: BotSenderType; content: string; status: BotMessageStatus; sequence: number;
  kind: 'message' | 'task_progress' | 'task_done' | 'world_observation' | 'attention';
  correlationId: string; createdAt: string; error?: string;
  attachments?: BotMediaRef[];
  timing?: BotReplyTiming;
  progress?: BotReplyProgress;
  parts?:BotReplyPart[];
  taskNotice?: { taskId: string; kind: 'task_done' | 'task_progress'; replyMessageId?: string; companionId?: string; companionName?: string; title?: string; status?: string };
}
export interface BotEvent {
  id: string; eventId: string; laneId: string; conversationId: string; companionId: string;
  source: BotSource; sourceInstanceId: string; sourceMessageId: string;
  senderId: string; senderType: BotSenderType; senderName: string;
  audienceScopeId: string; securityDomainId: string; aclRevision: number;
  sequence: number; kind: BotMessage['kind']; content: string; payload: Record<string, unknown>;
  correlationId: string; causationId?: string; sourceMessageRecordId: string; sourceMessageSequence: number; replyMessageId: string;
  status: BotEventStatus; attempts: number; occurredAt: string; receivedAt: string;
  dshEventId?: string; error?: string;
}
export interface BotLane {
  id: string; conversationId: string; companionId: string; sessionId?: string;
  aclRevision: number; epoch: number; lastClaimedAt: number;
}
export interface BotClaim { event: BotEvent; leaseToken: string; leaseUntil: number; }
export interface BotAttachmentGrant { mediaId: string; grantId: string }
export interface BotEnqueueInput {
  conversationId: string; senderId: string; senderName?: string; content: string;
  source?: BotSource; sourceInstanceId?: string; sourceMessageId?: string;
  recipientIds?: string[]; correlationId?: string; causationId?: string; occurredAt?: string;
  kind?: BotMessage['kind']; payload?: Record<string, unknown>;
  attachments?: BotMediaRef[];
  attachmentGrants?: BotAttachmentGrant[]; sourceIds?: string[];
  /** Host-only validated cross-direct delivery; never accepted from a UI sender. */
  contactSourceEventId?: string;
}
export interface BotMessagePage { items: BotMessage[]; hasMore: boolean; nextBefore?: number; }
export type BotTaskStatus = 'queued' | 'running' | 'waiting' | 'paused' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export interface BotTask {
  id: string; conversationId: string; companionId: string; companionName?: string; sourceEventId: string; goal: string;
  status: BotTaskStatus; attemptId: string; dshTaskId?: string; sessionId?: string;
  summary?: string; summaryIsPreview?: boolean; error?: string; createdAt: string; updatedAt: string; extra: Record<string, unknown>;
}
export type BotMemoryJobKind = 'prepare' | 'response' | 'capture' | 'projection' | 'mutation' | 'maintenance';
export interface BotMemoryJobInput { id?: string; key?: string; kind: BotMemoryJobKind; payload: Record<string, unknown>; }
export interface BotMemoryJob {
  id: string; kind: BotMemoryJobKind; domainKey: string; payload: Record<string, unknown>;
  status: 'queued' | 'running' | 'done' | 'failed'; attempts: number; createdAt: string; updatedAt: string; error?: string;
}
export interface BotMemoryJobClaim { job: BotMemoryJob; leaseToken: string; leaseUntil: number; }
