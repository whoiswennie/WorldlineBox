export class NullAudioLevelAnalyzer {
    getLevel() {
        return 0;
    }
    getPeak() {
        return 0;
    }
    isAvailable() {
        return false;
    }
    available() {
        return false;
    }
    reset() {
        // Intentionally empty: this analyzer never exposes a live source.
    }
}
