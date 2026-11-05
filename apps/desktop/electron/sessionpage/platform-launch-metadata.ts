import type { IssuedModelAccess } from '../model-access'
import { PrivateJsonFile } from '../session/main/lib/stable-endpoint'

/** Only facts returned by issue(), never a credential or a locally inferred model catalog. */
export type PlatformLaunchMetadata = Pick<IssuedModelAccess,
  'model' | 'protocol' | 'contextWindow' | 'reasoningEfforts' | 'switchableModels' | 'callableRoutes' | 'membershipLocked'
>

export function platformLaunchMetadata(access: PlatformLaunchMetadata): PlatformLaunchMetadata {
  return {
    model: access.model,
    protocol: access.protocol,
    contextWindow: access.contextWindow,
    reasoningEfforts: access.reasoningEfforts,
    switchableModels: access.switchableModels,
    callableRoutes: access.callableRoutes ?? {},
    membershipLocked: access.membershipLocked,
  }
}

// Cache eviction only loses startup acceleration; issue() remains authoritative.
export const PLATFORM_LAUNCH_METADATA_MAX_ENTRIES = 64

/** Account separation matters: membership and callable sets belong to the issuer's account. */
export class PlatformLaunchMetadataCache {
  private readonly entries: Record<string, PlatformLaunchMetadata>
  private readonly store?: PrivateJsonFile<Record<string, PlatformLaunchMetadata>>

  constructor(file?: string) {
    this.store = file ? new PrivateJsonFile(file) : undefined
    this.entries = Object.fromEntries(Object.entries(this.store?.read() ?? {})
      .slice(-PLATFORM_LAUNCH_METADATA_MAX_ENTRIES))
  }

  key(owner: string, engine: string, model: string, protocol: string): string {
    return JSON.stringify([owner, engine, model, protocol])
  }

  get(key: string): PlatformLaunchMetadata | undefined {
    return this.entries[key]
  }

  remember(key: string, access: PlatformLaunchMetadata): void {
    delete this.entries[key]
    this.entries[key] = platformLaunchMetadata(access)
    for (const old of Object.keys(this.entries).slice(0, -PLATFORM_LAUNCH_METADATA_MAX_ENTRIES)) delete this.entries[old]
    this.store?.write(this.entries)
  }
}
