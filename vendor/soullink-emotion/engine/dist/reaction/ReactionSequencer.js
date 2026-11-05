import { scaleFACSFromNeutral } from "../facs/FACSUtils";
import { evaluateExpressionTimeline, getTimelineDuration } from "../expression/ExpressionTimeline";
export class ReactionSequencer {
    expression = null;
    startedAt = 0;
    start(expression, timeSeconds) {
        this.expression = expression;
        this.startedAt = timeSeconds;
    }
    reset() {
        this.expression = null;
        this.startedAt = 0;
    }
    get currentExpression() {
        return this.expression;
    }
    get duration() {
        return this.expression ? getTimelineDuration(this.expression.timeline) : 0;
    }
    elapsed(timeSeconds) {
        return Math.max(0, timeSeconds - this.startedAt);
    }
    isComplete(timeSeconds) {
        return Boolean(this.expression && this.elapsed(timeSeconds) >= this.duration);
    }
    evaluate(timeSeconds) {
        if (!this.expression)
            return {};
        return evaluateExpressionTimeline(this.expression.timeline, this.elapsed(timeSeconds));
    }
    hold(weight = 0.86) {
        return this.expression ? scaleFACSFromNeutral(this.expression.peakFACS, weight) : {};
    }
}
