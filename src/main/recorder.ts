import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { AUDIO, MAX_RECORD_MS } from '@shared/constants'

/**
 * 录音协调器（M2）
 *
 * 职责：
 *  - 在 start() 时开启新会话：清空 buffer、记录时间戳、启动超时保护
 *  - 接收 renderer 推来的 PCM16LE 块，拼接到内存 buffer
 *  - 在 stop() 时封装为 WAV，落盘到 app.getPath('userData')/recordings/，打印时长/大小
 *
 * 注意：真正的麦克风访问在 renderer 的 recorder 窗口里，本模块只做数据聚合与落盘。
 */
export class Recorder {
  private chunks: Uint8Array[] = []
  private totalBytes = 0
  private startedAt = 0
  private timer: NodeJS.Timeout | null = null
  private recording = false

  /** 触发超时自动停止的回调，由外部注入（窗口管理器会用它通知 renderer 并切状态） */
  private onTimeout: (() => void) | null = null

  /** 开始一次新录音会话 */
  start(opts?: { onTimeout?: () => void }): void {
    if (this.recording) {
      console.warn('[Recorder] start() ignored: already recording')
      return
    }
    this.chunks = []
    this.totalBytes = 0
    this.startedAt = Date.now()
    this.recording = true
    this.onTimeout = opts?.onTimeout ?? null

    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      console.warn(`[Recorder] 达到最大时长 ${MAX_RECORD_MS}ms，自动停止`)
      this.onTimeout?.()
    }, MAX_RECORD_MS)
  }

  /** 收到 renderer 的一块 PCM16LE */
  pushChunk(buf: ArrayBuffer | Uint8Array): void {
    if (!this.recording) return
    const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
    // 拷贝出独立内存（避免后续 ipc 复用）
    const copy = new Uint8Array(view.byteLength)
    copy.set(view)
    this.chunks.push(copy)
    this.totalBytes += copy.byteLength
  }

  /**
   * 停止录音并写 WAV。
   * @returns 本次录音的元信息（路径、时长、大小），若无数据则返回 null
   */
  async stop(): Promise<{ filePath: string; durationMs: number; bytes: number } | null> {
    if (!this.recording) {
      return null
    }
    this.recording = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const durationMs = Date.now() - this.startedAt

    if (this.totalBytes === 0) {
      console.warn('[Recorder] 停止时未收到任何 PCM 数据（可能麦克风权限未授予）')
      return null
    }

    // 拼接 PCM
    const pcm = new Uint8Array(this.totalBytes)
    let offset = 0
    for (const c of this.chunks) {
      pcm.set(c, offset)
      offset += c.byteLength
    }
    this.chunks = []
    this.totalBytes = 0

    // 封装 WAV
    const wav = buildWav(pcm, AUDIO.SAMPLE_RATE, AUDIO.CHANNELS, AUDIO.BIT_DEPTH)

    // 落盘：userData/recordings/rec-<ts>.wav
    const dir = path.join(app.getPath('userData'), 'recordings')
    await fs.mkdir(dir, { recursive: true })
    const filePath = path.join(dir, `rec-${Date.now()}.wav`)
    await fs.writeFile(filePath, wav)

    const kb = (wav.byteLength / 1024).toFixed(1)
    const sec = (durationMs / 1000).toFixed(2)
    console.log(`[Recorder] 录音结束：时长 ${sec}s，文件 ${kb} KB → ${filePath}`)

    return { filePath, durationMs, bytes: wav.byteLength }
  }

  isRecording(): boolean {
    return this.recording
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.chunks = []
    this.totalBytes = 0
    this.recording = false
  }
}

/** 将原始 PCM16LE 数据包装成标准 WAV（RIFF）文件 Buffer */
function buildWav(
  pcm: Uint8Array,
  sampleRate: number,
  channels: number,
  bitDepth: number
): Uint8Array {
  const blockAlign = (channels * bitDepth) / 8
  const byteRate = sampleRate * blockAlign
  const dataSize = pcm.byteLength
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  // RIFF header
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(view, 8, 'WAVE')

  // fmt chunk
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitDepth, true)

  // data chunk
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  const out = new Uint8Array(buffer)
  out.set(pcm, 44)
  return out
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i))
  }
}
