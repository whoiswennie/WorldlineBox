import { useEffect, useRef, useState, type PointerEvent } from "react";

import { Button } from "./ui/primitives";
import { useT } from "./i18n";
import {
  clampByte,
  hexToHsv,
  hsvToHex,
  hsvToRgb,
  rgbToHsv,
  type ColorHsv,
} from "../shared/color-hsl";

const FALLBACK_HSV: ColorHsv = { hue: 0, saturation: 0, value: 0.533 };

function unitFromClient(
  element: HTMLElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  const x = rect.width <= 0 ? 0 : (clientX - rect.left) / rect.width;
  const y = rect.height <= 0 ? 0 : (clientY - rect.top) / rect.height;
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
  };
}

function hueCss(hue: number): string {
  return `hsl(${hue}, 100%, 50%)`;
}

export function ColorDraftPicker(props: {
  disabled: boolean;
  value: string;
  onChange: (hex: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const { disabled, value, onChange, onConfirm, onCancel } = props;
  const [hsv, setHsv] = useState<ColorHsv>(() => hexToHsv(value) ?? FALLBACK_HSV);
  const hsvRef = useRef(hsv);
  const panelRef = useRef<HTMLDivElement>(null);
  const rgb = hsvToRgb(hsv);

  useEffect(() => {
    hsvRef.current = hsv;
  }, [hsv]);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    const next = hexToHsv(value);
    if (!next) return;
    if (hsvToHex(hsvRef.current) === hsvToHex(next)) return;
    setHsv(next);
  }, [value]);

  function commit(next: ColorHsv) {
    hsvRef.current = next;
    setHsv(next);
    onChange(hsvToHex(next));
  }

  function beginDrag(
    event: PointerEvent<HTMLDivElement>,
    apply: (clientX: number, clientY: number) => void,
  ) {
    if (disabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    apply(event.clientX, event.clientY);
  }

  function onSvPointer(clientX: number, clientY: number, target: HTMLDivElement) {
    const unit = unitFromClient(target, clientX, clientY);
    commit({
      ...hsvRef.current,
      saturation: unit.x,
      value: 1 - unit.y,
    });
  }

  function onHuePointer(clientX: number, clientY: number, target: HTMLDivElement) {
    const unit = unitFromClient(target, clientX, clientY);
    commit({
      ...hsvRef.current,
      hue: unit.x * 360,
    });
  }

  function updateChannel(channel: "r" | "g" | "b", raw: string) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return;
    const nextRgb = { ...rgb, [channel]: clampByte(parsed) };
    commit(rgbToHsv(nextRgb));
  }

  return (
    <div
      className="dimension-color-picker"
      data-color-add-draft=""
      ref={panelRef}
      tabIndex={-1}
    >
      <div
        aria-label={t("filter.addCustomColor")}
        className="dimension-color-picker-sv"
        data-color-picker-sv=""
        onPointerDown={(event) => {
          beginDrag(event, (x, y) => onSvPointer(x, y, event.currentTarget));
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          onSvPointer(event.clientX, event.clientY, event.currentTarget);
        }}
        role="presentation"
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueCss(hsv.hue)})`,
        }}
      >
        <span
          className="dimension-color-picker-thumb"
          style={{
            left: `${hsv.saturation * 100}%`,
            top: `${(1 - hsv.value) * 100}%`,
          }}
        />
      </div>
      <div className="dimension-color-picker-hue-row">
        <span
          className="dimension-color-picker-preview"
          style={{ background: hsvToHex(hsv) }}
        />
        <div
          aria-label={t("filter.addCustomColor")}
          aria-valuemax={360}
          aria-valuemin={0}
          aria-valuenow={Math.round(hsv.hue)}
          className="dimension-color-picker-hue"
          data-color-picker-hue=""
          onPointerDown={(event) => {
            beginDrag(event, (x, y) => onHuePointer(x, y, event.currentTarget));
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            onHuePointer(event.clientX, event.clientY, event.currentTarget);
          }}
          role="slider"
        >
          <span
            className="dimension-color-picker-thumb"
            style={{ left: `${(hsv.hue / 360) * 100}%`, top: "50%" }}
          />
        </div>
      </div>
      <div className="dimension-color-picker-rgb">
        {(["r", "g", "b"] as const).map((channel) => (
          <label className="dimension-color-picker-channel" key={channel}>
            <span>{channel.toUpperCase()}</span>
            <input
              aria-label={channel.toUpperCase()}
              data-color-channel={channel}
              disabled={disabled}
              inputMode="numeric"
              max={255}
              min={0}
              onChange={(event) => updateChannel(channel, event.target.value)}
              type="number"
              value={rgb[channel]}
            />
          </label>
        ))}
      </div>
      <div className="dimension-color-picker-actions">
        <Button disabled={disabled} onClick={onCancel} size="sm">
          {t("common.cancel")}
        </Button>
        <Button disabled={disabled} onClick={onConfirm} size="sm" variant="primary">
          {t("common.confirm")}
        </Button>
      </div>
    </div>
  );
}
