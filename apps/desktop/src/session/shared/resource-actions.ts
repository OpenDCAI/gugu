import type { GuguLinkTarget } from '@gugu/core/shared/ui/guguLink'

/** Resource hosts supply the kind and facts; these declarations never infer intent from text.
 *  Every menu places these as one trailing group behind a separator, only ahead of a destructive item (uninstall,
 *  delete); a resource's own right-click menu (ResourceMenu) is just them. ❌ A message's menu: the file or App has its
 *  own (its card, its preview), and the bubble's menu stays short (owner, #560). */
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
} as const satisfies Record<string, readonly ResourceTemplate[]>
export type ResourceKind = keyof typeof RESOURCE_TEMPLATES
export interface ResourceContext {
  kind: ResourceKind
  target: Extract<GuguLinkTarget, { kind: 'app-detail' | 'file' }>
  facts?: readonly ResourceRequirement[]
}
