import type { RuntimeArgvTrustBehavior } from '@gugu/session-core/agents/plugins';

/**
 * Pi's `--approve` trusts project-local files for this run only. It does not update the user's
 * global trust database, which keeps the runtime adapter zero-residue.
 *
 * Evidence: @earendil-works/pi-coding-agent@0.85.1 `pi --help` (mac1, 2026-09-07):
 * `--approve, -a Trust project-local files for this run`.
 */
export const PI_TRUST_ARGS = Object.freeze(['--approve'] as const);

export function buildPiTrustBehavior(): RuntimeArgvTrustBehavior {
  return {
    channel: 'runtime-argv',
    trustArgs: () => [...PI_TRUST_ARGS],
  };
}
