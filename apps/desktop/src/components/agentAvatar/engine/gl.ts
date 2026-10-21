/**
 * gl.ts —— 身体都在这里画：每个部件 = 一张无眼素材当成软网格（顶点由 CPU 用 geometry.warp 算好传进来）。
 * 角色本体与各状态形态的素材（Pack）走同一条路径。
 * 一个共享的离屏 WebGL2 画布，所有头像往里画，再 drawImage 抄到各自的 2D 画布上
 * （浏览器对同页 WebGL 上下文数量有上限，几十个头像不能各开一个）。
 * 同一帧要画的几只一批:每一趟在画布上占一格,整批画完再统一抄走 —— 每在 GL 画过之后抄一次,GPU 就要同步一次,
 * ❌ 画一只抄一只(mac1 实测 8 张画布、每秒 15 帧:交错着抄 5.6 CPU 秒/分,画完再抄 4.0)。
 */
import { rendererLogger } from '@/lib/log'
import type { Character, Pack } from './characters'
import type { Rgb } from './identity'

export const GRID_X = 14
export const GRID_Y = 28
const VERT_COUNT = (GRID_X + 1) * (GRID_Y + 1)

const VS = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
uniform vec2 u_res;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  vec2 c = a_pos / u_res * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_desat;
uniform float u_dim;
uniform float u_alpha;
uniform vec3 u_tint;     // 身份层的身体颜色:目标色 / 奶油参考色(线性空间逐通道比值,identity.ts bodyTint)
uniform float u_tintOn;
out vec4 o;
vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec3 base = c.rgb;
  if (u_tintOn > 0.5 && c.a > 0.004) {
    // 只换奶油身体:按色度(r、g 在三通道里的占比)离奶油有多远做一张柔和的遮罩 —— 奶油的明暗都在 (0.41–0.45, 0.35) 附近,
    // 鼠尾草翅膀在 (0.29, 0.43)、橙色嘴脚在 (0.68, 0.26),离得够远,原色不动。乘比值保留明暗与绒毛颗粒
    vec3 lin = toLin(c.rgb / c.a);   // 纹理是预乘的:先还原直通色
    float sum = lin.r + lin.g + lin.b + 1e-6;
    float m = 1.0 - smoothstep(0.055, 0.105, distance(lin.rg / sum, vec2(0.430, 0.346)));
    lin = mix(lin, min(lin * u_tint, vec3(1.0)), m);
    base = toSrgb(lin) * c.a;
  }
  float l = dot(base, vec3(0.299, 0.587, 0.114));
  // 「去色」不是变灰：灰会让奶黄的身体死气沉沉（owner：「很阴、不像阳间的东西」）。往偏暖偏亮的奶白淡下去，像褪了色的布，不像尸体
  vec3 rgb = mix(base, vec3(l) * vec3(1.04, 1.0, 0.93) + 0.04 * c.a, u_desat) * u_dim;   // 纹理是预乘的：提亮量也要乘 a，否则透明处会漏出一块方形的亮影
  o = vec4(rgb, c.a) * u_alpha;
}`

function compile(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s) ?? 'shader')
    return s
  }
  const prog = gl.createProgram()!
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs))
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(prog) ?? 'link')
  return prog
}

const log = rendererLogger('agent-avatar/gl')

export class GuguGL {
  readonly canvas: HTMLCanvasElement
  /** CPU 写入的网格顶点（画布像素坐标），长度 = 顶点数×2 */
  readonly verts = new Float32Array(VERT_COUNT * 2)
  private gl: WebGL2RenderingContext
  private prog: WebGLProgram
  private meshVao: WebGLVertexArrayObject
  private posBuf: WebGLBuffer
  private nIdx: number
  private u: Record<string, WebGLUniformLocation | null> = {}
  private w = 0
  private h = 0
  /** 这一批排到哪儿了:格子从左上往右排,一行排满换下一行 */
  private cx = 0
  private cy = 0
  private rowH = 0

  private tex = new Map<string, WebGLTexture>()
  private loading = new Map<string, Promise<boolean>>()

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas
    this.gl = gl

    this.prog = compile(gl, VS, FS)
    gl.useProgram(this.prog)
    this.meshVao = gl.createVertexArray()!
    gl.bindVertexArray(this.meshVao)
    this.posBuf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf)
    gl.bufferData(gl.ARRAY_BUFFER, this.verts.byteLength, gl.DYNAMIC_DRAW)
    const aPos = gl.getAttribLocation(this.prog, 'a_pos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
    const uv = new Float32Array(VERT_COUNT * 2)
    let k = 0
    for (let j = 0; j <= GRID_Y; j++)
      for (let i = 0; i <= GRID_X; i++) {
        uv[k++] = i / GRID_X
        uv[k++] = j / GRID_Y
      }
    const uvBuf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf)
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW)
    const aUv = gl.getAttribLocation(this.prog, 'a_uv')
    gl.enableVertexAttribArray(aUv)
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0)
    const idx: number[] = []
    for (let j = 0; j < GRID_Y; j++) {
      for (let i = 0; i < GRID_X; i++) {
        const a = j * (GRID_X + 1) + i
        const b = a + 1
        const c = a + (GRID_X + 1)
        const d = c + 1
        idx.push(a, b, c, b, d, c)
      }
    }
    this.nIdx = idx.length
    const ib = gl.createBuffer()!
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW)
    gl.activeTexture(gl.TEXTURE0)
    gl.uniform1i(gl.getUniformLocation(this.prog, 'u_tex'), 0)
    for (const n of ['u_res', 'u_desat', 'u_dim', 'u_alpha', 'u_tint', 'u_tintOn'])
      this.u[n] = gl.getUniformLocation(this.prog, n)

    gl.bindVertexArray(null)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  static create(): GuguGL | null {
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 512
    return GuguGL.on(canvas)
  }

  /**
   * 在这张画布上拿上下文、建好管线。上下文被收走后 ❌ 回到这张旧画布上再拿:Electron 44 实测
   * webglcontextrestored 永远不来,runtime 改在 create() 出来的新画布上重建(runtime.ts scheduleGLRebuild)。
   */
  static on(canvas: HTMLCanvasElement): GuguGL | null {
    try {
      const gl = canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        preserveDrawingBuffer: false
      })
      if (!gl || gl.isContextLost()) return null
      return new GuguGL(canvas, gl)
    } catch (err) {
      log.warn({ error: String(err) }, 'WebGL2 unavailable, falling back to flat sprite')
      return null
    }
  }

  has(id: string) {
    return this.tex.has(id)
  }

  /** 载入一张无眼素材；size = 期望的素材像素尺寸（与角色包里的 spr 对不上就警告）。失败不记账:下次再要就再试 */
  loadTexture(id: string, url: string, size: { w: number; h: number }): Promise<boolean> {
    if (this.tex.has(id)) return Promise.resolve(true)
    let p = this.loading.get(id)
    if (!p) {
      p = this.fetchTexture(id, url, size).then((ok) => {
        if (!ok) this.loading.delete(id)
        return ok
      })
      this.loading.set(id, p)
    }
    return p
  }

  private async fetchTexture(
    id: string,
    url: string,
    size: { w: number; h: number }
  ): Promise<boolean> {
    try {
      const gl = this.gl
      // 走 <img> 解码而不是 fetch：素材与页面同源，img 不受 connect-src 约束，file:// / 自定义协议下都能读
      const img = new Image()
      img.src = url
      await img.decode()
      // ImageBitmap 会无视 UNPACK_PREMULTIPLY_ALPHA，必须在创建位图时就预乘，否则边缘按直通色当预乘色混合会出白边
      const bmp = await createImageBitmap(img, {
        premultiplyAlpha: 'premultiply',
        colorSpaceConversion: 'none'
      })
      if (bmp.width !== size.w || bmp.height !== size.h) {
        log.warn({ id, w: bmp.width, h: bmp.height }, 'sprite size differs from character pack')
      }
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp)
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic')
      if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4)
      bmp.close()
      this.tex.set(id, tex)
      return true
    } catch (err) {
      log.error({ id, error: String(err) }, 'sprite load failed')
      return false
    }
  }

  /**
   * 这一批里给 n 格 w×h 留不留得出地方。一格都还没占时不够就把画布放大(放大会清空画布,所以只在空的时候)。
   * false = 先把这一批抄走、reset() 了再来。
   */
  room(w: number, h: number, n: number): boolean {
    const c = this.canvas
    let x = this.cx
    let y = this.cy
    let r = this.rowH
    for (let i = 0; i < n; i++) {
      if (x + w > c.width) [x, y, r] = [0, y + r, 0]
      if (y + h > c.height) {
        if (this.cx || this.cy) return false
        c.width = Math.max(c.width, w * Math.min(n, 4))
        c.height = Math.max(c.height, h * Math.ceil(n / 4))
        return true
      }
      x += w
      r = Math.max(r, h)
    }
    return true
  }

  /** 这一批抄完了:下一批从左上角重新排 */
  reset() {
    this.cx = this.cy = this.rowH = 0
  }

  /** 开一格(先 room() 过):视口挪到这一格、清空;返回它在画布上的左上角,画完从这里抄走 */
  begin(w: number, h: number): [number, number] {
    const gl = this.gl
    const c = this.canvas
    if (this.cx + w > c.width) [this.cx, this.cy, this.rowH] = [0, this.cy + this.rowH, 0]
    if (this.cy + h > c.height) throw new Error(`GL batch full at ${w}x${h}: room() was not asked first`)
    const x = this.cx
    const y = this.cy
    this.cx += w
    this.rowH = Math.max(this.rowH, h)
    this.w = w
    this.h = h
    // GL 的原点在左下:画布上 (x, y) 起的那一格,在 GL 里是从 c.height - y - h 起
    gl.viewport(x, c.height - y - h, w, h)
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(x, c.height - y - h, w, h)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    return [x, y]
  }

  /** 一个部件（this.verts 里的软网格，贴 id 对应的素材）；tint = 身份层的身体颜色（null = 素材原色） */
  drawSprite(id: string, desat: number, dim: number, alpha: number, tint: Rgb | null = null) {
    const tex = this.tex.get(id)
    if (alpha < 0.004 || !tex) return
    const gl = this.gl
    gl.useProgram(this.prog)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.bindVertexArray(this.meshVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.verts)
    gl.uniform2f(this.u.u_res, this.w, this.h)
    gl.uniform1f(this.u.u_desat, desat)
    gl.uniform1f(this.u.u_dim, dim)
    gl.uniform1f(this.u.u_alpha, alpha)
    gl.uniform1f(this.u.u_tintOn, tint ? 1 : 0)
    if (tint) gl.uniform3f(this.u.u_tint, tint[0], tint[1], tint[2])
    gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_SHORT, 0)
  }
}

/** 素材的 URL：characters.ts / packs.ts 里的 sprite 就是 vite 给出的地址 */
export function spriteUrl(p: { sprite: string }): string {
  return p.sprite
}

/** 一个角色用到的全部素材：本体 + 各状态形态（同一张素球被多个角色共用，只载一次） */
export function characterPacks(ch: Character): Pack[] {
  const out: Pack[] = [ch]
  if (ch.forms) {
    const seen = new Set<string>([ch.id])
    for (const p of Object.values(ch.forms))
      if (!seen.has(p.id)) {
        seen.add(p.id)
        out.push(p)
      }
  }
  return out
}

/** 载入一个角色的全部素材；resolve 时都到位了（本体失败 = false） */
export async function loadCharacter(gl: GuguGL, ch: Character): Promise<boolean> {
  const rs = await Promise.all(
    characterPacks(ch).map((p) => gl.loadTexture(p.id, spriteUrl(p), p.spr))
  )
  return rs[0]
}
