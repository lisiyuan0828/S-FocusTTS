import type { FocusKeeper } from './focus-keeper'

/**
 * mac 平台 FocusKeeper —— 空实现
 *
 * macOS 下 orb 窗口配置：
 *   - type: 'panel'
 *   - focusable: false
 *   - showInactive()
 * 三者合力使点击球不会抢占前台焦点，因此不需要任何记录/还原操作。
 */
export class NoopFocusKeeper implements FocusKeeper {
  snapshot(): void {
    // no-op
  }
  async restore(): Promise<void> {
    // no-op
  }
  dispose(): void {
    // no-op
  }
}
