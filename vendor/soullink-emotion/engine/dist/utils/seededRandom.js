export function seededRandom(seed) {
    let value = Math.abs(Math.floor(seed)) || 1;
    return () => {
        value = (value * 9301 + 49297) % 233280;
        return value / 233280;
    };
}
