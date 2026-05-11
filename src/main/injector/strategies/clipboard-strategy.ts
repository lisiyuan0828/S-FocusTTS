import { clipboard } from 'electron'
import { Key, keyboard } from '@nut-tree-fork/nut-js'
import type { InjectContext, InjectStrategy } from '../types'

/**
 * ClipboardStrategy —— 写剪贴板 + 模拟 Cmd/Ctrl+V 粘贴
 *
 * 适用场景：
 *   - 长文本（> INJECT_KEYBOARD_MAX_CHARS）
 *   - 某些 App 对模拟 Unicode 键盘事件兼容差（MVP 阶段降级通道）
 *
 * 行为：
 *   1. 保存用户当前剪贴板文本
 *   2. 写入目标文本
 *   3. 模拟 Cmd+V (macOS) / Ctrl+V (其他)
 *   4. 等待一个渲染周期后把原文本恢复回剪贴板
 *
 * 关键决定：
 *   - Electron 内置 `clipboard` 比 nut-js 的剪贴板 API 更稳（不依赖 libnut）
 *   - 恢复原剪贴板延时 120ms：目标 App 的"粘贴"一般同步完成，120ms 够 99% 场景
 */
export class ClipboardStrategy implements InjectStrategy {
  readonly name = 'clipboard' as const

  async inject(ctx: InjectContext): Promise<void> {
    if (!ctx.text) return

    const original = safeReadClipboard()
    clipboard.writeText(ctx.text)

    try {
      await pressPaste()
    } finally {
      // 120ms 后把原剪贴板还给用户，不污染剪贴板历史
      setTimeout(() => {
        try {
          if (original === null) {
            clipboard.clear()
          } else {
            clipboard.writeText(original)
          }
        } catch {
          /* ignore */
        }
      }, 120)
    }
  }
}

/** 读取剪贴板，遇到空/非文本时返回 null（便于恢复时 clear） */
function safeReadClipboard(): string | null {
  try {
    const t = clipboard.readText()
    return t.length === 0 ? null : t
  } catch {
    return null
  }
}

/**
 * 模拟 Cmd/Ctrl + V
 * nut-js 的 `keyboard.pressKey / releaseKey` 组合可精确控制按下释放，
 * 直接 `Key.A + Key.B` 会被解释成两次单独按键，所以用 pressKey 的多参数形式。
 */
async function pressPaste(): Promise<void> {
  const modifier = process.platform === 'darwin' ? Key.LeftSuper : Key.LeftControl
  await keyboard.pressKey(modifier, Key.V)
  await keyboard.releaseKey(modifier, Key.V)
}
