/**
 * userData 一次性迁移：FocusTTS → S-FocusTTS（DEC-006）
 *
 * 触发场景：
 *   工作目录与产品名从 FocusTTS 改为 S-FocusTTS（DEC-006），
 *   Electron 的 app.getPath('userData') 会随 app.getName() 变化，
 *   导致用户老的历史记录、设置、SQLite 数据库"看似消失"。
 *
 * 策略：
 *   - 在 app.setName('S-FocusTTS') 之后、app.whenReady() 之前调用一次。
 *   - 三平台分别检测旧目录：
 *       darwin : ~/Library/Application Support/<name>
 *       win32  : %APPDATA%\<name>     （等价于 path.join(os.homedir(), 'AppData', 'Roaming', name)）
 *       linux  : ~/.config/<name>
 *   - 若旧目录存在 **且** 新目录不存在 → fs.renameSync 迁移；
 *     否则不动（含两者都存在的并存场景，让用户手动决定，避免覆盖）。
 *
 * 同时迁移 dev 套件：FocusTTS-dev → S-FocusTTS-dev（electron-vite 在 NODE_ENV=development
 * 下会把 userData 自动改为 `<name>-dev`，因此 dev/prod 各迁一次）。
 *
 * 风险与回滚：
 *   - 失败时仅打印 warn，不抛错，保证应用能继续启动（最坏情况是用户配置看似丢失，
 *     但旧目录原样保留，可手动改名兜底）。
 *   - 未来回滚到 FocusTTS 时，把 OLD/NEW 互换调用即可。
 */

import { existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 解析 userData 父目录（不含 app name） */
function resolveAppDataParent(): string | null {
  const home = homedir()
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support')
    case 'win32': {
      // 优先用 APPDATA 环境变量；回退到默认路径
      const appData = process.env.APPDATA
      return appData && appData.length > 0
        ? appData
        : join(home, 'AppData', 'Roaming')
    }
    case 'linux':
      return process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
        ? process.env.XDG_CONFIG_HOME
        : join(home, '.config')
    default:
      return null
  }
}

/**
 * 把单个旧目录迁到新目录。返回是否真的发生了迁移。
 */
function tryRenameOne(parent: string, oldName: string, newName: string): boolean {
  const oldPath = join(parent, oldName)
  const newPath = join(parent, newName)
  if (!existsSync(oldPath)) return false
  if (existsSync(newPath)) {
    console.log(
      `[Migration] 跳过 "${oldName}" → "${newName}"：新目录已存在，保留双份避免覆盖（旧路径：${oldPath}）`
    )
    return false
  }
  try {
    renameSync(oldPath, newPath)
    console.log(`[Migration] ✅ userData 已迁移：${oldPath}  →  ${newPath}`)
    return true
  } catch (err) {
    console.warn(
      `[Migration] ⚠️ 迁移失败 "${oldName}" → "${newName}"：${(err as Error).message}\n` +
        `   旧路径仍保留：${oldPath}（可手动改名为 ${newName}）`
    )
    return false
  }
}

/**
 * 入口：执行 FocusTTS / FocusTTS-dev → S-FocusTTS / S-FocusTTS-dev 的一次性迁移
 *
 * 必须在 app.setName('S-FocusTTS') 之后、app.whenReady() 之前调用。
 * 重复调用是幂等的（旧目录已被改名后，第二次 existsSync 即为 false）。
 */
export function migrateUserDataFromFocusTTS(): void {
  const parent = resolveAppDataParent()
  if (!parent) {
    console.log(`[Migration] 不支持的平台 ${process.platform}，跳过 userData 迁移`)
    return
  }
  // prod
  tryRenameOne(parent, 'FocusTTS', 'S-FocusTTS')
  // dev（electron-vite 在 NODE_ENV=development 下使用 -dev 后缀）
  tryRenameOne(parent, 'FocusTTS-dev', 'S-FocusTTS-dev')
}
