import type { GuguLinkTarget } from '@gugu/core/shared/ui/guguLink'

/** Resource hosts supply the kind and facts; these declarations never infer intent from text. */
export const RESOURCE_ACTIONS = [
  { id: 'copy-resource-url', labelKey: 'resources.copyUrl' },
  { id: 'send-resource-url', labelKey: 'resources.sendTo' },
] as const
export type ResourceRequirement = 'fork' | 'behind'
export interface ResourceTemplate { id: string; labelKey: string; textKey: string; requires?: readonly ResourceRequirement[] }
export const RESOURCE_TEMPLATES = {
  app: [
    { id: 'understand', labelKey: 'resources.appUnderstand', textKey: 'resources.appUnderstandText' },
    { id: 'fork', labelKey: 'resources.appFork', textKey: 'resources.appForkText' },
    { id: 'improve', labelKey: 'resources.appImprove', textKey: 'resources.appImproveText' },
  ],
  'app-variant': [
    { id: 'request', labelKey: 'resources.forkRequest', textKey: 'resources.forkRequestText', requires: ['fork'] },
    { id: 'merge', labelKey: 'resources.forkMerge', textKey: 'resources.forkMergeText', requires: ['fork', 'behind'] },
    { id: 'remove', labelKey: 'resources.forkRemove', textKey: 'resources.forkRemoveText', requires: ['fork'] },
  ],
  file: [
    { id: 'summarize', labelKey: 'resources.fileSummary', textKey: 'resources.fileSummaryText' },
    { id: 'check', labelKey: 'resources.fileCheck', textKey: 'resources.fileCheckText' },
    { id: 'edit', labelKey: 'resources.fileEdit', textKey: 'resources.fileEditText' },
  ],
  message: [
    { id: 'explain', labelKey: 'resources.messageExplain', textKey: 'resources.messageExplainText' },
    { id: 'followup', labelKey: 'resources.messageFollowup', textKey: 'resources.messageFollowupText' },
    { id: 'reply', labelKey: 'resources.messageReply', textKey: 'resources.messageReplyText' },
  ],
  session: [
    { id: 'progress', labelKey: 'resources.taskProgress', textKey: 'resources.taskProgressText' },
    { id: 'blockers', labelKey: 'resources.taskBlockers', textKey: 'resources.taskBlockersText' },
    { id: 'next', labelKey: 'resources.taskNext', textKey: 'resources.taskNextText' },
  ],
  chat: [
    { id: 'summary', labelKey: 'resources.chatSummary', textKey: 'resources.chatSummaryText' },
    { id: 'followup', labelKey: 'resources.chatFollowup', textKey: 'resources.chatFollowupText' },
    { id: 'rules', labelKey: 'resources.chatRules', textKey: 'resources.chatRulesText' },
  ],
  project: [
    { id: 'summary', labelKey: 'resources.projectSummary', textKey: 'resources.projectSummaryText' },
    { id: 'next', labelKey: 'resources.projectNext', textKey: 'resources.projectNextText' },
    { id: 'blockers', labelKey: 'resources.projectBlockers', textKey: 'resources.projectBlockersText' },
  ],
} as const satisfies Record<string, readonly ResourceTemplate[]>
export type ResourceKind = keyof typeof RESOURCE_TEMPLATES
export interface ResourceContext {
  kind: ResourceKind
  target: Exclude<GuguLinkTarget, { kind: 'server-login' }>
  facts?: readonly ResourceRequirement[]
}
