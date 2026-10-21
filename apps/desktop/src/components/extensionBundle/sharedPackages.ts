import type { AttachmentSource } from '@gugu/core/shared/ui/attachmentModels'
import { attachmentBytes, sourceKeyOf } from '../../lib/attachmentBytes'
import { chatService } from '../../lib/chat'
import type { AttachmentPackage } from '../../session/shared/extensions/attachment-install'
import { rendererLogger } from '../../lib/log'
import { newestPackageOf } from '../../session/shared/extensions/app-card-state'
import type { ExtensionManifest } from '../../session/shared/extensions/manifest'
import { summarizeExtensionBundle, type ExtensionBundleSummary } from './summarizeExtensionBundle'

declare const __APP_VERSION__: string

const log = rendererLogger('chat/extension-bundle')

/**
 * A package sent in a chat, as a card knows it (#7290): where its bytes are — an old card's public URL, or the group
 * folder's item / the message itself (read like any attachment, `attachmentBytes`) — and the message it came in.
 */
export interface PackageCard {
  source: AttachmentSource
  messageId: string
}

/** One package, whichever card shows it: the identity its summary and the cards on screen are kept by. */
export function packageKey(card: PackageCard): string {
  return sourceKeyOf(card.source)
}

/** How an install names it: by its message, old cards and new (the host reads who published it there, #7290). */
export function installPackageOf(card: PackageCard): AttachmentPackage {
  return { messageId: card.messageId }
}

/** One read per package for the life of the window: a message re-rendering must not download it again. */
const summaries = new Map<string, Promise<ExtensionBundleSummary>>()

export function summaryOf(card: PackageCard): Promise<ExtensionBundleSummary> {
  const key = packageKey(card)
  let pending = summaries.get(key)
  if (!pending) {
    pending = (async (): Promise<ExtensionBundleSummary> => {
      const bytes = await attachmentBytes(card.source)
      if (bytes.status === 'gone') throw new Error('the package was deleted from the group folder')
      return summarizeExtensionBundle(new Uint8Array(await bytes.blob.arrayBuffer()), __APP_VERSION__)
    })()
      .catch((error: unknown) => {
        // A failed download says nothing about the package: the next time it is asked for, it is read again.
        summaries.delete(key)
        return { ok: false as const, problem: error instanceof Error ? error.message : String(error) }
      })
      .then((summary) => {
        if (!summary.ok) log.warn({ package: key, problem: summary.problem }, 'extension package in chat could not be read')
        return summary
      })
    summaries.set(key, pending)
  }
  return pending
}

/** A package somebody sent in a chat: the App it holds, and its card. */
export interface SharedPackage {
  manifest: ExtensionManifest
  card: PackageCard
}

/**
 * The newest package of each App shared in this chat's messages (摩擦单 F15 / F21): App id → the highest
 * version sent there. Read from the chat's own attachments — no table of its own.
 */
export async function newestSharedPackages(chatId: string, userId: string): Promise<Map<string, SharedPackage>> {
  const cards: PackageCard[] = (await chatService.getChatFiles(chatId, userId)).flatMap((file) =>
    /\.guguext$/i.test(file.fileName) && file.source.kind !== 'gone' ? [{ source: file.source, messageId: file.messageId }] : [],
  )
  const read = await Promise.all(cards.map(async (card) => ({ card, summary: await summaryOf(card) })))
  const packages: SharedPackage[] = read.flatMap(({ card, summary }) => (summary.ok ? [{ manifest: summary.manifest, card }] : []))
  const newest = new Map<string, SharedPackage>()
  for (const id of new Set(packages.map((pkg) => pkg.manifest.id))) newest.set(id, newestPackageOf(packages, id)!)
  return newest
}

// ─── one read per chat, shared (摩擦单 F15: the offer in the group's panel; the via-App badge on a whisper) ───

const perChat = new Map<string, { userId: string; read: Promise<Map<string, SharedPackage>> }>()
const chatListeners = new Set<(chatId: string) => void>()

/**
 * The newest package of each App shared in this chat (`newestSharedPackages`), read once and shared by everyone who
 * asks — until a package is sent in this chat (`packageArrived`); then it is read again and `subscribeSharedPackages`
 * says so.
 */
export function sharedPackagesOf(chatId: string, userId: string): Promise<ReadonlyMap<string, SharedPackage>> {
  let entry = perChat.get(chatId)
  if (!entry || entry.userId !== userId) {
    const read = newestSharedPackages(chatId, userId)
    const made = { userId, read }
    entry = made
    perChat.set(chatId, made)
    // A failed read is not kept: the next ask reads again.
    void read.catch(() => perChat.get(chatId) === made && perChat.delete(chatId))
  }
  return entry.read
}

/** A chat's list of shared packages was read again (a new card): ask `sharedPackagesOf` for it once more. */
export function subscribeSharedPackages(listener: (chatId: string) => void): () => void {
  chatListeners.add(listener)
  return () => chatListeners.delete(listener)
}

/**
 * A package was sent in `chatId` (摩擦单 F66: the account revision bus says so, whether or not anything of that chat is on
 * screen): its list is behind — read again when next asked.
 */
export function packageArrived(chatId: string): void {
  if (!perChat.delete(chatId)) return
  for (const listener of chatListeners) listener(chatId)
}

// ─── the cards on screen (F21: an older card says a newer one is here) ─────────

const shown = new Map<string, SharedPackage>()
const listeners = new Set<() => void>()
let version = 0

/** A card showing this package; the returned function takes it back. */
export function showPackage(pkg: SharedPackage): () => void {
  const key = packageKey(pkg.card)
  shown.set(key, pkg)
  version += 1
  for (const listener of listeners) listener()
  return () => {
    if (shown.get(key) !== pkg) return
    shown.delete(key)
    version += 1
    for (const listener of listeners) listener()
  }
}

export function subscribeShownPackages(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function shownPackagesVersion(): number {
  return version
}

/** The newest package of this App among the cards on screen. */
export function newestShownPackage(id: string): SharedPackage | undefined {
  return newestPackageOf(shown.values(), id)
}
