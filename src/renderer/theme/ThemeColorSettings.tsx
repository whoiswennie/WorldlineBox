import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { useT } from '../i18n';
import { SettingsDisclosure } from '../ui/patterns';
import { Button, TextField } from '../ui/primitives';
import { useTheme } from './ThemeProvider';
import { cssColorToHex, sampleThemeColors, type SampledThemeColors } from './sample-theme-colors';
import { USER_THEME_NAME_MAX } from './user-themes';
import { ThemeMiniDialog } from './ThemeMiniDialog';
import { Icon } from '../Icons';

/**
 * Twelve fields cover every surface the islands app paints; everything else
 * (hover/pressed/selected, focus rings, danger tints, accent hover…) is
 * derived. `sample` names the live surface read from the real app when the
 * field has no override, so the swatch always shows what is on screen.
 */
export const CUSTOM_THEME_EDITOR_FIELDS = [
  { token: '--ui-island-backdrop', labelKey: 'settings.customThemeWindow', sample: 'backdrop' },
  { token: '--ui-surface-pane', labelKey: 'settings.customThemePane', sample: 'side' },
  { token: '--ui-island-canvas', labelKey: 'settings.customThemeMain', sample: 'canvas' },
  { token: '--ui-island-card', labelKey: 'settings.customThemeCard', sample: 'card' },
  { token: '--ui-surface-raised', labelKey: 'settings.customThemeRaised', sample: null },
  { token: '--ui-surface-canvas', labelKey: 'settings.customThemeCanvas', sample: null },
  { token: '--ui-island-border', labelKey: 'settings.customThemeBorder', sample: 'border' },
  { token: '--ui-content-primary', labelKey: 'settings.customThemePrimary', sample: null },
  { token: '--ui-content-secondary', labelKey: 'settings.customThemeSecondary', sample: null },
  { token: '--ui-action-accent', labelKey: 'settings.customThemeAccent', sample: null },
  { token: '--ui-island-select', labelKey: 'settings.customThemeAccentSoft', sample: 'select' },
  { token: '--ui-status-danger', labelKey: 'settings.customThemeDanger', sample: null },
] as const;

type EditorToken = (typeof CUSTOM_THEME_EDITOR_FIELDS)[number]['token'];
const HEX6 = /^#[0-9a-f]{6}$/iu;

/**
 * Custom themes editor. A custom theme starts as a copy of whatever is
 * showing (built-in profile + any overrides), is named, and then edited per
 * light/dark variant. Selecting, renaming and deleting live here and in the
 * theme grid; everything persists through ThemeProvider (user-themes.ts).
 */
export function ThemeColorSettings(): ReactNode {
  const t = useT();
  const {
    createUserTheme,
    customOverlay,
    customTheme,
    resetCustomTheme,
    resolved,
    setCustomTheme,
    themeProfile,
    themeRevision,
  } = useTheme();
  const editStartValues = useRef<Partial<Record<EditorToken, string>>>({});
  const [draftName, setDraftName] = useState('');
  const [naming, setNaming] = useState(false);
  const [sampled, setSampled] = useState<SampledThemeColors | null>(null);
  const [rootValues, setRootValues] = useState<Record<string, string>>({});
  // Re-read the live app after every theme change (next frame, once the
  // provider has written the tokens).
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const colors = sampleThemeColors();
      setSampled(colors);
      const root = getComputedStyle(document.documentElement);
      const over = colors?.side ?? '#ffffff';
      const next: Record<string, string> = {};
      for (const field of CUSTOM_THEME_EDITOR_FIELDS) {
        if (field.sample) continue;
        next[field.token] = cssColorToHex(root.getPropertyValue(field.token).trim() || 'transparent', over) ?? '#808080';
      }
      setRootValues(next);
    });
    return () => cancelAnimationFrame(frame);
  }, [customTheme, resolved, themeProfile, themeRevision]);
  const hasOverlay = Object.values(customOverlay.light).some(Boolean)
    || Object.values(customOverlay.dark).some(Boolean);

  // Edits are anonymous and live: they go to the unsaved overlay on top of
  // whatever theme is selected (built-in or named).
  function setCustomColor(token: EditorToken, value: string) {
    if (!HEX6.test(value)) return;
    setCustomTheme({
      ...customOverlay,
      [resolved]: {
        ...customOverlay[resolved],
        [token]: value,
        // The soft accent is one colour: selection wash + every accent-soft
        // surface (chips, pills, filter washes).
        ...(token === '--ui-island-select' ? { '--ui-action-accent-soft': value } : {}),
      },
    });
  }

  // Island surfaces come straight from the live app (same pixels); token
  // surfaces (text, accent, raised, borders) use the real tokens via var().
  const previewStyle = {
    '--tp-backdrop': sampled?.backdrop,
    '--tp-panel': sampled?.side,
    '--tp-canvas': sampled?.canvas,
    '--tp-card': sampled?.card,
    '--tp-edge': sampled?.border,
    '--tp-select': sampled?.select,
    '--tp-tool': sampled?.tool,
    '--tp-field': sampled?.field,
  } as CSSProperties;

  // The new theme is created (and selected, edits folded in) only on 完成.
  function saveAsTheme() {
    createUserTheme(draftName.trim() || t('settings.customThemeUntitled'));
    setDraftName('');
    setNaming(false);
  }

  return (
    <SettingsDisclosure
      hint={t('settings.customThemesHint')}
      title={t('settings.advancedColors')}
    >
      <span className="app-settings-custom-theme-meta">
        {t('settings.customThemeEditingMode', {
          mode: t(resolved === 'dark' ? 'settings.customThemeModeDark' : 'settings.customThemeModeLight'),
        })}
      </span>
      <div className="app-settings-custom-theme-grid">
        {CUSTOM_THEME_EDITOR_FIELDS.map((field) => {
          const override = customTheme[resolved][field.token];
          const live = field.sample ? sampled?.[field.sample] : rootValues[field.token];
          const current = override && HEX6.test(override) ? override : (live ?? '#808080');
          return (
            <label className="app-settings-custom-theme-row" key={field.token}>
              <span className="app-settings-custom-theme-label">
                {t(field.labelKey)}
              </span>
              <input
                aria-label={t(field.labelKey)}
                className="app-settings-custom-theme-swatch"
                onChange={(event) => setCustomColor(field.token, event.target.value)}
                onFocus={() => {
                  editStartValues.current[field.token] = current;
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return;
                  const original = editStartValues.current[field.token];
                  if (original !== undefined) setCustomColor(field.token, original);
                  event.currentTarget.blur();
                }}
                onBlur={() => {
                  delete editStartValues.current[field.token];
                }}
                type="color"
                value={current}
              />
            </label>
          );
        })}
      </div>
      <div
        aria-label={t('settings.customThemePreview')}
        className="app-settings-theme-preview"
      >
        <div className="app-settings-theme-preview-heading">
          {t('settings.customThemePreview')}
          {hasOverlay ? (
            <span
              className="app-settings-theme-modified-badge"
              role="img"
              aria-label={t('settings.customThemeModified')}
              data-hover-tip={t('settings.customThemeModified')}
            >
              <Icon name="settings" size={11} />
            </span>
          ) : null}
        </div>
        {/* Live miniature of the islands app, painted from the real theme
            tokens so every edit above shows up immediately. */}
        <div className="tp-window" aria-hidden="true" style={previewStyle}>
          <div className="tp-island tp-nav">
            <span className="tp-nav-row is-active"><i /><b /></span>
            <span className="tp-nav-row"><i /><b /></span>
            <span className="tp-nav-row"><i /><b className="is-short" /></span>
            <span className="tp-nav-label" />
            <span className="tp-nav-row"><i /><b className="is-short" /></span>
            <span className="tp-nav-row"><i /><b /></span>
          </div>
          <div className="tp-island tp-main">
            <div className="tp-toolstrip">
              <span className="tp-pill is-accent" />
              <span className="tp-pill" />
              <span className="tp-toolstrip-spacer" />
              <span className="tp-dot" />
              <span className="tp-dot" />
            </div>
            <div className="tp-cards">
              <div className="tp-card is-selected">
                <div className="tp-card-media" />
                <div className="tp-card-caption">
                  <strong>{t('settings.themePreviewAssetPlaceholder')}</strong>
                  <span>{t('settings.themePreviewAssetMeta')}</span>
                </div>
              </div>
              <div className="tp-card">
                <div className="tp-card-media is-alt" />
                <div className="tp-card-caption"><b /><i /></div>
              </div>
              <div className="tp-card">
                <div className="tp-card-media is-alt2" />
                <div className="tp-card-caption"><b /><i /></div>
              </div>
            </div>
          </div>
          <div className="tp-island tp-inspector">
            <div className="tp-inspector-thumb" />
            <strong className="tp-inspector-name">{t('settings.themePreviewAssetPlaceholder')}</strong>
            <span className="tp-inspector-meta">{t('settings.themePreviewAssetMeta')}</span>
            <span className="tp-inspector-section">{t('settings.themePreviewTags')}</span>
            <div className="tp-tags">
              <span className="tp-tag"><span className="tp-tag-dot" />{t('settings.themePreviewTagsValue')}</span>
              <span className="tp-tag is-alt"><span className="tp-tag-dot" />UI</span>
            </div>
            <div className="tp-stars">
              <i className="is-on" /><i className="is-on" /><i className="is-on" /><i /><i />
            </div>
            <span className="tp-inspector-section">{t('settings.themePreviewDescription')}</span>
            <span className="tp-description">{t('settings.themePreviewDescriptionValue')}</span>
          </div>
        </div>
      </div>
      <div className="app-settings-custom-theme-save">
        <Button
          className="app-settings-theme-reset"
          disabled={!hasOverlay}
          onClick={resetCustomTheme}
          size="sm"
        >
          {t('settings.customThemeReset')}
        </Button>
        <Button
          className="app-settings-theme-save-new"
          onClick={() => {
            setDraftName('');
            setNaming(true);
          }}
          size="sm"
          variant="primary"
        >
          {t('settings.customThemeCreate')}
        </Button>
      </div>
      {naming ? (
        <ThemeMiniDialog
          cancelLabel={t('settings.customThemeCancel')}
          confirmLabel={t('settings.customThemeDone')}
          dialogId="theme-new-name-dialog"
          onCancel={() => setNaming(false)}
          onConfirm={saveAsTheme}
          title={t('settings.customThemeNewTitle')}
        >
          <TextField
            aria-label={t('settings.customThemeName')}
            maxLength={USER_THEME_NAME_MAX}
            onChange={(event) => setDraftName(event.target.value)}
            placeholder={t('settings.customThemeUntitled')}
            value={draftName}
          />
        </ThemeMiniDialog>
      ) : null}
    </SettingsDisclosure>
  );
}
