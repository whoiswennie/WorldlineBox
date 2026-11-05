export function randomRange(range, random) {
    return range[0] + (range[1] - range[0]) * random();
}
export function pickOne(items, random) {
    return items[Math.floor(random() * items.length) % items.length];
}
