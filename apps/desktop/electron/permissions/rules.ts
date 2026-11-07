import { z } from 'zod'

export type PermissionEffect = 'allow' | 'ask' | 'deny'
export type PermissionMode = 'ask_some' | 'always_ask'
export type ToolEffect = 'discovery' | 'read' | 'write' | 'send' | 'execute' | 'owner' | 'social' | 'permission' | 'credential'
export interface ToolRisk { risk: 'low' | 'medium' | 'high'; effect: ToolEffect }
export interface PermissionOperation extends ToolRisk {
  tool: string
  /** Host-selected namespace, not an MCP argument or model-supplied annotation. */
  namespace: string
  resource: Readonly<Record<string, string>>
  classified: boolean
  dynamic?: boolean
}

const ruleSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  tool: z.string().min(1).max(200),
  namespace: z.string().min(1).max(200).optional(),
  resource: z.record(z.string(), z.string()).optional(),
  effect: z.enum(['allow', 'ask', 'deny']),
  locked: z.boolean().optional(),
}).strict()
export type PermissionRule = z.infer<typeof ruleSchema>
const layerSchema = z.object({ mode: z.enum(['ask_some', 'always_ask']).optional(), rules: z.array(ruleSchema).max(1000) }).strict()
const policySchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  user: layerSchema,
  agents: z.record(z.string(), layerSchema),
}).strict().superRefine((policy, ctx) => {
  if (policy.user.rules.some(rule => rule.locked && rule.effect !== 'deny') ||
    Object.values(policy.agents).some(layer => layer.rules.some(rule => rule.locked))) {
    ctx.addIssue({ code: 'custom', message: 'Only user denials can be locked' })
  }
  for (const layer of [policy.user, ...Object.values(policy.agents)]) {
    if (new Set(layer.rules.map(rule => rule.id)).size !== layer.rules.length) {
      ctx.addIssue({ code: 'custom', message: 'Rule IDs must be unique within a layer' })
    }
  }
})
export type PermissionPolicy = z.infer<typeof policySchema>
export const defaultPermissionPolicy = (): PermissionPolicy => ({ version: 1, revision: 0, user: { rules: [] }, agents: {} })
export const parsePermissionPolicy = (value: unknown): PermissionPolicy => policySchema.parse(value)

export interface PermissionDecision {
  effect: PermissionEffect
  reason: 'boundary_denied' | 'policy_unavailable' | 'unclassified_tool' | 'unclassified_dynamic_tool' |
    'locked_user_denial' | 'agent_rule' | 'user_rule' | 'mandatory_person_confirmation' | 'always_ask' | 'risk_default' | 'resource_verification_required'
  source: 'boundary' | 'user' | 'agent' | 'mandatory' | 'mode' | 'default'
  ruleIds: string[]
  overriddenRuleIds: string[]
}
const order: Record<PermissionEffect, number> = { deny: 3, ask: 2, allow: 1 }
const mandatory = new Set<ToolEffect>(['owner', 'social', 'permission', 'credential'])
const matches = (rule: PermissionRule, operation: PermissionOperation) =>
  (rule.tool === '*' || rule.tool === operation.tool) &&
  (!rule.namespace || rule.namespace === operation.namespace) &&
  Object.entries(rule.resource ?? {}).every(([key, value]) => Object.hasOwn(operation.resource, key) && operation.resource[key] === value)
const strongest = (rules: PermissionRule[]) => [...rules].sort((a, b) => order[b.effect] - order[a.effect])[0]

/** The caller/owner and pre-existing resource boundaries are supplied by the host, never by tool arguments. */
export function decidePermission(input: {
  operation: PermissionOperation
  agentId: string
  policy: PermissionPolicy | null
  boundaryAllowed?: boolean
}): PermissionDecision {
  const decision = (effect: PermissionEffect, reason: PermissionDecision['reason'], source: PermissionDecision['source'], rules: PermissionRule[] = [], overridden: PermissionRule[] = []): PermissionDecision =>
    ({ effect, reason, source, ruleIds: rules.map(rule => rule.id).sort(), overriddenRuleIds: overridden.map(rule => rule.id).sort() })
  if (input.boundaryAllowed === false) return decision('deny', 'boundary_denied', 'boundary')
  if (!input.policy) return decision('deny', 'policy_unavailable', 'boundary')
  const { operation, policy, agentId } = input
  const user = policy.user.rules.filter(rule => matches(rule, operation))
  const locked = user.filter(rule => rule.locked && rule.effect === 'deny')
  if (locked.length) return decision('deny', 'locked_user_denial', 'user', locked)
  const agent = Object.hasOwn(policy.agents, agentId) ? policy.agents[agentId] : undefined
  const exceptions = agent?.rules.filter(rule => matches(rule, operation)) ?? []
  const rules = exceptions.length ? exceptions : user
  const chosen = strongest(rules)
  const source = exceptions.length ? 'agent' : 'user'
  const overridden = exceptions.length ? user.filter(rule => !rule.locked) : []
  if (chosen?.effect === 'deny') return decision('deny', source === 'agent' ? 'agent_rule' : 'user_rule', source, rules, overridden)
  if (!operation.classified) return decision(operation.dynamic ? 'ask' : 'deny', operation.dynamic ? 'unclassified_dynamic_tool' : 'unclassified_tool', 'default')
  if (mandatory.has(operation.effect)) return decision('ask', 'mandatory_person_confirmation', 'mandatory', rules, overridden)
  if (operation.effect !== 'discovery' && (agent?.mode ?? policy.user.mode ?? 'ask_some') === 'always_ask') {
    return decision('ask', 'always_ask', 'mode', rules, overridden)
  }
  if (chosen) return decision(chosen.effect, source === 'agent' ? 'agent_rule' : 'user_rule', source, rules, overridden)
  return decision(operation.effect === 'discovery' ? 'allow' : 'ask', 'risk_default', 'default')
}
