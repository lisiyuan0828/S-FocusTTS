import type { FocusKeeper } from './focus-keeper'

/**
 * Windows 平台 FocusKeeper
 *
 * 实现思路（D-M5-1，方案 C → D 梯度降级）：
 *   1) 优先用 @nut-tree-fork/nut-js 的 getActiveWindow() 记录当前前台窗口
 *      restore 时调用 window.focus() 把它拉回前台
 *   2) 如果 nut-js 拿不到或 focus() 失效，后续可替换为 node-window-manager（D-M5-1 的 D 分支）
 *
 * 注意：nut-js 在 Electron 主进程里是 native 绑定（libnut），需要 pnpm onlyBuiltDependencies 允许编译。
 * 已在 package.json 中配置。
 */
export class WinFocusKeeper implements FocusKeeper {
  /** 记录下来的窗口引用（nut-js 的 Window 对象，具体类型动态拿） */
  private saved: unknown = null

  snapshot(): void {
    try {
      // 懒加载避免 dev 启动失败影响其他功能
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nut = require('@nut-tree-fork/nut-js') as typeof import('@nut-tree-fork/nut-js')
      // getActiveWindow 返回 Promise<Window>
      void Promise.resolve(nut.getActiveWindow())
        .then((w) => {
          this.saved = w
        })
        .catch((err) => {
          console.warn('[FocusKeeper/win] getActiveWindow 失败：', err)
          this.saved = null
        })
    } catch (err) {
      console.warn('[FocusKeeper/win] 加载 nut-js 失败：', err)
      this.saved = null
    }
  }

  async restore(): Promise<void> {
    if (!this.saved) return
    try {
      // nut-js Window 对象带 focus() 方法；类型较复杂，这里 any 一下
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = this.saved as any
      if (typeof w?.focus === 'function') {
        await w.focus()
        // 焦点切换后给系统一点时间重绘光标
        await new Promise((r) => setTimeout(r, 30))
      }
    } catch (err) {
      console.warn('[FocusKeeper/win] restore 失败：', err)
    }
  }

  dispose(): void {
    this.saved = null
  }
}
