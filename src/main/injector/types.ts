/**
 * Injector 内部类型定义（M4）
 *
 * 为什么放在 `src/main/injector/types.ts` 而不是 `src/shared/types.ts`?
 * 因为 InjectStrategy 依赖的 API（模拟键盘、写剪贴板）全部是主进程能力，
 * renderer/preload 不会直接消费这些接口。跨进程导出的"结果类型"放 shared。
 */

import type { InjectMode } from '@shared/types'

/** 注入上下文：主调度器传给每个策略 */
export interface InjectContext {
  /** 要注入的文本（已 trim、已过滤空白） */
  text: string
  /** 本次会话希望使用的模式；策略只需处理自己那份 */
  mode: InjectMode
}

/** 策略实现契约 */
export interface InjectStrategy {
  /** 策略标识（日志/配置用） */
  readonly name: InjectMode
  /**
   * 实际执行注入。异常会被调度器捕获后尝试降级。
   */
  inject(ctx: InjectContext): Promise<void>
}
