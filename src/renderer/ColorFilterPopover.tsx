import { useRef, useState } from "react";

import { Icon } from "./Icons";
import { Slider } from "./ui/primitives";
import { ColorDraftPicker } from "./ColorDraftPicker";
import { applyDimensionSelectionClick } from "./dimension-filter-selection";
import {
  MAX_CUSTOM_FILTER_COLORS,
  saveColorFilterPreferences,
  withCustomColorAdded,
  withCustomColorRemoved,
  type ColorFilterPreferences,
} from "./color-filter-preferences";
import {
  COLOR_PRESETS,
  parseColorFilterValues,
} from "../shared/color-filter-presets";
import { normalizeColorHex } from "../shared/color-hsl";
import { useT } from "./i18n";

const DEFAULT_DRAFT_HEX = "#888888";

export function ColorFilterPopover(props: {
  disabled: boolean;
  colorFilter: string;
  setColorFilter: (value: string) => void;
  excludeColorFilter: boolean;
  setExcludeColorFilter: (value: boolean) => void;
  colorSimilarity: number;
  setColorSimilarity: (value: number) => void;
  colorFilterPrefs: ColorFilterPreferences;
  onColorFilterPrefsChange: (prefs: ColorFilterPreferences) => void;
}) {
  const t = useT();
  const {
    disabled,
    colorFilter,
    setColorFilter,
    excludeColorFilter,
    setExcludeColorFilter,
    colorSimilarity,
    setColorSimilarity,
    colorFilterPrefs,
    onColorFilterPrefsChange,
  } = props;
  const [draftHex, setDraftHex] = useState<string | null>(null);
  const draftRestoreRef = useRef<string | null>(null);
  const selected = new Set(parseColorFilterValues(colorFilter));
  const canAddCustom =
    !disabled && colorFilterPrefs.customColors.length < MAX_CUSTOM_FILTER_COLORS;
  const draftToken = draftHex ? normalizeColorHex(draftHex) : null;

  function commitPrefs(next: ColorFilterPreferences) {
    saveColorFilterPreferences(next);
    onColorFilterPrefsChange(next);
  }

  function toggleToken(token: string, shiftKey: boolean) {
    const next = applyDimensionSelectionClick([...selected], token, shiftKey);
    setColorFilter(next.join(", "));
  }

  function persistSimilarity(value: number) {
    setColorSimilarity(value);
    commitPrefs({ ...colorFilterPrefs, similarity: value });
  }

  function applyDraftFilter(hex: string) {
    const normalized = normalizeColorHex(hex);
    if (!normalized) return;
    setDraftHex(normalized);
    setColorFilter(normalized);
  }

  function beginDraft() {
    draftRestoreRef.current = colorFilter;
    applyDraftFilter(DEFAULT_DRAFT_HEX);
  }

  function updateDraft(hex: string) {
    applyDraftFilter(hex);
  }

  function cancelDraft() {
    const restore = draftRestoreRef.current;
    draftRestoreRef.current = null;
    setDraftHex(null);
    if (restore !== null) setColorFilter(restore);
  }

  function confirmDraft() {
    if (!draftHex || disabled) return;
    const nextPrefs = withCustomColorAdded(colorFilterPrefs, draftHex);
    if (nextPrefs !== colorFilterPrefs) commitPrefs(nextPrefs);
    draftRestoreRef.current = null;
    setDraftHex(null);
  }

  return (
    <>
      <div
        aria-label={t("filter.dimColor")}
        className="dimension-color-presets"
        data-color-presets=""
        role="listbox"
      >
        {COLOR_PRESETS.map((preset) => (
          <button
            aria-label={t(`filter.color.${preset.id}`)}
            aria-selected={selected.has(preset.id)}
            className={`dimension-color-swatch${selected.has(preset.id) ? " is-active" : ""}${preset.kind === "neutral" ? " is-neutral" : ""}`}
            data-color={preset.id}
            disabled={disabled}
            key={preset.id}
            onClick={(event) => toggleToken(preset.id, event.shiftKey)}
            style={{ background: preset.swatch }}
            type="button"
          />
        ))}
      </div>
      <div className="dimension-color-row" data-color-custom="">
        {colorFilterPrefs.customColors.map((hex) => (
          <span className="dimension-color-custom" key={hex}>
            <button
              aria-label={hex}
              aria-selected={selected.has(hex)}
              className={`dimension-color-swatch${selected.has(hex) ? " is-active" : ""}`}
              data-color={hex}
              disabled={disabled}
              onClick={(event) => toggleToken(hex, event.shiftKey)}
              style={{ background: hex }}
              type="button"
            />
            <button
              aria-label={t("filter.removeCustomColor")}
              className="dimension-color-remove"
              disabled={disabled}
              onClick={() => {
                const nextPrefs = withCustomColorRemoved(colorFilterPrefs, hex);
                commitPrefs(nextPrefs);
                if (selected.has(hex)) {
                  setColorFilter(
                    parseColorFilterValues(colorFilter)
                      .filter((token) => token !== hex)
                      .join(", "),
                  );
                }
              }}
              type="button"
            >
              <Icon name="close" size={10} />
            </button>
          </span>
        ))}
        {draftToken ? (
          <span className="dimension-color-custom" data-color-draft="">
            <button
              aria-label={draftToken}
              aria-selected="true"
              className="dimension-color-swatch is-active"
              data-color={draftToken}
              disabled={disabled}
              style={{ background: draftToken }}
              type="button"
            />
          </span>
        ) : null}
        {draftHex === null && canAddCustom ? (
          <button
            aria-label={t("filter.addCustomColor")}
            className="dimension-color-add"
            data-color-add=""
            disabled={disabled}
            onClick={beginDraft}
            type="button"
          >
            <Icon name="plus" size={12} />
          </button>
        ) : null}
      </div>
      {draftHex ? (
        <ColorDraftPicker
          disabled={disabled}
          onCancel={cancelDraft}
          onChange={updateDraft}
          onConfirm={confirmDraft}
          value={draftHex}
        />
      ) : null}
      <div className="dimension-color-similarity" data-color-similarity="">
        <Slider
          disabled={disabled}
          label={t("filter.colorSimilarity")}
          max={100}
          min={0}
          onValueChange={persistSimilarity}
          showValue
          value={colorSimilarity}
          valueText={`${colorSimilarity}%`}
        />
      </div>
      <label className="dimension-filter-check">
        <input
          checked={excludeColorFilter}
          disabled={disabled || selected.size === 0}
          onChange={(event) => setExcludeColorFilter(event.target.checked)}
          type="checkbox"
        />
        {t("filter.exclude")}
      </label>
      <p className="dimension-filter-hint">{t("filter.shiftMultiSelectHint")}</p>
    </>
  );
}
