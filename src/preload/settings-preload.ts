/**
 * settings 窗口的预加载脚本（M5）
 *
 * 暴露给 renderer 的安全 API：
 *   - getSettings()：读配置
 *   - updateSetting(key, value)：更新单项配置
 *   - getDiagnostics()：读系统诊断信息（版本、路径、权限）
 *   - openAccessibility()：macOS 打开辅助功能设置页
 *   - openPath(p)：在 Finder/Explorer 中打开路径
 *   - openExternal(url)：在浏览器打开外链
 *   - onDiagnosticsUpdate(cb)：订阅诊断信息变化
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { AppSettings, Diagnostics, RebindShortcutResult } from '../shared/types'

contextBridge.exposeInMainWorld('settingsAPI', {
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.SETTINGS_GET),
  updateSetting: <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K]
  ): Promise<AppSettings> => ipcRenderer.invoke(IPC.SETTINGS_SET, key, value),
  /** 试注册新录音快捷键（成功才持久化） */
  rebindShortcut: (accel: string): Promise<RebindShortcutResult> =>
    ipcRenderer.invoke(IPC.SETTINGS_REBIND_SHORTCUT, accel),
  getDiagnostics: (): Promise<Diagnostics> =>
    ipcRenderer.invoke(IPC.SETTINGS_DIAGNOSTICS),
  openAccessibility: (): void => {
    ipcRenderer.send(IPC.SETTINGS_OPEN_ACCESSIBILITY)
  },
  openPath: (p: string): void => {
    ipcRenderer.send(IPC.SETTINGS_OPEN_EXTERNAL, { kind: 'path', target: p })
  },
  openExternal: (url: string): void => {
    ipcRenderer.send(IPC.SETTINGS_OPEN_EXTERNAL, { kind: 'url', target: url })
  },
  onDiagnosticsUpdate(cb: (d: Diagnostics) => void) {
    ipcRenderer.on(IPC.SETTINGS_DIAGNOSTICS_UPDATE, (_e, d: Diagnostics) => cb(d))
  }
})

export {}
