import type { CredentialUseBinding } from './credential-use-contract';

const KEYS = ['requestId', 'useId', 'accountId', 'installationId', 'agentId', 'sessionId', 'browserId',
  'loginSurfaceId', 'loginSurfaceEpoch', 'documentId', 'frameId', 'formFingerprint', 'credentialId',
  'credentialVersion', 'lockEpoch', 'origin', 'operation'] as const;

/** Physical host adapters preserve the reviewed binding without copying arbitrary extra properties. */
export function copyCredentialBinding(binding: CredentialUseBinding): CredentialUseBinding {
  return Object.freeze(Object.fromEntries(KEYS.map(key => [key, binding[key]]))) as CredentialUseBinding;
}

export function credentialBindingMatches(expected: CredentialUseBinding, actual: CredentialUseBinding): boolean {
  return KEYS.every(key => expected[key] === actual[key]);
}
