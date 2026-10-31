/**
 * gl.ts —— 身体都在这里画：每个部件 = 一张无眼素材当成软网格（顶点由 CPU 用 geometry.warp 算好传进来）。
 * 角色本体与各状态形态的素材（Pack）走同一条路径。
 * 一个共享的离屏 WebGL2 画布，所有头像往里画，再 drawImage 抄到各自的 2D 画布上
 * （浏览器对同页 WebGL 上下文数量有上限，几十个头像不能各开一个）。
 * 同一帧要画的几只一批:每一趟在画布上占一格,整批画完再统一抄走 —— 每在 GL 画过之后抄一次,GPU 就要同步一次,
 * ❌ 画一只抄一只(mac1 实测 8 张画布、每秒 15 帧:交错着抄 5.6 CPU 秒/分,画完再抄 4.0)。
 * 一格里贴同一张纹理的几片攒成一次绘制:本体和它的刚体部件、接触阴影拼在一张图集里(loadCharacter),
 * 一只鸟一格只画一次 —— 每次绘制在 GPU 进程里都有固定开销(实测一片一画一次:10 只空闲头像的 GPU 进程多 1.4 CPU 秒/分)。
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
in vec2 a_at; // 这一片的不透明度、换不换身体颜色
uniform vec2 u_res;
out vec2 v_uv;
out vec2 v_at;
void main() {
  v_uv = a_uv;
  v_at = a_at;
  vec2 c = a_pos / u_res * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec2 v_at;
uniform sampler2D u_tex;
uniform float u_desat;
uniform float u_dim;
uniform vec3 u_tint;     // 身份层的身体颜色:目标色 / 奶油参考色(线性空间逐通道比值,identity.ts bodyTint)
out vec4 o;
vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec3 base = c.rgb;
  if (v_at.y > 0.5 && c.a > 0.004) {
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
  o = vec4(rgb, c.a) * v_at.x;
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

/** 一张素材在哪张纹理的哪一块(uv 0..1);单张素材就是整张 */
interface Sub {
  t: WebGLTexture
  u: number
  v: number
  du: number
  dv: number
}
/** 每个顶点:画布上的 x, y,纹理上的 u, v,这一片的不透明度,换不换身体颜色 */
const FLOATS = 6
/** 图集里各块之间留空:小头像采到的 mip 层上一个纹素是十几个素材像素,留得够,相邻的块才不会渗进来 */
const GUTTER = 48

export class GuguGL {
  readonly canvas: HTMLCanvasElement
  /** CPU 写入的网格顶点(画布像素坐标):drawSprite 读前 (cols+1)×(rows+1) 个,一行接一行 */
  readonly verts = new Float32Array(VERT_COUNT * 2)
  private gl: WebGL2RenderingContext
  private prog: WebGLProgram
  private vao: WebGLVertexArrayObject
  private vbuf: WebGLBuffer
  private u: Record<string, WebGLUniformLocation | null> = {}
  private w = 0
  private h = 0
  /** 这一批排到哪儿了:格子从左上往右排,一行排满换下一行 */
  private cx = 0
  private cy = 0
  private rowH = 0

  private tex = new Map<string, Sub>()
  private loading = new Map<string, Promise<boolean>>()

  /** 攒着还没画的几片:同一张纹理、同样的去色 / 压暗 / 身体颜色 */
  private bv = new Float32Array(FLOATS * 2048)
  private bi = new Uint16Array(8192)
  private nv = 0
  private ni = 0
  private bt: WebGLTexture | null = null
  private bDesat = 0
  private bDim = 1
  private bTint: Rgb | null = null

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas
    this.gl = gl

    this.prog = compile(gl, VS, FS)
    gl.useProgram(this.prog)
    this.vao = gl.createVertexArray()!
    gl.bindVertexArray(this.vao)
    this.vbuf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbuf)
    const attr = (name: string, off: number) => {
      const loc = gl.getAttribLocation(this.prog, name)
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, FLOATS * 4, off * 4)
    }
    attr('a_pos', 0)
    attr('a_uv', 2)
    attr('a_at', 4)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer()!)
    gl.activeTexture(gl.TEXTURE0)
    gl.uniform1i(gl.getUniformLocation(this.prog, 'u_tex'), 0)
    for (const n of ['u_res', 'u_desat', 'u_dim', 'u_tint']) this.u[n] = gl.getUniformLocation(this.prog, n)

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

  /** 载入一张无眼素材;size = 期望的素材像素尺寸(与角色包里的 spr 对不上就警告)。失败不记账:下次再要就再试 */
  loadTexture(id: string, url: string, size: { w: number; h: number }): Promise<boolean> {
    return this.loadAtlas([{ id, url, size }])
  }

  /**
   * 几张素材拼成一张图集(本体 + 它的刚体部件、接触阴影),同一格里贴它们的几片就攒成一次绘制。
   * 第一张放左上,其余一行行排在它下面;以第一张的 id 记账,失败不记账:下次再要就再试
   */
  loadAtlas(parts: { id: string; url: string; size: { w: number; h: number } }[]): Promise<boolean> {
    const key = parts[0].id
    if (this.tex.has(key)) return Promise.resolve(true)
    let p = this.loading.get(key)
    if (!p) {
      p = this.fetchAtlas(parts).then((ok) => {
        if (!ok) this.loading.delete(key)
        return ok
      })
      this.loading.set(key, p)
    }
    return p
  }

  private async fetchAtlas(parts: { id: string; url: string; size: { w: number; h: number } }[]): Promise<boolean> {
    try {
      const bmps = await Promise.all(parts.map((p) => this.decode(p.id, p.url, p.size)))
      const W = Math.max(...bmps.map((b) => b.width))
      const at: [number, number][] = [[0, 0]]
      let x = 0
      let y = bmps[0].height + GUTTER
      let rowH = 0
      for (let i = 1; i < bmps.length; i++) {
        if (x > 0 && x + bmps[i].width > W) [x, y, rowH] = [0, y + rowH + GUTTER, 0]
        at.push([x, y])
        x += bmps[i].width + GUTTER
        rowH = Math.max(rowH, bmps[i].height)
      }
      const H = bmps.length > 1 ? y + rowH : bmps[0].height
      const gl = this.gl
      const t = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, t)
      if (bmps.length === 1) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmps[0])
      else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null) // 全透明:块与块之间的留空
        bmps.forEach((b, i) => gl.texSubImage2D(gl.TEXTURE_2D, 0, at[i][0], at[i][1], gl.RGBA, gl.UNSIGNED_BYTE, b))
      }
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic')
      if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4)
      parts.forEach((p, i) =>
        this.tex.set(p.id, { t, u: at[i][0] / W, v: at[i][1] / H, du: bmps[i].width / W, dv: bmps[i].height / H })
      )
      for (const b of bmps) b.close()
      return true
    } catch (err) {
      log.error({ id: parts[0].id, error: String(err) }, 'sprite load failed')
      return false
    }
  }

  private async decode(id: string, url: string, size: { w: number; h: number }): Promise<ImageBitmap> {
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
    return bmp
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

  /** 开一格(先 room() 过):上一格攒着的先画掉,视口挪到这一格、清空;返回它在画布上的左上角,画完从这里抄走 */
  begin(w: number, h: number): [number, number] {
    this.flush()
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

  /**
   * 一片:this.verts 里 cols×rows 格的网格,贴 id 对应的素材;tint = 身份层的身体颜色(null = 素材原色)。
   * 先攒着,换了纹理 / 去色压暗 / 身体颜色才画掉前面攒的;开新的一格、flush() 时也画掉
   */
  drawSprite(id: string, desat: number, dim: number, alpha: number, tint: Rgb | null = null, cols = GRID_X, rows = GRID_Y, vertexAlpha?: Float32Array) {
    const s = this.tex.get(id)
    if (alpha < 0.004 || !s) return
    const nv = (cols + 1) * (rows + 1)
    const ni = cols * rows * 6
    if (
      s.t !== this.bt ||
      desat !== this.bDesat ||
      dim !== this.bDim ||
      (tint && this.bTint && tint !== this.bTint) ||
      this.nv + nv > 65535
    )
      this.flush()
    this.bt = s.t
    this.bDesat = desat
    this.bDim = dim
    if (tint) this.bTint = tint
    if ((this.nv + nv) * FLOATS > this.bv.length) this.bv = grow(this.bv, (this.nv + nv) * FLOATS)
    if (this.ni + ni > this.bi.length) this.bi = grow(this.bi, this.ni + ni)
    const bv = this.bv
    const tf = tint ? 1 : 0
    let k = this.nv * FLOATS
    let q = 0
    for (let j = 0; j <= rows; j++)
      for (let i = 0; i <= cols; i++) {
        bv[k++] = this.verts[q++]
        bv[k++] = this.verts[q++]
        bv[k++] = s.u + (i / cols) * s.du
        bv[k++] = s.v + (j / rows) * s.dv
        bv[k++] = alpha * (vertexAlpha ? vertexAlpha[j * (cols + 1) + i] : 1)
        bv[k++] = tf
      }
    const bi = this.bi
    let m = this.ni
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const a = this.nv + j * (cols + 1) + i
        const c = a + cols + 1
        bi[m++] = a
        bi[m++] = a + 1
        bi[m++] = c
        bi[m++] = a + 1
        bi[m++] = c + 1
        bi[m++] = c
      }
    this.nv += nv
    this.ni = m
  }

  /** 把攒着的几片画出去(一次绘制)。抄走这一格之前一定要冲过:paintGL 末尾、begin() 开头 */
  flush() {
    if (!this.ni) return
    const gl = this.gl
    gl.useProgram(this.prog)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.bt)
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbuf)
    gl.bufferData(gl.ARRAY_BUFFER, this.bv.subarray(0, this.nv * FLOATS), gl.STREAM_DRAW)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.bi.subarray(0, this.ni), gl.STREAM_DRAW)
    gl.uniform2f(this.u.u_res, this.w, this.h)
    gl.uniform1f(this.u.u_desat, this.bDesat)
    gl.uniform1f(this.u.u_dim, this.bDim)
    if (this.bTint) gl.uniform3f(this.u.u_tint, this.bTint[0], this.bTint[1], this.bTint[2])
    gl.drawElements(gl.TRIANGLES, this.ni, gl.UNSIGNED_SHORT, 0)
    this.nv = this.ni = 0
    this.bTint = null
  }
}

function grow<T extends Float32Array | Uint16Array>(a: T, need: number): T {
  const b = new (a.constructor as { new (n: number): T })(Math.max(need, a.length * 2))
  b.set(a)
  return b
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

/**
 * 载入一个角色的全部素材:本体和它的刚体部件、接触阴影拼成一张图集(一格画一次),各状态形态各一张。
 * runtime 以「本体纹理到位」为能画的信号:部件和本体一起到,不会先画出一只没翅膀、没嘴的鸟
 */
export async function loadCharacter(gl: GuguGL, ch: Character): Promise<boolean> {
  const rig = ch.rig ? ch.rig.pieces.flatMap((pc) => [pc, ...(pc.shade ? [pc.shade] : [])]) : []
  const body = [{ id: ch.id, url: spriteUrl(ch), size: ch.spr }, ...rig.map((r) => ({ id: r.id, url: r.sprite, size: { w: r.box.w, h: r.box.h } }))]
  const rs = await Promise.all(characterPacks(ch).map((p, i) => (i === 0 ? gl.loadAtlas(body) : gl.loadTexture(p.id, spriteUrl(p), p.spr))))
  return rs[0]
}
