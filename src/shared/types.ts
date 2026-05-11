/**
 * 跨进程共享数据类型
 */

/** 一次 ASR 转写的最终结果（M3） */
export interface AsrResult {
  /** 识别出的完整文本（已 trim） */
  text: string
  /** 转写耗时（毫秒） */
  durationMs: number
  /** 源音频文件路径 */
  audioPath: string
  /** 使用的模型文件名（便于排障） */
  model: string
}

/** ASR 失败原因 */
export type AsrErrorCode =
  | 'binary_missing' // 找不到 whisper-cli 可执行文件
  | 'model_missing' // 找不到模型文件
  | 'spawn_failed' // 启动子进程失败
  | 'exit_nonzero' // 子进程非 0 退出
  | 'empty_output' // 运行成功但没识别出任何文字
  | 'busy' // 已有转写在进行中

// ─────────────────────────────────────────────
// M4 · 文本注入
// ─────────────────────────────────────────────

/** 注入模式（对应 InjectStrategy 实现） */
export type InjectMode = 'auto' | 'keyboard' | 'clipboard'

/** 一次注入的结果（供日志/历史展示） */
export interface InjectResult {
  /** 最终成功使用的策略；失败时为 `null` */
  usedMode: Exclude<InjectMode, 'auto'> | null
  /** 是否整体成功（包括降级成功） */
  success: boolean
  /** 注入耗时（ms） */
  durationMs: number
  /** 若失败：失败原因码 */
  errorCode?: InjectErrorCode
  /** 若失败：失败时是否已将文本写入剪贴板作为兜底（问题 1-B） */
  clipboardFallback?: boolean
}

/** 注入失败的错误类别 */
export type InjectErrorCode =
  | 'empty_text' // 文本为空，跳过注入
  | 'keyboard_failed' // nut-js 键盘注入抛错
  | 'clipboard_failed' // 剪贴板写入或模拟粘贴失败
  | 'permission_denied' // 系统权限未授予（macOS 辅助功能 / Win UIPI）
  | 'unknown'

// ─────────────────────────────────────────────
// M5 · 设置 / 诊断
// ─────────────────────────────────────────────

/** 应用可配置项（MVP 版） */
export interface AppSettings {
  /** 主快捷键（录音 toggle） */
  shortcut: string
  /** 注入模式 */
  injectMode: InjectMode
  /** ASR 语言（zh/en/auto） */
  asrLanguage: 'zh' | 'en' | 'auto'
  /** 开机自启（M5 仅保存，M6 打包后生效） */
  launchAtLogin: boolean
  /** 在呼吸球下方显示录音快捷键提示（M5.2） */
  showShortcutHint: boolean
  /** 呼吸球尺寸档位（M5.3：normal=140px 命中区 / compact=40px，便于驻留角落） */
  orbSize: 'normal' | 'compact'
  /** 呼吸球上次关闭前的左上角屏幕坐标（M5.3 持久化；null/undefined 表示用屏幕中央） */
  orbPosition: { x: number; y: number } | null
  /**
   * 常显模式（M6）：
   *  - true（默认）：球一直显示，快捷键/左键 = 录音切换；录音结束球不消失
   *  - false：老行为——快捷键按下才呼出球，录音结束自动隐藏
   */
  alwaysShow: boolean
}

// ─────────────────────────────────────────────
// M5.2 · Orb Hint（球下方快捷键提示）
// ─────────────────────────────────────────────

/** main → orb：快捷键提示的最新快照 */
export interface OrbHintPayload {
  /** 是否显示 */
  show: boolean
  /** 显示的 accelerator（原始字符串，如 'CommandOrControl+Shift+Space'） */
  accelerator: string
}

// ─────────────────────────────────────────────
// M5.2 · 快捷键重绑定
// ─────────────────────────────────────────────

export interface RebindShortcutResult {
  /** 是否成功重绑 */
  ok: boolean
  /** 最终生效的快捷键（成功：新值；失败：回退到的旧值） */
  current: string
  /** 失败原因（仅 ok=false 时有） */
  error?: 'invalid_format' | 'conflict_with_secondary' | 'register_failed'
  /** 失败时的可读消息（用于设置页 toast） */
  message?: string
}

/** 诊断信息（设置页"系统状态"区展示） */
export interface Diagnostics {
  appVersion: string
  platform: NodeJS.Platform
  arch: string
  recordingsDir: string
  whisperBinPath: string
  whisperBinExists: boolean
  modelPath: string
  modelExists: boolean
  /** 仅 macOS：辅助功能权限状态 */
  accessibilityStatus?: 'authorized' | 'denied' | 'not-determined' | 'unsupported'
}
