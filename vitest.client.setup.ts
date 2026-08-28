// jsdom does not currently expose PointerEvent. Keep pointer-driven component
// tests faithful by supplying the browser shape they use instead of skipping
// drag, capture, cancellation, and right-button interaction coverage.
if (typeof globalThis.PointerEvent === 'undefined' && typeof globalThis.MouseEvent !== 'undefined') {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number
    readonly pointerType: string
    readonly isPrimary: boolean

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 0
      this.pointerType = init.pointerType ?? ''
      this.isPrimary = init.isPrimary ?? false
    }
  }

  Object.defineProperty(globalThis, 'PointerEvent', {
    configurable: true,
    writable: true,
    value: TestPointerEvent,
  })
}
