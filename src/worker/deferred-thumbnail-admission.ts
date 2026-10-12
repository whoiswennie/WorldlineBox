export interface DeferredThumbnailAdmissionToken {
  libraryId: string;
  generation: number;
}

/** Keep a startup thumbnail admission alive until an active viewport wave yields. */
export class DeferredThumbnailAdmission {
  private readonly generationByLibrary = new Map<string, number>();

  defer(token: DeferredThumbnailAdmissionToken): void {
    this.generationByLibrary.set(token.libraryId, token.generation);
  }

  /**
   * Take the pending admission only after the queue is idle and the library
   * generation still matches. A stale generation is discarded even if a queue
   * is active, so a later close/reopen cannot revive old work.
   */
  takeWhenIdle(
    libraryId: string,
    currentGeneration: number | undefined,
    queueActive: boolean,
  ): number | undefined {
    const pendingGeneration = this.generationByLibrary.get(libraryId);
    if (pendingGeneration === undefined) return undefined;
    if (pendingGeneration !== currentGeneration) {
      this.generationByLibrary.delete(libraryId);
      return undefined;
    }
    if (queueActive) return undefined;
    this.generationByLibrary.delete(libraryId);
    return pendingGeneration;
  }

  cancel(libraryId: string): void {
    this.generationByLibrary.delete(libraryId);
  }
}
