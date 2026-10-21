import type { AgentModelSelection, ModelAccessProtocol } from '@gugu/core/shared/agentModelSelection';

/** Moving a local subscription to the cloud uses Gugu credits; credentials never move with it. */
export function cloudMoveModel(selection: AgentModelSelection, protocol: ModelAccessProtocol): AgentModelSelection {
  return selection.source === 'platform' ? { ...selection, protocol }
    : { source: 'platform', modelId: 'glm-5.3-flash', protocol };
}

/** Carry the real billing source as well as the model; a target's default is not the old home's configuration. */
export function moveModelSelection(desired: AgentModelSelection, options: {
  model?: { selected: string | null } | null;
  modelMenu?: { conversationSelection?: { modelId: string } | null };
}, protocol: ModelAccessProtocol): AgentModelSelection {
  if (desired.source !== 'default') return desired;
  const platform = options.modelMenu?.conversationSelection;
  if (platform?.modelId) return { source: 'platform', protocol, modelId: platform.modelId };
  if (platform === null && options.model?.selected) return { source: 'byok', modelId: options.model.selected };
  throw new Error('The source home did not report its model and billing source');
}

export function sameMoveModel(a: AgentModelSelection, b: AgentModelSelection | null): boolean {
  return a.source === b?.source && (a.source === 'default' || (b.source !== 'default' && a.modelId === b.modelId
    && (a.source !== 'platform' || (b.source === 'platform' && a.protocol === b.protocol))));
}
