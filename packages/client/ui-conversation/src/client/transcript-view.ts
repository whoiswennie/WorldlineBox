import {
  createSnapshotStore, type SettingsScope, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  DEFAULT_TRANSCRIPT_VIEW_MODE, TRANSCRIPT_VIEW_FIELD,
  type ConversationSettings, type TranscriptViewMode,
} from '../submission-settings.ts'

/** Host-backed completed-turn transcript presentation policy. */
export class TranscriptViewPolicy {
  /**
   * Current mode.
   * @returns The resulting value.
   */
  readonly mode: SnapshotStore<TranscriptViewMode> =
    createSnapshotStore(DEFAULT_TRANSCRIPT_VIEW_MODE)

  constructor(private readonly host: SettingsScope<ConversationSettings>) {
    host.subscribe(() => { this.adopt() })
    this.adopt()
  }

  /**
   * Set mode.
   * @param mode - mode value.
   */
  setMode(mode: TranscriptViewMode): void {
    if (this.mode.getSnapshot() === mode) return
    this.mode.set(mode)
    void this.host.set(TRANSCRIPT_VIEW_FIELD, mode)
  }

  private adopt(): void {
    const section = this.host.getSnapshot().value
    if (section === undefined || this.mode.getSnapshot() === section.transcriptView) return
    this.mode.set(section.transcriptView)
  }
}
