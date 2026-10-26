import type {
  AcpAttachmentError,
  AcpCancelTurnError,
  AcpChangeQueuePromptOrderError,
  AcpDeleteQueuedPromptError,
  AcpEditQueuedPromptError,
  AcpExportRawLogError,
  AcpExportTranscriptError,
  AcpGetHistoryError,
  AcpQueuePromptError,
  AcpResolvePermissionError,
  AcpResumeSessionError,
  AcpSendPromptError,
  AcpSetModeOptionError,
  AcpSetModelOptionError,
  AcpSetPromptDraftError,
  AcpStartSessionError,
  AcpSteerQueuedPromptError,
  AcpStopBackgroundTaskError,
  AcpStopSessionError,
  AttachmentMimeType,
  AttachmentRef,
  PromptDraftUpdate,
  PromptInput,
  QueuedPromptEdit,
  ResumeResult,
  SessionState,
  TerminalState,
  TranscriptTurn,
} from '@gugu/session-core/acp';
import { acpErr } from '@gugu/session-core/acp';
import type { Result } from '@gugu/session-shared';
import { ok } from '@gugu/session-shared';
import type { LiveLog } from '@gugu/session-wire';
import { FsPort } from '../agent-ports/fs-port';
import { AgentTerminalManager } from '../agent-ports/terminal-manager';
import { TerminalPort } from '../agent-ports/terminal-port';
import { createAcpConnectionSource, type AcpConnectionSource } from '../connection/source';
import type { SessionLiveModels, SessionsListModel } from '../state/live-models';
import type { StoredAttachment } from './attachment-store';
import { SessionManager, type HistoryPage } from './session-manager';
import { TerminalLiveRegistry } from './terminal-live-registry';
import type { AcpRuntimeDeps, AcpStartInput } from './types';
import type { LiveSettingApplyResult } from '../session/cell-deps';

export class AcpRuntime {
  readonly terminals: AgentTerminalManager;
  readonly connections: AcpConnectionSource;
  readonly manager: SessionManager;
  private readonly terminalLiveRegistry: TerminalLiveRegistry;

  constructor(private readonly deps: AcpRuntimeDeps) {
    let manager: SessionManager | null = null;
    this.terminalLiveRegistry = new TerminalLiveRegistry((sessionId) =>
      manager?.syncTerminals(sessionId)
    );
    this.terminals = new AgentTerminalManager(deps.host, this.terminalLiveRegistry.hooks);
    const fs = new FsPort(deps.host);
    const terminalPort = new TerminalPort(this.terminals);
    this.connections = createAcpConnectionSource({
      host: deps.host,
      agentHost: deps.agentHost,
      logger: deps.logger,
      onClosed: (key, exit) => manager?.onProcessClosed(key, exit),
    });
    manager = new SessionManager(deps, this.connections, this.terminals, {
      fs,
      terminals: terminalPort,
    });
    this.manager = manager;
  }

  startSession(input: AcpStartInput): Promise<Result<{ providerSessionId: string }, AcpStartSessionError>> {
    return this.manager.start(input);
  }

  async resumeSession(
    input: AcpStartInput & { providerSessionId: string },
    limit = 50
  ): Promise<Result<ResumeResult, AcpResumeSessionError>> {
    const result = await this.manager.start(input);
    if (!result.success) return result;
    const page = this.manager.getHistory(input.sessionId, undefined, limit);
    return ok({ providerSessionId: result.data.providerSessionId, ...page });
  }

  stopSession(sessionId: string, onlyIfIdle = false): Promise<Result<void, AcpStopSessionError>> {
    return this.manager.stop(sessionId, onlyIfIdle);
  }

  /** 这条会话此刻attach的适配器进程(连接 key + pid)。只给会话重载当判据,见 SessionManager 那里。 */
  adapterProvenance(sessionId: string): { connectionKey: string; pid: number | null } | null {
    return this.manager.adapterProvenance(sessionId);
  }

  /** #6396 宿主告诉一条活会话一件事(转录里一行 / agent 下一轮的开头),见 SessionManager.announce。 */
  announceSession(input: Parameters<SessionManager['announce']>[0]): { delivered: boolean } {
    return this.manager.announce(input);
  }

  turnEnvelope(sessionId: string) {
    return this.manager.turnEnvelope(sessionId);
  }

  sendPrompt(
    sessionId: string,
    prompt: PromptInput,
    opts?: { steerIfBusy?: boolean }
  ): Promise<Result<{ queued: boolean }, AcpSendPromptError>> {
    return this.manager.prompt({
      sessionId,
      prompt,
      ...(opts?.steerIfBusy ? { steerIfBusy: true } : {}),
    });
  }

  /** Host-only admission path; public ACP sendPrompt keeps its full-turn promise semantics. */
  promptDetached(
    sessionId: string,
    prompt: PromptInput,
    opts?: { steerIfBusy?: boolean },
  ) {
    return this.manager.promptDetached({
      sessionId,
      prompt,
      ...(opts?.steerIfBusy ? { steerIfBusy: true } : {}),
    });
  }

  queuePrompt(
    sessionId: string,
    prompt: PromptInput,
    startInput?: AcpStartInput,
  ): Promise<Result<{ queued: boolean }, AcpQueuePromptError>> {
    return this.manager.queuePrompt({ sessionId, prompt }, startInput);
  }

  editQueuedPrompt(
    sessionId: string,
    id: string,
    prompt: PromptInput,
    queueEdit?: QueuedPromptEdit | null
  ): Result<void, AcpEditQueuedPromptError> {
    return this.manager.editQueuedPrompt(sessionId, id, prompt, queueEdit);
  }

  deleteQueuedPrompt(sessionId: string, id: string): Result<void, AcpDeleteQueuedPromptError> {
    return this.manager.removeQueuedPrompt(sessionId, id);
  }

  changeQueuePromptOrder(
    sessionId: string,
    ids: readonly string[]
  ): Result<void, AcpChangeQueuePromptOrderError> {
    return this.manager.reorderQueue(sessionId, ids);
  }

  steerQueuedPrompt(
    sessionId: string,
    id: string
  ): Promise<Result<void, AcpSteerQueuedPromptError>> {
    return this.manager.steerQueuedPrompt(sessionId, id);
  }

  cancelTurn(sessionId: string): Promise<Result<void, AcpCancelTurnError>> {
    return this.manager.cancel(sessionId);
  }

  finishHistoryRevert(sessionId: string): void { this.manager.finishHistoryRevert(sessionId); }

  revertSession(sessionId: string, anchor: string) {
    return this.manager.revertSession(sessionId, anchor);
  }

  stopBackgroundTask(
    sessionId: string,
    taskId: string
  ): Promise<Result<void, AcpStopBackgroundTaskError>> {
    return this.manager.stopBackgroundTask(sessionId, taskId);
  }

  setPromptDraft(
    sessionId: string,
    draft: PromptDraftUpdate
  ): Result<void, AcpSetPromptDraftError> {
    return this.manager.setPromptDraft(sessionId, draft);
  }

  resolvePermission(
    sessionId: string,
    requestId: string,
    optionId: string
  ): Result<void, AcpResolvePermissionError> {
    return this.manager.resolvePermission(sessionId, requestId, optionId);
  }

  setModeOption(
    sessionId: string,
    modeId: string
  ): Promise<Result<LiveSettingApplyResult, AcpSetModeOptionError>> {
    return this.manager.setMode(sessionId, modeId);
  }

  setModelOption(
    sessionId: string,
    dimension: 'model' | 'effort',
    value: string
  ): Promise<Result<LiveSettingApplyResult, AcpSetModelOptionError>> {
    return this.manager.setConfigOption(sessionId, dimension, value);
  }

  getHistory(
    sessionId: string,
    before?: number,
    limit?: number
  ): Result<HistoryPage, AcpGetHistoryError> {
    return ok(this.manager.getHistory(sessionId, before, limit));
  }

  getChatHistory(sessionId: string): {
    committed: TranscriptTurn[];
    active: TranscriptTurn | null;
  } {
    return this.manager.getChatHistory(sessionId);
  }

  exportParsedTranscript(sessionId: string): Result<string, AcpExportTranscriptError> {
    return this.manager.exportParsedTranscript(sessionId);
  }

  exportRawAcpLog(sessionId: string): Result<string, AcpExportRawLogError> {
    return this.manager.exportRawAcpLog(sessionId);
  }

  getSessionState(sessionId: string): SessionState {
    return this.manager.getSessionState(sessionId);
  }

  getTerminals(sessionId: string): TerminalState[] {
    return this.manager.getTerminals(sessionId);
  }

  getHostTerminals(): TerminalState[] {
    return this.manager.getHostTerminals();
  }

  killAllTerminals(): void {
    this.manager.killAllTerminals();
  }

  async uploadAttachment(input: {
    data?: Uint8Array;
    mimeType: AttachmentMimeType;
    name?: string;
    originalPath?: string;
  }): Promise<Result<AttachmentRef, AcpAttachmentError>> {
    if (!this.deps.attachmentStore) return acpErr.invalidState('No attachment store configured');
    return ok(await this.deps.attachmentStore.put(input));
  }

  async downloadAttachment(id: string): Promise<Result<StoredAttachment, AcpAttachmentError>> {
    if (!this.deps.attachmentStore) return acpErr.invalidState('No attachment store configured');
    const stored = await this.deps.attachmentStore.get(id);
    if (!stored) return acpErr.invalidState(`Attachment '${id}' not found`);
    return ok(stored);
  }

  async deleteAttachment(id: string): Promise<Result<void, AcpAttachmentError>> {
    if (!this.deps.attachmentStore) return acpErr.invalidState('No attachment store configured');
    await this.deps.attachmentStore.delete(id);
    return ok();
  }

  sessionLiveModels(sessionId: string): SessionLiveModels | null {
    return this.manager.getLiveModels(sessionId);
  }

  sessionsListLiveModel(): SessionsListModel {
    return this.manager.sessionsList;
  }

  sessionLiveHost() {
    return this.manager.sessionHost;
  }

  sessionsLiveHost() {
    return this.manager.sessionsHost;
  }

  terminalOutputLog(terminalId: string): LiveLog | null {
    return this.terminalLiveRegistry.getTerminalLog(terminalId);
  }

  async dispose(): Promise<void> {
    this.killAllTerminals();
    await this.connections.dispose();
  }
}
