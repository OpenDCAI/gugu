import type { AgentProviderId } from '@gugu/session-plugins/agents';
import type { RendererMetrics } from './renderer-metrics';

/**
 * Per-PTY resource sample. `cpu` is a percentage of one core (can exceed 100
 * on multi-core systems). `memory` is RSS in bytes. `pid` is undefined for
 * remote (SSH) PTYs where the owning process runs on the remote host.
 *
 * `providerId` is populated for agent-conversation PTYs. `title` is populated
 * for conversations and user-created shell terminals. They are sourced from
 * the registry at register-time so the renderer can label entries even when
 * the owning project isn't mounted (in which case the renderer-side store join
 * would fail and the row would fall back to a leafId hex).
 */
export interface ResourcePtyEntry {
  ptySessionId: string;
  projectId: string;
  scopeId: string;
  leafId: string;
  pid: number | undefined;
  ppid?: number;
  cpu: number;
  memory: number;
  providerId?: AgentProviderId;
  title?: string;
}

/**
 * Memory + CPU consumed by the Electron app itself (main, renderer, GPU,
 * utility processes). Sampled from `app.getAppMetrics()`. Does not include
 * PTY child processes — those are reported per-entry to avoid double counting.
 */
export interface ResourceAppUsage {
  memoryBytes: number;
  /** Sum of the processes' `cpu`; undefined until at least one process has a reading. */
  cpuPercent?: number;
}

export type ResourceAppProcessType =
  | 'Browser'
  | 'Tab'
  | 'Utility'
  | 'Zygote'
  | 'Sandbox helper'
  | 'GPU'
  | 'Pepper Plugin'
  | 'Pepper Plugin Broker'
  | 'Unknown';

/**
 * Per-process breakdown of the Electron app (one entry per `app.getAppMetrics()`
 * row). Sums of `memory` / `cpu` across these match `ResourceAppUsage`.
 */
export interface ResourceAppProcess {
  pid: number;
  type: ResourceAppProcessType;
  name?: string;
  /**
   * % of one core since the previous sample, from `cpu.cumulativeCPUUsage` deltas. Undefined on a
   * process's first sample: there is nothing to difference yet.
   */
  cpu?: number;
  memory: number;
}

export interface ResourceSnapshot {
  timestamp: number;
  cpuCount: number;
  totalMemoryBytes: number;
  app: ResourceAppUsage;
  appProcesses: ResourceAppProcess[];
  entries: ResourcePtyEntry[];
  /** Only while an open monitor page has advanced diagnostics expanded. */
  internals?: { renderers: RendererMetrics[] };
}
