import { clipboard } from 'electron'
import {
  DEFAULT_INJECT_MODE,
  INJECT_CLIPBOARD_FALLBACK_ON_FAILURE,
  INJECT_KEYBOARD_MAX_CHARS
} from '@shared/constants'
import type { InjectErrorCode, InjectMode, InjectResult } from '@shared/types'

import {
  canSimulateInput,
  getAccessibilityStatus,
  logAccessibilityGuide,
  requestAccessibility
} from './permissions'
import { ClipboardStrategy } from './strategies/clipboard-strategy'
import { KeyboardStrategy } from './strategies/keyboard-strategy'
import type { InjectContext, InjectStrategy } from './types'

/**
 * InjectorService —— 文本注入调度器（M4）
 *
 * 对上层暴露单一方法 `inject(text)`：
 *   1. 预处理：trim + 过滤纯空白/纯标点
 *   2. 根据模式（auto / keyboard / clipboard）选策略
 *   3. 执行策略；keyboard 失败自动降级为 clipboard
 *   4. 全失败时（Dex 问题 1-B）把原文写进剪贴板作为兜底
 *
 * 关键设计：
 *   - **懒加载 nut-js**：nut-js 依赖的 libnut 会在首次 import 时触发 .node 加载，
 *     dev 启动阶段能延后一点算一点。所以 KeyboardStrategy 在首次 auto/keyboard
 *     场景才实例化；只走 clipboard 模式则永远不加载 nut-js 键盘模块。
 *     （剪贴板策略为了模拟 Cmd+V 也用了 nut-js，但用到再懒加载同理）
 *   - **无队列**：ASR 自带 Promise 锁，调用 inject 天然串行；即使并发也只是
 *     两次剪贴板覆盖，不会崩。M5 引入历史记录时再做注入队列。
 */
export class InjectorService {
  private keyboardStrategy: KeyboardStrategy | null = null
  private clipboardStrategy: ClipboardStrategy | null = null

  /** 用户配置的注入模式（M5 接入 electron-store 后动态） */
  private mode: InjectMode = DEFAULT_INJECT_MODE

  /**
   * 注入前钩子（M5）：如 Win 平台在这里 restore 前一个前台窗口
   * 返回 Promise 以便异步等待焦点切换完成
   */
  private beforeInject: (() => Promise<void>) | null = null

  setMode(mode: InjectMode): void {
    this.mode = mode
  }

  /** 设置注入前钩子（Win 下传 FocusKeeper.restore） */
  setBeforeInject(hook: (() => Promise<void>) | null): void {
    this.beforeInject = hook
  }

  /**
   * 执行一次注入
   * @returns 结果元信息（供主入口打印日志 / M5 写历史）
   */
  async inject(rawText: string): Promise<InjectResult> {
    const t0 = Date.now()
    const text = normalizeText(rawText)

    if (!text) {
      return {
        usedMode: null,
        success: false,
        durationMs: Date.now() - t0,
        errorCode: 'empty_text'
      }
    }

    const preferred = this.resolveMode(text)

    // M5：执行焦点保持钩子（Win 上还原之前记录的前台窗口）
    if (this.beforeInject) {
      try {
        await this.beforeInject()
      } catch (err) {
        console.warn('[Inject] beforeInject 钩子抛错（不影响注入尝试）：', err)
      }
    }

    // macOS 辅助功能权限缺失时，键盘和剪贴板（需模拟 Cmd+V）都会失效。
    // 提前拦截：直接走兜底（写剪贴板）+ 打开系统设置引导。
    if (!canSimulateInput()) {
      const status = getAccessibilityStatus()
      console.error(
        `[Inject] ❌ 缺少"辅助功能"权限（当前状态：${status}），无法模拟键盘/粘贴`
      )
      requestAccessibility()
      logAccessibilityGuide()
      const clipboardFallback = writeClipboardFallback(text)
      return {
        usedMode: null,
        success: false,
        durationMs: Date.now() - t0,
        errorCode: 'permission_denied',
        clipboardFallback
      }
    }

    const result = await this.tryInject(text, preferred)
    result.durationMs = Date.now() - t0
    return result
  }

  /**
   * 根据当前模式与文本长度决定首选策略
   */
  private resolveMode(text: string): Exclude<InjectMode, 'auto'> {
    if (this.mode === 'keyboard') return 'keyboard'
    if (this.mode === 'clipboard') return 'clipboard'
    // auto
    return text.length <= INJECT_KEYBOARD_MAX_CHARS ? 'keyboard' : 'clipboard'
  }

  /**
   * 按首选策略尝试；keyboard 失败自动降级到 clipboard；全失败则兜底写剪贴板
   */
  private async tryInject(
    text: string,
    preferred: Exclude<InjectMode, 'auto'>
  ): Promise<InjectResult> {
    const ctx: InjectContext = { text, mode: preferred }

    const order: Array<Exclude<InjectMode, 'auto'>> =
      preferred === 'keyboard' ? ['keyboard', 'clipboard'] : ['clipboard']

    let lastCode: InjectErrorCode = 'unknown'

    for (const mode of order) {
      try {
        const strategy = this.getStrategy(mode)
        await strategy.inject(ctx)
        return {
          usedMode: mode,
          success: true,
          durationMs: 0 // 由调用方填
        }
      } catch (err) {
        lastCode = classifyError(mode, err)
        console.warn(
          `[Inject] ${mode} 策略失败 (${lastCode})：${(err as Error).message}`
        )
        // 继续下一个候选
      }
    }

    // 全部失败 → 兑底写剪贴板（Dex 问题 1-B）
    const clipboardFallback = writeClipboardFallback(text)

    // 如果失败原因是权限 → 主动引导
    if (lastCode === 'permission_denied') {
      requestAccessibility()
      logAccessibilityGuide()
    }

    return {
      usedMode: null,
      success: false,
      durationMs: 0,
      errorCode: lastCode,
      clipboardFallback
    }
  }
  private getStrategy(
    mode: Exclude<InjectMode, 'auto'>
  ): InjectStrategy {
    if (mode === 'keyboard') {
      if (!this.keyboardStrategy) this.keyboardStrategy = new KeyboardStrategy()
      return this.keyboardStrategy
    }
    if (!this.clipboardStrategy) this.clipboardStrategy = new ClipboardStrategy()
    return this.clipboardStrategy
  }
}

/**
 * 兑底写剪贴板（Dex 问题 1-B）：即使全路失败，用户至少能 Cmd+V 找回识别结果
 */
function writeClipboardFallback(text: string): boolean {
  if (!INJECT_CLIPBOARD_FALLBACK_ON_FAILURE) return false
  try {
    clipboard.writeText(text)
    return true
  } catch (err) {
    console.warn('[Inject] 兑底写剪贴板也失败：', err)
    return false
  }
}

/**
 * 文本归一化：
 *   - trim 首尾空白
 *   - 去除只由零宽/空白/常见噪声构成的文本
 *   - 不做标点修正，那是 post-processor 的事（M5）
 */
function normalizeText(raw: string): string {
  if (typeof raw !== 'string') return ''
  const t = raw.replace(/^[\s\u200B\uFEFF]+|[\s\u200B\uFEFF]+$/g, '')
  if (!t) return ''
  // 仅空白/标点/符号构成的文本视为无意义
  if (/^[\s\p{P}\p{S}]+$/u.test(t)) return ''
  return t
}

/**
 * 把异常粗分类为 InjectErrorCode。libnut 的错误文案比较乱，
 * macOS 下未授予"辅助功能"会抛 "permission"/"accessibility" 关键字。
 */
function classifyError(
  mode: Exclude<InjectMode, 'auto'>,
  err: unknown
): InjectErrorCode {
  const msg = (err as Error | undefined)?.message?.toLowerCase() ?? ''
  if (
    msg.includes('permission') ||
    msg.includes('accessibility') ||
    msg.includes('denied')
  ) {
    return 'permission_denied'
  }
  return mode === 'keyboard' ? 'keyboard_failed' : 'clipboard_failed'
}
