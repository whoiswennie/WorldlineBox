import { facsKeys } from "../facs/FACSUtils";
import { detectCapabilities } from "./CapabilityDetector";
/** Standard Cubism 4 parameter ids used by the canonical mapping table. */
const STANDARD_IDS = new Set([
    "ParamAngleX",
    "ParamAngleY",
    "ParamAngleZ",
    "ParamEyeLOpen",
    "ParamEyeROpen",
    "ParamEyeBallX",
    "ParamEyeBallY",
    "ParamEyeLSmile",
    "ParamEyeRSmile",
    "ParamMouthOpenY",
    "ParamMouthForm",
    "ParamCheek",
    "ParamBreath",
    "ParamBodyAngleX",
    "ParamBodyAngleY",
    "ParamBodyAngleZ",
    "ParamBrowLY",
    "ParamBrowRY",
    "ParamBrowLAngle",
    "ParamBrowRAngle",
    "ParamBrowLForm",
    "ParamBrowRForm"
]);
/** Membership check over the standard Cubism parameter ids. */
export function isStandardId(id) {
    return STANDARD_IDS.has(id);
}
/** FACS key -> the ModelCapabilities flag it contributes to, when applicable. */
const FACS_KEY_CAPABILITY = {
    headX: "headControl",
    headY: "headControl",
    headZ: "headControl",
    bodyX: "bodyControl",
    bodyY: "bodyControl",
    bodyZ: "bodyControl",
    eyeBlinkL: "eyeBlink",
    eyeBlinkR: "eyeBlink",
    eyeSmile: "eyeSmile",
    gazeX: "gazeControl",
    gazeY: "gazeControl",
    mouthOpen: "mouthOpen",
    mouthSmile: "mouthSmile",
    browInnerUp: "browControl",
    browOuterUp: "browControl",
    browDown: "browControl",
    blush: "blush",
    tear: "tear",
    sweat: "sweat",
    breath: "breath"
};
function ruleTargets(rule) {
    return rule.targets?.length ? rule.targets : rule.target ? [rule.target] : [];
}
function confidenceFor(source, targets) {
    if (source === "standard-group" || source === "standard-id")
        return "high";
    if (source === "unknown") {
        return targets.length > 0 && targets.every(isStandardId) ? "high" : "low";
    }
    if (source === "name-match")
        return "medium";
    if (source === "derived")
        return "medium";
    // "llm" and any residual case
    return "low";
}
function normalizeText(text) {
    return text.toLowerCase().replace(/[\s_-]+/g, "");
}
/**
 * Best-effort hint: guess which FACS key an unmapped CDI parameter probably
 * corresponds to, from simple name needles over id + name + groupName.
 * Returns undefined when nothing matches. Hint only — never authoritative.
 */
export function guessFacsKey(param) {
    const text = normalizeText(`${param.id} ${param.name} ${param.groupName}`);
    if (text.includes("blush") || text.includes("cheek") || text.includes("脸红")) {
        return "blush";
    }
    if (text.includes("tear") || text.includes("泪"))
        return "tear";
    if (text.includes("sweat") || text.includes("汗"))
        return "sweat";
    if (text.includes("eyeballx") || text.includes("眼球x"))
        return "gazeX";
    if (text.includes("anglex") || text.includes("角度x"))
        return "headX";
    if (text.includes("angley") || text.includes("角度y"))
        return "headY";
    if (text.includes("mouthopen") || text.includes("张开"))
        return "mouthOpen";
    if (text.includes("breath") || text.includes("呼吸"))
        return "breath";
    return undefined;
}
/**
 * Compute a response-only adaptation-coverage diagnostic for a model profile.
 * Pure: never mutates inputs and never touches disk. This must never be written
 * into soullink.profile.json.
 */
export function computeAdaptationCoverage(profile, params, input) {
    const parameterMap = profile.parameterMap ?? {};
    const provenance = input.provenance ?? {};
    // usedTargets = union of standard/custom mapping targets and declarative
    // private-emotion targets. A parameter driven by privateEmotionMap is not
    // actually unmapped and should not be offered as a leftover in devtools.
    const usedTargets = new Set();
    for (const rule of Object.values(parameterMap)) {
        if (!rule)
            continue;
        for (const target of ruleTargets(rule))
            usedTargets.add(target);
    }
    for (const rule of Object.values(profile.customParams ?? {})) {
        if (!rule)
            continue;
        for (const target of ruleTargets(rule))
            usedTargets.add(target);
    }
    for (const mapping of Object.values(profile.privateEmotionMap ?? {})) {
        if (mapping.target)
            usedTargets.add(mapping.target);
        for (const target of mapping.targets ?? [])
            usedTargets.add(target);
    }
    const perKey = [];
    const unmappedKeys = [];
    const lowConfidenceKeys = [];
    let mappedKeyCount = 0;
    for (const key of facsKeys) {
        const capability = FACS_KEY_CAPABILITY[key];
        const rule = parameterMap[key];
        if (rule) {
            const targets = ruleTargets(rule);
            const source = provenance[key] ?? "unknown";
            const confidence = confidenceFor(source, targets);
            mappedKeyCount += 1;
            perKey.push({ key, status: "mapped", source, targets, confidence, capability });
            // lowConfidenceKeys tracks mapped-but-shaky keys; unmapped keys live in
            // unmappedKeys so the two arrays stay disjoint and each is meaningful.
            if (confidence === "low")
                lowConfidenceKeys.push(key);
        }
        else {
            perKey.push({
                key,
                status: "unmapped",
                source: "unmapped",
                targets: [],
                confidence: "low",
                capability
            });
            unmappedKeys.push(key);
        }
    }
    const unmappedCdiParameters = [];
    let usedCdiParameterCount = 0;
    for (const param of params) {
        if (usedTargets.has(param.id)) {
            usedCdiParameterCount += 1;
            continue;
        }
        unmappedCdiParameters.push({
            id: param.id,
            name: param.name,
            groupId: param.groupId,
            groupName: param.groupName,
            guessedFacsKey: guessFacsKey(param)
        });
    }
    const capabilities = profile.capabilities ?? detectCapabilities(profile);
    const provider = input.provider ?? profile.autoProfile?.provider ?? "unknown";
    return {
        schemaVersion: 1,
        modelDir: input.modelDir,
        facsKeyCount: facsKeys.length,
        mappedKeyCount,
        perKey,
        unmappedKeys,
        lowConfidenceKeys,
        cdiParameterCount: params.length,
        usedCdiParameterCount,
        unmappedCdiParameters,
        capabilities,
        provider
    };
}
