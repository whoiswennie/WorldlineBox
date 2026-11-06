// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AiConfigDialog, type AiConfigDialogProps } from '../../src/renderer/AiConfigDialog';
import { DEFAULT_AI_ANALYSIS_SETTINGS } from '../../src/shared/ai-analysis-settings';
import { LocaleProvider } from '../../src/renderer/i18n';

let root: Root, container: HTMLDivElement;
const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
beforeEach(() => { env.IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(() => root.unmount()); container.remove(); env.IS_REACT_ACT_ENVIRONMENT = false; });
function fixture(patch: Partial<AiConfigDialogProps> = {}): AiConfigDialogProps {
  return { open: true, variant: 'embedded', profiles: [{ id: 'a', name: '主模型', model: 'model-a', apiFormat: 'openai_chat', baseUrl: 'https://fixture.invalid', hasCredential: true },
    { id: 'b', name: '备用模型', model: 'model-b', apiFormat: 'openai_chat', baseUrl: 'https://fixture.invalid', hasCredential: true }],
    activeProfileId: 'a', profileDraftId: 'b', profileName: '备用模型', apiFormat: 'openai_chat', model: 'model-b', baseUrl: 'https://fixture.invalid', apiKey: '', hasKey: true,
    languages: ['zh-CN'], concurrencyLimit: 16, maxAnalysisImageEdgePx: 2048, descriptionEnabled: true, tagsEnabled: true, ratingEnabled: true, forceExistingTags: false,
    analysisSettings: DEFAULT_AI_ANALYSIS_SETTINGS, disclaimerAccepted: true, autoAnalyzeEnabled: false, connectionState: 'idle',
    onApiKeyChange: vi.fn(), onProfileNameChange: vi.fn(), onNewProfile: vi.fn(), onSelectProfile: vi.fn(), onActivateProfile: vi.fn(), onDeleteProfile: vi.fn(), onClearCredential: vi.fn(),
    onApiFormatChange: vi.fn(), onModelChange: vi.fn(), onBaseUrlChange: vi.fn(), onLanguagesChange: vi.fn(), onConcurrencyLimitChange: vi.fn(), onMaxAnalysisImageEdgePxChange: vi.fn(),
    onDescriptionEnabledChange: vi.fn(), onTagsEnabledChange: vi.fn(), onRatingEnabledChange: vi.fn(), onForceExistingTagsChange: vi.fn(), onAnalysisSettingsChange: vi.fn(),
    onDisclaimerAcceptedChange: vi.fn(), onAutoAnalyzeEnabledChange: vi.fn(), onClose: vi.fn(), onSave: vi.fn(), onSaveAnalysis: vi.fn(async () => true),
    onTestConnection: vi.fn(async () => ({ success: true })), onFetchModels: vi.fn(async () => ({ models: [] })), ...patch };
}
async function render(props: AiConfigDialogProps) { await act(async () => { root.render(<LocaleProvider initialPreference="zh-CN"><AiConfigDialog {...props} /></LocaleProvider>); }); }
function button(text: string) { return [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === text)!; }

it('distinguishes the active connection from the saved draft and keeps save/test/activate beside the connection', async () => {
  const props = fixture(); await render(props);
  expect(container.querySelector('.ai-config-current-profile')?.textContent).toContain('当前使用：主模型 · model-a');
  expect(container.querySelector('.ai-config-draft-status')?.textContent).toBe('配置已保存');
  expect(button('保存配置').disabled).toBe(true); expect(button('设为当前').disabled).toBe(false);
  await act(() => button('测试连接').click()); expect(props.onTestConnection).toHaveBeenCalledOnce(); expect(props.onSave).not.toHaveBeenCalled();
  await act(() => button('设为当前').click()); expect(props.onActivateProfile).toHaveBeenCalledWith('b');
  expect(button('保存配置').closest('section')).toBe(container.querySelector('.ai-config-connection-section'));
  expect(button('保存分析选项').closest('details')).toBe(container.querySelector('.ai-config-asset-options'));
});

it('makes unsaved changes visible, prevents activation and protects them while switching profiles', async () => {
  const props = fixture({ model: 'changed-model' }); await render(props);
  expect(container.querySelector('.ai-config-draft-status')?.textContent).toBe('有未保存的修改');
  expect(button('设为当前').disabled).toBe(true); expect(button('保存配置').disabled).toBe(false);
  await act(() => button('新建').click()); expect(props.onNewProfile).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('切换配置会放弃这些修改');
  await act(() => button('继续编辑').click()); expect(container.querySelector('[role="alert"]')).toBeNull(); expect(props.onNewProfile).not.toHaveBeenCalled();
  await act(() => button('新建').click()); await act(() => button('放弃修改并切换').click()); expect(props.onNewProfile).toHaveBeenCalledOnce();
});

it('waits for a connection save and saves analysis separately without activating or testing the connection', async () => {
  let resolve!: () => void;
  const props = fixture({ model: 'changed-model', onSave: vi.fn(() => new Promise<void>(done => { resolve = done; })) }); await render(props);
  await act(() => button('保存配置').click()); expect(button('正在保存…').disabled).toBe(true);
  expect(container.querySelector<HTMLFieldSetElement>('fieldset')?.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('#ai-config-profile')?.disabled).toBe(true);
  await act(() => button('正在保存…').click()); expect(props.onSave).toHaveBeenCalledOnce();
  await act(async () => { resolve(); }); expect(button('保存配置').disabled).toBe(false);
  await act(() => button('保存分析选项').click()); expect(props.onSaveAnalysis).toHaveBeenCalledOnce(); expect(props.onSave).toHaveBeenCalledOnce();
  expect(props.onActivateProfile).not.toHaveBeenCalled(); expect(props.onTestConnection).not.toHaveBeenCalled();
  expect(container.querySelector('.ai-config-analysis-actions')?.textContent).toContain('分析选项已保存');
});

it('protects a new draft after editing the name or model even before entering a key', async () => {
  const props = fixture({ profileDraftId: null, profileName: '新配置', apiKey: '', hasKey: false }); await render(props);
  await render({ ...props, profileName: '尚未保存的配置', model: 'new-model' });
  await act(() => button('新建').click()); expect(props.onNewProfile).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('未保存');
});

it('keeps the draft editable and reports a rejected save without an unhandled promise', async () => {
  const props = fixture({ model: 'changed-model', onSave: vi.fn(async () => { throw new Error('injected persistence failure'); }) }); await render(props);
  await act(() => button('保存配置').click());
  expect(container.textContent).toContain('连接配置保存失败'); expect(button('保存配置').disabled).toBe(false);
  expect(container.querySelector('.ai-config-draft-status')?.textContent).toContain('未保存');
  expect(container.querySelector<HTMLFieldSetElement>('fieldset')?.disabled).toBe(false);
});

it('reports analysis persistence failure without claiming it was saved', async () => {
  await render(fixture({ onSaveAnalysis: async () => false })); await act(() => button('保存分析选项').click());
  expect(container.querySelector('.ai-config-analysis-actions')?.textContent).toContain('保存未完成');
  expect(container.querySelector('.ai-config-analysis-actions')?.textContent).not.toContain('已保存');
});
