/**
 * electron/preload.ts
 * Electron preload script: exposes a safe IPC bridge (contextBridge) to
 * the renderer process. All renderer ↔ main communication goes through here.
 */

import { contextBridge, ipcRenderer } from 'electron'

/** Type-safe API exposed to the renderer as window.zuppy */
const api = {
  /** Fetch current status from the main process */
  getStatus: () => ipcRenderer.invoke('get-status'),

  /** Fetch current configuration */
  getConfig: () => ipcRenderer.invoke('get-config'),

  /** Fetch recent print logs */
  getLogs: () => ipcRenderer.invoke('get-logs'),

  /** List available Windows printers */
  getPrinters: () => ipcRenderer.invoke('get-printers'),

  /** Save updated configuration */
  saveConfig: (patch: Record<string, unknown>) =>
    ipcRenderer.invoke('save-config', patch),

  /** Trigger a test print */
  testPrint: (printerName?: string) =>
    ipcRenderer.invoke('test-print', printerName),

  /** Listen for queue/connection updates pushed from main process */
  onUpdate: (callback: (event: string, data: unknown) => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: string, data: unknown) => {
      callback(event, data)
    }
    ipcRenderer.on('push-update', handler)
    // Return cleanup function
    return () => ipcRenderer.removeListener('push-update', handler)
  },
}

contextBridge.exposeInMainWorld('zuppy', api)

// ─── TypeScript declaration (used by renderer) ────────────────────────────────
export type ZuppyApi = typeof api
