import type { IconProps } from './icons/props.ts'

/**
 * Compatibility export for older UI contributors. The visible asset is the
 * authoritative Worldline application icon emitted by the Web build.
 */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <img
      src="/worldline-icon.png"
      width={size}
      height={size}
      className={className}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}
