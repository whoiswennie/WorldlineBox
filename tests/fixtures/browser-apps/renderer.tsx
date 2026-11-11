import { createRoot } from 'react-dom/client';
import { LocaleProvider } from '../../../src/renderer/i18n';
import { BotWorkspace } from '../../../src/renderer/companion-bot/BotWorkspace';
import { botUiSharedLauncher } from '../bot-ui-shared-launcher';
import type { WorldlineBoxBotApi } from '../../../src/shared/companion-bot';
import type { WorldlineBoxBrowserApi } from '../../../src/shared/browser';
import '../../../src/renderer/styles.css';
import '../../../src/renderer/ui/tokens.css';
import '../../../src/renderer/ui/ui.css';

const bridge = Reflect.get(window, 'browserAppsFixture') as { browser: WorldlineBoxBrowserApi; bot: WorldlineBoxBotApi };
createRoot(document.getElementById('root')!).render(<LocaleProvider initialPreference="zh-CN"><BotWorkspace api={bridge.bot} browserApi={bridge.browser} launcherApi={botUiSharedLauncher()} onOpenSettings={() => undefined} /></LocaleProvider>);
