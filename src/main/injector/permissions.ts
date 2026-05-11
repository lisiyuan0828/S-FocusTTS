/**
 * 辅助功能（Accessibility）权限工具 —— 仅 macOS 相关
 *
 * 为什么要这层封装？
 *   1. mac 上 nut-js 的 `keyboard.type` 在权限缺失时**不抛异常**、只打 stderr，
 *      导致 InjectorService 的降级链路失效。我们改为"注入前主动查权限"。
 *   2. 统一两种查询源，彼此兜底。
 *
 * 设计决策（D-M4-5 修订版 D-M4-6）：
 *   **权威判据改为 Electron 原生 `systemPreferences.isTrustedAccessibilityClient(false)`**。
 *   原因：
 *   - `node-mac-permissions` 查的是 TCC.db 记录，pnpm 下 Electron 每次安装路径 hash
 *     变动，TCC 里的旧记录会对不上；而 `isTrustedAccessibilityClient` 是 Chromium
 *     底层直接调 `AXIsProcessTrustedWithOptions`，查的是**当前进程实际是否受信任**，
 *     与 nut-js 实际执行时的判断完全一致。
 *   - `node-mac-permissions` 降级为"辅助信号"：用它的 `askForAccessibilityAccess`
 *     打开系统设置（因为 Electron 没有直接打开面板的 API）。
 *
 *   - Windows 永远视为已授权（Windows 没有等价概念；真失败由 nut-js 抛错）
 *   - 节流：同一进程内最多引导一次系统设置，避免反复弹面板骚扰
 */

import { systemPreferences, app, shell } from 'electron'

const isMac = process.platform === 'darwin'

interface MacPermissions {
  getAuthStatus: (type: string) => string
  askForAccessibilityAccess: () => void
}

let macPerm: MacPermissions | null | undefined
function loadMacPermissions(): MacPermissions | null {
  if (macPerm !== undefined) return macPerm
  if (!isMac) {
    macPerm = null
    return macPerm
  }

  // 候选路径：
  //   1. 正常顶层 require（需要 node-mac-permissions 在 package.json dependencies 里）
  //   2. 兜底：pnpm 严格隔离模式下顶层软链可能缺失，改走 .pnpm 直接路径
  //      （仅 dev 模式能命中，打包后结构不同但那时依赖已是扁平的）
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeRequire = require
  const candidates = [
    '@nut-tree-fork/node-mac-permissions',
    // 绝对路径兜底（pnpm 的 .pnpm 虚拟 store 稳定路径）
    require('path').resolve(
      __dirname,
      '../../../node_modules/.pnpm/@nut-tree-fork+node-mac-permissions@2.2.1/node_modules/@nut-tree-fork/node-mac-permissions'
    ),
    require('path').resolve(
      process.cwd(),
      'node_modules/.pnpm/@nut-tree-fork+node-mac-permissions@2.2.1/node_modules/@nut-tree-fork/node-mac-permissions'
    )
  ]

  let lastErr: unknown = null
  for (const p of candidates) {
    try {
      macPerm = nodeRequire(p) as MacPermissions
      return macPerm
    } catch (err) {
      lastErr = err
    }
  }
  console.warn('[Permissions] 无法加载 node-mac-permissions（所有候选路径失败）：', lastErr)
  macPerm = null
  return macPerm
}

export type AccessibilityStatus =
  | 'authorized'
  | 'denied'
  | 'restricted'
  | 'not determined'
  | 'unsupported'

/** 查辅助功能（模拟键盘/粘贴的必要权限）当前授予状态 */
export function getAccessibilityStatus(): AccessibilityStatus {
  if (!isMac) return 'authorized' // Win/Linux 无此概念，视为已授权
  // 🔑 权威判据：Electron 内建 API，与 nut-js 实际执行时所用的 AXIsProcessTrusted
  //    是同一个系统调用，路径/签名变化也能如实反映
  try {
    const trusted = systemPreferences.isTrustedAccessibilityClient(false)
    if (trusted) return 'authorized'
  } catch (err) {
    console.warn('[Permissions] isTrustedAccessibilityClient 失败：', err)
  }
  // 不是 authorized，尝试进一步细分状态（仅用于日志展示）
  const perm = loadMacPermissions()
  if (!perm) return 'denied' // 无细分能力时，直接视为 denied
  try {
    const s = perm.getAuthStatus('accessibility') as AccessibilityStatus
    // mac-permissions 可能返回 'authorized'、但 Electron 判据说没授权——
    // 以 Electron 判据为准（路径不匹配等）返回 denied
    return s === 'authorized' ? 'denied' : s
  } catch (err) {
    console.warn('[Permissions] getAuthStatus 失败：', err)
    return 'denied'
  }
}

/** 当前是否允许模拟键盘/粘贴 */
export function canSimulateInput(): boolean {
  const s = getAccessibilityStatus()
  return s === 'authorized' || s === 'unsupported'
  // unsupported：mac 下权限模块加载失败，我们放行让 nut-js 去试（已是 worst case）
}

let askedOnce = false

/**
 * 引导用户去系统设置授权；同一进程只触发一次，避免反复弹面板
 * mac 10.14+ 不允许程序化获取授权，只能打开设置页让用户点勾选。
 */
export function requestAccessibility(): void {
  if (!isMac) return
  if (askedOnce) return
  askedOnce = true
  const perm = loadMacPermissions()
  if (!perm) return
  try {
    perm.askForAccessibilityAccess()
  } catch (err) {
    console.warn('[Permissions] askForAccessibilityAccess 失败：', err)
  }
}

/** 打印一段醒目的终端引导，告诉用户怎么授权 */
export function logAccessibilityGuide(): void {
  if (!isMac) return

  // 诊断信息：当前 Electron 真实路径 + App Bundle 路径（用户应把这个 .app 拖进辅助功能）
  const execPath = process.execPath
  // execPath 形如 .../Electron.app/Contents/MacOS/Electron；截到 .app 为止
  const appBundle = execPath.includes('.app/')
    ? execPath.slice(0, execPath.indexOf('.app/') + 4)
    : execPath

  console.log(
    '\n' +
      '╔════════════════════════════════════════════════════════════════╗\n' +
      '║  🔐 需要「辅助功能」权限才能把识别文本注入到当前输入框         ║\n' +
      '║                                                                ║\n' +
      '║  ⚠️ 如果你已经勾选了 Electron 但仍提示 denied：                ║\n' +
      '║    多半是"辅助功能"里添加的是旧路径（pnpm 每次装 hash 会变）   ║\n' +
      '║                                                                ║\n' +
      '║  ✅ 正确做法（务必添加下面这个真实路径）：                     ║\n' +
      '║    1. 打开「系统设置 → 隐私与安全 → 辅助功能」                 ║\n' +
      '║    2. 删除列表里旧的 "Electron" 条目（点 − 号）                ║\n' +
      '║    3. 点 + 号，按 ⌘⇧G 粘贴下方路径，选中 .app 后点"打开"       ║\n' +
      '║    4. 勾选开关                                                 ║\n' +
      '║    5. 回终端 Ctrl+C 停掉 pnpm dev，再重新 pnpm dev             ║\n' +
      '║                                                                ║\n' +
      '║  当前 Electron.app 真实路径：                                  ║\n' +
      '╚════════════════════════════════════════════════════════════════╝\n' +
      `  👉  ${appBundle}\n` +
      `     (可在终端运行 \`open -R "${appBundle}"\` 在 Finder 中定位)\n` +
      '\n  本次识别文本已复制到剪贴板，可直接 Cmd+V 粘贴\n'
  )
}

/**
 * 诊断日志：启动时打印关键环境信息，便于用户自查
 * （execPath 与"系统设置→辅助功能"列表里路径是否一致）
 */
export function logPermissionDiagnostics(): void {
  if (!isMac) return
  const execPath = process.execPath
  const appBundle = execPath.includes('.app/')
    ? execPath.slice(0, execPath.indexOf('.app/') + 4)
    : execPath
  let trusted: boolean | string = 'unknown'
  try {
    trusted = systemPreferences.isTrustedAccessibilityClient(false)
  } catch (err) {
    trusted = `error: ${(err as Error).message}`
  }
  let macPermStatus = 'n/a'
  try {
    const perm = loadMacPermissions()
    macPermStatus = perm ? perm.getAuthStatus('accessibility') : 'module_unavailable'
  } catch (err) {
    macPermStatus = `error: ${(err as Error).message}`
  }
  console.log(
    '[Permissions/诊断] ----------------------------------------\n' +
      `  Electron execPath : ${execPath}\n` +
      `  App Bundle        : ${appBundle}\n` +
      `  isTrusted (权威)  : ${trusted}\n` +
      `  mac-permissions   : ${macPermStatus}\n` +
      `  appName           : ${app.getName()}\n` +
      '  -------------------------------------------------------\n' +
      '  👉 请确认"系统设置 → 隐私与安全 → 辅助功能"里添加的路径\n' +
      '     与上面的 [App Bundle] 完全一致。路径不一致时，旧勾选无效。\n'
  )
}

/** 在 Finder 中定位到 Electron.app，方便用户拖进"辅助功能" */
export function revealElectronAppInFinder(): void {
  if (!isMac) return
  const execPath = process.execPath
  const appBundle = execPath.includes('.app/')
    ? execPath.slice(0, execPath.indexOf('.app/') + 4)
    : execPath
  try {
    shell.showItemInFolder(appBundle)
  } catch (err) {
    console.warn('[Permissions] showItemInFolder 失败：', err)
  }
}
