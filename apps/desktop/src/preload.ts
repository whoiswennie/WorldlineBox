import { contextBridge, ipcRenderer } from 'electron'
import {
  UPDATE_CHECK_CHANNEL,
  UPDATE_DOWNLOAD_CHANNEL,
  UPDATE_GET_STATE_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_STATE_CHANGED_CHANNEL,
  type DesktopUpdateBridge,
  type DesktopUpdateSnapshot,
} from './update-contract.ts'

const updates: DesktopUpdateBridge = {
  getState: () => ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL) as Promise<DesktopUpdateSnapshot>,
  check: () => ipcRenderer.invoke(UPDATE_CHECK_CHANNEL) as Promise<DesktopUpdateSnapshot>,
  download: () => ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL) as Promise<DesktopUpdateSnapshot>,
  install: () => ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL) as Promise<void>,
  onStateChanged(listener) {
    const receiver = (_event: Electron.IpcRendererEvent, snapshot: DesktopUpdateSnapshot): void => {
      listener(snapshot)
    }
    ipcRenderer.on(UPDATE_STATE_CHANGED_CHANNEL, receiver)
    return () => { ipcRenderer.removeListener(UPDATE_STATE_CHANGED_CHANNEL, receiver) }
  },
}

/** The sandbox receives only serializable updater operations, never Electron primitives. */
contextBridge.exposeInMainWorld('worldlineDesktop', { updates })
