// An App page's member faces (画廊车道 §6): `getContext().chat.members[].avatar` is the face this host already draws for
// someone (`displayAvatarUrl`: their upload, else their default face), made small — 128px, twice the largest App avatar
// (`--em-avatar-lg` 64), WebP — as a `data:` URL, which the App's CSP already lets in (`app-csp.ts` img-src). Drawn
// here, in a renderer: the phone's host calls it, and the desktop's main process asks the window for it.
import { normalizeAvatarUrl } from '@gugu/core/shared/ui/avatarUrl'
import { displayAvatarUrl } from './dicebearAvatar'
import { parseAgentLook } from '../components/agentAvatar/look'
import { settledAgentLookPoster } from '../components/agentAvatar/posters'
import { redrawImage } from './redrawImage'

const SIZE = 128

// By id and avatar: a new upload is a new URL, so the URL is the avatar's version; a default face is the id's for good.
const drawn = new Map<string, Promise<string | null>>()

/**
 * Someone's face for an App page: their upload, else their default face from their id (seeded by the id, as every
 * surface seeds it — never the name). Null when it cannot be drawn — an upload that does not load stays a failure, not
 * a default face over it (`displayAvatarUrl`) — and drawn again the next time it is asked.
 */
export function memberFace(id: string, avatar: string | null): Promise<string | null> {
  const key = `${id} ${avatar ?? ''}`
  const known = drawn.get(key)
  if (known) return known
  // 形象地址:等引擎把这个形象的定格画好再缩(❌ 缩那张还没画好时顶着的同色图,这里画一次就缓存住了)
  const look = parseAgentLook(normalizeAvatarUrl(avatar))
  const face = look
    ? settledAgentLookPoster(look, id).then(draw, () => null)
    : draw(displayAvatarUrl(avatar, id, 'App member face'))
  drawn.set(key, face)
  void face.then((url) => url === null && drawn.delete(key))
  return face
}

/** These people's faces, by id — none for whom one could not be drawn. */
export async function memberFaces(people: readonly { id: string; avatar: string | null }[]): Promise<Record<string, string>> {
  const faces = await Promise.all(people.map(async ({ id, avatar }) => [id, await memberFace(id, avatar)] as const))
  return Object.fromEntries(faces.filter((face): face is readonly [string, string] => face[1] !== null))
}

async function draw(src: string | null): Promise<string | null> {
  return src ? redrawImage(src, { size: SIZE, fit: 'cover', type: 'image/webp', quality: 0.8 }) : null
}
