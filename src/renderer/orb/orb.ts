
/**
 * 呼吸球渲染端逻辑
 *
 * M5 职责：
 *  - 订阅 main 推送的 OrbState，把状态写到根节点 data-state，CSS 驱动动画
 *  - 左键球 → 通知 main 停止录音（等价于二次按快捷键）
 *  - 右键球 → 请求 main 在球附近弹出原生上下文菜单（设置/退出等）
 *  - 长按拖动 → 通知 main 移动球窗口（main 侧用 screen.getCursorScreenPoint 轮询跟随）
 *
 * M6 新增：
 *  - 球核改为 Three.js 3D 粒子宇宙漩涡（DEC-004）
 *  - state/voice/size 变化 → 同步驱动粒子系统的档位
 */

import { ParticleSystem } from './particle-system'

type OrbStateType = 'idle' | 'recording' | 'transcribing' | 'injecting' | 'error'
type OrbSizeType = 'normal' | 'compact'
type OrbHintPayload = { show: boolean; accelerator: string }

declare global {
  interface Window {
    orbAPI?: {
      onState(cb: (state: OrbStateType) => void): void
      onVoiceActive(cb: (active: boolean) => void): void
      onHint(cb: (hint: OrbHintPayload) => void): void
      onSize(cb: (size: OrbSizeType) => void): void
      requestStop(): void
      openContextMenu(x: number, y: number): void
      dragStart(mouseScreenX: number, mouseScreenY: number): void
      dragEnd(): void
      dragCancel(): void
    }
  }
}

console.log('[Orb] mounted')

/** 进入拖动态的位移阈值（px）—— 低于此值视作 click */
const DRAG_THRESHOLD_PX = 4

// 防止意外的系统右键菜单/拖拽图像（不影响我们自定义的 mousedown 逻辑）
window.addEventListener('contextmenu', (e) => e.preventDefault())
window.addEventListener('dragstart', (e) => e.preventDefault())

const orbEl = document.getElementById('orb')!
const hitEl = document.getElementById('orbHit')!
const hintEl = document.getElementById('orbHint') as HTMLElement
const hintKbdEl = document.getElementById('orbHintKbd') as HTMLElement
const canvasEl = document.getElementById('orbCanvas') as HTMLCanvasElement

// ── 粒子系统（M6） ─────────────────────────
// 当前缓存：state / voiceActive / size —— 任一变更都要回传给粒子
let curState: OrbStateType = 'idle'
let curVoice = false
let curSize: OrbSizeType = 'normal'

const particles = new ParticleSystem(canvasEl)
particles.mount()
particles.setTarget(curState, curVoice, curSize)

// 窗口/球尺寸变化时让粒子 canvas 同步
const resizeObserver = new ResizeObserver(() => particles.resize())
resizeObserver.observe(hitEl)

function syncParticles(): void {
  particles.setTarget(curState, curVoice, curSize)
}

function applyState(state: OrbStateType): void {
  orbEl.setAttribute('data-state', state)
  curState = state
  syncParticles()
}

function applyVoiceActive(active: boolean): void {
  orbEl.setAttribute('data-voice', active ? 'active' : 'silent')
  curVoice = active
  syncParticles()
}

function applySize(size: OrbSizeType): void {
  orbEl.setAttribute('data-size', size)
  curSize = size
  // compact 下强制隐藏 hint（与 CSS 双保险）
  if (size === 'compact') {
    hintEl.hidden = true
  }
  // 尺寸变后给粒子 canvas 一帧时间重新 layout，再 resize + 切档
  requestAnimationFrame(() => {
    particles.resize()
    syncParticles()
  })
}

/** 把 accelerator 按平台美化显示（mac 用符号，win/linux 用文字） */
function prettifyAccelerator(accel: string): string {
  if (!accel) return ''
  const isMac = navigator.userAgent.includes('Mac')
  const map = isMac
    ? {
        CommandOrControl: '⌘',
        CmdOrCtrl: '⌘',
        Command: '⌘',
        Cmd: '⌘',
        Control: '⌃',
        Ctrl: '⌃',
        Alt: '⌥',
        Option: '⌥',
        Shift: '⇧',
        Super: '⌘',
        Meta: '⌘',
        Space: 'Space'
      }
    : {
        CommandOrControl: 'Ctrl',
        CmdOrCtrl: 'Ctrl',
        Command: 'Win',
        Cmd: 'Win',
        Control: 'Ctrl',
        Ctrl: 'Ctrl',
        Alt: 'Alt',
        Option: 'Alt',
        Shift: 'Shift',
        Super: 'Win',
        Meta: 'Win',
        Space: 'Space'
      }
  return accel
    .split('+')
    .map((p) => p.trim())
    .map((p) => (map as Record<string, string>)[p] ?? p)
    .join(isMac ? '' : '+')
}

function applyHint(hint: OrbHintPayload): void {
  // compact 尺寸下任何情况都不显示 hint
  const currentSize = orbEl.getAttribute('data-size') ?? 'normal'
  if (currentSize === 'compact' || !hint.show || !hint.accelerator) {
    hintEl.hidden = true
    return
  }
  hintKbdEl.textContent = prettifyAccelerator(hint.accelerator)
  hintEl.hidden = false
}

// 订阅状态
window.orbAPI?.onState((state) => applyState(state))
window.orbAPI?.onVoiceActive((active) => applyVoiceActive(active))
window.orbAPI?.onHint((hint) => applyHint(hint))
window.orbAPI?.onSize((size) => applySize(size))

// ─────────────────────────────────────────────
// click vs drag 状态机
// ─────────────────────────────────────────────

type PressCtx = {
  startScreenX: number
  startScreenY: number
  dragging: boolean
}

let press: PressCtx | null = null

hitEl.addEventListener('mousedown', (e) => {
  // 仅响应左键；右键走独立的 contextmenu 事件分支
  if (e.button !== 0) return
  e.preventDefault()
  e.stopPropagation()
  press = {
    startScreenX: Math.round(e.screenX),
    startScreenY: Math.round(e.screenY),
    dragging: false
  }
})

// 在 window 级别监听 move/up，避免鼠标滑出命中区后丢事件
window.addEventListener('mousemove', (e) => {
  if (!press) return
  if (press.dragging) return
  const dx = Math.round(e.screenX) - press.startScreenX
  const dy = Math.round(e.screenY) - press.startScreenY
  if (Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
    press.dragging = true
    // 传入当前鼠标屏幕坐标，main 侧会算出"鼠标→窗口左上角"的偏移并开始跟随
    window.orbAPI?.dragStart(press.startScreenX, press.startScreenY)
  }
})

window.addEventListener('mouseup', (e) => {
  if (!press) return
  if (e.button !== 0) {
    // 右键松开不影响左键 press 状态（一般不会发生，保险）
    return
  }
  if (press.dragging) {
    window.orbAPI?.dragEnd()
  } else {
    // 没达到拖动阈值，视作单击 → 停录
    window.orbAPI?.dragCancel()
    window.orbAPI?.requestStop()
  }
  press = null
})

// 窗口失焦/页面隐藏时，兜底清理 press 状态，防止 main 侧拖动会话悬空
window.addEventListener('blur', () => {
  if (press?.dragging) {
    window.orbAPI?.dragEnd()
  }
  press = null
})

// 右键 → 请求 main 弹出原生菜单；把屏幕坐标传过去
hitEl.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  e.stopPropagation()
  // 右键不走 mousedown/up 流程，直接弹菜单
  press = null
  window.orbAPI?.openContextMenu(Math.round(e.screenX), Math.round(e.screenY))
})

export {}

