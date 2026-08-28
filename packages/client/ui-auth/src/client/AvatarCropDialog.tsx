import { useCallback, useEffect, useRef, useState } from 'react'
import css from './AvatarCropDialog.module.css'

type Point = { x: number; y: number }

export interface AvatarCropDialogProps {
  imageUrl: string
  onCancel: () => void
  onConfirm: (dataUrl: string) => void
}

const OUTPUT_SIZE = 512

function Glyph({ kind }: { kind: 'move' | 'minus' | 'plus' | 'reset' | 'close' | 'check' }) {
  const path = kind === 'move' ? <><path d="M12 3v18M3 12h18"/><path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/></>
    : kind === 'minus' ? <path d="M5 12h14"/>
      : kind === 'plus' ? <path d="M12 5v14M5 12h14"/>
        : kind === 'reset' ? <><path d="M4 7v5h5"/><path d="M5.5 16a8 8 0 1 0 .5-9l-2 5"/></>
          : kind === 'close' ? <path d="m6 6 12 12M18 6 6 18"/>
            : <path d="m5 12 4 4L19 6"/>
  return <svg viewBox="0 0 24 24" aria-hidden="true">{path}</svg>
}

export function AvatarCropDialog({ imageUrl, onCancel, onConfirm }: AvatarCropDialogProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const dragRef = useRef<{ pointerId: number; start: Point; origin: Point } | null>(null)
  const [natural, setNatural] = useState({ width: 1, height: 1 })
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 })

  const clampOffset = useCallback((next: Point, nextZoom = zoom): Point => {
    const viewport = viewportRef.current?.clientWidth || 360
    const baseScale = Math.max(viewport / natural.width, viewport / natural.height)
    const maxX = Math.max(0, (natural.width * baseScale * nextZoom - viewport) / 2)
    const maxY = Math.max(0, (natural.height * baseScale * nextZoom - viewport) / 2)
    return { x: Math.max(-maxX, Math.min(maxX, next.x)), y: Math.max(-maxY, Math.min(maxY, next.y)) }
  }, [natural.height, natural.width, zoom])

  const applyZoom = useCallback((value: number) => {
    const next = Math.max(1, Math.min(4, value))
    setZoom(next)
    setOffset(current => clampOffset(current, next))
  }, [clampOffset])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [onCancel])

  const viewport = viewportRef.current?.clientWidth || 360
  const baseScale = Math.max(viewport / natural.width, viewport / natural.height)

  const confirm = () => {
    const image = imageRef.current
    const cropViewport = viewportRef.current
    if (image === null || cropViewport === null || image.naturalWidth === 0) return
    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT_SIZE
    canvas.height = OUTPUT_SIZE
    const context = canvas.getContext('2d')
    if (context === null) return
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    const scale = Math.max(OUTPUT_SIZE / image.naturalWidth, OUTPUT_SIZE / image.naturalHeight) * zoom
    const ratio = OUTPUT_SIZE / cropViewport.clientWidth
    const width = image.naturalWidth * scale
    const height = image.naturalHeight * scale
    context.drawImage(image, (OUTPUT_SIZE - width) / 2 + offset.x * ratio, (OUTPUT_SIZE - height) / 2 + offset.y * ratio, width, height)
    onConfirm(canvas.toDataURL('image/webp', 0.9))
  }

  return <div
    className={css.backdrop}
    role="dialog"
    aria-modal="true"
    aria-label="调整头像取景"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}
  >
    <section className={css.dialog}>
      <header><span className={css.headerIcon}><Glyph kind="move" /></span><div><h3>调整头像取景</h3><p>拖动图片调整位置，滚轮或滑杆缩放；圆形区域是头像预览范围。</p></div><button type="button" aria-label="关闭头像裁剪" onClick={onCancel}><Glyph kind="close" /></button></header>
      <div className={css.body}>
        <div ref={viewportRef} className={css.viewport}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            dragRef.current = {
              pointerId: event.pointerId,
              start: { x: event.clientX, y: event.clientY },
              origin: offset,
            }
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current
            if (drag?.pointerId === event.pointerId) {
              setOffset(clampOffset({
                x: drag.origin.x + event.clientX - drag.start.x,
                y: drag.origin.y + event.clientY - drag.start.y,
              }))
            }
          }}
          onPointerUp={(event) => {
            dragRef.current = null
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
          }}
          onPointerCancel={() => { dragRef.current = null }}
          onWheel={(event) => { event.preventDefault(); applyZoom(zoom + (event.deltaY < 0 ? 0.12 : -0.12)) }}>
          <img ref={imageRef} src={imageUrl} alt="待裁剪头像" draggable={false}
            onLoad={(event) => {
              setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
              setZoom(1)
              setOffset({ x: 0, y: 0 })
            }}
            style={{
              width: natural.width * baseScale,
              height: natural.height * baseScale,
              transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${zoom})`,
            }} />
          <div className={css.safeArea} /><div className={css.horizontal} /><div className={css.vertical} />
        </div>
        <div className={css.zoom}><button type="button" aria-label="缩小" onClick={() => { applyZoom(zoom - 0.1) }}><Glyph kind="minus" /></button><input aria-label="头像缩放" type="range" min="1" max="4" step="0.01" value={zoom} onChange={(event) => { applyZoom(Number(event.target.value)) }} /><button type="button" aria-label="放大" onClick={() => { applyZoom(zoom + 0.1) }}><Glyph kind="plus" /></button><span>{Math.round(zoom * 100)}%</span></div>
        <footer><button type="button" className={css.reset} onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }) }}><Glyph kind="reset" />居中重置</button><div><button type="button" onClick={onCancel}>取消</button><button type="button" className={css.primary} onClick={confirm}><Glyph kind="check" />使用此取景</button></div></footer>
      </div>
    </section>
  </div>
}
