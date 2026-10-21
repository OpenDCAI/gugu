import type { ProbeResult } from './types';

export interface HarnessRuntimeIdentity {
  providerId: string;
  executable: string;
  version: string | null;
  versionProbeExitCode: number | null;
  versionProbeTimedOut: boolean;
}

export function parseHarnessRuntimeVersion(probe: ProbeResult): string | null {
  if (probe.exitCode !== 0 || probe.timedOut) return null;
  const firstLine = `${probe.stdout}\n${probe.stderr}`
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;
  const match = firstLine.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=$|\s)/);
  return match?.[1] ?? firstLine;
}

export function makeHarnessRuntimeIdentity(input: {
  providerId: string;
  executable: string;
  probe: ProbeResult;
}): HarnessRuntimeIdentity {
  return {
    providerId: input.providerId,
    executable: input.executable,
    version: parseHarnessRuntimeVersion(input.probe),
    versionProbeExitCode: input.probe.exitCode,
    versionProbeTimedOut: input.probe.timedOut,
  };
}
