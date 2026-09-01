import { useLayoutEffect, type DependencyList, type RefObject } from 'react'
import { gsap } from 'gsap'

export const WORLDLINE_EASE = 'power3.out'

function motionAllowed(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** One current motion language shared by every Worldline surface. */
export function useWorldlineEntrance(
  scope: RefObject<HTMLElement>,
  dependencies: DependencyList,
): void {
  useLayoutEffect(() => {
    if (!motionAllowed() || scope.current === null) return
    const context = gsap.context(() => {
      gsap.fromTo('[data-worldline-hero]',
        { autoAlpha: 0, y: 24, scale: 0.985 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.75, ease: WORLDLINE_EASE, clearProps: 'transform' })
      gsap.fromTo('[data-worldline-reveal]',
        { autoAlpha: 0, y: 16 },
        { autoAlpha: 1, y: 0, duration: 0.56, stagger: 0.055, ease: WORLDLINE_EASE, clearProps: 'transform' })
      gsap.fromTo('[data-worldline-stagger] > *',
        { autoAlpha: 0, y: 12, scale: 0.99 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.48, stagger: 0.035, ease: WORLDLINE_EASE, clearProps: 'transform' })
      gsap.to('[data-worldline-orbit]', {
        rotate: 360,
        duration: 36,
        ease: 'none',
        repeat: -1,
      })
    }, scope)
    return () => { context.revert() }
  // The caller owns stable semantic transition keys rather than object identities.
  }, dependencies)
}

export function useWorldlinePulse(
  scope: RefObject<HTMLElement | SVGElement>,
  selector: string,
  dependencies: DependencyList,
): void {
  useLayoutEffect(() => {
    if (!motionAllowed() || scope.current === null) return
    const context = gsap.context(() => {
      gsap.fromTo(selector,
        { autoAlpha: 0, scale: 0.9, transformOrigin: 'center center' },
        { autoAlpha: 1, scale: 1, duration: 0.42, stagger: { each: 0.018, from: 'center' }, ease: 'back.out(1.5)', clearProps: 'transform' })
    }, scope)
    return () => { context.revert() }
  }, dependencies)
}

export function useWorldlineParallax(
  scope: RefObject<HTMLElement>,
  dependencies: DependencyList,
): void {
  useLayoutEffect(() => {
    const root = scope.current
    if (!motionAllowed() || root === null || window.matchMedia('(pointer: coarse)').matches) return
    const elements = [...root.querySelectorAll<HTMLElement>('[data-worldline-depth]')]
    const movers = elements.map(element => ({
      element,
      x: gsap.quickTo(element, 'x', { duration: 0.75, ease: WORLDLINE_EASE }),
      y: gsap.quickTo(element, 'y', { duration: 0.75, ease: WORLDLINE_EASE }),
      depth: Number(element.dataset['worldlineDepth'] ?? 1),
    }))
    const move = (event: PointerEvent): void => {
      const horizontal = event.clientX / window.innerWidth - 0.5
      const vertical = event.clientY / window.innerHeight - 0.5
      for (const mover of movers) {
        mover.x(horizontal * mover.depth * 12)
        mover.y(vertical * mover.depth * 10)
      }
    }
    const reset = (): void => { for (const mover of movers) { mover.x(0); mover.y(0) } }
    root.addEventListener('pointermove', move, { passive: true })
    root.addEventListener('pointerleave', reset)
    return () => {
      root.removeEventListener('pointermove', move)
      root.removeEventListener('pointerleave', reset)
      gsap.set(elements, { clearProps: 'transform' })
    }
  }, dependencies)
}

export function animateWorldlineNumber(element: HTMLElement | null): void {
  if (!motionAllowed() || element === null) return
  gsap.fromTo(element, { scale: 1.12, color: 'var(--dsw-alias-state-business-primary)' }, {
    scale: 1,
    color: 'var(--dsw-alias-label-primary)',
    duration: 0.5,
    ease: WORLDLINE_EASE,
    clearProps: 'transform,color',
  })
}
