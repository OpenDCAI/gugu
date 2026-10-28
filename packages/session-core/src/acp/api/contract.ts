import {
  defineContract,
  downloadFile,
  fallible,
  liveLog,
  liveModel,
  liveState,
  procedure,
  uploadFile,
} from '@gugu/session-wire';
import { z } from 'zod';
import { terminalStateSchema } from '../models';
import { agentStateSchema } from '../models/agents';
import { attachmentMimeTypeSchema, attachmentRefSchema } from '../models/attachments';
import {
  liveSettingResultSchema,
  sessionConfigStateSchema,
  sessionUsageSchema,
} from '../models/config';
import { planStateSchema } from '../models/plan';
import { promptDraftSchema, promptInputSchema } from '../models/prompt';
import { sessionStateSchema, sessionSummarySchema } from '../models/session';
import { transcriptTurnSchema } from '../models/turns';
import { toolImageLookupSchema } from '../models/turns/tool-calls';
import {
  cancelTurnCommandSchema,
  changeQueuePromptOrderCommandSchema,
  deleteAttachmentCommandSchema,
  deleteQueuedPromptCommandSchema,
  downloadAttachmentCommandSchema,
  editQueuedPromptCommandSchema,
  exportAcpTranscriptCommandSchema,
  exportRawAcpLogCommandSchema,
  queuePromptCommandSchema,
  resolvePermissionCommandSchema,
  resumeSessionCommandSchema,
  sendPromptCommandSchema,
  sendPromptResponseSchema,
  setModeOptionCommandSchema,
  setModelOptionCommandSchema,
  setPromptDraftCommandSchema,
  startSessionCommandSchema,
  steerQueuedPromptCommandSchema,
  stopBackgroundTaskCommandSchema,
  stopSessionCommandSchema,
  uploadAttachmentCommandSchema,
  uploadAttachmentResponseSchema,
} from './commands';
import {
  acpAttachmentErrorSchema,
  acpCancelTurnErrorSchema,
  acpStopBackgroundTaskErrorSchema,
  acpChangeQueuePromptOrderErrorSchema,
  acpDeleteQueuedPromptErrorSchema,
  acpEditQueuedPromptErrorSchema,
  acpExportRawLogErrorSchema,
  acpExportTranscriptErrorSchema,
  acpGetHistoryErrorSchema,
  acpQueuePromptErrorSchema,
  acpResolvePermissionErrorSchema,
  acpResumeSessionErrorSchema,
  acpSendPromptErrorSchema,
  acpSetModeOptionErrorSchema,
  acpSetModelOptionErrorSchema,
  acpSetPromptDraftErrorSchema,
  acpStartSessionErrorSchema,
  acpSteerQueuedPromptErrorSchema,
  acpStopSessionErrorSchema,
} from './errors';
import { historyPageInputSchema, historyPageSchema, resumeResultSchema, toolImageInputSchema } from './queries';

const startSessionResultSchema = z.object({ providerSessionId: z.string() });
const sessionKeySchema = z.object({ sessionId: z.string() });
const terminalOutputKeySchema = z.object({ terminalId: z.string() });

export const acpApiContract = defineContract({
  startSession: fallible({
    input: startSessionCommandSchema,
    data: startSessionResultSchema,
    error: acpStartSessionErrorSchema,
  }),
  resumeSession: fallible({
    input: resumeSessionCommandSchema,
    data: resumeResultSchema,
    error: acpResumeSessionErrorSchema,
  }),
  stopSession: fallible({
    input: stopSessionCommandSchema,
    data: z.void(),
    error: acpStopSessionErrorSchema,
  }),
  revertSession: fallible({
    input: z.object({ sessionId: z.string().min(1), anchor: z.string().min(1) }),
    data: z.object({ providerSessionId: z.string().min(1) }),
    error: acpSendPromptErrorSchema,
  }),
  sendPrompt: fallible({
    input: sendPromptCommandSchema,
    data: sendPromptResponseSchema,
    error: acpSendPromptErrorSchema,
  }),
  queuePrompt: fallible({
    input: queuePromptCommandSchema,
    data: sendPromptResponseSchema,
    error: acpQueuePromptErrorSchema,
  }),
  editQueuedPrompt: fallible({
    input: editQueuedPromptCommandSchema,
    data: z.void(),
    error: acpEditQueuedPromptErrorSchema,
  }),
  deleteQueuedPrompt: fallible({
    input: deleteQueuedPromptCommandSchema,
    data: z.void(),
    error: acpDeleteQueuedPromptErrorSchema,
  }),
  changeQueuePromptOrder: fallible({
    input: changeQueuePromptOrderCommandSchema,
    data: z.void(),
    error: acpChangeQueuePromptOrderErrorSchema,
  }),
  steerQueuedPrompt: fallible({
    input: steerQueuedPromptCommandSchema,
    data: z.void(),
    error: acpSteerQueuedPromptErrorSchema,
  }),
  cancelTurn: fallible({
    input: cancelTurnCommandSchema,
    data: z.void(),
    error: acpCancelTurnErrorSchema,
  }),
  stopBackgroundTask: fallible({
    input: stopBackgroundTaskCommandSchema,
    data: z.void(),
    error: acpStopBackgroundTaskErrorSchema,
  }),
  setModelOption: fallible({
    input: setModelOptionCommandSchema,
    data: liveSettingResultSchema,
    error: acpSetModelOptionErrorSchema,
  }),
  setModeOption: fallible({
    input: setModeOptionCommandSchema,
    data: liveSettingResultSchema,
    error: acpSetModeOptionErrorSchema,
  }),
  resolvePermission: fallible({
    input: resolvePermissionCommandSchema,
    data: z.void(),
    error: acpResolvePermissionErrorSchema,
  }),
  setPromptDraft: fallible({
    input: setPromptDraftCommandSchema,
    data: z.void(),
    error: acpSetPromptDraftErrorSchema,
  }),
  exportACPTranscript: fallible({
    input: exportAcpTranscriptCommandSchema,
    data: z.string(),
    error: acpExportTranscriptErrorSchema,
  }),
  exportRawAcpLog: fallible({
    input: exportRawAcpLogCommandSchema,
    data: z.string(),
    error: acpExportRawLogErrorSchema,
  }),
  uploadAttachment: uploadFile({
    input: uploadAttachmentCommandSchema,
    accept: attachmentMimeTypeSchema.options,
    result: uploadAttachmentResponseSchema,
    error: acpAttachmentErrorSchema,
  }),
  downloadAttachment: downloadFile({
    input: downloadAttachmentCommandSchema,
    meta: attachmentRefSchema,
    error: acpAttachmentErrorSchema,
  }),
  deleteAttachment: fallible({
    input: deleteAttachmentCommandSchema,
    data: z.void(),
    error: acpAttachmentErrorSchema,
  }),
  getToolImage: fallible({
    input: toolImageInputSchema,
    data: toolImageLookupSchema,
    error: acpGetHistoryErrorSchema,
  }),
  getStoredQueue: procedure({
    input: sessionKeySchema,
    output: z.array(promptInputSchema.pick({ text: true, origin: true })),
  }),
  getHistory: fallible({
    input: historyPageInputSchema,
    data: historyPageSchema,
    error: acpGetHistoryErrorSchema,
  }),
  sessions: liveModel({
    key: z.void(),
    states: {
      list: liveState({ data: z.record(z.string(), sessionSummarySchema) }),
    },
  }),
  session: liveModel({
    key: sessionKeySchema,
    states: {
      state: liveState({ data: sessionStateSchema }),
      config: liveState({ data: sessionConfigStateSchema }),
      usage: liveState({ data: sessionUsageSchema.nullable() }),
      plan: liveState({ data: planStateSchema.nullable() }),
      agents: liveState({ data: z.array(agentStateSchema) }),
      activeTurn: liveState({ data: transcriptTurnSchema.nullable() }),
      draft: liveState({ data: promptDraftSchema.nullable() }),
      terminals: liveState({ data: z.array(terminalStateSchema) }),
    },
  }),
  terminalOutput: liveLog({ key: terminalOutputKeySchema }),
});

export type AcpApiContract = typeof acpApiContract;
export type StartSessionInput = z.infer<typeof startSessionCommandSchema>['input'];
