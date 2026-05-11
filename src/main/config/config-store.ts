import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_SHORTCUT,
  DEFAULT_INJECT_MODE,
  DEFAULT_ALWAYS_SHOW
} from '@shared/constants'
import type { AppSettings } from '@shared/types'

/**
 * ConfigStore —— 轻量 JSON 配置存储（M5 · MVP）
 *
 * 设计决策（D-M5-2 的延伸）：
 *  - 不引 electron-store：当前只有 4 项配置，不值得一个 7KB 的依赖 + schema 校验开销
 *  - 文件位置：userData/settings.json
 *  - 读取：启动时一次同步读；之后内存中是 source of truth
 *  - 写入：每次 set 立即落盘（同步写 < 1KB 毫秒级）
 *  - 损坏兜底：JSON 解析失败 → 用默认值，不阻塞启动
 *
 * M5 若要加字段，扩 AppSettings + DEFAULTS 即可；M6 如果 schema 复杂了再迁 electron-store
 */

const DEFAULTS: AppSettings = {
  shortcut: DEFAULT_SHORTCUT,
  injectMode: DEFAULT_INJECT_MODE,
  asrLanguage: 'zh',
  launchAtLogin: false,
  showShortcutHint: true,
  orbSize: 'normal',
  orbPosition: null,
  alwaysShow: DEFAULT_ALWAYS_SHOW
}

export class ConfigStore {
  private data: AppSettings
  private readonly filePath: string

  constructor() {
    const userData = app.getPath('userData')
    if (!existsSync(userData)) {
      mkdirSync(userData, { recursive: true })
    }
    this.filePath = path.join(userData, 'settings.json')
    this.data = this.load()
  }

  /** 读取配置；与 DEFAULTS 合并防止新增字段缺省 */
  private load(): AppSettings {
    if (!existsSync(this.filePath)) {
      return { ...DEFAULTS }
    }
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      return { ...DEFAULTS, ...parsed }
    } catch (err) {
      console.warn('[ConfigStore] 读取 settings.json 失败，使用默认值：', err)
      return { ...DEFAULTS }
    }
  }

  /** 同步落盘 */
  private persist(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8')
    } catch (err) {
      console.warn('[ConfigStore] 写入 settings.json 失败：', err)
    }
  }

  /** 读整个配置（返回拷贝，防止外部意外改内存） */
  getAll(): AppSettings {
    return { ...this.data }
  }

  /** 读单项 */
  get<K extends keyof AppSettings>(k: K): AppSettings[K] {
    return this.data[k]
  }

  /** 写单项，返回新配置（拷贝） */
  set<K extends keyof AppSettings>(k: K, v: AppSettings[K]): AppSettings {
    this.data = { ...this.data, [k]: v }
    this.persist()
    return this.getAll()
  }

  /** 配置文件路径（诊断页展示用） */
  getFilePath(): string {
    return this.filePath
  }
}
