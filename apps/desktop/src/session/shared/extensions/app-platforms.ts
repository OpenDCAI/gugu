import type { ExtensionCapability } from './manifest';

/** Platforms describe the App's human-facing interface, not where its agent programs run. */
export const APP_PLATFORMS = ['desktop', 'phone'] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];
export const APP_PLATFORMS_API_VERSION = 11;

/**
 * The phone's one capability table. Agent features do not run here; declaring them does not make an otherwise usable
 * phone page invalid. A human-facing capability unavailable here does. New capability words must choose a category.
 * `files:read:all-machines` reads chat files here, as `files:read` does: a phone has no session working copies.
 */
export const PHONE_CAPABILITY_SUPPORT = {
  'files:read': 'available',
  'files:read:all-machines': 'available',
  'files:write': 'available',
  'chat:relay': 'available',
  'chat:read': 'available',
  'agents:read': 'agent',
  'agents:read:all': 'agent',
  'agents:read:all-machines': 'agent',
  'agents:history': 'agent',
  'agents:history:all': 'agent',
  'agents:control': 'agent',
  'agents:control:all': 'agent',
  'agents:control:all-machines': 'agent',
  'agents:tools': 'agent',
  notifications: 'desktop-only',
} as const satisfies Record<ExtensionCapability, 'available' | 'agent' | 'desktop-only'>;

export const PHONE_CAPABILITIES: readonly ExtensionCapability[] = (Object.keys(PHONE_CAPABILITY_SUPPORT) as ExtensionCapability[])
  .filter((capability) => PHONE_CAPABILITY_SUPPORT[capability] === 'available');

/**
 * Publication, market selection and installation share this rule. Runtime inventory deliberately does not call it:
 * an installed older App stays runnable and eligible for the existing automatic updater.
 * No runtime dependencies: the market's Node 24 verifier imports this exact module from its pinned client commit.
 */
export function appPlatformProblems(raw: unknown, target?: AppPlatform): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['platforms: an App manifest is required'];
  const manifest = raw as { platforms?: unknown; apiVersion?: unknown; permissions?: { capabilities?: unknown } };
  const platforms = manifest.platforms;
  if (!Array.isArray(platforms) || platforms.length === 0) return ['platforms: declare desktop, phone, or both'];
  const problems: string[] = [];
  if (platforms.some((platform) => !APP_PLATFORMS.includes(platform))) problems.push('platforms: only desktop and phone are supported');
  if (new Set(platforms).size !== platforms.length) problems.push('platforms: duplicate platform');
  if (typeof manifest.apiVersion !== 'number' || !Number.isInteger(manifest.apiVersion) || manifest.apiVersion < APP_PLATFORMS_API_VERSION) {
    problems.push(`platforms: requires apiVersion ${APP_PLATFORMS_API_VERSION}`);
  }
  if (platforms.includes('phone') && Array.isArray(manifest.permissions?.capabilities)) {
    for (const capability of manifest.permissions.capabilities) {
      if (typeof capability !== 'string' || !Object.hasOwn(PHONE_CAPABILITY_SUPPORT, capability)) {
        problems.push(`permissions.capabilities: unknown capability ${String(capability)}`);
      } else if (PHONE_CAPABILITY_SUPPORT[capability as ExtensionCapability] === 'desktop-only') {
        problems.push(`platforms: phone does not support ${capability}`);
      }
    }
  }
  if (target && !platforms.includes(target)) problems.push(`platforms: this App does not support ${target}`);
  return problems;
}

export function requireAppPlatform(raw: unknown, target: AppPlatform): void {
  const problems = appPlatformProblems(raw, target);
  if (problems.length) throw new Error(problems.join('\n'));
}
