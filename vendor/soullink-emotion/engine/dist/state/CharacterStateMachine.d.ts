import type { CharacterState } from "./CharacterState";
export declare class CharacterStateMachine {
    private state;
    private enteredAt;
    get current(): CharacterState;
    get phaseStartedAt(): number;
    transition(next: CharacterState, timeSeconds: number, force?: boolean): void;
    reset(timeSeconds?: number): void;
    elapsed(timeSeconds: number): number;
}
