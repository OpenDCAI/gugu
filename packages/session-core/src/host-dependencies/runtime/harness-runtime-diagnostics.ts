import { versionLineOf } from './probe';
import type { ProbeResult } from './types';

export interface HarnessRuntimeIdentity {
  providerId: string;
  executable: string;
  version: string | null;
  versionProbeExitCode: number | null;
  versionProbeTimedOut: boolean;
}

export function parseHarnessRuntimeVersion(probe: ProbeResult, versionLine?: RegExp): string | null {
  if (probe.exitCode !== 0 || probe.timedOut) return null;
  const printed = `${probe.stdout}\n${probe.stderr}`;
  // 它自己那一行(`versionLineOf`:包装器的 banner 在前面);认不出就照旧取第一行。
  const firstLine = versionLineOf(printed, versionLine) ?? printed
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;
  const match = firstLine.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=$|\s)/);
  // 那一行里没有版本号就是没读到,❌ 拿原文冒充版本。
  return match?.[1] ?? null;
}

export function makeHarnessRuntimeIdentity(input: {
  providerId: string;
  executable: string;
  probe: ProbeResult;
  versionLine?: RegExp;
}): HarnessRuntimeIdentity {
  return {
    providerId: input.providerId,
    executable: input.executable,
    version: parseHarnessRuntimeVersion(input.probe, input.versionLine),
    versionProbeExitCode: input.probe.exitCode,
    versionProbeTimedOut: input.probe.timedOut,
  };
}
