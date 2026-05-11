import { app } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * binary-locator —— 统一解析 whisper 可执行文件与模型文件的物理路径
 *
 * 设计原则：
 *   1. **dev 与 prod 用同一份业务代码** —— 只在这里分支
 *   2. 二进制按平台与架构分目录存放，避免 mac/win 互相踩
 *   3. 文件不存在时抛明确异常，上层决定是否降级
 *
 * 目录约定（都是「项目资源目录」下的相对路径）：
 *   bin/
 *     darwin-arm64/whisper-cli
 *     darwin-x64/whisper-cli
 *     win32-x64/whisper-cli.exe
 *   models/
 *     ggml-small-q5_0.bin   (M3 默认，Dex 决策)
 */

/** 默认模型文件名（M3，Dex 决策 2-B：small + q5_1 量化，约 181MB） */
export const DEFAULT_MODEL_FILE = 'ggml-small-q5_1.bin'

/**
 * 资源根目录：
 *  - dev：`<workspace>/resources`
 *  - prod：`process.resourcesPath`（electron-builder 会把 extraResources 放在这里）
 */
export function getResourcesRoot(): string {
  if (app.isPackaged) {
    // 打包后：app.asar 同级的 resources/（extraResources 产物）
    return process.resourcesPath
  }
  // dev 环境：从 out/main/index.js 反推到项目根目录
  // 结构：<root>/out/main/index.js  →  <root>
  return path.resolve(app.getAppPath(), 'resources')
}

/** 当前平台+架构对应的子目录名，如 `darwin-arm64` */
export function getPlatformBinDir(): string {
  // process.arch: 'arm64' | 'x64' | 'ia32' | ...
  // process.platform: 'darwin' | 'win32' | 'linux'
  return `${process.platform}-${process.arch}`
}

/** whisper 可执行文件的绝对路径（按平台返回带/不带 .exe） */
export function resolveWhisperBinary(): string {
  const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
  return path.join(getResourcesRoot(), 'bin', getPlatformBinDir(), exe)
}

/** 模型文件的绝对路径 */
export function resolveModelPath(modelFile: string = DEFAULT_MODEL_FILE): string {
  return path.join(getResourcesRoot(), 'models', modelFile)
}

/**
 * 校验二进制与模型都存在；若不存在返回提示语供上层日志使用。
 * 返回 `null` 表示 OK。
 */
export function checkAsrAssets(modelFile: string = DEFAULT_MODEL_FILE): string | null {
  const bin = resolveWhisperBinary()
  if (!existsSync(bin)) {
    return `whisper 可执行文件缺失：${bin}\n` +
      '→ 请按 docs 指引下载 whisper.cpp release 并放到该路径'
  }
  const model = resolveModelPath(modelFile)
  if (!existsSync(model)) {
    return `whisper 模型文件缺失：${model}\n` +
      `→ 请下载 ${modelFile} 到该路径`
  }
  return null
}
