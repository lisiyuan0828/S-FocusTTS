import type { AsrResult } from '@shared/types'

/**
 * ASRProvider —— 语音识别提供者统一接口
 *
 * M3 只实现本地 whisper.cpp（`WhisperLocalProvider`），
 * 后续若接入云端 API / 其它引擎，在此实现同接口即可无缝替换。
 */
export interface ASRProvider {
  /** 引擎标识（用于日志/配置） */
  readonly id: string

  /**
   * 对给定 WAV 文件做语音识别。
   * @param wavPath 16kHz / 16bit / mono PCM WAV 文件绝对路径
   * @param opts   可选：语言、初始提示词等
   */
  transcribe(wavPath: string, opts?: TranscribeOptions): Promise<AsrResult>
}

export interface TranscribeOptions {
  /** whisper 语言代码，如 'zh' / 'en' / 'auto'，默认 'auto' */
  language?: string
  /** 转写超时（毫秒），默认 120_000 */
  timeoutMs?: number
}

/** 带错误码的 ASR 错误对象（方便上层做分支处理） */
export class AsrError extends Error {
  constructor(
    public readonly code:
      | 'binary_missing'
      | 'model_missing'
      | 'spawn_failed'
      | 'exit_nonzero'
      | 'empty_output'
      | 'busy',
    message: string
  ) {
    super(message)
    this.name = 'AsrError'
  }
}
