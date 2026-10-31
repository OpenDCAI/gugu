/**
 * 小鸟的静态定格:给只能放 <img> 的地方(群消息旁、群头像组合格、投递卡发信人等)。会动的那只是 AgentAvatar。
 * 定格由同一个引擎画一帧静止的样子(runtime.still):颜色、休息表情、装扮都和会动的那只对得上。按形象缓存,同一个形象
 * 整个会话只画一次(组合格、投递卡等多处共用一张)。
 * 第一次要的那一刻还没画好:先给打包的同色定格(12 张 = 12 种身体颜色各一张,平静脸、不戴装扮,由本体定格按
 * engine/identity.ts 同一套换色离线烘出;存储里那 12 张给老客户端的也是它们,见 scripts/agent-look-posters.ts),
 * 画好后通知订阅者换上。
 */
import { useSyncExternalStore } from 'react'
import { rendererLogger } from '@/lib/log'
import { wornOf, type AgentLook } from './look'
import { bodyTint } from './engine/identity'
import { wearKey } from './engine/outfitCatalog'
import { runtime } from './engine/runtime'
import face00 from './assets/faces/agent-face-00.webp'
import face01 from './assets/faces/agent-face-01.webp'
import face02 from './assets/faces/agent-face-02.webp'
import face03 from './assets/faces/agent-face-03.webp'
import face04 from './assets/faces/agent-face-04.webp'
import face05 from './assets/faces/agent-face-05.webp'
import face06 from './assets/faces/agent-face-06.webp'
import face07 from './assets/faces/agent-face-07.webp'
import face08 from './assets/faces/agent-face-08.webp'
import face09 from './assets/faces/agent-face-09.webp'
import face10 from './assets/faces/agent-face-10.webp'
import face11 from './assets/faces/agent-face-11.webp'

const FACES = [face00, face01, face02, face03, face04, face05, face06, face07, face08, face09, face10, face11]

/** 定格的边长(像素):和打包的那 12 张一样大,全身取景 */
const POSTER_PX = 256

const log = rendererLogger('agent-avatar/posters')

const drawn = new Map<string, Promise<string>>()
const ready = new Map<string, string>()
const listeners = new Set<() => void>()
let version = 0

/** 定格按「颜色 | 表情 | 实际穿的那一身」缓存:缺省装扮为空,同一形象共用定格 */
const keyOf = (look: AgentLook) => `${look.color}|${look.rest}|${wearKey(wornOf(look))}`

/** 这个形象的定格画好了的那张;还没画就开始画。画失败记一条,这次会话里不再重画(❌ 每次渲染都起一轮等待) */
export function settledAgentLookPoster(look: AgentLook): Promise<string> {
  const key = keyOf(look)
  let p = drawn.get(key)
  if (!p) {
    p = runtime.still({ tint: bodyTint(look.color), rest: look.rest, wear: wornOf(look) }, POSTER_PX)
    drawn.set(key, p)
    p.then(
      (url) => {
        ready.set(key, url)
        version++
        for (const fn of listeners) fn()
      },
      (err: unknown) => {
        log.error({ key, error: String(err) }, 'drawing agent look poster failed')
      }
    )
  }
  return p
}

/** 这个形象的定格(调用方先定好身体颜色、表情与保存的装扮)。还没画好 = 打包的同色那张 */
export function agentLookPoster(look: AgentLook): string {
  const hit = ready.get(keyOf(look))
  if (hit) return hit
  void settledAgentLookPoster(look).catch(() => {}) // 失败已在里面记过
  return FACES[look.color]
}

/** 有定格画好了就通知(只能放图、又不在 React 里的地方据此重读) */
export function subscribeAgentLookPosters(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** React 里读定格:画好了自动换上 */
export function useAgentLookPostersVersion(): number {
  return useSyncExternalStore(subscribeAgentLookPosters, () => version, () => version)
}

export function useAgentLookPoster(look: AgentLook): string {
  useAgentLookPostersVersion()
  return agentLookPoster(look)
}
