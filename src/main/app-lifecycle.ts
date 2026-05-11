
import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { lstatSync, readlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 是否为开发模式
 *
 * 判定规则：只要 NODE_ENV 不等于 'production' 就视为 dev。
 * （electron-vite 在 dev 模式下会注入 ELECTRON_RENDERER_URL，这里不强依赖它）
 */
const IS_DEV = process.env.NODE_ENV !== 'production'

/**
 * 应用生命周期管理
 * 职责：
 *  - 单例锁（防止多开）
 *  - 启动前清理上次崩溃残留的 SingletonLock（Chromium 机制）
 *  - 统一的 app 事件钩子
 *  - macOS 隐藏 Dock 图标（工具类应用）
 *  - dev 模式下，父进程（electron-vite）死亡时主动自毁，
 *    防止 Ctrl+C 后残留僵尸主进程霸占 SingletonLock
 */
export class AppLifecycle {
  private onReadyHandlers: Array<() => void | Promise<void>> = []
  private onQuitHandlers: Array<() => void | Promise<void>> = []
  /** 父进程存活监测定时器（仅 dev） */
  private parentWatchdog: NodeJS.Timeout | null = null

  /**
   * 清理上次异常退出残留的 SingletonLock
   *
   * 背景：Electron/Chromium 会在 userData 目录下创建名为 `SingletonLock`
   * 的软链，内容形如 `主机名-PID`。正常退出会自动删除；但 Ctrl+C、
   * dev server 崩溃、强杀等非正常退出会残留。
   *
   * 策略（分三步判定）：
   *   1. 软链不存在 / 非软链 / 格式异常  → 不处理
   *   2. PID 不存在                       → 陈旧锁，删
   *   3. PID 存在但**不是我们自己的 Electron**（macOS PID 会被系统复用，
   *      有可能被分配给 VSCode、CodeBuddy 等其他 Electron 应用）
   *                                        → 也视为陈旧锁，删
   *
   * 只处理 darwin / linux（Windows 上 SingletonLock 形态不同，暂不覆盖）。
   * 必须在 `app.requestSingleInstanceLock()` **之前** 调用。
   */
  private cleanStaleSingletonLock(): void {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return

    const lockPath = join(app.getPath('userData'), 'SingletonLock')

    let linkTarget: string
    try {
      const st = lstatSync(lockPath)
      if (!st.isSymbolicLink()) return
      linkTarget = readlinkSync(lockPath)
    } catch {
      return
    }

    const dashIdx = linkTarget.lastIndexOf('-')
    if (dashIdx < 0) return
    const pid = Number(linkTarget.slice(dashIdx + 1))
    if (!Number.isInteger(pid) || pid <= 0) return

    const stale = this.isPidStale(pid)
    if (!stale) {
      console.log(
        `[Lifecycle] 检测到 SingletonLock 指向本项目活跃的 PID ${pid}，保持不动`
      )
      return
    }

    try {
      unlinkSync(lockPath)
      console.log(
        `[Lifecycle] 已清理陈旧的 SingletonLock（残留 PID ${pid}：${stale}）`
      )
    } catch (err) {
      console.warn('[Lifecycle] 清理 SingletonLock 失败：', err)
    }
  }

  /**
   * 判定一个 PID 对应的"锁"是否已陈旧。
   * @returns 若为陈旧锁，返回原因字符串；否则返回 null
   *
   * dev 环境增强（方案 C）：若 PID 确实是"本项目 Electron"，但当前用户启动的
   * 是一次新的 `pnpm dev`，那原进程必然是上次 Ctrl+C 没被清掉的僵尸——
   * 直接 `kill -9` 它，然后把锁也视为陈旧。这样用户永远不需要手动清。
   */
  private isPidStale(pid: number): string | null {
    // 1) PID 是否存在
    try {
      process.kill(pid, 0)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return '进程不存在'
      if (code === 'EPERM') return '进程存在但不属于当前用户（PID 已被系统复用）'
      return `进程状态未知 (${code ?? 'unknown'})`
    }

    // 2) PID 存在 → 再看它的可执行路径是不是本项目的 Electron
    //    本项目期望的关键字：`S-FocusTTS/node_modules/.pnpm/electron@`
    //    macOS / linux 都支持 `ps -o command= -p <pid>`
    try {
      const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      if (!cmd) return 'ps 查询 PID 为空'
      const isOurElectron =
        cmd.includes('S-FocusTTS/node_modules') && cmd.includes('electron')

      if (isOurElectron) {
        // dev 环境：既然我自己正在启动，说明 PID 指向的必然是上次残留的僵尸
        if (IS_DEV) {
          try {
            process.kill(pid, 'SIGKILL')
            console.log(
              `[Lifecycle] dev 模式下检测到本项目僵尸主进程 PID ${pid}，已 SIGKILL`
            )
            return `dev 僵尸进程已清理：PID ${pid}`
          } catch (err) {
            console.warn(
              `[Lifecycle] 尝试 kill dev 僵尸 PID ${pid} 失败：`,
              err
            )
            // kill 失败时退回旧行为，不动它
            return null
          }
        }
        // 生产环境：保持原行为，认为是正常活进程
        return null
      }

      return `PID 被复用给其他进程：${cmd.slice(0, 120)}`
    } catch {
      // ps 不可用/失败时保守不清理，交给 Electron 自己兜底
      return null
    }
  }

  /**
   * 请求单例锁。失败则说明已有实例在运行，当前进程应直接退出
   */
  requestSingleInstance(): boolean {
    this.cleanStaleSingletonLock()
    const got = app.requestSingleInstanceLock()
    if (!got) {
      console.error(
        '[Lifecycle] requestSingleInstanceLock 失败：' +
        '检测到已有 S-FocusTTS Electron 主进程在运行。\n' +
        '→ 若为后台僵尸进程，请执行：\n' +
        '  ps aux | grep "S-FocusTTS/node_modules.*electron" | grep -v grep | awk \'{print $2}\' | xargs kill -9'
      )
      app.quit()
      return false
    }
    app.on('second-instance', () => {
      // 已有实例运行时，第二次启动暂时无事可做（常驻后台 + 快捷键触发）
      // 后续里程碑可在此打开设置窗口
    })
    return true
  }

  /** 注册 ready 回调 */
  onReady(handler: () => void | Promise<void>): void {
    this.onReadyHandlers.push(handler)
  }

  /** 注册退出回调 */
  onQuit(handler: () => void | Promise<void>): void {
    this.onQuitHandlers.push(handler)
  }

  /** 启动应用（绑定所有事件并等待 app ready） */
  async bootstrap(): Promise<void> {
    // 先绑定防退出钩子（所有窗口关闭时不退出，工具类应用常驻后台）
    app.on('window-all-closed', (e: Electron.Event) => {
      e.preventDefault()
    })

    app.on('will-quit', async () => {
      this.stopParentWatchdog()
      for (const h of this.onQuitHandlers) {
        await h()
      }
    })

    // macOS：作为常驻工具，不在 Dock 显示
    if (process.platform === 'darwin' && app.dock) {
      app.dock.hide()
    }

    // dev 模式下启动父进程守护（方案 A）
    this.startParentWatchdog()

    await app.whenReady()

    for (const h of this.onReadyHandlers) {
      await h()
    }
  }

  /**
   * 启动父进程存活守护（仅 dev 模式）
   *
   * 原理：
   *   electron-vite dev 在 Ctrl+C 时只杀自己这条 Node 进程，不会把
   *   Electron 子进程一起拉走，导致每次 Ctrl+C 都会产生一只僵尸。
   *
   *   这里主进程每 2 秒检查一次 `process.ppid` 对应的父进程是否还活着
   *   （用 `process.kill(ppid, 0)` 零信号探测），一旦父进程死亡就立刻
   *   `app.exit(0)` 自毁，从源头杜绝僵尸。
   *
   * 只在 dev 下启用，生产环境主进程就是顶层进程，不需要这个机制。
   */
  private startParentWatchdog(): void {
    if (!IS_DEV) return
    const ppid = process.ppid
    if (!Number.isInteger(ppid) || ppid <= 1) {
      // ppid 非法（=1 表示已被 init 收养，通常就已经是僵尸状态了）
      console.warn(
        `[Lifecycle] 启动时 ppid=${ppid} 异常，跳过父进程守护`
      )
      return
    }
    console.log(
      `[Lifecycle] dev 模式：启用父进程（PID ${ppid}）存活守护，每 2s 检查一次`
    )
    this.parentWatchdog = setInterval(() => {
      try {
        process.kill(ppid, 0)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        // ESRCH = 进程不存在 → 父进程已退出（通常是 Ctrl+C）
        // EPERM = PID 已被复用为其他用户的进程 → 原父进程一定死了
        if (code === 'ESRCH' || code === 'EPERM') {
          console.log(
            `[Lifecycle] 检测到父进程 PID ${ppid} 已退出（${code}），主进程自毁以避免僵尸`
          )
          this.stopParentWatchdog()
          app.exit(0)
        }
      }
    }, 2000)
    // 让定时器不阻塞 Electron 事件循环的退出
    this.parentWatchdog.unref?.()
  }

  private stopParentWatchdog(): void {
    if (this.parentWatchdog) {
      clearInterval(this.parentWatchdog)
      this.parentWatchdog = null
    }
  }
}

