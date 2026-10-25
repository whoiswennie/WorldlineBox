/**
 * 3D viewer toolbar (spec 3.5 minimal toolbar: 重置视角 / HDRI 环境切换 /
 * 统计开关 / 全屏；3D-09 HDRI 切换带缩略图, 光照强度可调).
 *
 * Rendered as a floating chrome chip row at the bottom of the viewport (same
 * `preview-chrome-fade` behavior as the other viewer chrome). All state lives
 * in the surface; this component is pure presentation.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createShellPortal } from '../ui/ShellStyleScope';
import { Select } from '../ui/primitives/Select';
import { useLocale } from '../i18n';
import { isImeKeyboardEvent } from '../ime-safe-dismiss';
import { Icon } from '../Icons';
import { LIGHT_INTENSITY_MAX, LIGHT_INTENSITY_MIN } from './light-intensity';
import {
  HDRI_PRESETS,
  resolveHdriPreviewUrl,
  type HdriPresetId,
} from './hdri-presets';
import { MODEL_DISPLAY_MODES, type ModelDisplayMode } from './model-display-mode';
import { formatByteSize, formatCount, type ModelStats } from './model-stats';

export interface ModelViewerToolbarProps {
  readonly presetId: HdriPresetId;
  readonly lightIntensity: number;
  readonly displayMode: ModelDisplayMode;
  readonly doubleSided: boolean;
  readonly statsVisible: boolean;
  readonly isFullscreen: boolean;
  onPresetChange(presetId: HdriPresetId): void;
  onLightIntensityChange(intensity: number): void;
  onDisplayModeChange(mode: ModelDisplayMode): void;
  onDoubleSidedChange(enabled: boolean): void;
  onToggleStats(): void;
  onResetView(): void;
  onFullscreen(): void;
}

export function ModelViewerToolbar(props: ModelViewerToolbarProps) {
  const { locale, t } = useLocale();
  const [hdriOpen, setHdriOpen] = useState(false);
  const [pickerRect, setPickerRect] = useState<{
    bottom: number;
    right: number;
    maxHeight: number;
    inModal: boolean;
  } | null>(null);
  const hdriPickerRef = useRef<HTMLDivElement>(null);
  const hdriTriggerRef = useRef<HTMLButtonElement>(null);
  const hdriListRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!hdriOpen || !hdriTriggerRef.current) {
      setPickerRect(null);
      return;
    }
    const update = () => {
      const rect = hdriTriggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const menuWidth = Math.min(300, Math.max(0, window.innerWidth - 16));
      const maxRight = Math.max(8, window.innerWidth - menuWidth - 8);
      const right = Math.min(Math.max(8, window.innerWidth - rect.right), maxRight);
      setPickerRect({
        bottom: window.innerHeight - rect.top + 8,
        right,
        maxHeight: Math.max(0, rect.top - 16),
        inModal: hdriTriggerRef.current?.closest('[role="dialog"]') != null,
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [hdriOpen]);

  // Close the HDRI picker on outside pointer-down / Escape.
  useEffect(() => {
    if (!hdriOpen) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (hdriPickerRef.current?.contains(target)) return;
      if (hdriListRef.current?.contains(target)) return;
      setHdriOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (isImeKeyboardEvent(event)) return;
      if (event.key === 'Escape') setHdriOpen(false);
    }
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [hdriOpen]);

  const activePreset =
    HDRI_PRESETS.find((preset) => preset.id === props.presetId) ?? null;

  const hdriPicker =
    hdriOpen && pickerRect
      ? createShellPortal(
          <div
            className="ui-menu-surface model-viewer-hdri-picker is-ported"
            data-modal-popover={pickerRect.inModal || undefined}
            ref={hdriListRef}
            role="listbox"
            style={{
              bottom: pickerRect.bottom,
              right: pickerRect.right,
              maxHeight: pickerRect.maxHeight,
            }}
          >
            {HDRI_PRESETS.map((preset) => {
              const preview = resolveHdriPreviewUrl(preset);
              const selected = preset.id === props.presetId;
              return (
                <button
                  aria-selected={selected}
                  className={`model-viewer-hdri-option${selected ? ' is-active' : ''}`}
                  key={preset.id}
                  onClick={() => {
                    props.onPresetChange(preset.id);
                    setHdriOpen(false);
                  }}
                  role="option"
                  tabIndex={0}
                  type="button"
                >
                  {preview !== null ? (
                    <img alt="" className="model-viewer-hdri-option-thumb" src={preview} />
                  ) : null}
                  <span className="model-viewer-hdri-option-name">
                    {preset.displayName[locale]}
                  </span>
                </button>
              );
            })}
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="model-viewer-toolbar preview-chrome-fade is-approach-toolbar">
      <div className="model-viewer-toolbar-item is-hdri" ref={hdriPickerRef}>
        <span className="model-viewer-toolbar-label">{t('viewer3d.hdri')}</span>
        <button
          aria-expanded={hdriOpen}
          aria-haspopup="listbox"
          aria-label={t('viewer3d.hdri')}
          className="model-viewer-hdri-trigger"
          onClick={() => setHdriOpen((open) => !open)}
          ref={hdriTriggerRef}
          tabIndex={0}
          type="button"
        >
          <span className="model-viewer-hdri-trigger-name">
            {activePreset?.displayName[locale] ?? t('viewer3d.hdri')}
          </span>
          <Icon name="chevron" size={12} />
        </button>
        {hdriPicker}
      </div>
      <div className="model-viewer-toolbar-item is-display-mode">
        <span className="model-viewer-toolbar-label">{t('viewer3d.displayMode')}</span>
        <Select
          appearance="inline"
          aria-label={t('viewer3d.displayMode')}
          onValueChange={(value) => {
            if (value !== props.displayMode) props.onDisplayModeChange(value as ModelDisplayMode);
          }}
          options={MODEL_DISPLAY_MODES.map((mode) => ({
            value: mode,
            label: t(`viewer3d.displayModes.${mode}`),
          }))}
          value={props.displayMode}
        />
      </div>
      <button
        aria-label={t('viewer3d.doubleSided')}
        aria-pressed={props.doubleSided}
        className={`model-viewer-toolbar-button is-labeled${props.doubleSided ? ' is-active' : ''}`}
        data-hover-tip={t('viewer3d.doubleSided')}
        onClick={() => props.onDoubleSidedChange(!props.doubleSided)}
        tabIndex={0}
        type="button"
      >
        {t('viewer3d.doubleSided')}
      </button>
      <label className="model-viewer-toolbar-item is-light-intensity">
        <span className="model-viewer-toolbar-label">{t('viewer3d.lightIntensity')}</span>
        <input
          aria-label={t('viewer3d.lightIntensity')}
          max={LIGHT_INTENSITY_MAX}
          min={LIGHT_INTENSITY_MIN}
          onChange={(event) => {
            const value = Number(event.currentTarget.value);
            if (Number.isFinite(value)) props.onLightIntensityChange(value);
          }}
          step={0.05}
          tabIndex={0}
          type="range"
          value={props.lightIntensity}
        />
        <span className="model-viewer-toolbar-value">
          {props.lightIntensity.toFixed(2)}
        </span>
      </label>
      <button
        aria-label={t('viewer3d.resetView')}
        className="model-viewer-toolbar-button"
        onClick={props.onResetView}
        tabIndex={0}
        data-hover-tip={t('viewer3d.resetView')}
        type="button"
      >
        <Icon name="fit-window" size={16} />
      </button>
      <button
        aria-label={t('viewer3d.toggleStats')}
        aria-pressed={props.statsVisible}
        className={`model-viewer-toolbar-button${props.statsVisible ? ' is-active' : ''}`}
        onClick={props.onToggleStats}
        tabIndex={0}
        data-hover-tip={t('viewer3d.toggleStats')}
        type="button"
      >
        <Icon name="info" size={16} />
      </button>
      <button
        aria-label={
          props.isFullscreen ? t('preview.exitFullscreen') : t('preview.fullscreen')
        }
        className="model-viewer-toolbar-button"
        onClick={props.onFullscreen}
        tabIndex={0}
        data-hover-tip={props.isFullscreen ? t('preview.exitFullscreen') : t('preview.fullscreen')}
        type="button"
      >
        <Icon name={props.isFullscreen ? 'fullscreen-exit' : 'fullscreen'} size={16} />
      </button>
    </div>
  );
}

/** Stats readout (3D-13): 三角面/顶点/材质数/贴图数/文件大小, viewport corner. */
export interface ModelViewerStatsOverlayProps {
  readonly stats: ModelStats;
  readonly byteSize: number;
  readonly locale: string;
}

export function ModelViewerStatsOverlay(props: ModelViewerStatsOverlayProps) {
  const { t } = useLocale();
  return (
    <dl className="model-viewer-stats" aria-label={t('viewer3d.statsAria')}>
      <div>
        <dt>{t('viewer3d.stats.triangles')}</dt>
        <dd>{formatCount(props.stats.triangles, props.locale)}</dd>
      </div>
      <div>
        <dt>{t('viewer3d.stats.vertices')}</dt>
        <dd>{formatCount(props.stats.vertices, props.locale)}</dd>
      </div>
      <div>
        <dt>{t('viewer3d.stats.materials')}</dt>
        <dd>{formatCount(props.stats.materials, props.locale)}</dd>
      </div>
      <div>
        <dt>{t('viewer3d.stats.textures')}</dt>
        <dd>{formatCount(props.stats.textures, props.locale)}</dd>
      </div>
      <div>
        <dt>{t('viewer3d.stats.fileSize')}</dt>
        <dd>{formatByteSize(props.byteSize)}</dd>
      </div>
    </dl>
  );
}
