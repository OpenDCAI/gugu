import type { useSessionMessages } from '@renderer/localization/use-session-messages';
import { compareExtensionVersions, programLine, type ExtensionCapability, type ExtensionManifest } from '@shared/extensions/manifest';
import { localizedManifestText } from '@shared/extensions/catalog';
import { addedPermissions } from '@shared/extensions/upgrade';
import { isComputerUseView } from '@shared/extensions/app-places';
import type { ExtensionConsentDetails } from '@shared/extensions/host-actions';

/**
 * What the user is asked before a bundle lands.
 *
 * Kept out of the settings component, and out of the app-state graph, so the
 * wording can be judged on its own: this is the one screen standing between an
 * unaudited third-party bundle and the machine, and「装时一次性人话清单」is a
 * product promise, not a detail of how the card renders. Refs #2374.
 */

export type SessionTranslate = ReturnType<typeof useSessionMessages>['translate'];

export interface ConsentPrompt {
  title: string;
  description: string;
  /** The exact command lines the plain sentence stands for, folded (`programDetails`). */
  details?: ExtensionConsentDetails;
  confirmLabel: string;
  /** The button that says no, when 「取消」 would mislead (first run's 「不装」: never asked again). */
  cancelLabel?: string;
  variant: 'default';
}

/**
 * What each capability lets an extension do, in plain words — one sentence each, the same wherever the App works: a
 * word means the same anywhere (owner 10-05 23:29), so its breadth is said once, as it is. Exhaustive by type: a new
 * capability without a sentence stops the build instead of reaching a user as its own key.
 */
const CAPABILITY_MESSAGE = {
  'files:read': 'extensions.permissionsFilesRead',
  'files:read:all-machines': 'extensions.permissionsFilesReadAllMachines',
  'files:write': 'extensions.permissionsFilesWrite',
  'chat:relay': 'extensions.permissionsChatRelay',
  'chat:read': 'extensions.permissionsChatRead',
  'agents:read': 'extensions.permissionsAgentsRead',
  'agents:read:all': 'extensions.permissionsAgentsReadAll',
  'agents:read:all-machines': 'extensions.permissionsAgentsReadAllMachines',
  'agents:history': 'extensions.permissionsAgentsHistory',
  'agents:history:all': 'extensions.permissionsAgentsHistoryAll',
  'agents:control': 'extensions.permissionsAgentsControl',
  'agents:control:all': 'extensions.permissionsAgentsControlAll',
  'agents:control:all-machines': 'extensions.permissionsAgentsControlAllMachines',
  'agents:tools': 'extensions.permissionsAgentsTools',
  'notifications': 'extensions.permissionsNotifications',
} as const satisfies Record<ExtensionCapability, string>;

/** The one sentence for a capability, wherever it is shown: consent, the permission switches, the detail sheet. */
export function describeCapability(
  capability: ExtensionCapability,
  manifest: ExtensionManifest,
  translate: SessionTranslate,
  /** D-31 Asked on another device: the computer it installs on, named instead of 「这台电脑」. */
  machine?: string
): string {
  if (capability === 'agents:tools') return describeAgentTools(manifest, translate, machine);
  return translate(CAPABILITY_MESSAGE[capability], { computer: computerNamed(translate, machine) });
}

/**
 * The computer a sentence of the consent is about, named as it is: this one, or the one it installs on (an App page or a
 * card showing another machine) — every `{computer}` of these sentences is filled from here (owner: a consent says its
 * reach as it is).
 */
export function computerNamed(translate: SessionTranslate, machine?: string): string {
  return machine ? translate('extensions.permissionsOnMachine', { machine }) : translate('extensions.permissionsThisComputer');
}

function describeCapabilities(
  capabilities: readonly ExtensionCapability[],
  translate: SessionTranslate,
  manifest: ExtensionManifest,
  machine?: string
): string[] {
  return capabilities.map((capability) => describeCapability(capability, manifest, translate, machine));
}

/**
 * `agents:tools` in plain words (owner 10-06「node launch.mjs 没人看得懂」): that a program of its own will run, and what a
 * program running with the person's rights can reach. #6387's point stands — the person agrees to these programs, never to
 * "some tools" — so each command, exactly as it will run, is in the details beside it (`programDetails`).
 */
function describeAgentTools(manifest: ExtensionManifest, translate: SessionTranslate, machine?: string): string {
  const servers = manifest.contributes.mcpServers ?? [];
  // #7317 Computer Use runs no program of its own: it is the switch of gugu's computer control on that computer (agents
  // operate its apps once it is on), and its page shows that control at work. With skills it gives agents something more.
  if (isComputerUseView(manifest)) {
    return translate('extensions.permissionsComputerUseView', { computer: computerNamed(translate, machine) });
  }
  if (servers.length === 0) {
    return machine ? translate('extensions.permissionsAgentsSkillsOnlyOn', { machine }) : translate('extensions.permissionsAgentsSkillsOnly');
  }
  const skills = manifest.contributes.skills ? translate('extensions.permissionsAgentsToolsSkills') : '';
  return machine ? translate('extensions.permissionsAgentsToolsOn', { skills, machine }) : translate('extensions.permissionsAgentsTools', { skills });
}

/**
 * An install from the market says where it came from, first, on the same sheet as a chat package.
 */
export function withMarketSource(prompt: ConsentPrompt, translate: SessionTranslate): ConsentPrompt {
  const line = translate('extensions.consentFromMarket');
  return { ...prompt, description: `${line}\n\n${prompt.description}` };
}

/** The command lines an App's programs run, word for word: the details under the plain sentence. */
export function programDetails(manifest: ExtensionManifest, translate: SessionTranslate): ExtensionConsentDetails | undefined {
  const lines = (manifest.contributes.mcpServers ?? []).map(programLine);
  if (lines.length === 0) return undefined;
  return { label: translate('extensions.consentDetails'), caption: translate('extensions.consentDetailsCommands'), lines };
}

/**
 * The permission list in plain words — abilities first, then where it may go.
 * An extension that asked for nothing says so: "no permissions" is information,
 * and leaving the line out would read as though the question had not been asked.
 */
export function describePermissions(
  manifest: ExtensionManifest,
  translate: SessionTranslate,
  machine?: string
): string {
  const lines = describeCapabilities(manifest.permissions?.capabilities ?? [], translate, manifest, machine);
  const hosts = manifest.permissions?.network ?? [];
  if (hosts.length > 0) {
    lines.push(translate('extensions.permissionsNetwork', { hosts: hosts.join(', ') }));
  }
  // Asking for nothing still reaches one thing: the file the person opens with it.
  if (lines.length === 0) return translate('extensions.permissionsNone');
  return lines.join('\n');
}

/**
 * A first install asks about everything it declares. An upgrade asks only about
 * what it newly gained (`addedPermissions`): re-reading the same list on every
 * version is how a prompt stops being read at all, and the contract says the
 * parts that did not change should not interrupt again. A withdrawn permission
 * is not new, and stays withdrawn.
 *
 * Adding something is not a destructive act, so the dialog is asked for the
 * plain variant rather than the red one it defaults to.
 */
export function consentPrompt(
  installed: Pick<ExtensionManifest, 'version' | 'permissions'> | undefined,
  revokedPermissions: readonly string[],
  candidate: ExtensionManifest,
  translate: SessionTranslate,
  /** The interface language: the App is named as its manifest's `localized` says it there. */
  locale: string,
  /**
   * 「这版改了什么」(云端那一版的 store/whats-new.md,#5410)。只在有装着的旧版本、且这是
   * 一次更新时才放在描述最前面 —— 首次安装没有「这一版相对哪一版」可言,权限清单已经
   * 是当时最重要的那句话。
   */
  releaseNotes?: string,
  /** D-31 Asked on another device: the computer it installs on (its agents, its files). */
  machine?: string
): ConsentPrompt {
  const details = programDetails(candidate, translate);
  const name = localizedManifestText(candidate, locale).name;
  if (!installed) {
    // Only a first install takes the App's own `toolsListed` (an upgrade leaves the person's switch alone): said here, so
    // the person knows it will sit in every agent's tool list — and that the Apps page switches it back.
    const listed = candidate.contributes.toolsListed ? `\n${translate('extensions.consentToolsListed')}` : '';
    return {
      title: translate('extensions.installConfirmTitle', { name }),
      description: `${describePermissions(candidate, translate, machine)}${listed}`,
      ...(details ? { details } : {}),
      confirmLabel: translate('extensions.installAction'),
      variant: 'default',
    };
  }
  const { capabilities: addedCapabilities, network: addedHosts } = addedPermissions(
    installed,
    revokedPermissions,
    candidate
  );
  const added = [...describeCapabilities(addedCapabilities, translate, candidate, machine)];
  if (addedHosts.length > 0) {
    added.push(translate('extensions.permissionsNetwork', { hosts: addedHosts.join(', ') }));
  }
  const goingBack = compareExtensionVersions(candidate.version, installed.version) < 0;
  const permissionsLine =
    added.length === 0
      ? translate('extensions.updateNothingNew')
      : translate('extensions.updateNewPermissions', { permissions: added.join('\n') });
  return {
    title: translate(
      goingBack ? 'extensions.downgradeConfirmTitle' : 'extensions.updateConfirmTitle',
      { name, version: candidate.version, installedVersion: installed.version }
    ),
    description:
      releaseNotes && !goingBack
        ? `${translate('extensions.updateConsentReleaseNotes')}\n${releaseNotes}\n\n${permissionsLine}`
        : permissionsLine,
    ...(details ? { details } : {}),
    // Going back is no update: the button says which version it puts there (the title says it is older).
    confirmLabel: goingBack ? translate('extensions.useVersion', { version: candidate.version }) : translate('extensions.updateAction'),
    variant: 'default',
  };
}
