import { clamp } from "../utils/clamp";
import { applyFallbackStrategies } from "./FallbackStrategy";
import { deriveNeutralParams } from "./deriveProfileDefaults";
import { effectiveSchemaVersion } from "./ModelProfileSchema";
import { transformRuleValue } from "./ParameterTransform";
export class ModelProfileAdapter {
    profile;
    constructor(profile) {
        this.profile = profile;
    }
    setProfile(profile) {
        this.profile = profile;
    }
    getProfile() {
        return this.profile;
    }
    apply(facs, customChannels) {
        if (effectiveSchemaVersion(this.profile) < 2) {
            return this.applyLegacy(facs);
        }
        return this.applyV2(facs, customChannels ?? {});
    }
    applyLegacy(facs) {
        const normalized = applyFallbackStrategies(facs, this.profile);
        const effectiveNeutral = this.profile.neutralParams ?? deriveNeutralParams(this.profile);
        const result = { ...effectiveNeutral };
        for (const key of Object.keys(this.profile.parameterMap)) {
            const rule = this.profile.parameterMap[key];
            if (!rule)
                continue;
            const raw = normalized[key] ?? 0;
            const targets = this.getTargets(rule);
            if (targets.length === 0)
                continue;
            const mapped = this.mapValue(raw, rule, false);
            for (const target of targets) {
                if (rule.mode === "set" || result[target] === undefined) {
                    result[target] = this.clampRuleValue(mapped, rule);
                }
                else {
                    result[target] += mapped;
                    result[target] = this.clampRuleValue(result[target], rule);
                }
            }
        }
        return result;
    }
    applyV2(facs, customChannels) {
        const normalized = applyFallbackStrategies(facs, this.profile);
        const effectiveNeutral = this.profile.neutralParams ?? deriveNeutralParams(this.profile);
        const result = { ...effectiveNeutral };
        const contributions = [];
        for (const key of Object.keys(this.profile.parameterMap)) {
            const rule = this.profile.parameterMap[key];
            if (!rule)
                continue;
            const raw = normalized[key] ?? 0;
            const mapped = transformRuleValue(raw, rule);
            for (const target of this.getTargets(rule)) {
                contributions.push({ target, rule, mapped });
            }
        }
        for (const [channel, rule] of Object.entries(this.profile.customParams ?? {})) {
            const raw = customChannels[channel] ?? 0;
            const mapped = transformRuleValue(raw, rule);
            for (const target of this.getTargets(rule)) {
                contributions.push({ target, rule, mapped });
            }
        }
        for (const contribution of contributions) {
            if (contribution.rule.mode === "add" || contribution.rule.mode === "subtract")
                continue;
            result[contribution.target] = this.clampRuleValue(contribution.mapped, contribution.rule);
        }
        for (const contribution of contributions) {
            if (contribution.rule.mode !== "add" && contribution.rule.mode !== "subtract")
                continue;
            result[contribution.target] = this.clampRuleValue((result[contribution.target] ?? 0) + contribution.mapped, contribution.rule);
        }
        return result;
    }
    getTargets(rule) {
        if (rule.targets?.length)
            return rule.targets;
        return rule.target ? [rule.target] : [];
    }
    mapValue(value, rule, shouldClamp = true) {
        const scale = rule.scale ?? 1;
        const offset = rule.offset ?? 0;
        let mapped = value;
        if (rule.mode === "inverse") {
            mapped = 1 - value * scale;
        }
        else if (rule.mode === "subtract") {
            mapped = -(value * scale);
        }
        else {
            mapped = value * scale;
        }
        mapped += offset;
        return shouldClamp ? this.clampRuleValue(mapped, rule) : mapped;
    }
    clampRuleValue(value, rule) {
        return clamp(value, rule.min, rule.max);
    }
}
