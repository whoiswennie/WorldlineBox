// @vitest-environment happy-dom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { OperationControls } from '../../src/renderer/launcher/OperationControls';
import { LocaleProvider } from '../../src/renderer/i18n';
import type { DshOperation } from '../../src/shared/dsh-launcher';

const operation: DshOperation = { id:'install',kind:'runtime.install',label:'Install DSH',status:'running',phase:'resolving official dependencies',progress:20,startedAt:new Date().toISOString(),
  download:{transferredBytes:1234,speedBytesPerSecond:0,canPause:true,paused:false} };
const render = (value: DshOperation) => renderToStaticMarkup(createElement(LocaleProvider, { initialPreference:'zh-CN',children:createElement(OperationControls,{operation:value,run:async()=>({ok:true as const})}) }));
it('shows activity for an unknown transfer total and counted dependencies for prefetch',()=>{
  const resolving = render(operation);
  expect(resolving).toContain('解析依赖清单'); expect(resolving).toContain('ui-progress--indeterminate'); expect(resolving).not.toContain('20%');
  const downloading = render({...operation,phase:'prefetching dependency archives:5/30',progress:30});
  expect(downloading).toContain('依赖包 5/30'); expect(downloading).toContain('下载并校验依赖包');
  expect(downloading).toContain('17%');
});
