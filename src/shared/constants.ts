
/**
 * 跨进程共享常量
 */

/** 默认全局快捷键（Dex 决策 2） */
export const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+Space'

/**
 * 打开设置窗口的全局快捷键（D-M5-Q3：托盘 + 全局快捷键双通道）
 *
 * 注意：Electron accelerator 对标点类键**必须使用字面符号**，不能用键名 `Comma`。
 *   ✅ 'CommandOrControl+Shift+,'
 *   ❌ 'CommandOrControl+Shift+Comma'  （会抛 TypeError: conversion failure）
 */
export const OPEN_SETTINGS_SHORTCUT = 'CommandOrControl+Shift+,'

/** 呼吸球窗口尺寸（可在设置里调整，M1 用默认）
 *  注：M5 起窗口实际尺寸 = ORB_WINDOW_SIZE，比 ORB_SIZE 大，用来留光晕和动画边距
 */
export const ORB_SIZE = 140
/** 呼吸球所在窗口的真实尺寸（留外圈光晕和动画空间，避免黑框） */
export const ORB_WINDOW_SIZE = 220
/** 启用"球下方显示快捷键"时，窗口需要额外预留的高度（M5.2） */
export const ORB_HINT_EXTRA_HEIGHT = 36

/**
 * 呼吸球"紧凑模式"尺寸（M5.3 / v9.4）
 *
 * 用途：用户希望把球驻留到屏幕角落时，体积越小越好
 *  - ORB_SIZE_COMPACT：命中区实际大小（hit）
 *  - ORB_WINDOW_SIZE_COMPACT：窗口实际尺寸（要略大于命中区，留外圈光晕余量）
 *  - 紧凑模式下不显示快捷键 hint（再拉高窗口就失去"小"的意义）
 *
 * v9.4（2026-05-11）：用户反馈 v9.3 仍偏小，命中区 40→56、窗口 64→88（约 +40%），
 *   外圈 ring/spinner 同步等比放大。仍远小于 normal 模式（命中区 140 / 窗口 220）。
 */
export const ORB_SIZE_COMPACT = 56
export const ORB_WINDOW_SIZE_COMPACT = 88

/** 球的尺寸档位（M5.3） */
export const OrbSize = {
  Normal: 'normal',
  Compact: 'compact'
} as const

export type OrbSizeType = (typeof OrbSize)[keyof typeof OrbSize]

/**
 * 判定用户"正在说话"的 RMS 音量阈值（0..1）
 *
 * 经验值：
 *  - 静音环境底噪 ≈ 0.001~0.003
 *  - 正常说话峰值 ≈ 0.02~0.15
 *  - 我们取 0.012 左右，避开底噪，正常说话就能触发
 *
 * renderer 每帧（~85ms）算一次 RMS，超阈值即为 active
 * main 侧再做一点"抖动抑制"（100ms 内仍静音才降为 silent）
 */
export const VOICE_ACTIVE_RMS_THRESHOLD = 0.012
/** 静音连续多久（ms）才视作"不在说话"；避免每个字之间的短暂静音反复切换 */
export const VOICE_SILENT_DEBOUNCE_MS = 350

/** 应用名（Dex Q1 决策） */
export const APP_NAME = 'S-FocusTTS'

/** 录音状态 */
export const RecordState = {
  Idle: 'idle',
  Recording: 'recording',
  Transcribing: 'transcribing',
  Injecting: 'injecting'
} as const

export type RecordStateType = (typeof RecordState)[keyof typeof RecordState]

/** 呼吸球 UI 状态（与 RecordState 解耦，UI 可独立演进） */
export const OrbState = {
  Idle: 'idle',
  Recording: 'recording',
  Transcribing: 'transcribing',
  Injecting: 'injecting',
  Error: 'error'
} as const

export type OrbStateType = (typeof OrbState)[keyof typeof OrbState]

/** 录音音频参数（whisper.cpp 推荐：16kHz / 16bit / mono） */
export const AUDIO = {
  SAMPLE_RATE: 16_000,
  CHANNELS: 1,
  BIT_DEPTH: 16,
  /** renderer → main 每块 PCM 的长度（样本数），约 100ms */
  FRAME_SAMPLES: 1600
} as const

/** 单次录音最大时长（毫秒），超过自动停止。PRD F3：5 分钟 */
export const MAX_RECORD_MS = 5 * 60 * 1000

/**
 * 文本注入策略自动切换阈值（字符数，Dex 决策 D-M4-2）
 *
 * 文本长度 ≤ 此值用 keyboard（体感瞬时）
 * 否则用 clipboard（粘贴一次到位，避免逐字键入耗时）
 */
export const INJECT_KEYBOARD_MAX_CHARS = 80

/** 默认注入模式（对应 InjectMode） */
export const DEFAULT_INJECT_MODE = 'auto' as const

/** 注入失败时把文本兜底写入剪贴板（Dex 问题 1-B） */
export const INJECT_CLIPBOARD_FALLBACK_ON_FAILURE = true

/**
 * 默认"常显模式"（M6）：
 *  - true：球启动即显示并常驻；快捷键/左键 = 录音切换；录音结束球不消失
 *  - false：按快捷键才呼出，录音结束自动隐藏
 */
export const DEFAULT_ALWAYS_SHOW = true
