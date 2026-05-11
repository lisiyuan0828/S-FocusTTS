import { app, session, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import path from 'node:path'
import { AppLifecycle } from './app-lifecycle'
import { ShortcutManager } from './shortcut-manager'
import { WindowManager } from './window-manager'
import { IpcRouter } from './ipc/ipc-router'
import { Recorder } from './recorder'
import { WhisperLocalProvider } from './asr/whisper-local'
import { AsrError } from './asr/provider'
import { checkAsrAssets } from './asr/binary-locator'
import { InjectorService } from './injector'
import {
  getAccessibilityStatus,
  logAccessibilityGuide,
  logPermissionDiagnostics,
  requestAccessibility,
  revealElectronAppInFinder
} from './injector/permissions'
import { ConfigStore } from './config/config-store'
import { TrayMenu } from './tray/tray-menu'
import { createFocusKeeper } from './platform/focus-keeper'
import type { FocusKeeper } from './platform/focus-keeper'
import { migrateUserDataFromFocusTTS } from './migration/userdata-rename'
import {
  APP_NAME,
  DEFAULT_SHORTCUT,
  OPEN_SETTINGS_SHORTCUT,
  OrbState,
  RecordState,
  VOICE_ACTIVE_RMS_THRESHOLD,
  VOICE_SILENT_DEBOUNCE_MS,
  type OrbStateType
} from '@shared/constants'

/**
 * S-FocusTTS 主进程入口
 *
 * M5：
 *  - Orb 改为可交互（左键停录/右键菜单）+ 新增状态动画
 *  - 新增设置窗口（托盘 + 全局快捷键 Cmd/Ctrl+Shift+, 双入口）
 *  - 新增系统托盘（macOS 菜单栏 / Windows 通知区）
 *  - Win 引入 FocusKeeper：点球前 snapshot，注入前 restore，避免丢失前台焦点
 */
app.setName(APP_NAME)

// DEC-006：一次性迁移 FocusTTS → S-FocusTTS 的 userData 目录
// 必须紧跟 setName 之后、单例锁/whenReady 之前；幂等可重复调用
migrateUserDataFromFocusTTS()

// 全局异常钩子：避免静默崩溃难以排障
process.on('uncaughtException', (err) => {
  console.error('[Main] uncaughtException:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[Main] unhandledRejection:', reason)
})
app.on('render-process-gone', (_e, wc, details) => {
  console.error('[Main] render-process-gone:', wc.getURL(), details)
})
app.on('child-process-gone', (_e, details) => {
  console.error('[Main] child-process-gone:', details)
})

const lifecycle = new AppLifecycle()

if (!lifecycle.requestSingleInstance()) {
  // 已有实例运行，当前进程退出
} else {
  const shortcutManager = new ShortcutManager()
  const windowManager = new WindowManager()
  const recorder = new Recorder()
  const asr = new WhisperLocalProvider()
  const injector = new InjectorService()
  const trayMenu = new TrayMenu()

  let configStore: ConfigStore | null = null
  let focusKeeper: FocusKeeper | null = null
  let ipcRouter: IpcRouter | null = null

  lifecycle.onReady(async () => {
    // 放行 renderer 发起的 media 权限请求；
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      if (permission === 'media') return cb(true)
      return cb(false)
    })

    // ── 配置加载 ─────────────────────────
    configStore = new ConfigStore()
    const settings = configStore.getAll()
    injector.setMode(settings.injectMode)

    // M5.3：启动时还原球的尺寸档位 + 上次位置
    windowManager.setOrbSize(settings.orbSize)
    windowManager.restoreOrbPosition(settings.orbPosition)
    // 拖动结束时 window-manager 回调这里，持久化 orbPosition
    windowManager.setOrbPositionCommitter((pos) => {
      configStore?.set('orbPosition', pos)
    })
    // ── Windows 焦点保持器 ─────────────────────
    focusKeeper = await createFocusKeeper()
    // 把 restore 钩子交给 InjectorService，它在执行注入前会调用
    injector.setBeforeInject(async () => {
      if (focusKeeper) await focusKeeper.restore()
    })

    // ── Voice Activity 去抖状态（M5.2） ────────
    // recorder 每 ~80ms 上报 RMS；active 瞬时切上，silent 去抖 350ms
    let voiceActive = false
    let voiceSilentTimer: NodeJS.Timeout | null = null
    function handleVoiceLevel(rms: number): void {
      const isSpeaking = rms >= VOICE_ACTIVE_RMS_THRESHOLD
      if (isSpeaking) {
        if (voiceSilentTimer) {
          clearTimeout(voiceSilentTimer)
          voiceSilentTimer = null
        }
        if (!voiceActive) {
          voiceActive = true
          windowManager.setOrbVoiceActive(true)
        }
      } else {
        // 不是在说话：延迟判定，避免词间短暂静音频繁抖动
        if (voiceActive && !voiceSilentTimer) {
          voiceSilentTimer = setTimeout(() => {
            voiceActive = false
            voiceSilentTimer = null
            windowManager.setOrbVoiceActive(false)
          }, VOICE_SILENT_DEBOUNCE_MS)
        }
      }
    }
    function resetVoiceActive(): void {
      if (voiceSilentTimer) {
        clearTimeout(voiceSilentTimer)
        voiceSilentTimer = null
      }
      voiceActive = false
      windowManager.setOrbVoiceActive(false)
    }

    // ── IPC 路由 ───────────────────────────────
    ipcRouter = new IpcRouter({
      recorder,
      configStore,
      windowManager,
      onToggleRecord: () => shortcutManager.trigger(),
      onOrbContextMenu: buildOrbContextMenu,
      onRebindShortcut: (accel) => {
        const r = shortcutManager.rebind(accel)
        if (r.ok) {
          // 新快捷键生效后同步到 orb 下方 hint
          const s = configStore?.getAll()
          windowManager.setOrbHint({
            show: s?.showShortcutHint ?? true,
            accelerator: r.current
          })
          console.log(`[Main] 录音快捷键已重绑：${r.current}`)
        } else {
          console.warn(
            `[Main] 录音快捷键重绑失败（${r.error}）：${r.message ?? ''}；已回退到 ${r.current}`
          )
        }
        return r
      },
      onVoiceLevel: handleVoiceLevel,
      onSettingsChanged: (key, value) => {
        if (key === 'injectMode') {
          injector.setMode(value as 'auto' | 'keyboard' | 'clipboard')
        } else if (key === 'showShortcutHint') {
          const s = configStore?.getAll()
          windowManager.setOrbHint({
            show: !!value,
            accelerator: s?.shortcut ?? DEFAULT_SHORTCUT
          })
        } else if (key === 'orbSize') {
          // 立即应用新尺寸；窗口会以视觉中心为锚点重排
          windowManager.setOrbSize(value as 'normal' | 'compact')
        } else if (key === 'alwaysShow') {
          // 常显：立即显示球；关闭：仅当处于 idle 态时隐藏（录音/转写中保留）
          if (value) {
            windowManager.showOrb()
            windowManager.setOrbState(OrbState.Idle)
          } else if (shortcutManager.getState() === RecordState.Idle) {
            windowManager.hideOrb()
          }
        }
        // shortcut 不经此路径（走 onRebindShortcut）
        // asrLanguage / launchAtLogin 的副作用后续里程碑再接
      }
    })
    ipcRouter.register()

    // ── 资产/权限自检 ──────────────────────────
    const assetWarn = checkAsrAssets()
    if (assetWarn) {
      console.warn(`[ASR] ⚠️ 资产检查失败：\n${assetWarn}\n→ 录音仍可用，但转写会被跳过`)
    } else {
      console.log('[ASR] ✅ whisper-cli 与模型就绪')
    }

    if (process.platform === 'darwin') {
      logPermissionDiagnostics()
      const axStatus = getAccessibilityStatus()
      if (axStatus === 'authorized') {
        console.log('[Inject] ✅ 辅助功能权限已授予')
      } else if (axStatus === 'unsupported') {
        console.warn(
          '[Inject] ⚠️ 无法查询辅助功能权限状态（node-mac-permissions 未加载），' +
            '将让 nut-js 兜底；若无反应请去"系统设置 → 隐私与安全 → 辅助功能"确认'
        )
      } else {
        console.warn(`[Inject] ⚠️ 辅助功能权限未授予（当前：${axStatus}）→ 注入将无法生效`)
        requestAccessibility()
        logAccessibilityGuide()
        revealElectronAppInFinder()
      }
    }

    // ── 全局快捷键 ──────────────────────────────
    const ok = shortcutManager.register(settings.shortcut || DEFAULT_SHORTCUT)
    if (!ok) {
      console.error(
        `[Main] 全局快捷键 ${settings.shortcut} 注册失败（可能被其他应用占用）`
      )
    } else {
      console.log(`[Main] 全局快捷键已注册：${settings.shortcut}`)
    }

    // 初始化 orb 下方快捷键提示（M5.2）
    windowManager.setOrbHint({
      show: !!settings.showShortcutHint,
      accelerator: shortcutManager.getCurrent() ?? settings.shortcut ?? DEFAULT_SHORTCUT
    })

    // 设置窗口快捷键（M5：Cmd/Ctrl+Shift+,）
    const okSettings = shortcutManager.registerSecondary(OPEN_SETTINGS_SHORTCUT, () => {
      windowManager.showSettings()
    })
    if (okSettings) {
      console.log(`[Main] 设置窗口快捷键已注册：${OPEN_SETTINGS_SHORTCUT}`)
    }

    // ── 托盘 ────────────────────────────────────
    trayMenu.create({
      onToggleRecord: () => shortcutManager.trigger(),
      onOpenSettings: () => windowManager.showSettings(),
      onOpenRecordingsDir: () => {
        const dir = path.join(app.getPath('userData'), 'recordings')
        shell.openPath(dir).catch((err) => console.warn('[Tray] openPath 失败：', err))
      },
      onQuit: () => app.quit()
    })

    // ── M6：根据"常显模式"决定启动时是否显示球 ─
    //  alwaysShow=true（默认）：启动即显示，球常驻，录音结束不消失
    //  alwaysShow=false：老行为——按下快捷键才呼出，录音结束自动隐藏
    if (settings.alwaysShow) {
      windowManager.showOrb()
      windowManager.setOrbState(OrbState.Idle)
    }

    // ── 主逻辑：录音状态机 ─────────────────────
    shortcutManager.onToggle(async (next) => {
      if (next === RecordState.Recording) {
        // 记录用户当前正在打字的窗口（Win 上点球前必须记）
        focusKeeper?.snapshot()

        // 进入录音：先当作"静音"，等真说话了 RMS 超阈值再切
        resetVoiceActive()

        windowManager.showOrb()
        windowManager.setOrbState(OrbState.Recording)

        recorder.start({
          onTimeout: () => {
            console.log('[Main] 录音超时，自动停止')
            void handleStop()
          }
        })
        try {
          await windowManager.sendRecordStart()
          console.log('[Main] orb shown + recorder started')
        } catch (err) {
          console.error('[Main] 启动录音窗口失败：', err)
          windowManager.setOrbState(OrbState.Error)
        }
      } else if (next === RecordState.Idle) {
        await handleStop()
      }
    })

    async function handleStop(): Promise<void> {
      // 录音结束：立刻清掉 voice-active 视觉
      resetVoiceActive()
      // 立刻切到"转写中"，让用户看到"在干活"
      windowManager.setOrbState(OrbState.Transcribing)

      try {
        await windowManager.sendRecordStop()
      } catch (err) {
        console.warn('[Main] 通知 recorder 停止失败：', err)
      }
      // 给 renderer 留 200ms 冲刷最后一块 PCM
      await new Promise((r) => setTimeout(r, 200))

      const result = await recorder.stop()
      if (result) {
        console.log(
          `[Main] ✅ 录音已落盘：${result.filePath}（时长 ${(result.durationMs / 1000).toFixed(2)}s，大小 ${(result.bytes / 1024).toFixed(1)} KB）`
        )
        void transcribeAndLog(result.filePath, result.durationMs)
      } else {
        console.warn('[Main] ⚠️ 本次录音无数据（检查麦克风权限 / 设备）')
        // 无数据也要收尾：复位状态；常显模式下球保留可见
        finishOrb(OrbState.Idle, 0)
      }
    }

    async function transcribeAndLog(
      wavPath: string,
      audioDurationMs: number
    ): Promise<void> {
      const lang = (configStore?.get('asrLanguage') ?? 'zh') as 'zh' | 'en' | 'auto'
      try {
        console.log('[ASR] ⏳ 开始转写…')
        const res = await asr.transcribe(wavPath, {
          // whisper-cli 支持 'auto' 让模型自检测语言；直接透传
          language: lang
        })
        const sec = (res.durationMs / 1000).toFixed(2)
        const rtf = audioDurationMs > 0
          ? (res.durationMs / audioDurationMs).toFixed(2)
          : '?'
        console.log(
          `\n📝 [ASR] 识别结果（耗时 ${sec}s / 实时倍率 ${rtf}x / ${res.model}）：\n────────────────────\n${res.text}\n────────────────────\n`
        )
        // 切到"注入中"短暂闪一下
        windowManager.setOrbState(OrbState.Injecting)
        await injectAndLog(res.text)
      } catch (err) {
        if (err instanceof AsrError) {
          console.error(`[ASR] ❌ 转写失败 (${err.code}): ${err.message}`)
        } else {
          console.error('[ASR] ❌ 转写失败（未知错误）:', err)
        }
        windowManager.setOrbState(OrbState.Error)
        // 错误态展示 1.2s 后复位（常显模式下保留球，仅切回 idle）
        finishOrb(OrbState.Idle, 1200)
      }
    }

    async function injectAndLog(text: string): Promise<void> {
      const r = await injector.inject(text)
      const ms = r.durationMs
      if (r.success) {
        console.log(`[Inject] ✅ ${r.usedMode} 注入完成，用时 ${ms}ms`)
      } else if (r.errorCode === 'empty_text') {
        console.warn('[Inject] ⚠️ 文本为空或仅含标点，跳过注入')
      } else {
        const fb = r.clipboardFallback ? '（已兜底写入剪贴板，Cmd/Ctrl+V 可粘贴）' : ''
        console.error(`[Inject] ❌ 注入失败 (${r.errorCode})，用时 ${ms}ms${fb}`)
      }
      // 无论成败都收尾：短暂停留让动画完结，常显模式下保留球
      finishOrb(OrbState.Idle, 250)
    }

    /**
     * 收尾：统一处理"录音/转写/注入结束"的球态还原
     *  - 常显模式（默认）：保留球，仅切到 nextState（通常是 idle）
     *  - 非常显：等 delayMs 毫秒后 hide 球 + 复位 state
     */
    function finishOrb(nextState: OrbStateType, delayMs: number): void {
      const keep = configStore?.get('alwaysShow') ?? true
      if (keep) {
        // 常显：动画余韵留一下，再复位状态（不 hide）
        if (delayMs > 0) {
          setTimeout(() => windowManager.setOrbState(nextState), delayMs)
        } else {
          windowManager.setOrbState(nextState)
        }
        return
      }
      // 非常显：老行为
      if (delayMs > 0) {
        setTimeout(() => {
          windowManager.hideOrb()
          windowManager.setOrbState(nextState)
        }, delayMs)
      } else {
        windowManager.hideOrb()
        windowManager.setOrbState(nextState)
      }
    }
  })

  lifecycle.onQuit(async () => {
    shortcutManager.dispose()
    windowManager.dispose()
    ipcRouter?.dispose()
    recorder.dispose()
    trayMenu.dispose()
    focusKeeper?.dispose()
  })

  lifecycle.bootstrap().catch((err) => {
    console.error('[Main] bootstrap failed:', err)
    app.exit(1)
  })

  /** orb 右键菜单内容（M5） */
  function buildOrbContextMenu(): MenuItemConstructorOptions[] {
    return [
      {
        label: '停止录音',
        enabled: shortcutManager.getState() === RecordState.Recording,
        click: () => shortcutManager.trigger()
      },
      { type: 'separator' },
      {
        label: '打开设置',
        accelerator: OPEN_SETTINGS_SHORTCUT,
        click: () => windowManager.showSettings()
      },
      {
        label: '打开录音目录',
        click: () => {
          const dir = path.join(app.getPath('userData'), 'recordings')
          shell.openPath(dir).catch((err) => console.warn('[Menu] openPath 失败：', err))
        }
      },
      { type: 'separator' },
      {
        label: '暂时隐藏（按快捷键再呼出）',
        click: () => windowManager.hideOrb()
      }
    ]
  }
}
