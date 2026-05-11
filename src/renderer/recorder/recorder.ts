/**
 * 录音窗口脚本（M2）
 *
 * 职责：
 *  - 监听主进程 start/stop 指令
 *  - 启动 getUserMedia → AudioContext → ScriptProcessor 采集音频
 *  - 下采样到 16kHz，转为 Int16 PCM，按块回传主进程
 *
 * 说明：此处先用 ScriptProcessorNode（虽被标 deprecated，但在 Electron/Chrome 里稳定可用，
 *      M2 完成基础链路后，M3 可以换成 AudioWorkletProcessor 做更低延迟）。
 */
declare global {
  interface Window {
    recorderAPI: {
      onStart(cb: (p: { sampleRate: number; channels: number }) => void): void
      onStop(cb: () => void): void
      sendPcmChunk(chunk: ArrayBuffer): void
      sendVoiceLevel(rms: number): void
      sendError(msg: string): void
      sendAck(stage: 'started' | 'stopped'): void
    }
  }
}

const TARGET_SAMPLE_RATE = 16_000
/** 每多少毫秒上报一次音量；~85ms 一帧，这里节流到 100ms 级别够用 */
const VOICE_LEVEL_THROTTLE_MS = 80

let audioCtx: AudioContext | null = null
let mediaStream: MediaStream | null = null
let source: MediaStreamAudioSourceNode | null = null
let processor: ScriptProcessorNode | null = null
/** 浏览器实际采样率（一般 44100 或 48000），用于计算下采样比 */
let inputSampleRate = 48_000
/** 上一次发送 voiceLevel 的时间戳，用于节流 */
let lastVoiceLevelAt = 0

/** 把 Float32（−1..1）块下采样到 16kHz 并转 Int16LE */
function downsampleAndToInt16(float32: Float32Array, fromRate: number): Int16Array {
  if (fromRate === TARGET_SAMPLE_RATE) {
    const out = new Int16Array(float32.length)
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]))
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    return out
  }
  const ratio = fromRate / TARGET_SAMPLE_RATE
  const outLength = Math.floor(float32.length / ratio)
  const out = new Int16Array(outLength)
  let oi = 0
  let ii = 0
  while (oi < outLength) {
    const nextI = Math.floor((oi + 1) * ratio)
    // 简单平均：对落入该目标样本区间的源样本求均值
    let sum = 0
    let cnt = 0
    for (; ii < nextI && ii < float32.length; ii++) {
      sum += float32[ii]
      cnt++
    }
    const avg = cnt > 0 ? sum / cnt : 0
    const s = Math.max(-1, Math.min(1, avg))
    out[oi] = s < 0 ? s * 0x8000 : s * 0x7fff
    oi++
  }
  return out
}

async function startRecording() {
  try {
    // 1) 拿麦克风
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    })

    // 2) 建立 AudioContext
    audioCtx = new AudioContext()
    inputSampleRate = audioCtx.sampleRate

    source = audioCtx.createMediaStreamSource(mediaStream)

    // 3) ScriptProcessor：bufferSize 4096，单声道
    //    每回调约 4096/inputSampleRate 秒（48k 下 ~85ms）
    processor = audioCtx.createScriptProcessor(4096, 1, 1)
    processor.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0)
      // 拷贝出来再下采样，避免被复用的 buffer 抢走
      const copy = new Float32Array(input.length)
      copy.set(input)

      // ── Voice Activity：算一下 RMS 并节流上报 ──
      // RMS = sqrt(sum(x^2)/n)，range ≈ 0..1（人声正常 0.02~0.15）
      const now = performance.now()
      if (now - lastVoiceLevelAt >= VOICE_LEVEL_THROTTLE_MS) {
        let sumSq = 0
        for (let i = 0; i < copy.length; i++) {
          const s = copy[i]
          sumSq += s * s
        }
        const rms = Math.sqrt(sumSq / Math.max(1, copy.length))
        // 防御性 clamp；某些设备会给出超过 1 的异常值
        window.recorderAPI.sendVoiceLevel(Math.min(1, Math.max(0, rms)))
        lastVoiceLevelAt = now
      }

      const pcm16 = downsampleAndToInt16(copy, inputSampleRate)
      // 发出 ArrayBuffer
      window.recorderAPI.sendPcmChunk(pcm16.buffer)
    }

    source.connect(processor)
    // 必须连到 destination 否则 onaudioprocess 不会被调
    processor.connect(audioCtx.destination)

    window.recorderAPI.sendAck('started')
    console.log('[recorder] started, inputSampleRate=', inputSampleRate)
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.error('[recorder] start error:', err)
    window.recorderAPI.sendError(msg)
    await stopRecording()
  }
}

async function stopRecording() {
  try {
    processor?.disconnect()
    source?.disconnect()
    if (processor) {
      // @ts-expect-error - allow null assignment to detach handler
      processor.onaudioprocess = null
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop())
    }
    if (audioCtx && audioCtx.state !== 'closed') {
      await audioCtx.close()
    }
  } finally {
    processor = null
    source = null
    mediaStream = null
    audioCtx = null
    window.recorderAPI.sendAck('stopped')
    console.log('[recorder] stopped')
  }
}

window.recorderAPI.onStart(() => {
  void startRecording()
})
window.recorderAPI.onStop(() => {
  void stopRecording()
})
