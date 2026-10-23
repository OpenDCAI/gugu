/**
 * runtime.ts —— 一个全局 rAF 循环驱动页面上所有头像。
 * 只更新/绘制视口内、不在 inert 常驻面板里的头像；共用一个 WebGL 画布与一份纹理。
 * 只画会变的帧,按变了多少决定什么时候画(CPU 跟重画次数成正比,mac1 实测一次约 2.4ms):
 * 和上一张差不到半个 CSS 像素就不画;慢慢在变的(呼吸、左右摆、视线游走)攒到共用的 SLOW_TICK_MS 时钟上,所有鸟同一帧一起画;
 * 一下变得多的(眨眼、跳视、蹦、表情轮换、变形、拍一拍)、以及眼睛正跟着光标的,下一帧就画,并接着排 rAF 全帧率跟着。
 * 没有快动作就不排 rAF,改用一个计时器:到共用时钟的下一格,或者哪只鸟下一次眨眼的时刻,哪个先到就那时醒(排着 rAF 本身就要出帧);
 * 光标一动、窗口露出来就当场醒,不等计时器;
 * 窗口藏起来(document.hidden,或主进程报窗口最小化、收进托盘)、或一只头像都不在视口里,整个循环停下,回来再接着
 * (Chole 上咕咕入口那只鸟 60 fps 一直画,吃满一个核)。
 * 没焦点不停:没焦点照样看得见(副屏、并排放着、人点进了咕咕自己的浏览器页签)。
 * 同一趟要画的几只先都画进共用 GL 画布(各占一格),再挨个抄走(gl.ts:每抄一次 GPU 同步一次)。
 * 每只头像带一层装扮(outfits.ts):这一身的素材到齐之前先不画(❌ 先画光身再一闪穿上)。
 * 定格(still):给只能放 <img> 的地方,用同一个引擎、同一份 GL 画一帧静止的样子,转成一张图。
 */
import { rendererLogger } from '@/lib/log'
import { isAnimationWindowVisible, observeAnimationViewport, subscribeAnimationWindowVisibility } from '@gugu/session-shared/animation-visibility'
import { clamp } from './geometry'
import { GuguEngine } from './engine'
import { drawAvatar, drawnLook, glPasses, lookDiff, paintGL, Crop, DrawOpts, FrameShape, Slots } from './draw'
import { GuguGL, loadCharacter } from './gl'
import { CHARACTER_BY_ID, Character, CharacterId, DEFAULT_CHARACTER } from './characters'
import { OutfitDraw } from './outfits'
import type { WearItem } from './outfitCatalog'
import type { Rgb } from './identity'
import type { ExpressionId } from './spec'

const log = rendererLogger('agent-avatar/runtime')
/** GL 素材没载下来时,隔多久再试一次(期间用 2D 定格画着) */
const TEXTURE_RETRY_MS = 15_000
/**
 * 共用 WebGL 被收走后,隔多久在一张**新画布**上重建;再失败就按下一档再等。
 * 实测(Electron 44,GPU 进程被杀一次):旧画布 50s 后仍等不来 webglcontextrestored,新画布当场就拿得到上下文。
 */
const GL_REBUILD_DELAYS_MS = [500, 2_000, 10_000, 30_000, 60_000]
/** 重建出来的 GL 活过这么久才算稳住:之前又丢,下一次重建按下一档等,❌ 每 500ms 建一个新上下文空转 */
const GL_STABLE_MS = 60_000
/**
 * 一帧什么都没画(画面没变):下一次不排 rAF,用计时器在「共用时钟的下一格」与「最早的一次眨眼」里先到的那一刻再看。
 * 排着 rAF 就算不画,Chromium 每帧也要走一遍出帧流程,渲染进程 + GPU 进程每分钟要吃掉十来个 CPU 秒(mac1 实测);
 * 计时器只跑引擎这几行 JS。眨眼是快动作,准点醒才不会漏掉它合上的那几帧;慢变化本来就攒到时钟格上一起画。
 */
/** 和上一张差不到这么多 CSS 像素(色阶按同样的倍数)= 同一张,不画 */
const SAME_CSS_PX = 0.5
/** 差不到这么多 CSS 像素的变化是「慢慢在变」:不急着画,等共用时钟的下一格,所有鸟一起画 */
const SLOW_CSS_PX = 1.5
/** 共用时钟一格:慢变化最多晚这么久上屏(10 帧/秒;32px 的鸟呼吸一格挪不到 0.1 个像素,看不出一格一格) */
const SLOW_TICK_MS = 100
/** 定格等素材(本体 + 这一身各片)最多等多久;等不到就报错,调用方继续用打包的那张 */
const STILL_WAIT_MS = 15_000
/** 定格的眨眼 / 呼吸相位:固定一个种子,同一个形象每次画出来都一样 */
const STILL_SEED = 1

/** 定格要画成什么样:身体颜色、休息表情、这一身装扮 */
export interface StillLook {
  tint: Rgb
  rest: ExpressionId
  wear: readonly WearItem[] | undefined
}

export interface AvatarOpts {
  shape: FrameShape
  bg: boolean
  crop: Crop
  fx: boolean
  tracking: boolean
}

export interface AvatarHandle {
  ch: Character
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  engine: GuguEngine
  /** 这只身上的装扮(AgentAvatar 按形象 set) */
  outfit: OutfitDraw
  opts: AvatarOpts
  dpr: number
  visible: boolean
  stopVisibility: () => void
  rect: DOMRect | null
  rectAt: number
  pendingDt: number
  /** 画布上现在那一张:画它时的 drawnLook 与走的画法(GL / 2D 定格、画布尺寸、选项);[] = 还没画过 */
  drawn: number[]
  drawnWith: string
  /** 这一帧要画的(和 drawn 轮换着用,省得每帧新建数组) */
  next: number[]
}

/** 这一趟要画的一只:身体已经画进共用 GL 画布的 slots,等 flush 抄到它自己的画布上 */
interface Pending {
  h: AvatarHandle
  gl: GuguGL | null
  sprite: HTMLImageElement | null
  o: DrawOpts
  slots: Slots
}

class Runtime {
  private handles = new Set<AvatarHandle>()
  private gl: GuguGL | null = null
  /** 用到过的角色(GL 重建时按它重载素材) */
  private chars = new Set<CharacterId>()
  /** 无 WebGL 时整张贴的定格图:只在真走 2D 退路时才去取(有 WebGL 时不多载这一张) */
  private flats = new Map<CharacterId, HTMLImageElement>()
  /** GL 素材这次没载下来的角色:先走 2D 定格(❌ 整只空白),过一会儿再试 */
  private texFailed = new Set<CharacterId>()
  private ready = false
  private starting = false
  private raf = 0
  /** 画面没变时下一次查看的计时器(和 raf 同时只有一个在排) */
  private idle: ReturnType<typeof setTimeout> | null = null
  private last = 0
  private cursor: { x: number; y: number } | null = null
  private workEma = 0
  private frameNo = 0
  /** 共用时钟上一次画慢变化的那一格(SLOW_TICK_MS 为一格) */
  private slowTick = -1
  private glRebuild: ReturnType<typeof setTimeout> | null = null
  private glRebuildTier = 0
  private glInstalledAt = 0
  /** 供 UI 读：当前是否走 GPU 网格（false = 退路） */
  usingGL = false

  private start() {
    if (this.starting) return
    this.starting = true
    const gl = GuguGL.create()
    if (gl) {
      this.installGL(gl)
    } else {
      // 一上来就拿不到(比如界面进程崩溃重载的那一刻 GPU 还没起来):同样按档再试,❌ 整个会话都停在定格
      log.warn({}, 'WebGL unavailable at start; drawing flat stills, will retry on a fresh canvas')
      this.scheduleGLRebuild()
    }
    this.ready = true
    window.addEventListener(
      'pointermove',
      (e) => {
        this.cursor = { x: e.clientX, y: e.clientY }
        // 只有正跟着光标看的头像要马上醒;别的头像不因为光标在窗里动就出帧
        for (const h of this.handles)
          if (h.visible && h.opts.tracking) {
            this.wake()
            break
          }
      },
      { passive: true }
    )
    subscribeAnimationWindowVisibility(this.wake)
    document.addEventListener('pointerleave', () => {
      this.cursor = null
    })
    window.addEventListener('blur', () => {
      this.cursor = null
    })
    this.wake()
  }

  /** 循环停着或在等计时器时马上跑一帧(窗口露出来、头像进了视口、指针在动、来了新头像):停的时候不记时间,接上时不补那一段 */
  private wake = () => {
    if (this.raf || !this.ready) return
    if (this.idle) {
      // 循环还活着,只是在等计时器:提前醒,时间接着记
      clearTimeout(this.idle)
      this.idle = null
    } else this.last = 0
    this.raf = requestAnimationFrame(this.loop)
  }

  /** 用上这一份 GL:盯住它的上下文,已经用到的角色把素材载进去(旧上下文的纹理随它作废) */
  private installGL(gl: GuguGL) {
    this.gl = gl
    this.usingGL = true
    this.glInstalledAt = performance.now()
    this.texFailed.clear()
    this.watchContext(gl)
    for (const id of this.chars) this.loadTextures(CHARACTER_BY_ID[id])
  }

  /**
   * 共用的 WebGL 上下文会被收走(GPU 进程重启、睡眠唤醒、驱动重置)。收走期间所有小鸟退回 2D 定格画法,
   * 并在一张新画布上重建 —— ❌ 等旧画布的 webglcontextrestored:实测它不来,小鸟就一直是褪了色、
   * 状态形态只剩一对眼睛的定格,直到重开 app。❌ 拿着作废的纹理接着画,那样每只小鸟都是空白。
   */
  private watchContext(gl: GuguGL) {
    gl.canvas.addEventListener('webglcontextlost', () => {
      // 旧画布不再要回来(不 preventDefault):重建用新画布,两份上下文同时活着只是白占一份显存
      if (this.gl !== gl) return
      this.gl = null
      this.usingGL = false
      if (performance.now() - this.glInstalledAt > GL_STABLE_MS) this.glRebuildTier = 0
      log.warn({}, 'WebGL context lost; drawing flat stills, rebuilding on a fresh canvas')
      this.scheduleGLRebuild()
    })
  }

  private scheduleGLRebuild() {
    if (this.glRebuild) return
    const attempt = this.glRebuildTier
    const delay = GL_REBUILD_DELAYS_MS[Math.min(attempt, GL_REBUILD_DELAYS_MS.length - 1)]
    this.glRebuildTier++
    this.glRebuild = setTimeout(() => {
      this.glRebuild = null
      if (this.gl) return
      const gl = GuguGL.create()
      if (!gl) {
        // 封顶以后每分钟一次的重试不再记:GPU 长期用不了的机器上 ❌ 一天一千多行同样的话
        if (attempt < GL_REBUILD_DELAYS_MS.length - 1) {
          log.warn({ attempt, waitedMs: delay }, 'WebGL still unavailable on a fresh canvas; drawing flat stills, will retry')
        }
        this.scheduleGLRebuild()
        return
      }
      log.info({ attempt, waitedMs: delay }, 'WebGL rebuilt on a fresh canvas')
      this.installGL(gl)
    }, delay)
  }

  /** 本体 + 各状态形态的 GL 素材一起载;没载下来就先记着走 2D 定格,过一会儿再试 */
  private loadTextures(ch: Character) {
    const gl = this.gl
    if (!gl) return
    void loadCharacter(gl, ch).then((ok) => {
      if (ok || gl !== this.gl) return
      this.texFailed.add(ch.id)
      setTimeout(() => {
        if (gl !== this.gl) return
        this.texFailed.delete(ch.id)
        this.loadTextures(ch)
      }, TEXTURE_RETRY_MS)
    })
  }

  /** 首次用到某个角色时才取它的 GL 素材 */
  private ensureSprite(ch: Character) {
    if (this.chars.has(ch.id)) return
    this.chars.add(ch.id)
    this.loadTextures(ch)
  }

  /** 2D 退路要画的那张定格图(身体与部件拼好的一整张):第一次用到才取 */
  private flatOf(ch: Character): HTMLImageElement {
    let img = this.flats.get(ch.id)
    if (!img) {
      img = new Image()
      img.src = ch.flat
      this.flats.set(ch.id, img)
    }
    return img
  }

  /** 画布拿不到 2D 上下文（无 canvas 的环境）⇒ 返回 null，由调用方决定怎么说；❌ 不在这里吞掉 */
  register(
    canvas: HTMLCanvasElement,
    opts: AvatarOpts,
    seed: number,
    dpr: number,
    chId: CharacterId
  ): AvatarHandle | null {
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    this.start()
    const ch = CHARACTER_BY_ID[chId]
    this.ensureSprite(ch)
    const h: AvatarHandle = {
      ch,
      canvas,
      ctx,
      engine: new GuguEngine(seed, chId),
      outfit: new OutfitDraw(ch),
      opts,
      dpr,
      visible: true,
      stopVisibility: () => {},
      rect: null,
      rectAt: 0,
      pendingDt: 0,
      drawn: [],
      drawnWith: '',
      next: []
    }
    this.handles.add(h)
    h.stopVisibility = observeAnimationViewport(canvas, (visible) => {
      h.visible = visible
      this.wake()
    }, '80px')
    this.wake()
    return h
  }

  unregister(h: AvatarHandle) {
    this.handles.delete(h)
    h.stopVisibility()
  }

  private lookFor(h: AvatarHandle, now: number): { x: number; y: number } | null {
    if (!h.opts.tracking || !this.cursor) return null
    if (!h.rect || now - h.rectAt > 200) {
      h.rect = h.canvas.getBoundingClientRect()
      h.rectAt = now
    }
    const r = h.rect
    const norm = Math.max(240, r.width * 2.4)
    return {
      x: clamp((this.cursor.x - (r.left + r.width / 2)) / norm, -1, 1),
      y: clamp((this.cursor.y - (r.top + r.height * 0.4)) / norm, -1, 1)
    }
  }

  private loop = (ms: number) => {
    // 没人看得见就停:窗口藏起来、一只都不在视口里
    this.raf = 0
    this.idle = null
    if (!this.ready || !isAnimationWindowVisible() || ![...this.handles].some((h) => h.visible)) return
    let fast = false
    const dt = this.last ? (ms - this.last) / 1000 : 1 / 60
    this.last = ms
    // 自适应降载：一帧里的活儿超过 ~9ms 就让小头像隔帧更新（大头像始终全帧率）
    const throttle = this.workEma > 9
    this.frameNo++
    // 共用时钟走进了新的一格:这一趟把攒着的慢变化全画了
    const tick = Math.floor(ms / SLOW_TICK_MS)
    const slowDue = tick !== this.slowTick
    if (slowDue) this.slowTick = tick
    const w0 = performance.now()
    const batch: Pending[] = []
    let nextWake = Infinity
    for (const h of this.handles) {
      if (!h.visible || h.canvas.closest('[inert]')) continue
      // 素材还在路上：先不画（避免一闪而过的空画面）；这次没载下来：用 2D 定格画着,等重试
      const gl = this.gl && this.gl.has(h.ch.id) ? this.gl : null
      if (this.gl && !gl && !this.texFailed.has(h.ch.id)) continue
      if (throttle && h.canvas.width < 160 * h.dpr) {
        h.pendingDt += dt
        if (this.frameNo % 2) continue
      }
      const step = dt + h.pendingDt
      h.pendingDt = 0
      h.engine.crop = h.opts.crop
      h.engine.spinOK = h.outfit.spins
      const look = this.lookFor(h, ms)
      h.engine.update(step, look)
      nextWake = Math.min(nextWake, h.engine.wakeIn() * 1000) // 只看这一趟真跑过的引擎(在 inert 面板里、还在等素材的不算)
      h.outfit.update(step, h.engine.frame)
      // 这一身还有素材在路上:先不画(画布上留着上一张);载不下来的那片 ensure 记过错,不再等
      if ((gl ? h.outfit.ensure(gl) : h.outfit.ensureFlat()) > 0) continue
      const sprite = gl ? null : this.flatOf(h.ch)
      const o = {
        w: h.canvas.width,
        h: h.canvas.height,
        dpr: h.dpr,
        shape: h.opts.shape,
        bg: h.opts.bg,
        crop: h.opts.crop,
        fx: h.opts.fx
      }
      // 画法变了(GL 到位 / 丢了、定格图载好了、画布尺寸或选项改了、换了一身装扮)一定马上重画;否则按画面变了多少
      const by = `${gl ? 'gl' : sprite?.complete ? 'still' : 'none'}|${o.w}x${o.h}|${o.dpr}|${o.shape}|${o.bg}|${o.crop}|${o.fx}|${h.outfit.key}`
      drawnLook(h.engine.frame, o, h.next, h.outfit)
      const d = by === h.drawnWith ? lookDiff(h.drawn, h.next) : Infinity
      if (d < SAME_CSS_PX * h.dpr) continue
      // 眼睛正跟着光标(大头像、光标在窗里):一直全帧率,❌ 跟光标的眼珠一格一格跳
      if (d >= SLOW_CSS_PX * h.dpr || look) fast = true
      else if (!slowDue) continue
      // 这一批在共用 GL 画布上排不下了:先把排好的抄走,再从头排
      if (gl && !gl.room(o.w, o.h, glPasses(h.engine.frame, h.outfit))) {
        this.flush(batch)
        // reset 只归零格子,不会扩容;大头像的多趟绘制仍需在空画布上重新申请空间。
        gl.room(o.w, o.h, glPasses(h.engine.frame, h.outfit))
      }
      batch.push({ h, gl, sprite, o, slots: gl ? paintGL(gl, h.engine.frame, o, h.outfit) : { at: [], next: 0 } })
      ;[h.drawn, h.next] = [h.next, h.drawn]
      h.drawnWith = by
    }
    this.flush(batch)
    this.workEma = this.workEma * 0.9 + (performance.now() - w0) * 0.1
    if (fast) this.raf = requestAnimationFrame(this.loop)
    else this.idle = setTimeout(() => this.loop(performance.now()), Math.max(1, Math.min(nextWake, SLOW_TICK_MS - (ms % SLOW_TICK_MS))))
  }

  /** 这一批画好的格子抄到各自的画布上,共用 GL 画布从头排 */
  private flush(batch: Pending[]) {
    for (const b of batch) drawAvatar(b.h.ctx, b.gl, b.sprite, b.h.engine.frame, b.o, b.h.outfit, b.slots)
    batch.length = 0
    this.gl?.reset()
  }

  /**
   * 一张定格:同一个引擎画一帧静止的样子(颜色、休息表情、装扮都和会动的那只对得上),返回图的 blob 地址。
   * 画在共用的 GL 上(GL 用不了就走 2D 定格,同 drawAvatar 的退路);素材没到齐先等,等不到就 reject。
   */
  async still(look: StillLook, px: number): Promise<string> {
    const canvas = document.createElement('canvas')
    canvas.width = px
    canvas.height = px
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context unavailable for still')
    this.start()
    const ch = CHARACTER_BY_ID[DEFAULT_CHARACTER]
    this.ensureSprite(ch)
    const outfit = new OutfitDraw(ch)
    outfit.set(look.wear)
    const until = performance.now() + STILL_WAIT_MS
    // 先定这一张走哪条画法(同 loop:GL 本体纹理到位走 GL;GL 用不了或本体纹理没载下来走 2D 定格),再等那条画法要的素材
    const pathFor = () => {
      const gl = this.gl && this.gl.has(ch.id) ? this.gl : null
      const glLoading = !!this.gl && !gl && !this.texFailed.has(ch.id)
      const sprite = gl || glLoading ? null : this.flatOf(ch)
      const body = gl ? true : !!sprite?.complete && sprite.naturalWidth > 0
      return { gl, body, pending: gl ? outfit.ensure(gl) : outfit.ensureFlat() }
    }
    let path = pathFor()
    while (!path.body || path.pending > 0) {
      if (performance.now() > until) throw new Error(`still timed out waiting for sprites (body=${path.body}, pending=${path.pending})`)
      await new Promise((r) => setTimeout(r, 16))
      path = pathFor()
    }
    const engine = new GuguEngine(STILL_SEED, ch.id)
    engine.rotate = false
    engine.crop = 'full'
    engine.setExpression(look.rest)
    engine.setBodyColor(look.tint)
    engine.update(1 / 60, null) // 第一帧直接落在休息表情上,眼睛睁着(第一次眨眼在 1.2s 以后)
    const o = { w: px, h: px, dpr: 1, shape: 'free' as const, bg: false, crop: 'full' as const, fx: false }
    // 共用 GL 画布在两趟 loop 之间总是空的(每趟末尾都抄走、reset),room() 必然放得下
    const gl = path.gl
    if (gl && !gl.room(px, px, glPasses(engine.frame, outfit))) throw new Error('shared GL canvas not empty between frames')
    drawAvatar(ctx, gl, gl ? null : this.flatOf(ch), engine.frame, o, outfit, gl ? paintGL(gl, engine.frame, o, outfit) : { at: [], next: 0 })
    gl?.reset()
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.9))
    if (!blob) throw new Error('still encode failed')
    return URL.createObjectURL(blob)
  }
}

export const runtime = new Runtime()
