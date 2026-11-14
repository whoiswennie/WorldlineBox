import { ipcRenderer } from 'electron';
import { MOBILE_ACCESS_CHANNEL, type MobileSettingsRequest, type MobileSettingsResult, type WorldlineBoxMobileAccessApi } from '../../shared/mobile-access';

export const mobileAccess: WorldlineBoxMobileAccessApi = Object.freeze({
  request: (input: MobileSettingsRequest) => ipcRenderer.invoke(MOBILE_ACCESS_CHANNEL, input) as Promise<MobileSettingsResult>,
});
