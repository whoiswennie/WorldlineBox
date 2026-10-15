import type { CSSProperties } from 'react';
import type { CompanionAvatarCrop } from '../../shared/companion-avatar-crop';

export type AvatarCrop = CompanionAvatarCrop;
export type AvatarImageSize = { width: number; height: number };
export const INITIAL_AVATAR_CROP: AvatarCrop = { centerX: .5, centerY: .5, zoom: 1, rotation: 0 };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export function avatarCropGeometry(size: AvatarImageSize, crop: AvatarCrop) {
  const turned = crop.rotation === 90 || crop.rotation === 270;
  const width = turned ? size.height : size.width, height = turned ? size.width : size.height;
  const side = Math.max(1, Math.round(Math.min(width, height) / clamp(crop.zoom, 1, 8)));
  return { width, height, side, left: clamp(Math.round(crop.centerX * width - side / 2), 0, width - side), top: clamp(Math.round(crop.centerY * height - side / 2), 0, height - side) };
}
export function clampAvatarCrop(size: AvatarImageSize, crop: AvatarCrop): AvatarCrop {
  const zoom = clamp(crop.zoom, 1, 8), geometry = avatarCropGeometry(size, { ...crop, zoom });
  const x = geometry.side / geometry.width / 2, y = geometry.side / geometry.height / 2;
  return { ...crop, zoom, centerX: clamp(crop.centerX, x, 1 - x), centerY: clamp(crop.centerY, y, 1 - y) };
}
export function rotateAvatarCrop(size: AvatarImageSize, crop: AvatarCrop): AvatarCrop {
  return clampAvatarCrop(size, { ...crop, centerX: 1 - crop.centerY, centerY: crop.centerX, rotation: ((crop.rotation + 90) % 360) as AvatarCrop['rotation'] });
}
/** Source image center in the rotated bounding box, scaled to the same square in every preview. */
export function avatarCropImageStyle(size: AvatarImageSize, crop: AvatarCrop, diameterFraction = 1): CSSProperties {
  const { width, height, side, left, top } = avatarCropGeometry(size, crop), factor = diameterFraction * 100 / side;
  return { width: `${size.width * factor}%`, height: `${size.height * factor}%`, left: `${50 + (width / 2 - left - side / 2) * factor}%`, top: `${50 + (height / 2 - top - side / 2) * factor}%`, transform: `translate(-50%, -50%) rotate(${crop.rotation}deg)` };
}
