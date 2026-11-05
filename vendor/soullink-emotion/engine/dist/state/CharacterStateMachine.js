export class CharacterStateMachine {
    state = "IDLE";
    enteredAt = 0;
    get current() {
        return this.state;
    }
    get phaseStartedAt() {
        return this.enteredAt;
    }
    transition(next, timeSeconds, force = false) {
        if (this.state === next && !force)
            return;
        this.state = next;
        this.enteredAt = timeSeconds;
    }
    reset(timeSeconds = 0) {
        this.state = "IDLE";
        this.enteredAt = timeSeconds;
    }
    elapsed(timeSeconds) {
        return Math.max(0, timeSeconds - this.enteredAt);
    }
}
