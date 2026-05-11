
/**
 * orb 窗口的预加载脚本
 *
 * M5：
 *  - 接收 main 推送的 OrbState，驱动 CSS 动画切换
 *  - 把左键点击（停录）/右键点击（上下文菜单）回传给 main
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { OrbHintPayload } from '../shared/types'

type OrbStateType = 'idle' | 'recording' | 'transcribing' | 'injecting' | 'error'
type OrbSizeType = 'normal' | 'compact'

contextBridge.exposeInMainWorld('orbAPI', {
  /** main → orb：状态变更 */
  onState(cb: (state: OrbStateType) => void) {
    ipcRenderer.on(IPC.ORB_STATE, (_e, state: OrbStateType) => cb(state))
  },
  /** main → orb：是否正在说话 */
  onVoiceActive(cb: (active: boolean) => void) {
    ipcRenderer.on(IPC.ORB_VOICE_ACTIVE, (_e, active: boolean) => cb(active))
  },
  /** main → orb：快捷键提示（显示开关 + accelerator） */
  onHint(cb: (hint: OrbHintPayload) => void) {
    ipcRenderer.on(IPC.ORB_HINT, (_e, hint: OrbHintPayload) => cb(hint))
  },
  /** main → orb：尺寸档位（M5.3） */
  onSize(cb: (size: OrbSizeType) => void) {
    ipcRenderer.on(IPC.ORB_SIZE, (_e, size: OrbSizeType) => cb(size))
  },
  /** orb → main：用户左键停录 */
  requestStop() {
    ipcRenderer.send(IPC.ORB_CLICK_STOP)
  },
  /** orb → main：用户右键，显示上下文菜单（main 侧弹 native menu） */
  openContextMenu(x: number, y: number) {
    ipcRenderer.send(IPC.ORB_CONTEXT_MENU, { x, y })
  },
  /**
   * orb → main：开始拖动（鼠标按下时立刻调用；传入鼠标按下那一刻的屏幕坐标）
   * main 会记录鼠标与窗口左上角的偏移，之后靠屏幕坐标轮询跟随
   */
  dragStart(mouseScreenX: number, mouseScreenY: number) {
    ipcRenderer.send(IPC.ORB_DRAG_START, { x: mouseScreenX, y: mouseScreenY })
  },
  /** orb → main：结束拖动（松开鼠标） */
  dragEnd() {
    ipcRenderer.send(IPC.ORB_DRAG_END)
  },
  /** orb → main：没达到拖动阈值，取消拖动（main 会丢弃拖动状态；click 事件正常走 requestStop） */
  dragCancel() {
    ipcRenderer.send(IPC.ORB_DRAG_CANCEL)
  }
})

export {}

