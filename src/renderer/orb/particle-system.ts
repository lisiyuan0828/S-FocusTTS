/**
 * 呼吸球 · 3D 粒子体积漩涡（M6 · DEC-004 v9 · 单群布朗 · 无呼吸）
 *
 * 🔄 产品形态（v9 终态）：
 *   v8 曾尝试 shell+inner 双群（外壳静止 + 内部跳动），用户反馈
 *   "我要的是球内部粒子做无规则运动，且不要呼吸态" —— 撤回到单群布朗，球体半径全档 1.0。
 *
 * 运动模型（随机游走 + 软边界 + 硬反射）：
 *   vel += randomGauss3() · accelMag · accelScale · dt
 *   if |pos| > softR : vel += -dir(pos) · pullback · (|pos| - softR) · dt
 *   vel *= damping^dt
 *   pos += vel · dt
 *   if |pos| > hardR : pos = dir(pos) · hardR；反射法向速度分量
 *
 * 状态映射（accelMag / damping）：
 *   - idle：高频小位移（持续微颤）
 *   - recording.silent / active：明显高频颤动（active 更剧烈）
 *   - transcribing：神经元放电感
 *   - injecting：能量爆发的高频颤动
 *   - error：几乎冻住
 *
 * 实现要点：
 *   - 单个 THREE.Points 承载所有粒子；position / velocity 每帧 CPU 更新
 *   - 粒子初始在 r∈[0.05, 0.78] 体积均匀采样（cbrt）
 *   - hardR=0.78、softR=0.65：留 22% 给 sprite pointSize 屏幕扩展，球体不会冲出方形画布
 *   - radius 全档统一 1.0（无呼吸感），仅 compact 模式按 compactScale=0.9 缩放（窗口适配，v9.4 从 0.85 上调，配合命中区 40→56/窗口 64→88，球体视感约 50px）
 *   - normRadius 只在初始化时计算一次，为颜色提供稳定的"出生层级"
 *   - shader 接管圆形（gl_PointCoord 硬边圆 + 中心微亮核），纹理仅为 2×2 中性白点
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  WebGLRenderer
} from 'three'

export type OrbStateType = 'idle' | 'recording' | 'transcribing' | 'injecting' | 'error'
export type OrbSizeType = 'normal' | 'compact'

/** 每档的"表达力"参数 */
interface Tier {
  /** 粒子数 */
  count: number
  /** 目标帧率（低档降频省电） */
  fps: number
  /** 核心色（球心附近） */
  coreColor: string
  /** 边缘色（球表附近） */
  edgeColor: string
  /** 粒子基础大小（world unit） */
  pointSize: number
  /** 球半径（world unit） */
  radius: number
  /** 透明度倍率 */
  opacity: number
  /** 🆕 v4 随机加速度量级（world unit / s^2）—— 决定运动剧烈程度 */
  accelMag: number
  /** 🆕 v4 速度阻尼系数（每秒保留比例，0～1）—— 越小越黏滞 */
  damping: number
  /** 🆕 v4 软边界回拉力（world unit / s^2）—— 防止粒子飞出球外 */
  pullback: number
}

/** 按状态 × 尺寸返回目标档位 */
function resolveTier(
  state: OrbStateType,
  voiceActive: boolean,
  size: OrbSizeType
): Tier {
  // v9.4（2026-05-11）：跟随命中区 40→56的同步上调，compactScale 0.85 → 0.9，
  //   粒子最远 0.78·0.9 = 0.702，画布可视半径 0.91，留 22% 余量不冲框。
  //   命中区 56px 下球视觉直径约 56·0.9 ≈ 50px（v9.3 为 ~30px）。
  const compactScale = size === 'compact' ? 0.9 : 1
  // v5 高频抖动调教（球不再呼吸 + 粒子频繁转向）：
  //   思路：accelMag 显著上调（每帧被踢得更猛）+ damping 显著下调（速度衰减更快、相关时间更短）
  //   结果：粒子方向频繁变化，看上去「越发活跃地颤动」，但因短相关时间不会越界。
  //   radius 全档统一为 1.0 —— 球体不再有呼吸感（compact 下仍按 compactScale 等比缩，那是窗口适配）。
  const base: Record<OrbStateType, Tier> = {
    idle: {
      count: 380,
      fps: 30,
      coreColor: '#8ecaff',
      edgeColor: '#164a96',
      pointSize: 0.65,
      radius: 1.0,
      opacity: 0.9,
      // 静谧但持续微颤：加速度提升 + 阻尼加强 —— 高频小位移
      accelMag: 0.4,
      damping: 0.25,
      pullback: 0.9
    },
    recording: {
      count: voiceActive ? 1000 : 650,
      fps: 60,
      coreColor: voiceActive ? '#ffffff' : '#a5d8ff',
      edgeColor: voiceActive ? '#4a9bff' : '#0f52c7',
      pointSize: voiceActive ? 0.85 : 0.75,
      radius: 1.0,
      opacity: voiceActive ? 1.0 : 0.95,
      // active：加速度适度拉高（不再 4.5 那么暴力，靠短相关时间维持频繁感）
      accelMag: voiceActive ? 2.6 : 1.2,
      damping: voiceActive ? 0.12 : 0.2,
      pullback: voiceActive ? 2.4 : 1.5
    },
    transcribing: {
      count: 880,
      fps: 60,
      coreColor: '#c3afff',
      edgeColor: '#2f1a8f',
      pointSize: 0.75,
      radius: 1.0,
      opacity: 0.95,
      // 烦躁高频思考：加速度中强 + 阻尼大 —— 像神经元放电
      accelMag: 1.6,
      damping: 0.18,
      pullback: 1.8
    },
    injecting: {
      count: 760,
      fps: 60,
      coreColor: '#b9f0a2',
      edgeColor: '#0c6a2b',
      pointSize: 0.8,
      radius: 1.0,
      opacity: 1.0,
      // 能量爆发：强加速度 —— 整体高频颤动
      accelMag: 2.4,
      damping: 0.15,
      pullback: 2.2
    },
    error: {
      count: 540,
      fps: 45,
      coreColor: '#ffb5b5',
      edgeColor: '#8a1414',
      pointSize: 0.65,
      radius: 1.0,
      opacity: 0.95,
      // 警示但稳定：加速度小、阻尼极强 —— 几乎冻住的微颤
      accelMag: 0.15,
      damping: 0.15,
      pullback: 0.6
    }
  }
  const t = base[state]
  // v9.3+：compact 模式下粒子量直接按 compactScale 等比缩（不再额外压制）。
  //   v9.4：0.9 下 idle 380·0.9 ≈ 342 颗（normal idle 380），密度与 normal 几乎持平，实心感拉满。
  const countScale = compactScale
  return {
    ...t,
    count: Math.max(50, Math.round(t.count * countScale)),
    pointSize: t.pointSize * (size === 'compact' ? 1.0 : 1),
    radius: t.radius * compactScale,
    // compact 下加速度与回拉力同比缩放（依据半径等比），避免在小画布中运动过于激烈
    accelMag: t.accelMag * compactScale,
    pullback: t.pullback * compactScale
  }
}

/**
 * 每颗粒子的运动参数（v9 · 单群布朗）
 *
 * 体积均匀初始位置仅用于「出生」，后续位置随机游走。
 * normRadius 取「初始出生层」为颜色提供静态分层（避免颜色随位置闪烁）。
 */
interface ParticleMotion {
  /** 出生距球心归一化距离（0=中心，1=球表）—— 静态，仅为颜色径向渐变服务 */
  normRadius: number
  /** 大小倍率（0.7~1.3）—— 保留粒子大小差异 */
  sizeScale: number
  /** 加速度个体倍率（0.6~1.4）—— 让粒子间有运动剧烈程度差异 */
  accelScale: number
  /** 当前位置 xyz（相对球心，归一化于 radius=1，渲染时乘 globalScale） */
  px: number
  py: number
  pz: number
  /** 当前速度 xyz（world unit / s，归一化于 radius=1） */
  vx: number
  vy: number
  vz: number
}

export class ParticleSystem {
  private canvas: HTMLCanvasElement
  private renderer: WebGLRenderer
  private scene: Scene
  private camera: PerspectiveCamera
  private points: Points | null = null
  private material: ShaderMaterial | null = null
  private geometry: BufferGeometry | null = null

  /** 每颗粒子的运动参数（长度 = MAX_PARTICLES） */
  private motions: ParticleMotion[] = []
  /** 当前有效粒子数（上限） */
  private activeCount = 0
  /** 最大容量（初始化时一次分配，后续只调 drawRange） */
  private readonly MAX_PARTICLES = 3000

  /** 当前目标档位 */
  private tier: Tier
  /** 插值中的"当前显示档位"（让状态过渡平滑） */
  private displayTier: Tier

  /**
   * 当前实际渲染用的颜色（v9.1）
   * 与 displayTier.coreColor/edgeColor 字符串字段配对：
   *   - displayTier.{core,edge}Color 始终指向"目标色字符串"
   *   - _display{Core,Edge}Color 则在每帧被向目标色 RGB 线性插值，作为真正喂给 BufferAttribute 的颜色
   * 这样状态切换时颜色会以 ~166ms 平滑过渡，与运动参数（accelMag/damping/...）节奏一致，
   * 解决用户反馈的"开启录音瞬间球的颜色变化太快"。
   */
  private _displayCoreColor = new Color('#8ecaff')
  private _displayEdgeColor = new Color('#164a96')
  /** 目标色（每次 setTarget 时根据 tier.{core,edge}Color 重建一次，避免每帧 new） */
  private _targetCoreColor = new Color('#8ecaff')
  private _targetEdgeColor = new Color('#164a96')

  /** 全局时间（秒），驱动每颗粒子的 sin 抖动相位 */
  private elapsedTime = 0

  /** 上次 render 时间戳（节流用） */
  private lastFrameTime = 0
  /** rAF 句柄 */
  private rafHandle: number | null = null
  /** 是否已挂载 */
  private mounted = false
  /** 暂停（window 隐藏/不可见） */
  private paused = false

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.renderer = new WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance'
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(0x000000, 0)

    this.scene = new Scene()
    this.camera = new PerspectiveCamera(45, 1, 0.1, 100)
    this.camera.position.set(0, 0, 2.2)

    this.tier = resolveTier('idle', false, 'normal')
    this.displayTier = { ...this.tier }

    this.initGeometry()
  }

  /** 启动：创建粒子 + 开始渲染循环 */
  mount(): void {
    if (this.mounted) return
    this.mounted = true
    this.resize()
    this.lastFrameTime = performance.now() - 1000
    const gl = this.renderer.getContext()
    // eslint-disable-next-line no-console
    console.log(
      '[Orb/Particles v2] mount canvas=%dx%d, gl=%s, pointSizeRange=%o',
      this.canvas.width,
      this.canvas.height,
      gl ? 'ok' : 'null',
      gl?.getParameter(gl.ALIASED_POINT_SIZE_RANGE)
    )
    this.loop()

    document.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('resize', this.onResize)
  }

  /** 卸载：停止渲染 + 释放 GL 资源 */
  dispose(): void {
    this.mounted = false
    if (this.rafHandle != null) {
      cancelAnimationFrame(this.rafHandle)
      this.rafHandle = null
    }
    document.removeEventListener('visibilitychange', this.onVisibility)
    window.removeEventListener('resize', this.onResize)
    this.geometry?.dispose()
    this.material?.dispose()
    this.renderer.dispose()
  }

  /** 更新状态档位 */
  setTarget(state: OrbStateType, voiceActive: boolean, size: OrbSizeType): void {
    this.tier = resolveTier(state, voiceActive, size)
    this.activeCount = this.tier.count
    if (this.geometry) {
      this.geometry.setDrawRange(0, this.activeCount)
    }
    // 目标色字符串变化时一次性解析为 Color，避免每帧 new Color()（GC 友好）
    this._targetCoreColor.set(this.tier.coreColor)
    this._targetEdgeColor.set(this.tier.edgeColor)
  }

  /** 容器尺寸变化 */
  resize(): void {
    const parent = this.canvas.parentElement
    if (!parent) return
    const { width, height } = parent.getBoundingClientRect()
    const w = Math.max(1, Math.floor(width))
    const h = Math.max(1, Math.floor(height))
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    if (this.material) {
      this.material.uniforms['uPixelScale']!.value = h * 0.18
    }
  }

  // ─────────────────────────────────────────────
  // 内部
  // ─────────────────────────────────────────────

  private onResize = (): void => {
    this.resize()
  }

  private onVisibility = (): void => {
    this.paused = document.visibilityState === 'hidden'
  }

  /**
   * 创建粒子几何 + 初始化每颗粒子的运动状态（v9 · 单群布朗）
   *
   * 出生位置：球体内 r∈[0.05, 0.78] 体积均匀采样（cbrt 保证体积密度均匀）；
   * 出生速度：全为 0；后续每帧由随机加速度 + 阻尼 + 边界回拉驱动。
   * 上限 0.78 与主循环 hardR 一致，避免初始就贴在硬边界上抖动出格。
   */
  private initGeometry(): void {
    const geo = new BufferGeometry()
    const positions = new Float32Array(this.MAX_PARTICLES * 3)
    const colors = new Float32Array(this.MAX_PARTICLES * 3)
    const sizes = new Float32Array(this.MAX_PARTICLES)

    for (let i = 0; i < this.MAX_PARTICLES; i++) {
      // ─── 随机方向（单位球面均匀采样）───
      const u = Math.random() * 2 - 1
      const v = Math.random() * 2 * Math.PI
      const sinPhi = Math.sqrt(1 - u * u)
      const dirX = sinPhi * Math.cos(v)
      const dirY = u
      const dirZ = sinPhi * Math.sin(v)
      // 体积均匀采样：cbrt(random) 保证内外密度一致；范围 [0.05, 0.78]
      const rNorm = 0.05 + Math.cbrt(Math.random()) * 0.73

      const px = dirX * rNorm
      const py = dirY * rNorm
      const pz = dirZ * rNorm

      this.motions.push({
        normRadius: rNorm,
        sizeScale: 0.7 + Math.random() * 0.6,    // 0.7~1.3
        accelScale: 0.6 + Math.random() * 0.8,   // 0.6~1.4
        px,
        py,
        pz,
        vx: 0,
        vy: 0,
        vz: 0
      })

      positions[i * 3] = px
      positions[i * 3 + 1] = py
      positions[i * 3 + 2] = pz

      colors[i * 3] = 1
      colors[i * 3 + 1] = 1
      colors[i * 3 + 2] = 1

      sizes[i] = 1
    }

    geo.setAttribute('position', new BufferAttribute(positions, 3))
    geo.setAttribute('color', new BufferAttribute(colors, 3))
    geo.setAttribute('size', new BufferAttribute(sizes, 1))
    geo.setDrawRange(0, 380)
    this.activeCount = 380

    const tex = makeSpriteTexture()

    const material = new ShaderMaterial({
      uniforms: {
        uTexture: { value: tex },
        uOpacity: { value: 1.0 },
        uSizeScale: { value: 1.0 },
        uPixelScale: { value: 70.0 }
      },
      vertexShader: `
        attribute float size;
        varying vec3 vColor;
        varying float vDepthFade;
        uniform float uSizeScale;
        uniform float uPixelScale;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // v3 沙粒化：深度衰减更温和（0.55→1.0），后排不再变很暗，保持粒子整体清晰度
          vDepthFade = (1.0 - smoothstep(1.2, 3.2, -mv.z)) * 0.45 + 0.55;
          gl_PointSize = size * uSizeScale * (uPixelScale / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vDepthFade;
        uniform sampler2D uTexture;
        uniform float uOpacity;
        void main() {
          // v3 沙粒化：纹理提供硬边圆形蒙版，不再依赖径向软边缘
          vec2 uv = gl_PointCoord - vec2(0.5);
          float r = length(uv) * 2.0; // 0..1
          // 硬边圆，smoothstep 宽度 0.15 —— 既抗锯齿又保证不糊
          float mask = 1.0 - smoothstep(0.5, 0.65, r);
          // 中心略亮核，置于硬圆内 —— 保留一点粒子质感而非纯实心圆
          float core = 1.0 - smoothstep(0.0, 0.35, r);
          float a = mask * (0.75 + core * 0.25);
          gl_FragColor = vec4(vColor, a * uOpacity * vDepthFade);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      vertexColors: true
    })

    this.material = material
    this.geometry = geo
    this.points = new Points(geo, material)
    this.scene.add(this.points)
  }

  /**
   * 刷每颗粒子的颜色
   * v2：用 normRadius（home 到球心的归一化距离）做 core→edge 径向渐变
   *     内层偏 core 色、外层偏 edge 色，体积分布下颜色自然分层
   * v9.1：直接使用 _displayCoreColor / _displayEdgeColor —— 这两个 Color 对象
   *       已被 smoothDisplayTier 每帧向目标色 RGB 线性插值，因此颜色切换是平滑的，
   *       并且本函数不再每帧 new Color()（GC 友好）。
   */
  private updateColors(): void {
    if (!this.geometry) return
    const attr = this.geometry.getAttribute('color') as BufferAttribute
    const core = this._displayCoreColor
    const edge = this._displayEdgeColor
    const arr = attr.array as Float32Array
    const n = this.activeCount
    for (let i = 0; i < n; i++) {
      const m = this.motions[i]!
      const t = m.normRadius // 0=中心, 1=球表
      const r = core.r * (1 - t) + edge.r * t
      const g = core.g * (1 - t) + edge.g * t
      const b = core.b * (1 - t) + edge.b * t
      arr[i * 3] = r
      arr[i * 3 + 1] = g
      arr[i * 3 + 2] = b
    }
    attr.needsUpdate = true
  }

  /** 按 displayTier 更新每颗粒子 size（叠上每颗的 sizeScale） */
  private updateSizes(): void {
    if (!this.geometry) return
    const attr = this.geometry.getAttribute('size') as BufferAttribute
    const arr = attr.array as Float32Array
    const n = this.activeCount
    for (let i = 0; i < n; i++) {
      const m = this.motions[i]!
      arr[i] = this.displayTier.pointSize * m.sizeScale
    }
    attr.needsUpdate = true
  }

  /** 线性插值 tier → 让切换不突变 */
  private smoothDisplayTier(dt: number): void {
    const k = Math.min(1, dt * 6) // ~1/6 秒过渡
    const a = this.displayTier
    const b = this.tier
    a.pointSize += (b.pointSize - a.pointSize) * k
    a.radius += (b.radius - a.radius) * k
    a.opacity += (b.opacity - a.opacity) * k
    a.accelMag += (b.accelMag - a.accelMag) * k
    a.damping += (b.damping - a.damping) * k
    a.pullback += (b.pullback - a.pullback) * k
    // 🆕 v9.1：颜色也参与同节奏插值（解决"开启录音颜色变化太快"）
    //   注意：displayTier.{core,edge}Color 字符串字段仍然瞬时跟随目标，
    //   但真正喂给 BufferAttribute 的是 _display{Core,Edge}Color 这两个 Color 对象。
    const dc = this._displayCoreColor
    const de = this._displayEdgeColor
    const tc = this._targetCoreColor
    const te = this._targetEdgeColor
    dc.r += (tc.r - dc.r) * k
    dc.g += (tc.g - dc.g) * k
    dc.b += (tc.b - dc.b) * k
    de.r += (te.r - de.r) * k
    de.g += (te.g - de.g) * k
    de.b += (te.b - de.b) * k
    // count/fps 直接跟随；coreColor/edgeColor 字符串字段保留语义为"目标色"
    a.coreColor = b.coreColor
    a.edgeColor = b.edgeColor
    a.count = b.count
    a.fps = b.fps
  }

  /**
   * 渲染主循环（v4 · 布朗运动）
   *
   * v4 核心：球体静止；每颗粒子独立随机游走 + 软边界回拉
   *   - 随机加速度（高斯近似）推动
   *   - 指数阻尼防止速度发散
   *   - 超过 0.92·radius 后产生向心拉力，比硜反弹更柔和
   */
  private loop = (): void => {
    if (!this.mounted) return
    this.rafHandle = requestAnimationFrame(this.loop)

    if (this.paused) return

    const now = performance.now()
    const targetInterval = 1000 / this.tier.fps
    const elapsed = now - this.lastFrameTime
    if (elapsed < targetInterval) return
    const dt = Math.min(0.1, elapsed / 1000)
    this.lastFrameTime = now

    this.smoothDisplayTier(dt)
    this.updateColors()
    this.updateSizes()
    this.elapsedTime += dt

    if (this.geometry && this.points) {
      const posAttr = this.geometry.getAttribute('position') as BufferAttribute
      const arr = posAttr.array as Float32Array
      const globalScale = this.displayTier.radius
      const accelMag = this.displayTier.accelMag
      const damping = this.displayTier.damping
      const pullback = this.displayTier.pullback
      // 每帧阻尼衰减倍率：damping 是「每秒保留比例」，转换到 dt：pow(damping, dt)
      const dampFrame = Math.pow(damping, dt)
      const n = this.activeCount
      // v9 边界（与 v6 一致）：粒子在 r∈[0, hardR=0.78] 区域内做布朗运动
      //   hardR=0.78 留 22% 给 sprite pointSize 屏幕外扩，球外形不会冲出方框
      //   softR=0.65 提前向心拉回
      const hardR = 0.78
      const softR = 0.65

      for (let i = 0; i < n; i++) {
        const m = this.motions[i]!

        // ① 随机加速度：高斯近似（3 样本叠加 → 近正态分布，运动更柔）
        const aMag = accelMag * m.accelScale * dt
        const ax =
          (Math.random() + Math.random() + Math.random() - 1.5) * aMag
        const ay =
          (Math.random() + Math.random() + Math.random() - 1.5) * aMag
        const az =
          (Math.random() + Math.random() + Math.random() - 1.5) * aMag
        m.vx += ax
        m.vy += ay
        m.vz += az

        // ② 软边界回拉力：r ≥ softR 时与超出量成正比
        const r2 = m.px * m.px + m.py * m.py + m.pz * m.pz
        if (r2 > softR * softR) {
          const r = Math.sqrt(r2)
          const k = (pullback * (r - softR) * dt) / r
          m.vx -= m.px * k
          m.vy -= m.py * k
          m.vz -= m.pz * k
        }

        // ③ 阻尼
        m.vx *= dampFrame
        m.vy *= dampFrame
        m.vz *= dampFrame

        // ④ 位置更新
        m.px += m.vx * dt
        m.py += m.vy * dt
        m.pz += m.vz * dt

        // ⑤ 硬限制：投影回 hardR 球面 + 反射法向速度，防穿出
        const r2b = m.px * m.px + m.py * m.py + m.pz * m.pz
        if (r2b > hardR * hardR) {
          const r = Math.sqrt(r2b)
          const nx = m.px / r
          const ny = m.py / r
          const nz = m.pz / r
          m.px = nx * hardR
          m.py = ny * hardR
          m.pz = nz * hardR
          const dot = m.vx * nx + m.vy * ny + m.vz * nz
          if (dot > 0) {
            m.vx -= 1.6 * dot * nx
            m.vy -= 1.6 * dot * ny
            m.vz -= 1.6 * dot * nz
          }
        }

        arr[i * 3] = m.px * globalScale
        arr[i * 3 + 1] = m.py * globalScale
        arr[i * 3 + 2] = m.pz * globalScale
      }
      posAttr.needsUpdate = true

      this.points.rotation.set(0, 0, 0)

      if (this.material) {
        this.material.uniforms['uOpacity']!.value = this.displayTier.opacity
      }
    }

    this.renderer.render(this.scene, this.camera)
  }
}

/**
 * v3 沙粒化纹理：纯硬边圆点 —— 纹理目前仅作保留占位（shader 已接管形状计算）
 * 为避免 fragmentShader 纹理采样 alpha 储负数，纹理保留 1×1 中性白点即可。
 */
function makeSpriteTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 2
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 2, 2)
  const tex = new CanvasTexture(c)
  tex.needsUpdate = true
  return tex
}
