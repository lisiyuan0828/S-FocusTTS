/**
 * 设置界面逻辑（M5 · MVP，原生 TS）
 *
 * 职责：
 *   - 启动后拉取当前配置 + 诊断信息并回填到界面
 *   - 用户修改控件 → 调 updateSetting 写回；短暂提示"已保存"
 *   - 订阅诊断信息更新（权限状态变化时主进程主动推）
 *
 * 注意：这一层故意保持极简（~150 行），M5 结束时若功能增多再迁 React
 */
import type { AppSettings, Diagnostics, RebindShortcutResult } from '../../shared/types'

declare global {
  interface Window {
    settingsAPI: {
      getSettings(): Promise<AppSettings>
      updateSetting<K extends keyof AppSettings>(
        k: K,
        v: AppSettings[K]
      ): Promise<AppSettings>
      rebindShortcut(accel: string): Promise<RebindShortcutResult>
      getDiagnostics(): Promise<Diagnostics>
      openAccessibility(): void
      openPath(p: string): void
      openExternal(url: string): void
      onDiagnosticsUpdate(cb: (d: Diagnostics) => void): void
    }
  }
}

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T

// 控件引用
const shortcutDisplay = $<HTMLElement>('shortcutDisplay')
const kbdCapture = $<HTMLElement>('kbdCapture')
const kbdRecordBtn = $<HTMLButtonElement>('kbdRecordBtn')
const showShortcutHint = $<HTMLInputElement>('showShortcutHint')
const orbSizeSeg = $<HTMLElement>('orbSizeSeg')
const injectMode = $<HTMLSelectElement>('injectMode')
const asrLanguage = $<HTMLSelectElement>('asrLanguage')
const launchAtLogin = $<HTMLInputElement>('launchAtLogin')
const alwaysShow = $<HTMLInputElement>('alwaysShow')

const permSection = $<HTMLElement>('permSection')
const permStatus = $<HTMLElement>('permStatus')
const openAxBtn = $<HTMLButtonElement>('openAx')

const diagVersion = $<HTMLElement>('diagVersion')
const diagPlatform = $<HTMLElement>('diagPlatform')
// v2 UI 新增：顶栏版本号
const appbarVersion = document.getElementById('appbarVersion')
// v2 UI 新增：语言列表（替代下拉）
const langList = document.getElementById('langList')
const diagRecordingsDir = $<HTMLElement>('diagRecordingsDir')
const openRecordingsBtn = $<HTMLButtonElement>('openRecordings')
const diagWhisperBin = $<HTMLElement>('diagWhisperBin')
const diagWhisperBinState = $<HTMLElement>('diagWhisperBinState')
const diagModel = $<HTMLElement>('diagModel')
const diagModelState = $<HTMLElement>('diagModelState')

const saveHint = $<HTMLElement>('saveHint')

let saveHintTimer: number | null = null
/**
 * 轻量 toast。tone='success' 默认青绿色，'error' 为红色。
 * 所有状态变化提示全部走这个入口，保证反馈位置一致（右下状态栏）。
 */
function flashToast(
  text: string = '✔ 已保存',
  tone: 'success' | 'error' = 'success'
): void {
  saveHint.textContent = text
  saveHint.dataset['tone'] = tone
  saveHint.classList.add('show')
  if (saveHintTimer) window.clearTimeout(saveHintTimer)
  // 错误多给点时间让用户看完
  const ms = tone === 'error' ? 2000 : 1200
  saveHintTimer = window.setTimeout(() => {
    saveHint.classList.remove('show')
  }, ms)
}

/** 常规“已保存”调用，保留原名以免大面积改名 */
function flashSaved(): void {
  flashToast()
}

function renderSettings(s: AppSettings): void {
  setShortcutKeycaps(s.shortcut)
  injectMode.value = s.injectMode
  asrLanguage.value = s.asrLanguage
  applyLangListUI(s.asrLanguage)
  launchAtLogin.checked = !!s.launchAtLogin
  showShortcutHint.checked = !!s.showShortcutHint
  alwaysShow.checked = s.alwaysShow !== false
  applyOrbSizeUI(s.orbSize)
}

/** v2 UI：把当前语言值映射到 .lang-list__item 上的 aria-checked */
function applyLangListUI(value: AppSettings['asrLanguage']): void {
  if (!langList) return
  langList.querySelectorAll<HTMLElement>('.lang-list__item').forEach((item) => {
    const active = item.dataset['value'] === value
    item.setAttribute('aria-checked', active ? 'true' : 'false')
  })
}

function applyOrbSizeUI(size: AppSettings['orbSize']): void {
  orbSizeSeg.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    const active = btn.dataset['value'] === size
    btn.classList.toggle('is-active', active)
    btn.setAttribute('aria-checked', active ? 'true' : 'false')
  })
}

function renderDiagnostics(d: Diagnostics): void {
  diagVersion.textContent = d.appVersion
  if (appbarVersion) appbarVersion.textContent = `v${d.appVersion}`
  diagPlatform.textContent = `${d.platform} / ${d.arch}`
  diagRecordingsDir.textContent = d.recordingsDir
  diagWhisperBin.textContent = d.whisperBinPath
  setPill(diagWhisperBinState, d.whisperBinExists, '已就绪', '缺失')
  diagModel.textContent = d.modelPath
  setPill(diagModelState, d.modelExists, '已就绪', '缺失')

  // 仅 mac 展示权限区
  if (d.platform === 'darwin' && d.accessibilityStatus) {
    permSection.hidden = false
    renderAxStatus(d.accessibilityStatus)
  } else {
    permSection.hidden = true
  }
}

function setPill(
  el: HTMLElement,
  ok: boolean,
  okText: string,
  badText: string
): void {
  el.textContent = ok ? okText : badText
  el.classList.remove('pill-gray', 'pill-green', 'pill-red', 'pill-yellow')
  el.classList.add(ok ? 'pill-green' : 'pill-red')
}

function renderAxStatus(status: NonNullable<Diagnostics['accessibilityStatus']>): void {
  permStatus.classList.remove('pill-gray', 'pill-green', 'pill-red', 'pill-yellow')
  switch (status) {
    case 'authorized':
      permStatus.textContent = '已授权'
      permStatus.classList.add('pill-green')
      break
    case 'denied':
      permStatus.textContent = '未授权'
      permStatus.classList.add('pill-red')
      break
    case 'not-determined':
      permStatus.textContent = '未决定'
      permStatus.classList.add('pill-yellow')
      break
    case 'unsupported':
    default:
      permStatus.textContent = '未知'
      permStatus.classList.add('pill-gray')
      break
  }
}

// ─────────────────────────────────────────────
// 快捷键录制：点击"修改"→ 监听下一次 keydown → 转为 accelerator → 试注册
// ─────────────────────────────────────────────

/** 把浏览器 KeyboardEvent 映射成 Electron accelerator 字符串 */
function keyboardEventToAccelerator(e: KeyboardEvent): string | null {
  const parts: string[] = []
  const isMac = navigator.userAgent.includes('Mac')

  // 修饰键：用 CommandOrControl 统一，mac/win 都合法
  if (e.metaKey || e.ctrlKey) parts.push('CommandOrControl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')

  // 跳过纯修饰键按下（code 为 Meta/Control/Shift/Alt 本身）
  const modifierCodes = [
    'MetaLeft',
    'MetaRight',
    'ControlLeft',
    'ControlRight',
    'ShiftLeft',
    'ShiftRight',
    'AltLeft',
    'AltRight',
    'OSLeft',
    'OSRight'
  ]
  if (modifierCodes.includes(e.code)) return null

  // 主键：从 e.code / e.key 映射
  const primary = resolvePrimaryKey(e)
  if (!primary) return null
  parts.push(primary)

  // 必须至少一个修饰键
  if (parts.length < 2) return null
  // 防御：mac 下单 Shift+字母已被系统广泛占用，不强阻但警告
  void isMac

  return parts.join('+')
}

function resolvePrimaryKey(e: KeyboardEvent): string | null {
  const { code, key } = e
  // F 系列
  const fMatch = code.match(/^F(\d{1,2})$/)
  if (fMatch) return `F${fMatch[1]}`
  // 字母
  if (/^Key[A-Z]$/.test(code)) return code.slice(3) // KeyA → A
  // 数字（主区）
  if (/^Digit[0-9]$/.test(code)) return code.slice(5) // Digit1 → 1
  // 小键盘数字
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`
  // 常见键
  const byCode: Record<string, string> = {
    Space: 'Space',
    Tab: 'Tab',
    Enter: 'Return',
    Escape: 'Escape',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Minus: '-',
    Equal: '=',
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    BracketLeft: '[',
    BracketRight: ']',
    Backquote: '`'
  }
  if (byCode[code]) return byCode[code]
  // 兜底：如果 key 是单字符可打印字符
  if (key && key.length === 1 && /[\w\d,./\\;'`\-=\[\]]/.test(key)) {
    return key.toUpperCase()
  }
  return null
}

/** 把 accelerator 美化显示在按钮里（和球下方保持一致） */
function prettifyAccelerator(accel: string): string {
  if (!accel) return '—'
  const isMac = navigator.userAgent.includes('Mac')
  const map: Record<string, string> = isMac
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
        Meta: '⌘'
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
        Meta: 'Win'
      }
  return accel
    .split('+')
    .map((p) => p.trim())
    .map((p) => map[p] ?? p)
    .join(isMac ? '' : '+')
}

/**
 * 把 accelerator 渲染为分体键帽 DOM，写入 #shortcutDisplay。
 * 视觉风格遵循 macOS 系统偏好设置里的快捷键展示，但保持暗色主题。
 */
function setShortcutKeycaps(accel: string): void {
  // 清空旧节点
  while (shortcutDisplay.firstChild) {
    shortcutDisplay.removeChild(shortcutDisplay.firstChild)
  }
  if (!accel) {
    const ph = document.createElement('kbd')
    ph.className = 'kbd-key kbd-key--placeholder'
    ph.textContent = '—'
    shortcutDisplay.appendChild(ph)
    return
  }
  const isMac = navigator.userAgent.includes('Mac')
  const symbolMap: Record<string, string> = isMac
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
        Meta: '⌘'
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
        Meta: 'Win'
      }
  // 修饰键集合（用于决定键帽 modifier 修饰）
  const modifierSet = new Set([
    'CommandOrControl',
    'CmdOrCtrl',
    'Command',
    'Cmd',
    'Control',
    'Ctrl',
    'Alt',
    'Option',
    'Shift',
    'Super',
    'Meta'
  ])
  const tokens = accel.split('+').map((t) => t.trim()).filter(Boolean)
  tokens.forEach((tok) => {
    const key = document.createElement('kbd')
    key.className = 'kbd-key'
    if (modifierSet.has(tok)) key.classList.add('kbd-key--mod')
    // Space / 长键名给予加宽样式，仿物理键
    const wide = tok === 'Space' || tok.length >= 4
    if (wide) key.classList.add('kbd-key--wide')
    // mac 下 Space 用 ⎵ 符号；其他平台仍写 Space
    let label = symbolMap[tok] ?? tok
    if (tok === 'Space' && isMac) label = 'space'
    key.textContent = label
    shortcutDisplay.appendChild(key)
  })
}

let capturing = false

/**
 * 切换快捷键录制态。本轮重构：
 *  - 所有反馈走 toast，不再使用独立的状态提示行
 *  - capturing 态：按钮文案变化 + 容器脉动光晕足够暗示“请按下”
 *  - idle 态：静默恢复，不再占用下方空间
 */
function setCapturingUI(on: boolean): void {
  capturing = on
  kbdCapture.setAttribute('data-state', on ? 'capturing' : 'idle')
  kbdRecordBtn.textContent = on ? '按任意组合键…' : '修改'
}

kbdRecordBtn.addEventListener('click', () => {
  if (capturing) {
    setCapturingUI(false)
    return
  }
  setCapturingUI(true)
})

// 捕获阶段监听，避免其他全局 handler 吃掉事件
window.addEventListener(
  'keydown',
  async (e) => {
    if (!capturing) return
    e.preventDefault()
    e.stopPropagation()

    if (e.key === 'Escape') {
      // 取消静默退出，不再提示“已取消”
      setCapturingUI(false)
      return
    }

    const accel = keyboardEventToAccelerator(e)
    if (!accel) return // 纯修饰键按下，等用户补主键

    // 请求主进程试注册
    try {
      const r = await window.settingsAPI.rebindShortcut(accel)
      if (r.ok) {
        setShortcutKeycaps(r.current)
        setCapturingUI(false)
        flashToast(`✔ 已生效：${prettifyAccelerator(r.current)}`)
      } else {
        // 录制失败：退出 capturing 态，用错误 toast 告知原因，避免用户以为“没反应”
        setCapturingUI(false)
        flashToast(r.message ?? '注册失败，请换一组', 'error')
      }
    } catch (err) {
      console.error('[Settings] rebindShortcut 调用失败：', err)
      setCapturingUI(false)
      flashToast('通信失败，请重试', 'error')
    }
  },
  true
)

showShortcutHint.addEventListener('change', async () => {
  await window.settingsAPI.updateSetting('showShortcutHint', showShortcutHint.checked)
  flashSaved()
})

// 球尺寸 segmented 单选（M5.3）
orbSizeSeg.addEventListener('click', async (e) => {
  const target = (e.target as HTMLElement).closest<HTMLButtonElement>('.seg__btn')
  if (!target) return
  const value = target.dataset['value'] as AppSettings['orbSize']
  if (value !== 'normal' && value !== 'compact') return
  // 乐观更新 UI，并请求 main 应用尺寸 + 落盘
  applyOrbSizeUI(value)
  try {
    await window.settingsAPI.updateSetting('orbSize', value)
    flashSaved()
  } catch (err) {
    console.error('[Settings] 切换尺寸失败：', err)
  }
})

// 事件绑定
injectMode.addEventListener('change', async () => {
  await window.settingsAPI.updateSetting(
    'injectMode',
    injectMode.value as AppSettings['injectMode']
  )
  flashSaved()
})

asrLanguage.addEventListener('change', async () => {
  await window.settingsAPI.updateSetting(
    'asrLanguage',
    asrLanguage.value as AppSettings['asrLanguage']
  )
  applyLangListUI(asrLanguage.value as AppSettings['asrLanguage'])
  flashSaved()
})

// v2 UI：语言列表卡片点击 → 写回 select + 触发同步
if (langList) {
  langList.addEventListener('click', async (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('.lang-list__item')
    if (!target) return
    const value = target.dataset['value'] as AppSettings['asrLanguage']
    if (value !== 'zh' && value !== 'en' && value !== 'auto') return
    asrLanguage.value = value
    applyLangListUI(value)
    try {
      await window.settingsAPI.updateSetting('asrLanguage', value)
      flashSaved()
    } catch (err) {
      console.error('[Settings] 切换识别语言失败：', err)
    }
  })
}

launchAtLogin.addEventListener('change', async () => {
  await window.settingsAPI.updateSetting('launchAtLogin', launchAtLogin.checked)
  flashSaved()
})

alwaysShow.addEventListener('change', async () => {
  await window.settingsAPI.updateSetting('alwaysShow', alwaysShow.checked)
  flashSaved()
})

openAxBtn.addEventListener('click', () => {
  window.settingsAPI.openAccessibility()
})

openRecordingsBtn.addEventListener('click', () => {
  const dir = diagRecordingsDir.textContent
  if (dir) window.settingsAPI.openPath(dir)
})

// 订阅诊断信息变化
window.settingsAPI.onDiagnosticsUpdate((d) => {
  renderDiagnostics(d)
})

// 启动加载
async function bootstrap(): Promise<void> {
  try {
    const [settings, diagnostics] = await Promise.all([
      window.settingsAPI.getSettings(),
      window.settingsAPI.getDiagnostics()
    ])
    renderSettings(settings)
    renderDiagnostics(diagnostics)
  } catch (err) {
    console.error('[Settings] bootstrap 失败：', err)
  }
}
void bootstrap()

export {}
