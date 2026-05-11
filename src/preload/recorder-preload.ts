/**
 * recorder 窗口的预加载脚本（M2）
 *
 * 职责：
 *  - 接收 main 发来的 start/stop 指令（onStart / onStop）
 *  - 把 renderer 采集到的 PCM 块回传给 main（sendPcmChunk）
 *  - 报告错误与 ack 给 main
 *
 * 注意：为避免 `externalizeDeps` 把 electron 剔除，这里用 require 动态拿 electron 模块
 * 的 API（preload 运行在 node 环境）。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'

type StartPayload = { sampleRate: number; channels: number }

contextBridge.exposeInMainWorld('recorderAPI', {
  /** main → renderer：开始录音指令 */
  onStart(cb: (p: StartPayload) => void) {
    ipcRenderer.on(IPC.RECORD_START, (_e, p: StartPayload) => cb(p))
  },
  /** main → renderer：停止录音指令 */
  onStop(cb: () => void) {
    ipcRenderer.on(IPC.RECORD_STOP, () => cb())
  },
  /** renderer → main：一块 PCM16LE ArrayBuffer */
  sendPcmChunk(chunk: ArrayBuffer) {
    // 使用 transferable 避免复制开销
    ipcRenderer.send(IPC.RECORD_PCM_CHUNK, chunk)
  },
  /** renderer → main：当前窗口 RMS 音量（0..1），用于 voice-activity 视觉 */
  sendVoiceLevel(rms: number) {
    ipcRenderer.send(IPC.RECORD_VOICE_LEVEL, rms)
  },
  /** renderer → main：报错 */
  sendError(message: string) {
    ipcRenderer.send(IPC.RECORD_ERROR, message)
  },
  /** renderer → main：握手回执 */
  sendAck(stage: 'started' | 'stopped') {
    ipcRenderer.send(IPC.RECORD_ACK, stage)
  }
})

export {}
