/**
 * FocusKeeper —— 焦点保持（占位）
 *
 * 当前里程碑（M4）结论：
 *   orb 窗口已配置 `focusable:false` + `setIgnoreMouseEvents`，
 *   原焦点在录音期间根本不会丢，注入前无需"回切"。因此本文件暂为占位。
 *
 * 未来里程碑（M5/M6）若发现以下场景再实装：
 *   - 全屏 App 下激活 orb 窗口后焦点意外跳失
 *   - 某些 App 自带 focus 陷阱（如 JetBrains IDE 的模态对话框）
 *   那时引入 `active-win` 记录 + macOS `NSWorkspace.frontmostApplication`
 *   恢复即可。保留本文件名不变，避免再改 project-map。
 */

export class FocusKeeper {
  capture(): void {
    // no-op in M4
  }

  async restore(): Promise<void> {
    // no-op in M4
  }
}
