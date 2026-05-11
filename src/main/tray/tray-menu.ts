import { app, Menu, Tray, nativeImage, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { OPEN_SETTINGS_SHORTCUT } from '@shared/constants'

/**
 * 托盘菜单（M5）
 *
 * 作用：
 *  - macOS：菜单栏右上角常驻入口
 *  - Windows：系统通知区域常驻入口（在 Win 上是设置界面的**主入口**）
 *
 * 通过回调把"打开设置/触发录音/退出"等业务逻辑解耦出去，本模块只管 UI。
 *
 * 图标策略（D-M5-3）：
 *  - 本次不做 Template 图标资产（M6 打包前再补 resources/icons/tray-*.png）
 *  - 用 base64 嵌入的 16x16 蓝色圆点 PNG 作为占位图标，**保证 Win 托盘可见**
 *  - macOS 额外叠一个 setTitle 文字，视觉更清晰
 */

/**
 * 16x16 蓝色圆点 PNG（base64），用作跨平台托盘占位图标。
 * 这是编译时预生成的静态资源，避免运行时依赖 Canvas/Skia。
 */
const TRAY_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAsklEQVR4Ae3TIQ6DQBCF4X8JgiMgEBVI' +
  'JBKJqEMgiagElwiJqKirIyGhpyhCkkhCElpOwMU4ATcgRI4gmCmy7S5UoBAzm+y+/WZnZwEI/zQA+cxY' +
  'CUw5WQ8XzU8Hm2AGMOJ6GBmBj9gI7MJHbAQWYQJz+yU2Auuwgamd2QhswbvnF5vgIFAZX2wC34EZz4sJ' +
  'PkAh7z5/jE2gVGDOmUdsAl2BBe+lFZvgHORdA9G4HzaB/O0GrQAAAABJRU5ErkJggg=='

export interface TrayCallbacks {
  onToggleRecord(): void
  onOpenSettings(): void
  onOpenRecordingsDir(): void
  onQuit(): void
}

export class TrayMenu {
  private tray: Tray | null = null

  create(cbs: TrayCallbacks): void {
    if (this.tray) return

    // 跨平台占位图标：蓝色圆点 PNG → Win 可见，mac 也能显示
    const buf = Buffer.from(TRAY_ICON_PNG_BASE64, 'base64')
    const icon = nativeImage.createFromBuffer(buf)
    // mac 下建议用 Template 模式自适应深/浅色菜单栏，但蓝色圆点并非黑白 alpha mask，
    // 所以这里不设 setTemplateImage；M6 做正式 Template 图标时再切。
    this.tray = new Tray(icon)

    if (process.platform === 'darwin') {
      // mac 菜单栏叠加文字，图标+文字双保险，视觉上更易识别
      this.tray.setTitle(' 🎙')
    }

    this.tray.setToolTip('S-FocusTTS · 语音转文字')

    const template: MenuItemConstructorOptions[] = [
      {
        label: '开始 / 停止录音',
        click: () => cbs.onToggleRecord()
      },
      { type: 'separator' },
      {
        label: `打开设置 (${OPEN_SETTINGS_SHORTCUT})`,
        click: () => cbs.onOpenSettings()
      },
      {
        label: '打开录音目录',
        click: () => cbs.onOpenRecordingsDir()
      },
      { type: 'separator' },
      {
        label: '关于 S-FocusTTS',
        click: () => {
          shell.openExternal('https://github.com/')
        }
      },
      { type: 'separator' },
      {
        label: `版本 ${app.getVersion()}`,
        enabled: false
      },
      {
        label: '退出',
        click: () => cbs.onQuit()
      }
    ]

    const menu = Menu.buildFromTemplate(template)
    this.tray.setContextMenu(menu)

    // mac 单击托盘图标也弹菜单（默认行为即如此，这里显式加一行保险）
    this.tray.on('click', () => {
      this.tray?.popUpContextMenu()
    })
  }

  dispose(): void {
    if (this.tray) {
      this.tray.destroy()
      this.tray = null
    }
  }
}
