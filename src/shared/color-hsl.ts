/** sRGB hex → HSL. Hue is undefined for zero-chroma greys and stored as 0. */

export interface ColorHsl {
  hue: number;
  saturation: number;
  lightness: number;
}

export interface ColorRgb {
  r: number;
  g: number;
  b: number;
}

export interface ColorHsv {
  hue: number;
  saturation: number;
  value: number;
}

const HEX6 = /^#[0-9A-Fa-f]{6}$/u;

export function isColorHex(value: string): boolean {
  return HEX6.test(value);
}

export function normalizeColorHex(value: string): string | null {
  if (!HEX6.test(value)) return null;
  return value.toUpperCase();
}

export function hexToHsl(hex: string): ColorHsl {
  const normalized = normalizeColorHex(hex);
  if (!normalized) throw new Error("Colour must be a six-digit hex value.");
  const red = Number.parseInt(normalized.slice(1, 3), 16) / 255;
  const green = Number.parseInt(normalized.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(normalized.slice(5, 7), 16) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta > 0) {
    if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  if (hue < 0) hue += 360;
  const lightness = (maximum + minimum) / 2;
  const saturation =
    delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  return {
    hue: Number(hue.toFixed(6)),
    saturation: Number(saturation.toFixed(6)),
    lightness: Number(lightness.toFixed(6)),
  };
}

export function hueDelta(left: number, right: number): number {
  const delta = Math.abs(left - right) % 360;
  return delta > 180 ? 360 - delta : delta;
}

export function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
}

export function hexToRgb(hex: string): ColorRgb | null {
  const normalized = normalizeColorHex(hex);
  if (!normalized) return null;
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

export function rgbToHex(rgb: ColorRgb): string {
  const r = clampByte(rgb.r).toString(16).padStart(2, "0");
  const g = clampByte(rgb.g).toString(16).padStart(2, "0");
  const b = clampByte(rgb.b).toString(16).padStart(2, "0");
  return `#${r}${g}${b}`.toUpperCase();
}

export function rgbToHsv(rgb: ColorRgb): ColorHsv {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return {
    hue,
    saturation: max === 0 ? 0 : delta / max,
    value: max,
  };
}

export function hsvToRgb(hsv: ColorHsv): ColorRgb {
  const hue = ((hsv.hue % 360) + 360) % 360;
  const saturation = Math.min(1, Math.max(0, hsv.saturation));
  const value = Math.min(1, Math.max(0, hsv.value));
  const chroma = value * saturation;
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = value - chroma;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) {
    r = chroma;
    g = x;
  } else if (hue < 120) {
    r = x;
    g = chroma;
  } else if (hue < 180) {
    g = chroma;
    b = x;
  } else if (hue < 240) {
    g = x;
    b = chroma;
  } else if (hue < 300) {
    r = x;
    b = chroma;
  } else {
    r = chroma;
    b = x;
  }
  return {
    r: clampByte((r + m) * 255),
    g: clampByte((g + m) * 255),
    b: clampByte((b + m) * 255),
  };
}

export function hexToHsv(hex: string): ColorHsv | null {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHsv(rgb) : null;
}

export function hsvToHex(hsv: ColorHsv): string {
  return rgbToHex(hsvToRgb(hsv));
}
