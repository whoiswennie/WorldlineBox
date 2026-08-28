import type { IconProps } from './icons/props.ts'

export interface BrandWordmarkProps extends IconProps {
  includeMark?: boolean | undefined
}

/** Worldline's compact brand lockup. */
export function BrandWordmark({ size = 22, className, includeMark = true }: BrandWordmarkProps) {
  return (
    <span
      className={className}
      aria-label="世界线"
      style={{ display: 'inline-flex', alignItems: 'center', gap: Math.max(6, Math.round(size * 0.3)) }}
    >
      {includeMark ? (
        <img
          src="/worldline-icon.png"
          width={size}
          height={size}
          alt=""
          aria-hidden="true"
          draggable={false}
          style={{ borderRadius: Math.max(5, Math.round(size * 0.25)) }}
        />
      ) : null}
      <span style={{ fontSize: Math.max(13, Math.round(size * 0.64)), fontWeight: 550, whiteSpace: 'nowrap' }}>
        世界线
      </span>
    </span>
  )
}
