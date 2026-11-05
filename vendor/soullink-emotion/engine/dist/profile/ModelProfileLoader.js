import { validateModelProfile } from "./ModelProfileSchema.js";
export async function loadModelProfile(url, fetcher = fetch) {
    const response = await fetcher(url);
    if (!response.ok) {
        throw new Error(`Failed to load model profile: ${response.status} ${response.statusText}`);
    }
    const raw = await response.json();
    const validation = validateModelProfile(raw);
    if (!validation.ok) {
        throw new Error(`Invalid model profile at ${url}: ${validation.errors[0]}`);
    }
    for (const w of validation.warnings) {
        console.warn(`[SoullinkProfile] ${w}`);
    }
    return {
        profile: validation.profile,
        sourceUrl: url
    };
}
