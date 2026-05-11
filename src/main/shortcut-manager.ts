
import { globalShortcut } from 'electron'
import { DEFAULT_SHORTCUT, RecordState, type RecordStateType } from '@shared/constants'

/**
 * 全局快捷键管理器
 *
 * M1 职责：
 *  - 注册/注销全局快捷键
 *  - 对外暴露 onToggle 事件（按一下触发一次）
 *  - 维护最小状态机（Idle ⇄ Recording），M1 不涉及 Transcribing/Injecting
 *
 * M5 扩展：
 *  - 新增 `registerSecondary(accel, handler)`：支持注册任意附加快捷键
 *    （如打开设置窗口的 `Cmd/Ctrl+Shift+,`）
 *    附加快捷键与主快捷键独立管理，不影响录音状态机
 */
export class ShortcutManager {
  private current: string | null = null
  private state: RecordStateType = RecordState.Idle
  private toggleHandlers: Array<(next: RecordStateType) => void> = []
  /** 附加快捷键 → 清理回调 */
  private secondary: Map<string, () => void> = new Map()

  /**
   * 注册快捷键
   * @returns 是否注册成功（系统层冲突会返回 false）
   */
  register(accelerator: string = DEFAULT_SHORTCUT): boolean {
    // 已注册同一个快捷键则幂等
    if (this.current === accelerator && globalShortcut.isRegistered(accelerator)) {
      return true
    }
    this.unregister()

    const ok = globalShortcut.register(accelerator, () => this.handleToggle())
    if (ok) {
      this.current = accelerator
    }
    return ok
  }

  /** 注销当前快捷键 */
  unregister(): void {
    if (this.current) {
      globalShortcut.unregister(this.current)
      this.current = null
    }
  }

  /** 当前已注册的主快捷键（未注册则为 null） */
  getCurrent(): string | null {
    return this.current
  }

  /**
   * 尝试重绑主快捷键（设置页调用）
   *
   * 流程：
   *  1. 格式校验（必须有修饰键 + 主键）
   *  2. 不能与已注册的附加快捷键冲突
   *  3. 试注册：先注销旧的 → register 新的
   *     - 若 register 抛（格式非法）或返回 false（被占用） → 回退注册旧的，返回失败
   *  4. 成功则更新 current
   *
   * 返回 { ok, current, error?, message? }
   */
  rebind(nextAccel: string): {
    ok: boolean
    current: string
    error?: 'invalid_format' | 'conflict_with_secondary' | 'register_failed'
    message?: string
  } {
    const prev = this.current ?? ''
    // 1) 格式校验
    if (!isValidAccelerator(nextAccel)) {
      return {
        ok: false,
        current: prev,
        error: 'invalid_format',
        message: '快捷键必须包含至少一个修饰键（Cmd/Ctrl/Alt/Shift）和一个主键'
      }
    }
    // 2) 冲突检查
    if (this.secondary.has(nextAccel)) {
      return {
        ok: false,
        current: prev,
        error: 'conflict_with_secondary',
        message: `该快捷键已被"${nextAccel}"占用（其他功能）`
      }
    }
    // 幂等
    if (this.current === nextAccel && globalShortcut.isRegistered(nextAccel)) {
      return { ok: true, current: nextAccel }
    }

    // 3) 试注册
    this.unregister()
    let ok = false
    try {
      ok = globalShortcut.register(nextAccel, () => this.handleToggle())
    } catch (err) {
      console.error('[ShortcutManager] rebind register 抛错：', err)
      ok = false
    }
    if (ok) {
      this.current = nextAccel
      return { ok: true, current: nextAccel }
    }
    // 4) 失败回滚
    if (prev) {
      try {
        const okRollback = globalShortcut.register(prev, () => this.handleToggle())
        if (okRollback) this.current = prev
      } catch {
        /* ignore */
      }
    }
    return {
      ok: false,
      current: this.current ?? prev,
      error: 'register_failed',
      message: '注册失败：可能已被其他应用占用'
    }
  }

  /** 注销所有快捷键（通常由生命周期退出前调用） */
  dispose(): void {
    globalShortcut.unregisterAll()
    this.current = null
    this.secondary.clear()
    this.toggleHandlers = []
  }

  /**
   * 注册附加（次要）快捷键，如"打开设置"
   *
   * 注意：Electron 的 `globalShortcut.register`：
   *   - accelerator **格式正确但被占用** → 返回 false
   *   - accelerator **格式非法**（如 'Shift+Comma'）→ **同步抛 TypeError**
   * 所以必须 try/catch，防止附加快捷键崩掉整个主流程
   *
   * @returns 是否注册成功
   */
  registerSecondary(accelerator: string, handler: () => void): boolean {
    // 避免与主快捷键冲突
    if (accelerator === this.current) {
      console.warn(`[ShortcutManager] 附加快捷键 ${accelerator} 与主快捷键冲突，已跳过`)
      return false
    }
    // 若已注册同样的 accelerator，先注销
    if (this.secondary.has(accelerator)) {
      try {
        globalShortcut.unregister(accelerator)
      } catch {
        /* ignore */
      }
      this.secondary.delete(accelerator)
    }
    let ok = false
    try {
      ok = globalShortcut.register(accelerator, () => {
        try {
          handler()
        } catch (err) {
          console.error(`[ShortcutManager] secondary(${accelerator}) handler error:`, err)
        }
      })
    } catch (err) {
      console.error(
        `[ShortcutManager] 附加快捷键 ${accelerator} 格式非法或注册异常：`,
        err
      )
      return false
    }
    if (ok) this.secondary.set(accelerator, handler)
    return ok
  }

  /** 注销某个附加快捷键 */
  unregisterSecondary(accelerator: string): void {
    if (this.secondary.has(accelerator)) {
      try {
        globalShortcut.unregister(accelerator)
      } catch {
        /* ignore */
      }
      this.secondary.delete(accelerator)
    }
  }

  /** 订阅 toggle 事件（每次按下快捷键都触发） */
  onToggle(handler: (next: RecordStateType) => void): void {
    this.toggleHandlers.push(handler)
  }

  /** 获取当前录音状态 */
  getState(): RecordStateType {
    return this.state
  }

  /**
   * 外部手动触发一次 toggle（如托盘菜单、orb 点击）
   * 等价于用户按了一次快捷键
   */
  trigger(): void {
    this.handleToggle()
  }

  /**
   * 处理一次快捷键按下
   * M1 只在 Idle/Recording 间切换
   */
  private handleToggle(): void {
    if (this.state === RecordState.Idle) {
      this.state = RecordState.Recording
    } else if (this.state === RecordState.Recording) {
      this.state = RecordState.Idle
    } else {
      // Transcribing / Injecting 阶段忽略快捷键，避免打断流程
      return
    }
    for (const h of this.toggleHandlers) {
      try {
        h(this.state)
      } catch (err) {
        console.error('[ShortcutManager] toggle handler error:', err)
      }
    }
  }
}

/**
 * 校验一个 Electron accelerator 字符串是否"安全可注册"
 *
 * 规则（贴合 Electron accelerator 文档）：
 *  - 至少一个修饰键：Command/Cmd/Control/Ctrl/CommandOrControl/CmdOrCtrl/Alt/Option/Shift/Super/Meta
 *  - 至少一个主键：字母/数字/F1-F24/常见键名/符号字面量
 *  - 不允许空段、重复段
 *
 * 注意：这是**预校验**，最终以 globalShortcut.register 的抛错/返回值为准
 */
export function isValidAccelerator(accel: string): boolean {
  if (!accel || typeof accel !== 'string') return false
  const parts = accel.split('+').map((s) => s.trim())
  if (parts.length < 2) return false
  if (parts.some((p) => p.length === 0)) return false
  const MODIFIERS = new Set([
    'Command',
    'Cmd',
    'Control',
    'Ctrl',
    'CommandOrControl',
    'CmdOrCtrl',
    'Alt',
    'Option',
    'AltGr',
    'Shift',
    'Super',
    'Meta'
  ])
  // 主键：非修饰部分（通常是最后一个）
  const mods = parts.slice(0, -1)
  const primary = parts[parts.length - 1]
  if (mods.length === 0) return false
  if (!mods.every((m) => MODIFIERS.has(m))) return false
  if (MODIFIERS.has(primary)) return false
  // 主键不能为空或过长（排除乱输）
  if (primary.length === 0 || primary.length > 12) return false
  return true
}

