// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SemanticSearchSettings, type EmbeddingCatalogApi } from '../../src/renderer/SemanticSearchSettings';
import { LocalTextEmbeddingSettings } from '../../src/renderer/LocalTextEmbeddingSettings';
import { LocaleProvider } from '../../src/renderer/i18n';
import { LOCAL_TEXT_EMBEDDING_MODEL, type LocalTextEmbeddingInstallStatus } from '../../src/shared/embedding/global-profile';
import { loadSemanticSearchPreferences, SEMANTIC_SEARCH_PREF_KEY } from '../../src/renderer/semantic-search-preferences';

let root: Root | undefined, container: HTMLDivElement | undefined;
const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
beforeEach(() => { window.localStorage.clear(); reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; vi.restoreAllMocks(); reactEnvironment.IS_REACT_ACT_ENVIRONMENT = false; });
function ready(patch: Partial<LocalTextEmbeddingInstallStatus> = {}): LocalTextEmbeddingInstallStatus {
  return { modelId: 'embeddinggemma-2-compact', phase: 'ready', installed: true, runtimeInstalled: true,
    revision: LOCAL_TEXT_EMBEDDING_MODEL.revision, installedRevision: LOCAL_TEXT_EMBEDDING_MODEL.revision,
    updateAvailable: false, bytesDownloaded: LOCAL_TEXT_EMBEDDING_MODEL.packageBytes, totalBytes: LOCAL_TEXT_EMBEDDING_MODEL.packageBytes,
    error: null, ...patch };
}
function fixture(status = ready()) {
  let currentStatus = status;
  const api = {
    embeddingLocalTextStatus: vi.fn(async () => ({ ok: true, value: currentStatus })),
    embeddingLocalTextInstall: vi.fn(async (input: { update?: boolean }) => { void input; return { ok: true, value: currentStatus = ready() }; }),
    embeddingLocalTextDelete: vi.fn(async () => ({ ok: true, value: currentStatus = ready() })),
    embeddingListServices: vi.fn(async () => ({ ok: false })),
    embeddingSaveService: vi.fn(async () => ({ ok: false })), embeddingDeleteService: vi.fn(async () => ({ ok: false })),
    embeddingProbeService: vi.fn(async () => ({ ok: false })), embeddingInstallStatus: vi.fn(async () => ({ ok: false })),
    embeddingInstall: vi.fn(async () => ({ ok: false })), embeddingUninstall: vi.fn(async () => ({ ok: false })),
    embeddingGetGlobalSettings: vi.fn(async () => ({ ok: false })), embeddingSaveGlobalSettings: vi.fn(async () => ({ ok: false })),
  } satisfies EmbeddingCatalogApi;
  return api;
}
async function mount(content: ReactNode, locale: 'zh-CN' | 'en' = 'zh-CN') {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(<LocaleProvider initialPreference={locale}>{content}</LocaleProvider>); });
}
function button(pattern: RegExp): HTMLButtonElement {
  const found = [...container!.querySelectorAll<HTMLButtonElement>('button')].find(item => pattern.test(item.textContent ?? ''));
  if (!found) throw new Error(`Missing button ${pattern}`); return found;
}
function expectNoConfiguration(api: ReturnType<typeof fixture>) {
  expect(container!.querySelector('select, [role="combobox"], input[type="text"], input[type="url"], input[type="password"], textarea')).toBeNull();
  for (const method of [api.embeddingListServices, api.embeddingSaveService, api.embeddingDeleteService, api.embeddingProbeService,
    api.embeddingGetGlobalSettings, api.embeddingSaveGlobalSettings, api.embeddingInstallStatus, api.embeddingInstall, api.embeddingUninstall]) {
    expect(method).not.toHaveBeenCalled();
  }
}

describe('fixed built-in multimodal embedding settings', () => {
  it.each(['zh-CN', 'en'] as const)('shows a single bundled Gemma with status and no model/API configuration in %s', async locale => {
    const api = fixture(); await mount(<SemanticSearchSettings servicesApi={api} section="models" />, locale);
    expect(container!.textContent).toContain('EmbeddingGemma');
    expect(container!.textContent).toContain('768');
    expect(container!.textContent).toContain(locale === 'zh-CN' ? '已就绪' : 'Ready');
    expect(container!.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    expect(api.embeddingLocalTextStatus).toHaveBeenCalledOnce();
    expect(api.embeddingLocalTextInstall).not.toHaveBeenCalled(); expect(api.embeddingLocalTextDelete).not.toHaveBeenCalled();
    expectNoConfiguration(api);
  });
  it('keeps the bundled identity when changing the asset search switch or batch size from old external preferences', async () => {
    window.localStorage.setItem(SEMANTIC_SEARCH_PREF_KEY, JSON.stringify({ version: 1, enabled: false, modelId: 'svc_retiredservice', pageSize: 50 }));
    const api = fixture(); await mount(<SemanticSearchSettings servicesApi={api} />);
    const toggle = container!.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(() => toggle.click()); await act(() => button(/^100$/u).click());
    expect(loadSemanticSearchPreferences()).toMatchObject({ enabled: true, pageSize: 100, modelId: 'embeddinggemma-2-compact' });
    expectNoConfiguration(api);
  });
  it('repairs a ready model from bundled resources even when no version update is pending', async () => {
    const api = fixture(); await mount(<LocalTextEmbeddingSettings api={api} />);
    await act(() => button(/验证与修复/u).click());
    expect(api.embeddingLocalTextInstall).toHaveBeenCalledWith({ update: true });
    expect(container!.textContent).toContain('已就绪'); expectNoConfiguration(api);
  });
  it('keeps maintenance local even when an old receipt reports an update', async () => {
    const api = fixture(ready({ updateAvailable: true })); await mount(<LocalTextEmbeddingSettings api={api} />);
    expect(container!.textContent).not.toContain('有新版本可用');
    await act(() => button(/验证与修复/u).click());
    expect(api.embeddingLocalTextInstall).toHaveBeenCalledWith({ update: true }); expectNoConfiguration(api);
  });
  it('clears runtime metadata while the immutable bundled model stays ready without any download', async () => {
    const api = fixture(); await mount(<LocalTextEmbeddingSettings api={api} />);
    await act(() => button(/删除本地模型|清理.*缓存/u).click());
    expect(api.embeddingLocalTextDelete).toHaveBeenCalledOnce(); expect(container!.textContent).toContain('已就绪');
    await act(() => button(/验证与修复/u).click());
    expect(api.embeddingLocalTextInstall).toHaveBeenCalledOnce(); expect(container!.textContent).toContain('已就绪');
    expectNoConfiguration(api);
  });
  it('shows a failed repair without marking the model ready or exposing provider response text', async () => {
    const api = fixture(ready({ installed: false, phase: 'missing' }));
    api.embeddingLocalTextInstall.mockRejectedValueOnce(new Error('PRIVATE_PROVIDER_URL_OR_KEY'));
    await mount(<LocalTextEmbeddingSettings api={api} />); await act(() => button(/验证与修复/u).click());
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain('无法连接模型管理服务');
    expect(container!.textContent).not.toContain('PRIVATE_PROVIDER_URL_OR_KEY'); expect(container!.textContent).toContain('资源异常');
    expectNoConfiguration(api);
  });
  it('automatically inspects shipped files without presenting an install or preparation step', async () => {
    const api = fixture(ready({ phase: 'missing', installed: false, runtimeInstalled: false }));
    await mount(<LocalTextEmbeddingSettings api={api} />);
    expect(api.embeddingLocalTextStatus).toHaveBeenCalledOnce();
    expect(api.embeddingLocalTextInstall).not.toHaveBeenCalled();
    expect(container!.textContent).not.toMatch(/准备本地模型|下载|安装模型/u);
    expect(container!.querySelector('[role="status"]')?.textContent).toBe('资源异常');
    expect(button(/清理运行缓存/u).disabled).toBe(true);
    expect(button(/验证与修复/u).classList.contains('ui-button')).toBe(true);
    expect(container!.querySelector('[title*="磁盘大小"]')?.textContent).toContain('697 MiB');
    expectNoConfiguration(api);
  });
  it('handles a failed automatic inspection without leaking backend error text or starting inference', async () => {
    const api = fixture(); api.embeddingLocalTextStatus.mockRejectedValueOnce(new Error('PRIVATE_FILE_PATH'));
    await mount(<LocalTextEmbeddingSettings api={api} />);
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain('内置资源暂不可用');
    expect(container!.textContent).not.toContain('PRIVATE_FILE_PATH');
    expect(api.embeddingLocalTextInstall).not.toHaveBeenCalled();
    expectNoConfiguration(api);
  });
});
