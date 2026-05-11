import { keyboard } from '@nut-tree-fork/nut-js'
import type { InjectContext, InjectStrategy } from '../types'

/**
 * KeyboardStrategy —— 直接模拟键盘 Unicode 输入
 *
 * 优势：任何能接收键盘输入的位置（浏览器 / IDE / IM / 终端）都能用，
 *       不污染用户剪贴板。
 * 劣势：单字符耗时 5~10ms，长文本时体感明显；中文 IME 下可能触发候选面板，
 *       所以阈值管控在 INJECT_KEYBOARD_MAX_CHARS（80 字）以内。
 *
 * 实现：nut-js 的 `keyboard.type(string)` 走 `libnut` N-API，
 *       macOS 下调 CGEventKeyboardSetUnicodeString，Win 下走 SendInput。
 *
 * 节流：nut-js 默认 `config.autoDelayMs = 100`，对汉字序列来说太慢；
 *       我们把它降到 0，让底层按系统最快节奏发事件。
 */
export class KeyboardStrategy implements InjectStrategy {
  readonly name = 'keyboard' as const

  constructor() {
    // 只在策略实例化时设一次即可（nut-js 是模块单例）
    keyboard.config.autoDelayMs = 0
  }

  async inject(ctx: InjectContext): Promise<void> {
    if (!ctx.text) return
    // nut-js `keyboard.type` 接 string 后按字符逐个 type
    await keyboard.type(ctx.text)
  }
}
