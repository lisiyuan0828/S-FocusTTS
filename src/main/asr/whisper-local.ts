import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { AsrResult } from '@shared/types'
import {
  DEFAULT_MODEL_FILE,
  checkAsrAssets,
  resolveModelPath,
  resolveWhisperBinary
} from './binary-locator'
import { ASRProvider, AsrError, TranscribeOptions } from './provider'

/**
 * WhisperLocalProvider —— 调用本地 whisper-cli 做语音识别
 *
 * 参数说明（whisper.cpp CLI）：
 *   -m <model>     模型路径
 *   -f <wav>       输入 WAV 文件
 *   -l <lang>      语言（`auto` 让模型自判；中文场景直接用 `zh` 更稳）
 *   -nt            no-timestamps，输出纯文本
 *   --no-prints    抑制 whisper 自身的 banner / 进度日志
 *   -otxt          输出 .txt 副文件（我们忽略，直接读 stdout）
 *   -t <n>         线程数（默认 4；M4 Pro 给 8 更快）
 *   -p <n>         处理器数（1 即可，多处理器是切片并行，短语音反而变慢）
 *   -bs <n>        beam size（1 = greedy，短语音质量够，速度提升 20-30%）
 *   -bo <n>        best-of（配合 -bs 1 用 1 即可）
 *
 * 性能备注（macOS Apple Silicon）：
 *   - brew 版 whisper-cpp 1.8.4 编译时已默认启用 Metal/CoreML 加速，无需额外参数
 *   - M4 Pro 实测：small-q5_1 模型 5s 语音 ≈ 2-3s 出结果
 *
 * 并发策略：实例级 Promise 锁，同一时间只跑一次。第二次 transcribe() 抛 `busy`。
 */
export class WhisperLocalProvider implements ASRProvider {
  readonly id = 'whisper-local'

  private running: Promise<AsrResult> | null = null

  constructor(
    private readonly modelFile: string = DEFAULT_MODEL_FILE
  ) {}

  async transcribe(wavPath: string, opts: TranscribeOptions = {}): Promise<AsrResult> {
    if (this.running) {
      throw new AsrError('busy', '上一次转写还没结束')
    }

    // 1. 资源预检
    const assetErr = checkAsrAssets(this.modelFile)
    if (assetErr) {
      const code = assetErr.includes('可执行文件') ? 'binary_missing' : 'model_missing'
      throw new AsrError(code, assetErr)
    }
    if (!existsSync(wavPath)) {
      throw new AsrError('spawn_failed', `音频文件不存在：${wavPath}`)
    }

    const task = this.run(wavPath, opts)
    this.running = task
    try {
      return await task
    } finally {
      this.running = null
    }
  }

  private run(wavPath: string, opts: TranscribeOptions): Promise<AsrResult> {
    const bin = resolveWhisperBinary()
    const model = resolveModelPath(this.modelFile)
    const language = opts.language ?? 'zh'
    const timeoutMs = opts.timeoutMs ?? 120_000

    // M4 Pro 默认 8 线程；可用环境变量 FOCUSTTS_ASR_THREADS 覆盖
    const threads = Number(process.env.FOCUSTTS_ASR_THREADS) || 8

    const args = [
      '-m', model,
      '-f', wavPath,
      '-l', language,
      '-t', String(threads),
      '-p', '1',
      '-bs', '1',
      '-bo', '1',
      '-nt',
      '--no-prints'
    ]

    return new Promise<AsrResult>((resolve, reject) => {
      const t0 = Date.now()
      console.log(`[ASR] 启动 whisper-cli: ${bin} ${args.join(' ')}`)

      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        return reject(
          new AsrError('spawn_failed', `spawn 失败: ${(err as Error).message}`)
        )
      }

      let stdout = ''
      let stderr = ''
      let killed = false

      const killTimer = setTimeout(() => {
        killed = true
        child.kill('SIGKILL')
      }, timeoutMs)

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })

      child.on('error', (err) => {
        clearTimeout(killTimer)
        reject(new AsrError('spawn_failed', `子进程错误: ${err.message}`))
      })

      child.on('close', (code) => {
        clearTimeout(killTimer)
        const durationMs = Date.now() - t0

        if (killed) {
          return reject(
            new AsrError('exit_nonzero', `whisper-cli 运行超时 (>${timeoutMs}ms)`)
          )
        }
        if (code !== 0) {
          return reject(
            new AsrError(
              'exit_nonzero',
              `whisper-cli 退出码 ${code}\nstderr:\n${stderr.trim()}`
            )
          )
        }

        const text = cleanWhisperOutput(stdout)
        if (!text) {
          return reject(
            new AsrError(
              'empty_output',
              `whisper-cli 没有输出文字\nstdout:${stdout}\nstderr:${stderr}`
            )
          )
        }

        resolve({
          text,
          durationMs,
          audioPath: wavPath,
          model: this.modelFile
        })
      })
    })
  }
}

/**
 * 清洗 whisper-cli stdout：
 *   - whisper 在 `-nt` 模式下每行一段纯文本，但偶尔会残留 `[_BEG_]` 等标记
 *   - 去空行，去首尾空白，合并为单字符串（段落之间用换行保留）
 *   - 过滤明显的噪声占位符（`[BLANK_AUDIO]`、`(silence)` 等）
 */
function cleanWhisperOutput(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\[[^\]]*]$/.test(line)) // 纯标记行
    .filter((line) => !/^\((silence|music|blank[_ ]audio)\)$/i.test(line))
    .join('\n')
    .trim()
}
