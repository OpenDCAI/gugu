// @vitest-environment jsdom
// 统筹 10-05(画廊车道 §6、AGENTS.md「头像」那条):App 拿到的 members[].avatar 是宿主画的那张脸缩成 128px 的 WebP data:。
// 判据:① 没上传的人按稳定 id 出默认脸(和群成员列表同一个种子,❌ 名字);② 上传的照原图画;③ 按「id + 头像」只画一次,
// 换了上传(新 URL)就重画;④ 画不出来(上传加载失败)给 null,不拿默认脸盖掉,下次再问重画。
// jsdom 没有图片解码和 canvas:Image 和 canvas 换成记账的替身,量的是画了什么、画了几次。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dicebearAvatarDataUri } from '../../../../apps/desktop/src/lib/dicebearAvatar'

const drawnFrom: string[] = []
let broken = new Set<string>()
class FakeImage {
  crossOrigin: string | null = null
  src = ''
  naturalWidth = 460
  naturalHeight = 300
  decode() {
    drawnFrom.push(this.src)
    return broken.has(this.src) ? Promise.reject(new Error('EncodingError')) : Promise.resolve()
  }
}
const drawImage = vi.fn()
const createElement = document.createElement.bind(document)

beforeEach(() => {
  drawnFrom.length = 0
  broken = new Set()
  drawImage.mockClear()
  vi.stubGlobal('Image', FakeImage)
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
    tag === 'canvas'
      ? ({ width: 0, height: 0, getContext: () => ({ drawImage }), toDataURL: (type: string, quality: number) => `data:${type};q=${quality}` } as never)
      : createElement(tag)) as typeof document.createElement)
  vi.resetModules()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const load = () => import('../../../../apps/desktop/src/lib/memberFaces')
const ID = '0a000000-0000-4000-8000-00000000000a'
const UPLOAD = 'https://devdb.invalid/storage/v1/object/public/avatars/a-1.png'

describe('members[].avatar: the face the host draws, small', () => {
  it('no upload: the default face from their id, as the member list draws it — 128px WebP', async () => {
    const { memberFace } = await load()
    await expect(memberFace(ID, null)).resolves.toBe('data:image/webp;q=0.8')
    expect(drawnFrom).toEqual([dicebearAvatarDataUri(ID)])
    // The middle square of the image, into 128 × 128.
    expect(drawImage).toHaveBeenCalledWith(expect.any(FakeImage), 80, 0, 300, 300, 0, 0, 128, 128)
  })

  it('an upload is drawn from the upload, once per id and upload — a new upload is drawn again', async () => {
    const { memberFaces } = await load()
    await expect(memberFaces([{ id: ID, avatar: UPLOAD }])).resolves.toEqual({ [ID]: 'data:image/webp;q=0.8' })
    await memberFaces([{ id: ID, avatar: UPLOAD }])
    expect(drawnFrom).toEqual([UPLOAD])
    await memberFaces([{ id: ID, avatar: `${UPLOAD}?v=2` }])
    expect(drawnFrom).toEqual([UPLOAD, `${UPLOAD}?v=2`])
  })

  it('an upload that does not load is no face — not a default face over it — and is tried again when asked again', async () => {
    broken.add(UPLOAD)
    const { memberFaces } = await load()
    await expect(memberFaces([{ id: ID, avatar: UPLOAD }])).resolves.toEqual({})
    await memberFaces([{ id: ID, avatar: UPLOAD }])
    expect(drawnFrom).toEqual([UPLOAD, UPLOAD])
  })
})
