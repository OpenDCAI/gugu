import { comparer, reaction } from 'mobx'
import { observer } from 'mobx-react-lite'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { formatAttachmentSize, type ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'
import { extensionMonogram, localizedManifestText } from '@shared/extensions/catalog'
import { cardOffer } from '@shared/extensions/app-card-state'
import { compareExtensionVersions, opensInChats } from '@shared/extensions/manifest'
import type { ExtensionOrigin } from '@shared/extensions/upgrade'
import { describePermissions } from '@/session/renderer/features/extensions/extension-consent'
import { installedExtensionsStore } from '@/session/renderer/features/extensions/installed-extensions-store'
import { useLocale } from '@/i18n'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { askInShell, installConsentPrompt } from '@/session/renderer/features/extensions/install-consent'
import { rpcOn } from '@/session/renderer/lib/ipc'
import { deviceScopeTrayDevices, LOCAL_DEVICE_SCOPE } from '@/session/renderer/features/remote-hosts/device-scope-store'
import { remoteHostsStore } from '@/session/renderer/features/remote-hosts/remote-hosts-store'
import { INSTALL_CONSENT_HUMAN_WINDOW_MS, type InstallAlsoOnMachine } from '@shared/extensions/host-actions'
import { answered, installAgreedOn, InstallRefusedError } from '@/session/shared/extensions/install-agreed-on'
import { rendererLogger } from '../../lib/log'
import { appsHere } from '../appSlot/appsHere'
import { openApp } from '../appSlot/useOpenApp'
import { Button } from '../ui/Button'
import { ConsentLines } from './ConsentDetails'
import { installedHereLine, refusedLine } from './installedHere'
import { installPackageOf, newestShownPackage, packageKey, showPackage, shownPackagesVersion, subscribeShownPackages, summaryOf, type PackageCard } from './sharedPackages'
import type { ExtensionBundleSummary } from './summarizeExtensionBundle'
import type { HandedConsent } from '@/session/shared/extensions/install-consent-flow'

const log = rendererLogger('chat/extension-bundle')

/**
 * The version of this App installed here, whichever way it came — a folder an agent installed, a
 * card in a chat, the market (摩擦单 F4) — and where it came from (E-05). Follows the installed list as it changes.
 */
function useInstalled(id: string | undefined): { version: string; origin: ExtensionOrigin | undefined } | null {
  const [installed, setInstalled] = useState<{ version: string; origin: ExtensionOrigin | undefined } | null>(null)
  useEffect(() => {
    if (!id) {
      setInstalled(null)
      return undefined
    }
    return reaction(
      () => {
        const version = installedExtensionsStore.manifests.find((manifest) => manifest.id === id)?.version
        return version === undefined ? null : { version, origin: installedExtensionsStore.origins[id] }
      },
      setInstalled,
      { fireImmediately: true, equals: comparer.structural },
    )
  }, [id])
  return installed
}

/**
 * 「装到哪台」(主人 10-02):这台电脑连着的别的机器 —— 新建任务、资源库同一份清单(本机在前,离线的不可选)。没有别的机器
 * (手机,或只有这一台)就不画。画成原生的选择:会话页的 MachinePicker 把菜单弹进会话页的挂载层(getPortalContainer),
 * 聊天里那一层是隐藏的,开了也看不见(L4 装置 10-02 实测)。
 */
const InstallTarget = observer(function InstallTarget({ selectedId, onSelect, className }: { selectedId: string; onSelect: (id: string) => void; className: string }) {
  useEffect(() => remoteHostsStore.start(), [])
  const hosts = [...remoteHostsStore.hosts.values()]
  if (hosts.length === 0) return null
  const machines = deviceScopeTrayDevices(
    translateSessionMessage('task.deviceLocal'),
    hosts.map(({ device }) => ({ device, connection: remoteHostsStore.connectionState(device.id) })),
  )
  return (
    <select
      data-testid="extension-bundle-card-machine"
      aria-label={translateSessionMessage('extensions.bundleCardInstallOn')}
      value={selectedId}
      onChange={(event) => onSelect(event.target.value)}
      className={className}
    >
      {machines.map((machine) => (
        // A Gugu server has no window: an App does not install there (its own answer would only be a refusal).
        // #7199 A cloud computer is a Gugu server too.
        <option key={machine.id} value={machine.id} disabled={(!machine.isLocal && !machine.isOnline) || machine.kind === 'server' || machine.kind === 'cloudComputer'}>
          {machine.label}
        </option>
      ))}
    </select>
  )
})

/** An extension package (`.guguext`) in a chat, drawn from its own manifest (#6646). */
export function ExtensionBundleCard({ meta, card, isMine, senderName, chatId }: {
  meta: Pick<ParsedAttachment, 'fileName' | 'sizeBytes'>
  card: PackageCard
  isMine: boolean
  senderName?: string
  chatId?: string
}) {
  const { sizeBytes } = meta
  const key = packageKey(card)
  const [summary, setSummary] = useState<ExtensionBundleSummary | null>(null)
  useEffect(() => {
    let live = true
    setSummary(null)
    void summaryOf(card).then((next) => live && setSummary(next))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key is the card's identity
  }, [key])
  // On screen, it counts among the packages an older card of the same App points to (摩擦单 F21).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- key is the card's identity
  useEffect(() => (summary?.ok ? showPackage({ manifest: summary.manifest, card }) : undefined), [summary, key])
  const [install, setInstall] = useState<'idle' | 'installing' | 'failed'>('idle')
  /** The version an install from this card just put in: the card says «Installing…» until the installed list has it. */
  const [awaiting, setAwaiting] = useState<string | null>(null)
  /** An update that asked nothing new went straight in: said in one line, not a dialog (摩擦单 F21). */
  const [updatedTo, setUpdatedTo] = useState<string | null>(null)
  // 「装到哪台」(主人 10-02): this computer by default, or another this window is linked to (InstallTarget).
  const [machineId, setMachineId] = useState(LOCAL_DEVICE_SCOPE)
  const machine = machineId === LOCAL_DEVICE_SCOPE ? null : { id: machineId, label: remoteHostsStore.device(machineId)?.label ?? machineId }
  /** What an install on each other machine came to, one line each (that machine's own list is not shown here). */
  const [there, setThere] = useState<{ id: string; machine: string; installed: boolean; refused?: string }[]>([])
  const sayThere = (id: string, machine: string, installed: boolean, refused?: string) =>
    setThere((said) => [...said, { id, machine, installed, ...(refused ? { refused } : {}) }])
  /** E-05 refused this device's install (`refusedLine`): what is here, said instead of a bare failure. */
  const [refused, setRefused] = useState<string | null>(null)
  // This device's Apps download, check and ask the person (main on the desktop, the phone's App store on the phone —
  // one answer, `attachmentInstallPlan`); a declined or timed-out ask leaves the card as it was.
  const installHere = async (target: PackageCard) => {
    if (!appsHere) return
    // D-30: the card's chat — ticked when installing it again here widens who gets the App (125 10-07); a first install
    // ticks every agent here.
    // Read by `answered`, as every install from the card is: E-05 throws InstallRefusedError, said by installFromCard.
    const data = answered(await appsHere.installAttachment({ ...installPackageOf(target), ...(chatId ? { chatId } : {}) }), 'no answer')
    if (!data) throw new Error('no answer')
    if (data.installed) setAwaiting(data.version)
    if (data.installed && data.updatedFrom) setUpdatedTo(data.version)
  }
  // D-31 On a machine picked (another one, or this one with others to tick): that one fetches and checks the package and
  // hands back what it would ask; the person is asked here, where they clicked, and it installs only the bytes they agreed
  // to, given where they ticked. owner 10-16: the same sheet lists the person's other online computers, and the same yes
  // puts it on each one ticked (`installAgreedOn`), that computer's own install of this card's package.
  // Each computer reads the same message as the same person (#7290), or fetches the old card's URL.
  const installVia = async (target: { id: string; label: string } | null, alsoOn: InstallAlsoOnMachine[], pkg: PackageCard) => {
    const card = { ...installPackageOf(pkg), ...(chatId ? { chatId } : {}) }
    const at = (id: string | null) => (consent: HandedConsent) =>
      rpcOn(id).extensions.installAttachment({ ...card, consent })
    let also: string[] = []
    let digest: string | null = null
    /** What stopped this device's own install, thrown once the computers ticked with it have each said theirs. */
    let hereStopped: unknown = null
    try {
      // Both answers are read by `answered`, as installAgreedOn reads them: E-05 at either step throws InstallRefusedError.
      let data = answered(await at(target?.id ?? null)({ kind: 'return' }), 'no answer')
      if (!data) throw new Error('no answer')
      if (data.outcome === 'ask' && 'ask' in data) {
        // Nothing to agree to (`asks` false): the click was the yes.
        let enableIn: string[] | undefined
        digest = data.ask.manifestDigest
        if (data.asks !== false) {
          const ask = target ? { ...data.ask, machine: target.label } : data.ask
          const sheet = askInShell(installConsentPrompt(ask, ask.manifest), `${target?.id ?? 'here'}:${ask.manifestDigest}`, INSTALL_CONSENT_HUMAN_WINDOW_MS, ask.places, undefined, target?.label, alsoOn)
          if (!sheet) throw new Error('No consent sheet in this window to ask the person with')
          const answer = await sheet
          if (answer.outcome !== 'confirmed') return
          also = answer.alsoOn ?? []
          enableIn = answer.enableIn
        }
        data = answered(await at(target?.id ?? null)({ kind: 'given', digest, ...(enableIn ? { enableIn } : {}) }), 'no answer')
        if (!data) throw new Error('no answer')
      }
      if (target) sayThere(target.id, target.label, data.installed)
      else {
        if (data.installed) setAwaiting(data.version)
        if (data.installed && 'updatedFrom' in data && data.updatedFrom) setUpdatedTo(data.version)
      }
    } catch (error) {
      // The machine picked says what it came to in its own line; this device's is said by installFromCard — after the
      // computers ticked with it, which install and say theirs whatever happened here (refused, or the network).
      if (!target) hereStopped = error
      else if (error instanceof InstallRefusedError) {
        log.info({ package: packageKey(pkg), machine: target.id, reason: error.refusal.reason }, 'extension package from chat was refused')
        sayThere(target.id, target.label, false, refusedLine(error.refusal, target.label))
      } else {
        log.warn({ package: packageKey(pkg), machine: target.id, error: error instanceof Error ? error.message : String(error) }, 'extension package from chat was not installed')
        sayThere(target.id, target.label, false)
      }
    }
    // The other computers ticked under the same yes: each its own install, each said — refused ones with what is there.
    for (const id of also) {
      const label = alsoOn.find((one) => one.id === id)?.label ?? id
      const said = await installAgreedOn(at(id), async () => ({ digest: digest! })).then(
        () => ({ installed: true }),
        (error: unknown) => {
          if (error instanceof InstallRefusedError) {
            log.info({ package: packageKey(pkg), machine: id, reason: error.refusal.reason }, 'extension package from chat was refused on another computer')
            return { installed: false, refused: refusedLine(error.refusal, label) }
          }
          log.warn({ package: packageKey(pkg), machine: id, error: error instanceof Error ? error.message : String(error) }, 'extension package from chat was not installed on another computer')
          return { installed: false }
        },
      )
      sayThere(id, label, said.installed, 'refused' in said ? said.refused : undefined)
    }
    if (hereStopped) throw hereStopped
  }
  const installFromCard = async (pkg: PackageCard) => {
    setInstall('installing')
    setThere([])
    setRefused(null)
    try {
      // The person's other online computers, each by name: ticked in the sheet, the same yes installs there too.
      const alsoOn = [...remoteHostsStore.hosts.values()]
        .map(({ device }) => device)
        .filter((device) => device.isOnline && device.id !== machine?.id)
        .map((device) => ({ id: device.id, label: device.label }))
      await (machine || alsoOn.length > 0 ? installVia(machine, alsoOn, pkg) : installHere(pkg))
      setInstall('idle')
    } catch (error) {
      // E-05 here: what this device has did not come from a chat — said with what it is (`refusedLine`).
      if (error instanceof InstallRefusedError) {
        log.info({ package: packageKey(pkg), reason: error.refusal.reason }, 'extension package from chat was refused')
        setRefused(refusedLine(error.refusal))
        setInstall('idle')
        return
      }
      log.warn({ package: packageKey(pkg), machine: machine?.id, error: error instanceof Error ? error.message : String(error) }, 'extension package from chat was not installed')
      setInstall('failed')
    }
  }
  const strong = isMine ? 'text-[var(--text-on-bubble-strong)]' : 'text-[var(--text-primary)]'
  const muted = isMine ? 'text-[var(--text-on-bubble-muted)]' : 'text-[var(--text-tertiary)]'
  const t = translateSessionMessage
  const manifest = summary?.ok ? summary.manifest : null
  const { resolvedLocale: locale } = useLocale()
  const name = manifest ? localizedManifestText(manifest, locale).name : null
  // Already here — the same App at the same version — is installed, however it got here.
  const here = useInstalled(manifest?.id)
  const installedVersion = here?.version ?? null
  // A newer package of the same App is on screen too: this card says so, and installs that one (摩擦单 F21).
  useSyncExternalStore(subscribeShownPackages, shownPackagesVersion)
  const newest = manifest ? newestShownPackage(manifest.id) : undefined
  const newer = manifest && newest && compareExtensionVersions(newest.manifest.version, manifest.version) > 0 ? newest : null
  // What the card offers follows what is installed here, always — installed, updated, uninstalled (摩擦单 F66): the one
  // answer the desktop and the phone share (`cardOffer`).
  const offer = manifest
    ? cardOffer({ installedVersion, installedOrigin: here?.origin, cardVersion: manifest.version, ...(newer ? { newestVersion: newer.manifest.version } : {}) })
    : null
  const installed = offer?.action === 'open'
  const waiting = awaiting !== null && (installedVersion === null || compareExtensionVersions(installedVersion, awaiting) < 0)
  useEffect(() => {
    if (awaiting !== null && !waiting) setAwaiting(null)
  }, [awaiting, waiting])
  // Installed, the one button opens it here (「在本群打开」, `openApp`): in this chat's panel — a group's, a topic's or a
  // private chat's, each has one (主人 10-05) — when it has something to open in one. Otherwise the card says where it is
  // used: an App that only opens a session's files is used in sessions.
  const opens = manifest !== null && opensInChats(manifest)
  // Usable on this device at all: the host says, by what it can do (`appsHere.runs`) — never by which files the App opens.
  const runsHere = manifest !== null && appsHere !== null && appsHere.runs(manifest)
  return (
    <div
      data-testid="extension-bundle-card"
      data-extension-id={manifest?.id}
      data-installed={installed ? 'true' : undefined}
      data-problem={summary && !summary.ok ? summary.problem : undefined}
      className="mb-2 box-border flex min-w-0 max-w-72 flex-col gap-2 rounded-xl border border-[var(--border)] p-3"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span aria-hidden className={`grid size-8 shrink-0 place-items-center rounded-[var(--radius-document)] border border-[var(--border)] font-mono text-[var(--font-body)] ${strong}`}>
          {name ? extensionMonogram(name) : '?'}
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <span className={`truncate text-[var(--font-body)] font-semibold ${strong}`}>
            {manifest ? `${name} ${manifest.version}` : meta.fileName}
          </span>
          <span className={`truncate text-[var(--font-caption)] ${muted}`}>
            {manifest ? `${manifest.id} · ${formatAttachmentSize(sizeBytes)}` : formatAttachmentSize(sizeBytes)}
          </span>
        </div>
      </div>
      {!summary && <span className={`text-[var(--font-caption)] ${muted}`}>{t('extensions.bundleCardReading')}</span>}
      {summary && !summary.ok && (
        <span data-testid="extension-bundle-card-problem" className="text-[var(--font-body)] text-[var(--text-error)]">
          {summary.needsApp ? t('extensions.needsNewerApp', { version: summary.needsApp }) : t('extensions.bundleCardUnreadable')}
        </span>
      )}
      {manifest && summary?.ok && (
        <>
          {/* What the consent would ask where it installs: this device's (`grantable`: a phone does not list what only a
              computer gives), or the machine picked — all of it, named as that machine's. */}
          <div data-testid="extension-bundle-card-permissions" className={`text-[var(--font-body)] ${strong}`}>
            <ConsentLines text={machine ? describePermissions(manifest, t, machine.label) : describePermissions(appsHere ? appsHere.grantable(manifest) : manifest, t)} />
          </div>
          {senderName && <span className={`text-[var(--font-caption)] ${muted}`}>{t('extensions.bundleCardFrom', { name: senderName })}</span>}
          {appsHere && !runsHere && (
            <span data-testid="extension-bundle-card-elsewhere" className={`text-[var(--font-caption)] ${muted}`}>
              {t('extensions.bundleCardElsewhere')}
            </span>
          )}
          {runsHere && (
            <div className="flex flex-wrap items-center gap-2">
              <InstallTarget
                selectedId={machineId}
                onSelect={setMachineId}
                className={`max-w-32 truncate rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-[var(--font-caption)] ${strong}`}
              />
              {offer?.action === 'elsewhere' && !machine ? (
                // E-05: what is here did not come from a chat, so this card cannot update it — said, with the way to the
                // App page where it is managed; whether there is a newer one there is for its own source to say.
                <>
                  <span data-testid="extension-bundle-card-installed-elsewhere" data-from={offer.from ?? 'unknown'} className={`text-[var(--font-caption)] ${muted}`}>
                    {installedHereLine(offer.from, offer.installedVersion)}
                  </span>
                  <Button size="sm" variant="ghost" data-testid="extension-bundle-card-apps-page" onClick={() => appsHere?.openAppsPage()}>
                    {t('extensions.openAppsPage')}
                  </Button>
                </>
              ) : installed && !waiting && !opens && !machine ? (
                <span data-testid="extension-bundle-card-opens-in-sessions" className={`text-[var(--font-caption)] ${muted}`}>
                  {t('extensions.bundleCardOpensInSessions')}
                </span>
              ) : (
                <Button
                  size="sm"
                  data-testid="extension-bundle-card-install"
                  data-action={machine ? 'install-on' : offer?.action === 'install' && offer.newer ? 'install-newer' : offer?.action}
                  disabled={install === 'installing' || (waiting && !machine)}
                  onClick={() => (installed && !machine ? openApp(manifest.id, chatId) : void installFromCard(newer?.card ?? card))}
                >
                  {install === 'installing' || (waiting && !machine)
                    ? t('extensions.bundleCardInstalling')
                    : machine
                      ? t('extensions.installAction')
                      : offer?.action === 'open'
                      ? // A newer version than this card's is installed: said, and the card opens it — never a downgrade (L6).
                        offer.installedNewer !== null
                        ? t('extensions.bundleCardNewerInstalled', { version: offer.installedNewer })
                        : t('extensions.bundleCardOpen')
                      : offer?.action === 'update'
                        ? t('extensions.bundleCardUpdate', { version: offer.version })
                        : offer?.action === 'install' && offer.newer
                          ? t('extensions.bundleCardNewer', { version: offer.version })
                          : t('extensions.installAction')}
                </Button>
              )}
              {updatedTo && <span className={`text-[var(--font-caption)] ${muted}`}>{t('extensions.bundleCardUpdated', { version: updatedTo })}</span>}
              {there.map((one) => (
                <span key={one.id} data-testid="extension-bundle-card-there" data-installed={one.installed ? 'true' : 'false'}
                  className={`text-[var(--font-caption)] ${one.installed ? muted : 'text-[var(--text-error)]'}`}>
                  {one.refused ?? t(one.installed ? 'extensions.bundleCardInstalledOn' : 'extensions.bundleCardNotInstalledOn', { machine: one.machine })}
                </span>
              ))}
              {refused && (
                <span data-testid="extension-bundle-card-refused" className="text-[var(--font-caption)] text-[var(--text-error)]">
                  {refused}
                </span>
              )}
              {install === 'failed' && (
                <span className="text-[var(--font-caption)] text-[var(--text-error)]">{t('extensions.bundleCardInstallFailed')}</span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
