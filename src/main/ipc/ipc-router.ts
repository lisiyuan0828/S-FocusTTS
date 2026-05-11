import { ipcMain, shell, Menu, systemPreferences, app, BrowserWindow } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { IPC } from '@shared/ipc-channels'
import type {
  AppSettings,
  Diagnostics,
  RebindShortcutResult
} from '@shared/types'
import type { Recorder } from '../recorder'
import type { ConfigStore } from '../config/config-store'
import type { WindowManager } from '../window-manager'
import {
  DEFAULT_MODEL_FILE,
  resolveModelPath,
  resolveWhisperBinary
} from '../asr/binary-locator'
import { getAccessibilityStatus } from '../injector/permissions'

/**
 * IPC 路由：集中注册 ipcMain.handle / ipcMain.on
 *
 * M2：录音相关通道
 *  - RECORD_PCM_CHUNK：renderer 推 PCM16LE，转交 Recorder 聚合
 *  - RECORD_ERROR / RECORD_ACK：记录日志
 *
 * M5：
 *  - ORB_CLICK_STOP / ORB_CONTEXT_MENU：orb 可交互
 *  - ORB_DRAG_START / ORB_DRAG_END / ORB_DRAG_CANCEL：orb 拖动（方案 D：main 轮询 cursor）
 *  - SETTINGS_*：设置窗口读写配置、诊断信息、权限
 */
export interface IpcRouterDeps {
  recorder: Recorder
  configStore: ConfigStore
  windowManager: WindowManager
  /** 托盘/快捷键/orb 点击统一入口 */
  onToggleRecord(): void
  /** orb 右键菜单时主进程弹出原生菜单 */
  onOrbContextMenu(): MenuItemConstructorOptions[]
  /** 设置页请求重绑录音快捷键（交给主入口持有的 ShortcutManager 做试注册） */
  onRebindShortcut(accel: string): RebindShortcutResult
  /** recorder 侧实时上报音量 RMS，由 main 判定 voice-active 并推给 orb */
  onVoiceLevel?(rms: number): void
  /** 配置变更后的副作用（如快捷键变了要重新注册、注入模式要同步到 InjectorService） */
  onSettingsChanged?<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void
}

export class IpcRouter {
  constructor(private readonly deps: IpcRouterDeps) {}

  register(): void {
    const { recorder, configStore, windowManager } = this.deps

    // ── 录音 ──────────────────────────────────
    ipcMain.on(IPC.RECORD_PCM_CHUNK, (_e, chunk: ArrayBuffer | Uint8Array) => {
      recorder.pushChunk(chunk)
    })
    ipcMain.on(IPC.RECORD_VOICE_LEVEL, (_e, rms: number) => {
      if (typeof rms === 'number' && rms >= 0 && rms <= 1) {
        this.deps.onVoiceLevel?.(rms)
      }
    })
    ipcMain.on(IPC.RECORD_ERROR, (_e, msg: string) => {
      console.error('[IPC] recorder error from renderer:', msg)
    })
    ipcMain.on(IPC.RECORD_ACK, (_e, stage: 'started' | 'stopped') => {
      console.log(`[IPC] recorder ack: ${stage}`)
    })

    // ── Orb 交互 ─────────────────────────────
    ipcMain.on(IPC.ORB_CLICK_STOP, () => {
      this.deps.onToggleRecord()
    })
    ipcMain.on(IPC.ORB_CONTEXT_MENU, (e, { x, y }: { x: number; y: number }) => {
      const template = this.deps.onOrbContextMenu()
      const menu = Menu.buildFromTemplate(template)
      // 在点击位置附近弹菜单；要挂到一个 BrowserWindow 上才能定位
      const orbWin = BrowserWindow.fromWebContents(e.sender)
      if (orbWin && !orbWin.isDestroyed()) {
        // screenX/Y 转回窗口局部坐标
        const [wx, wy] = orbWin.getPosition()
        menu.popup({ window: orbWin, x: Math.max(0, x - wx), y: Math.max(0, y - wy) })
      } else {
        menu.popup()
      }
    })

    // ── Orb 拖动 ─────────────────────────────
    ipcMain.on(
      IPC.ORB_DRAG_START,
      (_e, { x, y }: { x: number; y: number }) => {
        windowManager.startOrbDrag(x, y)
      }
    )
    ipcMain.on(IPC.ORB_DRAG_END, () => {
      windowManager.endOrbDrag()
    })
    ipcMain.on(IPC.ORB_DRAG_CANCEL, () => {
      windowManager.endOrbDrag()
    })

    // ── 设置读写 ──────────────────────────────
    ipcMain.handle(IPC.SETTINGS_GET, () => {
      return configStore.getAll()
    })
    ipcMain.handle(IPC.SETTINGS_SET, (_e, key: keyof AppSettings, value: unknown) => {
      // 只接受预期的 key，防止乱写
      const allowed: Array<keyof AppSettings> = [
        'shortcut',
        'injectMode',
        'asrLanguage',
        'launchAtLogin',
        'showShortcutHint',
        'orbSize',
        'alwaysShow'
      ]
      if (!allowed.includes(key)) {
        console.warn('[IPC] settings set 非法 key:', key)
        return configStore.getAll()
      }
      // shortcut 必须走 rebind 通道（需要试注册 + 失败回退），这里拒绝绕过
      if (key === 'shortcut') {
        console.warn('[IPC] shortcut 不允许通过 SETTINGS_SET 直接写入，请用 rebindShortcut')
        return configStore.getAll()
      }
      // orbSize 校验：只允许白名单枚举
      if (key === 'orbSize' && value !== 'normal' && value !== 'compact') {
        console.warn('[IPC] orbSize 非法值：', value)
        return configStore.getAll()
      }
      const next = configStore.set(key, value as AppSettings[keyof AppSettings])
      // launchAtLogin 落到系统
      if (key === 'launchAtLogin') {
        try {
          app.setLoginItemSettings({ openAtLogin: !!value })
        } catch (err) {
          console.warn('[IPC] setLoginItemSettings 失败：', err)
        }
      }
      this.deps.onSettingsChanged?.(key, value as AppSettings[keyof AppSettings])
      return next
    })

    // ── 录音快捷键重绑（试注册 + 成功才持久化） ─
    ipcMain.handle(
      IPC.SETTINGS_REBIND_SHORTCUT,
      (_e, accel: string): RebindShortcutResult => {
        if (typeof accel !== 'string' || accel.length === 0) {
          return {
            ok: false,
            current: configStore.get('shortcut'),
            error: 'invalid_format',
            message: '快捷键不能为空'
          }
        }
        const result = this.deps.onRebindShortcut(accel)
        if (result.ok) {
          // 成功才落盘
          configStore.set('shortcut', result.current)
        }
        return result
      }
    )

    ipcMain.handle(IPC.SETTINGS_DIAGNOSTICS, async (): Promise<Diagnostics> => {
      return collectDiagnostics()
    })

    ipcMain.on(IPC.SETTINGS_OPEN_ACCESSIBILITY, () => {
      if (process.platform === 'darwin') {
        // 直接打开"隐私 → 辅助功能"面板
        shell.openExternal(
          'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
        )
      }
    })

    ipcMain.on(
      IPC.SETTINGS_OPEN_EXTERNAL,
      (_e, payload: { kind: 'path' | 'url'; target: string }) => {
        if (!payload || !payload.target) return
        if (payload.kind === 'path') {
          shell.openPath(payload.target).catch((err) => {
            console.warn('[IPC] openPath 失败：', err)
          })
        } else {
          shell.openExternal(payload.target).catch((err) => {
            console.warn('[IPC] openExternal 失败：', err)
          })
        }
      }
    )

    // 屏蔽未使用告警
    void windowManager
  }

  /** 向设置窗口推送最新诊断信息（供主进程在权限状态等变化时主动调用） */
  pushDiagnostics(): void {
    const settingsWin = this.deps.windowManager.getSettingsWindow()
    if (!settingsWin || settingsWin.isDestroyed()) return
    settingsWin.webContents.send(IPC.SETTINGS_DIAGNOSTICS_UPDATE, collectDiagnostics())
  }

  dispose(): void {
    ipcMain.removeAllListeners(IPC.RECORD_PCM_CHUNK)
    ipcMain.removeAllListeners(IPC.RECORD_VOICE_LEVEL)
    ipcMain.removeAllListeners(IPC.RECORD_ERROR)
    ipcMain.removeAllListeners(IPC.RECORD_ACK)
    ipcMain.removeAllListeners(IPC.ORB_CLICK_STOP)
    ipcMain.removeAllListeners(IPC.ORB_CONTEXT_MENU)
    ipcMain.removeAllListeners(IPC.ORB_DRAG_START)
    ipcMain.removeAllListeners(IPC.ORB_DRAG_END)
    ipcMain.removeAllListeners(IPC.ORB_DRAG_CANCEL)
    ipcMain.removeAllListeners(IPC.SETTINGS_OPEN_ACCESSIBILITY)
    ipcMain.removeAllListeners(IPC.SETTINGS_OPEN_EXTERNAL)
    ipcMain.removeHandler(IPC.SETTINGS_GET)
    ipcMain.removeHandler(IPC.SETTINGS_SET)
    ipcMain.removeHandler(IPC.SETTINGS_REBIND_SHORTCUT)
    ipcMain.removeHandler(IPC.SETTINGS_DIAGNOSTICS)
  }
}

/** 汇总诊断信息 */
function collectDiagnostics(): Diagnostics {
  const whisperBinPath = resolveWhisperBinary()
  const modelPath = resolveModelPath(DEFAULT_MODEL_FILE)
  return {
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    recordingsDir: path.join(app.getPath('userData'), 'recordings'),
    whisperBinPath,
    whisperBinExists: existsSync(whisperBinPath),
    modelPath,
    modelExists: existsSync(modelPath),
    accessibilityStatus:
      process.platform === 'darwin' ? getAccessibilityStatus() : undefined
  }
}

// 让 tsc 不因未用而抱怨（systemPreferences 仅作为可能的未来扩展保留）
void systemPreferences
