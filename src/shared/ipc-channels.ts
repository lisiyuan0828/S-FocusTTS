
/**
 * IPC 通道常量
 * 约定：main→renderer 用 `m2r:` 前缀；renderer→main 用 `r2m:` 前缀
 */
export const IPC = {
  // ── 录音（M2） ─────────────────────────────
  /** main → recorder renderer：开始录音 */
  RECORD_START: 'm2r:record/start',
  /** main → recorder renderer：停止录音 */
  RECORD_STOP: 'm2r:record/stop',
  /** recorder renderer → main：推送一块 PCM16LE 数据（ArrayBuffer） */
  RECORD_PCM_CHUNK: 'r2m:record/pcm-chunk',
  /** recorder renderer → main：录音出错（权限、设备等） */
  RECORD_ERROR: 'r2m:record/error',
  /** recorder renderer → main：renderer 端已实际开始/停止（握手回执，便于排障） */
  RECORD_ACK: 'r2m:record/ack',

  // ── Orb 状态（M5） ─────────────────────────
  /** main → orb renderer：推送 OrbState 变更 */
  ORB_STATE: 'm2r:orb/state',
  /** main → orb renderer：推送"是否正在说话"（true=active / false=silent） */
  ORB_VOICE_ACTIVE: 'm2r:orb/voice-active',
  /** main → orb renderer：推送快捷键提示（显示开关 + accelerator 文本） */
  ORB_HINT: 'm2r:orb/hint',
  /** main → orb renderer：推送尺寸档位（normal/compact，驱动 CSS data-size） */
  ORB_SIZE: 'm2r:orb/size',
  /** orb renderer → main：用户左键点击球（等价于二次快捷键） */
  ORB_CLICK_STOP: 'r2m:orb/click-stop',
  /** orb renderer → main：用户右键球，弹出上下文菜单 */
  ORB_CONTEXT_MENU: 'r2m:orb/context-menu',
  /** orb renderer → main：拖动开始（传入鼠标按下时的屏幕坐标） */
  ORB_DRAG_START: 'r2m:orb/drag-start',
  /** orb renderer → main：拖动结束（松开鼠标） */
  ORB_DRAG_END: 'r2m:orb/drag-end',
  /** orb renderer → main：取消拖动（没有超过阈值，视作 click） */
  ORB_DRAG_CANCEL: 'r2m:orb/drag-cancel',

  // ── 录音 · 音量 Voice Activity（M5.2） ─────
  /** recorder renderer → main：当前窗口 RMS 音量（0..1） */
  RECORD_VOICE_LEVEL: 'r2m:record/voice-level',

  // ── 设置（M5） ─────────────────────────────
  /** settings renderer → main：读取当前配置 */
  SETTINGS_GET: 'r2m:settings/get',
  /** settings renderer → main：更新一项配置 */
  SETTINGS_SET: 'r2m:settings/set',
  /** settings renderer → main：尝试重绑录音快捷键（试注册 + 失败回退） */
  SETTINGS_REBIND_SHORTCUT: 'r2m:settings/rebind-shortcut',
  /** settings renderer → main：打开外部链接/目录 */
  SETTINGS_OPEN_EXTERNAL: 'r2m:settings/open-external',
  /** settings renderer → main：打开 macOS 辅助功能设置 */
  SETTINGS_OPEN_ACCESSIBILITY: 'r2m:settings/open-accessibility',
  /** settings renderer → main：获取系统诊断信息（版本、路径、权限态） */
  SETTINGS_DIAGNOSTICS: 'r2m:settings/diagnostics',
  /** main → settings renderer：诊断信息变化（权限状态等） */
  SETTINGS_DIAGNOSTICS_UPDATE: 'm2r:settings/diagnostics-update'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

