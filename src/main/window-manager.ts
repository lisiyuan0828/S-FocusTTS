import { BrowserWindow, screen } from 'electron'
import path from 'node:path'
import {
  ORB_WINDOW_SIZE,
  ORB_WINDOW_SIZE_COMPACT,
  ORB_HINT_EXTRA_HEIGHT,
  AUDIO,
  OrbState,
  OrbSize,
  type OrbStateType,
  type OrbSizeType
} from '@shared/constants'
import { IPC } from '@shared/ipc-channels'
import type { OrbHintPayload } from '@shared/types'

/**
 * 窗口管理器
 *
 * M1：仅 orb（呼吸球）窗口
 * M2：新增 recorder 隐藏窗口，用于 getUserMedia + AudioWorklet 采集 PCM
 * M5：orb 改为可点击（左键停止/右键菜单），但仍不抢用户原焦点
 *      - mac：panel 面板 + focusable:false → 天然不抢焦点
 *      - win：普通窗口 + focusable:false + showInactive + FocusKeeper 记录前台窗口
 *     新增 settings 窗口（按需创建）
 */
export class WindowManager {
  private orbWindow: BrowserWindow | null = null
  private recorderWindow: BrowserWindow | null = null
  private recorderReady: Promise<void> | null = null
  private settingsWindow: BrowserWindow | null = null

  private lastOrbState: OrbStateType = OrbState.Idle
  /** M5.2：最新一次推送给 orb 的 hint 快照（窗口重载后补推用） */
  private lastOrbHint: OrbHintPayload = { show: true, accelerator: '' }
  /** M5.2：最新一次推送给 orb 的"是否正在说话"快照 */
  private lastVoiceActive = false
  /** M5.3：球当前尺寸档位（normal/compact） */
  private lastOrbSize: OrbSizeType = OrbSize.Normal
  /** M5.3：球的持久化位置（null = 用屏幕中央）；拖动结束时回写 */
  private orbPosition: { x: number; y: number } | null = null
  /** M5.3：拖动结束时持久化位置的回调（由主入口注入到 ConfigStore） */
  private onOrbPositionCommit: ((pos: { x: number; y: number }) => void) | null = null

  // ── Orb 拖动会话（M5） ─────────────────────
  /** 拖动会话的 interval 句柄；null 表示当前无拖动 */
  private orbDragTimer: NodeJS.Timeout | null = null
  /** 鼠标按下那一刻，鼠标屏幕坐标 - 窗口左上角屏幕坐标 的偏移 */
  private orbDragOffsetX = 0
  private orbDragOffsetY = 0

  /** 取得（或创建）呼吸球窗口 */
  private ensureOrbWindow(): BrowserWindow {
    if (this.orbWindow && !this.orbWindow.isDestroyed()) {
      return this.orbWindow
    }

    const isMac = process.platform === 'darwin'
    const { width: orbWinWidth, height: orbWinHeight } = this.computeOrbWindowBounds()

    const win = new BrowserWindow({
      width: orbWinWidth,
      height: orbWinHeight,
      show: false, // 手动控制显示
      frame: false,
      transparent: true,
      // ⭐ 关键：显式声明纯透明背景，彻底消除"黑色方框"外观（mac/win 都需要）
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      skipTaskbar: true,
      focusable: false, // ⭐ 关键：不抢用户原焦点（mac 靠 panel，win 靠这个 + showInactive）
      hasShadow: false,
      // ⭐ M5.3 修复：roundedCorners=true 会让 mac 给透明窗口加一层默认底色用于裁切，
      // compact 尺寸下这层底色会露出成"圆角矩形外框"。我们身也已用 CSS border-radius:50%
      // 自己裁了球体，不需要系统再帮做窗口圆角
      roundedCorners: false,
      // mac：panel 类型让窗口可以接收鼠标事件但不激活为 key window；win 上忽略
      // @ts-expect-error - type 仅部分平台支持，但设置是安全的
      type: isMac ? 'panel' : undefined,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: path.join(__dirname, '../preload/orb-preload.js')
      }
    })

    // 最高层级（覆盖全屏应用），不同平台值不同
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    // M5：球可交互（不再整窗穿透）；具体点击区由 CSS pointer-events 细粒度控制
    win.setIgnoreMouseEvents(false)

    // 加载 renderer（dev vs prod）
    // 把当前 orb size 作为 query 传过去，让 renderer 在脚本最早期立刻把
    // <div id="orb"> 的 data-size 设成对的值，避免"先 normal 后 compact"闪烁
    const sizeQuery = `?size=${this.lastOrbSize}`
    if (process.env['ELECTRON_RENDERER_URL']) {
      win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/orb/index.html${sizeQuery}`)
    } else {
      win.loadFile(path.join(__dirname, '../renderer/orb/index.html'), {
        search: sizeQuery.slice(1)
      })
    }

    // 窗口 webContents 每次加载完成后，补推最新状态（防止首帧 idle 被覆盖）
    win.webContents.on('did-finish-load', () => {
      win.webContents.send(IPC.ORB_STATE, this.lastOrbState)
      win.webContents.send(IPC.ORB_HINT, this.lastOrbHint)
      win.webContents.send(IPC.ORB_VOICE_ACTIVE, this.lastVoiceActive)
      win.webContents.send(IPC.ORB_SIZE, this.lastOrbSize)
    })

    this.orbWindow = win
    return win
  }

  /**
   * 根据当前 size + hint 开关计算 orb 窗口尺寸（宽高）
   *
   * - normal：220×220（+ hint 时再加 36 高）
   * - compact：64×64（不显示 hint —— 小球驻留角落，再挂 hint 失去紧凑意义）
   */
  private computeOrbWindowBounds(): { width: number; height: number } {
    if (this.lastOrbSize === OrbSize.Compact) {
      return { width: ORB_WINDOW_SIZE_COMPACT, height: ORB_WINDOW_SIZE_COMPACT }
    }
    const h = this.lastOrbHint.show
      ? ORB_WINDOW_SIZE + ORB_HINT_EXTRA_HEIGHT
      : ORB_WINDOW_SIZE
    return { width: ORB_WINDOW_SIZE, height: h }
  }

  /** 兼容旧调用方 */
  private computeOrbWindowHeight(): number {
    return this.computeOrbWindowBounds().height
  }

  /**
   * 将呼吸球显示在：
   *   - 如果有持久化位置 & 位置仍在可见屏幕内 → 还原到持久化位置
   *   - 否则 → 鼠标所在屏幕的正中央
   */
  showOrb(): void {
    const win = this.ensureOrbWindow()
    const { width: winW, height: winH } = this.computeOrbWindowBounds()

    const target = this.resolveOrbBounds(winW, winH)
    win.setBounds({ x: target.x, y: target.y, width: winW, height: winH })
    win.showInactive() // 显示但不抢焦点（win 上配合 focusable:false 近似 mac panel）
  }

  /**
   * 根据 "持久化位置 / 当前屏幕 / 鼠标位置" 决定本次 orb 应该放哪
   *
   * 规则：
   *   1. 若有持久化位置，且它仍落在某个可见 display 的 workArea 内 → 用持久化位置
   *      （容忍：球的中心在屏幕内即可，不需要整窗口都在）
   *   2. 否则 → 鼠标所在屏幕的正中央
   */
  private resolveOrbBounds(winW: number, winH: number): { x: number; y: number } {
    if (this.orbPosition) {
      const cx = this.orbPosition.x + winW / 2
      const cy = this.orbPosition.y + winH / 2
      const onDisplay = screen.getAllDisplays().some((d) => {
        const { x, y, width, height } = d.workArea
        return cx >= x && cx <= x + width && cy >= y && cy <= y + height
      })
      if (onDisplay) {
        return { x: Math.round(this.orbPosition.x), y: Math.round(this.orbPosition.y) }
      }
      // 记录的位置已经不在任何屏幕内（外接显示器拔掉了）→ 丢弃，落到中央
    }
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const { x, y, width, height } = display.workArea
    return {
      x: Math.round(x + (width - winW) / 2),
      y: Math.round(y + (height - winH) / 2)
    }
  }

  /** 隐藏呼吸球 */
  hideOrb(): void {
    this.endOrbDrag()
    if (this.orbWindow && !this.orbWindow.isDestroyed()) {
      this.orbWindow.hide()
    }
  }

  /** 给 orb 推送 UI 状态变更 */
  setOrbState(state: OrbStateType): void {
    this.lastOrbState = state
    if (this.orbWindow && !this.orbWindow.isDestroyed()) {
      this.orbWindow.webContents.send(IPC.ORB_STATE, state)
    }
  }

  /**
   * 设置球下方快捷键提示（M5.2）
   *
   * - show 变化时，必须同步调整 orb 窗口高度（展开/收起提示条的空间）
   * - accelerator 空或 show=false 时 renderer 侧会隐藏整条
   */
  setOrbHint(hint: OrbHintPayload): void {
    const prevShow = this.lastOrbHint.show
    const heightShouldChange = prevShow !== hint.show
    this.lastOrbHint = { ...hint }

    if (this.orbWindow && !this.orbWindow.isDestroyed()) {
      // 仅当球正在可见、处于 normal 尺寸、且开关状态真的变了，才动态调整窗口高度/位置
      // （compact 模式恒不显示 hint，无需折腾高度）
      if (
        this.lastOrbSize === OrbSize.Normal &&
        heightShouldChange &&
        this.orbWindow.isVisible()
      ) {
        const newH = this.computeOrbWindowHeight()
        const oldH = prevShow
          ? ORB_WINDOW_SIZE + ORB_HINT_EXTRA_HEIGHT
          : ORB_WINDOW_SIZE
        const [wx, wy] = this.orbWindow.getPosition()
        // 保持球视觉中心不动：窗口高度变化时同步上移/下移窗口
        const dy = Math.round((oldH - newH) / 2)
        this.orbWindow.setBounds({
          x: wx,
          y: wy + dy,
          width: ORB_WINDOW_SIZE,
          height: newH
        })
      }
      this.orbWindow.webContents.send(IPC.ORB_HINT, hint)
    }
  }

  /** 推送"是否正在说话"（M5.2） */
  setOrbVoiceActive(active: boolean): void {
    if (this.lastVoiceActive === active) return
    this.lastVoiceActive = active
    if (this.orbWindow && !this.orbWindow.isDestroyed()) {
      this.orbWindow.webContents.send(IPC.ORB_VOICE_ACTIVE, active)
    }
  }

  // ─────────────────────────────────────────────
  // Orb 拖动（M5）
  //
  // 实现思路（D-M5 拖动方案 D）：
  //   renderer 在 mousedown 超过阈值后调用 startOrbDrag，传入鼠标按下那一刻的
  //   屏幕坐标 (mx, my)。main 计算偏移 offset = mouse - windowTopLeft，
  //   之后用 setInterval 16ms 轮询 screen.getCursorScreenPoint() 更新窗口位置：
  //     newX = cursor.x - offsetX
  //     newY = cursor.y - offsetY
  //   这样做的好处：
  //     - 不依赖 renderer 持续的 mousemove 事件（focusable:false 下这些事件会丢）
  //     - mac/win 完全一致，绕开 panel 窗口对 app-region 的限制
  //     - 主进程主导，状态机干净
  // ─────────────────────────────────────────────

  /** 开始拖动 orb：传入鼠标按下时的屏幕坐标 */
  startOrbDrag(mouseScreenX: number, mouseScreenY: number): void {
    const win = this.orbWindow
    if (!win || win.isDestroyed() || !win.isVisible()) return

    // 先停掉旧的拖动会话（防御性）
    this.endOrbDrag()

    const [winX, winY] = win.getPosition()
    this.orbDragOffsetX = mouseScreenX - winX
    this.orbDragOffsetY = mouseScreenY - winY

    // 16ms ≈ 60fps；setInterval 在主进程够稳
    this.orbDragTimer = setInterval(() => {
      const w = this.orbWindow
      if (!w || w.isDestroyed() || !w.isVisible()) {
        this.endOrbDrag()
        return
      }
      const p = screen.getCursorScreenPoint()
      const nx = Math.round(p.x - this.orbDragOffsetX)
      const ny = Math.round(p.y - this.orbDragOffsetY)
      // setPosition 不触发 focus，在 mac panel / win focusable:false 下都安全
      w.setPosition(nx, ny)
    }, 16)
  }

  /** 结束拖动 orb（无论是 mouseup / blur / window 隐藏都调用它） */
  endOrbDrag(): void {
    if (this.orbDragTimer) {
      clearInterval(this.orbDragTimer)
      this.orbDragTimer = null
      // 拖动结束后把最终位置写入内存 + 回调落盘
      this.captureOrbPosition()
    }
  }

  /** 从窗口读取当前位置，更新内存并通过回调持久化 */
  private captureOrbPosition(): void {
    const win = this.orbWindow
    if (!win || win.isDestroyed()) return
    const [x, y] = win.getPosition()
    this.orbPosition = { x, y }
    if (this.onOrbPositionCommit) {
      this.onOrbPositionCommit({ x, y })
    }
  }

  // ─────────────────────────────────────────────
  // 位置记忆 & 尺寸切换（M5.3）
  // ─────────────────────────────────────────────

  /** 注入"位置变更回调"（由主入口连到 ConfigStore.set('orbPosition', ...)） */
  setOrbPositionCommitter(cb: (pos: { x: number; y: number }) => void): void {
    this.onOrbPositionCommit = cb
  }

  /** 启动时从 ConfigStore 还原上次的位置（null 表示无记忆） */
  restoreOrbPosition(pos: { x: number; y: number } | null): void {
    this.orbPosition = pos ? { x: pos.x, y: pos.y } : null
  }

  /**
   * 切换球的尺寸档位（M5.3）
   *
   * - 同步更新 lastOrbSize
   * - 若球当前可见：以"球视觉中心"为锚点，重排窗口 bounds（避免右下角缩小后球飞到别处）
   * - 向 renderer 推送 ORB_SIZE，让 CSS data-size 驱动内部动画
   */
  setOrbSize(size: OrbSizeType): void {
    if (this.lastOrbSize === size) return
    const prev = this.computeOrbWindowBounds()
    this.lastOrbSize = size
    const next = this.computeOrbWindowBounds()

    const win = this.orbWindow
    if (win && !win.isDestroyed() && win.isVisible()) {
      const [wx, wy] = win.getPosition()
      // 以视觉中心为锚点重新定位
      const dx = Math.round((prev.width - next.width) / 2)
      const dy = Math.round((prev.height - next.height) / 2)
      const newX = wx + dx
      const newY = wy + dy
      win.setBounds({ x: newX, y: newY, width: next.width, height: next.height })
      // 新位置同步到内存 + 持久化（不然缩小后再隐藏，下次还原会用旧位置）
      this.orbPosition = { x: newX, y: newY }
      this.onOrbPositionCommit?.({ x: newX, y: newY })
    }

    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.ORB_SIZE, size)
    }
  }

  /** 是否有可见的 orb */
  isOrbVisible(): boolean {
    return !!this.orbWindow && !this.orbWindow.isDestroyed() && this.orbWindow.isVisible()
  }

  /** 获取 orb 窗口引用（给托盘/菜单等用） */
  getOrbWindow(): BrowserWindow | null {
    return this.orbWindow
  }

  /** 退出前清理 */
  dispose(): void {
    this.endOrbDrag()

    if (this.orbWindow && !this.orbWindow.isDestroyed()) {
      this.orbWindow.destroy()
    }
    this.orbWindow = null

    if (this.recorderWindow && !this.recorderWindow.isDestroyed()) {
      this.recorderWindow.destroy()
    }
    this.recorderWindow = null
    this.recorderReady = null

    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.settingsWindow.destroy()
    }
    this.settingsWindow = null
  }

  // ─────────────────────────────────────────────
  // recorder 隐藏窗口（M2）
  // ─────────────────────────────────────────────

  /** 取得（或创建）录音窗口，等待页面加载完成 */
  private async ensureRecorderWindow(): Promise<BrowserWindow> {
    if (this.recorderWindow && !this.recorderWindow.isDestroyed() && this.recorderReady) {
      await this.recorderReady
      return this.recorderWindow
    }

    const win = new BrowserWindow({
      width: 1,
      height: 1,
      show: false, // 永远不显示
      frame: false,
      transparent: true,
      skipTaskbar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // 允许在 loopback 场景下不需要 user gesture 的 getUserMedia
        // （Electron 的 session 默认会接受 setPermissionRequestHandler 的结果）
        preload: path.join(__dirname, '../preload/recorder-preload.js')
      }
    })

    this.recorderWindow = win

    this.recorderReady = new Promise<void>((resolve) => {
      win.webContents.once('did-finish-load', () => resolve())
    })

    if (process.env['ELECTRON_RENDERER_URL']) {
      await win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/recorder/index.html`)
    } else {
      await win.loadFile(path.join(__dirname, '../renderer/recorder/index.html'))
    }

    await this.recorderReady
    return win
  }

  /** 通知 renderer 开始录音 */
  async sendRecordStart(): Promise<void> {
    const win = await this.ensureRecorderWindow()
    win.webContents.send(IPC.RECORD_START, {
      sampleRate: AUDIO.SAMPLE_RATE,
      channels: AUDIO.CHANNELS
    })
  }

  /** 通知 renderer 停止录音 */
  async sendRecordStop(): Promise<void> {
    if (!this.recorderWindow || this.recorderWindow.isDestroyed()) return
    this.recorderWindow.webContents.send(IPC.RECORD_STOP)
  }

  // ─────────────────────────────────────────────
  // settings 窗口（M5）
  // ─────────────────────────────────────────────

  /** 显示（或聚焦）设置窗口 */
  showSettings(): void {
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      if (this.settingsWindow.isMinimized()) this.settingsWindow.restore()
      this.settingsWindow.show()
      this.settingsWindow.focus()
      return
    }

    const win = new BrowserWindow({
      width: 1120,
      height: 760,
      minWidth: 880,
      minHeight: 600,
      show: false,
      title: 'S-FocusTTS · 设置',
      resizable: true,
      minimizable: true,
      maximizable: true,
      backgroundColor: '#0b0e15',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: path.join(__dirname, '../preload/settings-preload.js')
      }
    })

    win.setMenuBarVisibility(false)

    if (process.env['ELECTRON_RENDERER_URL']) {
      win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/settings/index.html`)
    } else {
      win.loadFile(path.join(__dirname, '../renderer/settings/index.html'))
    }

    win.once('ready-to-show', () => win.show())
    win.on('closed', () => {
      this.settingsWindow = null
    })

    this.settingsWindow = win
  }

  /** 获取设置窗口引用 */
  getSettingsWindow(): BrowserWindow | null {
    return this.settingsWindow
  }
}
