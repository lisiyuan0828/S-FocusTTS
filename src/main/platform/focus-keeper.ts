/**
 * FocusKeeper —— 跨平台"前台窗口焦点保持器"
 *
 * 背景（D-M5-1）：
 * 球改为可点击后，点击球必然让球窗口获得输入焦点，导致"用户刚才在打字的那个应用"
 * 失去前台，后续 keyboard/clipboard 注入要么打到球窗口，要么打飞。
 *
 * 职责：
 *   snapshot() → 在「球被点击前」记录当前真正的前台窗口（不是球自己）
 *   restore()  → 在「执行注入前」把刚才记录的窗口还原为前台
 *
 * 实现分化：
 *   macOS：panel 窗口天然不抢焦点（focusable:false + type:'panel'），空实现即可
 *   Windows：点击球真的会抢焦点，需要借助原生 API 读 HWND 并还原
 *
 * 这里定义接口 + 工厂，具体实现在同目录兄弟文件里。
 */

export interface FocusKeeper {
  /** 记录当前前台窗口（在用户触发会抢焦点的交互之前调用） */
  snapshot(): void
  /** 还原到 snapshot 记录的窗口（在注入前调用） */
  restore(): Promise<void>
  /** 清理资源 */
  dispose(): void
}

export async function createFocusKeeper(): Promise<FocusKeeper> {
  if (process.platform === 'win32') {
    const { WinFocusKeeper } = await import('./focus-keeper-win')
    return new WinFocusKeeper()
  }
  const { NoopFocusKeeper } = await import('./focus-keeper-mac')
  return new NoopFocusKeeper()
}
