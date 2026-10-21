// Pure Hermes `serve` ⇄ ACP shapes for the hermes-serve-acp bridge (no IO, no state).
//
// Wire facts come from Hermes' own generated contract (`apps/shared/src/gateway-contract.generated.ts`,
// desktop_contract 8), checked at v2026.9.24 and main ddde0670 — the design doc's rev 3 lists them.

export type Json = Record<string, unknown>;

/** The prefix Gugu already reads as "this option is a Gugu platform model" (Pi, OpenCode do the same). */
export const PLATFORM_PROVIDER = 'gugu-platform';
/** Hermes' reasoning ladder (`hermes_constants.VALID_REASONING_EFFORTS`); `none` = thinking off. */
export const HERMES_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const PERMISSION_MODES = [
  { value: 'default', name: 'Default', description: "Hermes' own approvals: dangerous commands ask first" },
  { value: 'yolo', name: 'YOLO', description: 'Auto-approve every command' },
];

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const text = (value: string) => ({ type: 'content', content: { type: 'text', text: value } });

// ── tools ──────────────────────────────────────────────────────────────────────

export function toolKind(name: string): string {
  if (name === 'terminal' || name === 'execute_code' || name === 'process') return 'execute';
  if (name === 'read_file') return 'read';
  if (name === 'write_file' || name === 'patch' || name === 'skill_manage') return 'edit';
  if (name === 'search_files') return 'search';
  if (name.startsWith('web_') || name.startsWith('browser')) return 'fetch';
  if (name === 'delegate_task' || name === 'todo') return 'think';
  return 'other';
}

function toolTitle(payload: Json): string {
  const labels = Array.isArray(payload.labels) ? (payload.labels as Json[]) : [];
  return str(labels[0]?.text) || str(payload.preview) || str(payload.context) || str(payload.name) || 'Tool';
}

export function toolCallStart(payload: Json): Json {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: str(payload.tool_id),
    title: toolTitle(payload),
    kind: toolKind(str(payload.name)),
    status: 'in_progress',
    rawInput: payload.args ?? {},
  };
}

/** `tool.complete` has no status field; a result that carries an error is the failure signal. */
function toolFailed(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const value = result as Json;
  return value.success === false || Boolean(value.error);
}

export function toolCallComplete(payload: Json): Json {
  const content: Json[] = [];
  const output = str(payload.result_text) || str(payload.summary);
  if (output) content.push(text(output));
  const diff = str(payload.inline_diff);
  if (diff) content.push(text(`\`\`\`diff\n${diff}\n\`\`\``));
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: str(payload.tool_id),
    status: toolFailed(payload.result) ? 'failed' : 'completed',
    ...(content.length ? { content } : {}),
    ...(payload.result !== undefined ? { rawOutput: payload.result } : {}),
  };
}

export function planUpdate(todos: unknown): Json {
  const items = Array.isArray(todos) ? (todos as Json[]) : [];
  return {
    sessionUpdate: 'plan',
    entries: items
      .filter((item) => item.status !== 'cancelled')
      .map((item) => ({
        content: str(item.content),
        status: item.status === 'in_progress' || item.status === 'completed' ? item.status : 'pending',
        priority: 'medium',
      })),
  };
}

export function usageUpdate(usage: unknown): Json | null {
  if (!usage || typeof usage !== 'object') return null;
  const { context_used: used, context_max: size } = usage as Json;
  return typeof used === 'number' && typeof size === 'number' && size > 0
    ? { sessionUpdate: 'usage_update', used, size }
    : null;
}

// ── history (session.resume / session.history messages) ───────────────────────

/**
 * Stored transcript rows → ACP updates. Hermes already drops `display_kind: hidden` rows (the Gugu
 * seed row) from this projection. Every row carries its own id: replayed rows are whole messages,
 * not deltas, and the host folds id-less consecutive chunks into one.
 */
export function replayUpdates(messages: unknown): Json[] {
  const rows = Array.isArray(messages) ? (messages as Json[]) : [];
  const updates: Json[] = [];
  rows.forEach((row, index) => {
    const id = `hermes-row-${row.row_id ?? index}`;
    const body = str(row.text);
    if (row.role === 'user' && body) {
      updates.push({ sessionUpdate: 'user_message_chunk', messageId: id, content: { type: 'text', text: body } });
    } else if (row.role === 'assistant') {
      const reasoning = str(row.reasoning);
      if (reasoning) {
        updates.push({ sessionUpdate: 'agent_thought_chunk', messageId: `${id}-reasoning`, content: { type: 'text', text: reasoning } });
      }
      if (body) updates.push({ sessionUpdate: 'agent_message_chunk', messageId: id, content: { type: 'text', text: body } });
    } else if (row.role === 'tool') {
      updates.push({
        ...toolCallStart({ ...row, tool_id: str(row.tool_call_id) || id }),
        status: 'completed',
      });
    }
  });
  return updates;
}

/** The text the user typed: Gugu wraps chat deliveries in an envelope whose body is the CDATA. */
export function titlePreview(promptText: string): string {
  const body = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(promptText)?.[1];
  return (body ?? promptText).trim().slice(0, 500);
}

// ── settings (ACP configOptions) ────────────────────────────────────────────────

export type ModelChoice = { value: string; name: string; efforts: string[] };

export function parseModelValue(value: string): { provider: string; model: string } | null {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return null;
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

/** Platform session: the gateway directory facts (`GUGU_PLATFORM_MODELS`), each with its own efforts. */
export function platformModelChoices(facts: { id: string; displayName: string; efforts: string[] }[]): ModelChoice[] {
  return facts.map((fact) => ({ value: `${PLATFORM_PROVIDER}/${fact.id}`, name: fact.displayName, efforts: fact.efforts }));
}

/**
 * Own account: `model.options` providers the user authenticated, as Hermes Desktop offers them. Effort
 * levels follow the model's capabilities (`reasoning`, `can_disable_reasoning`) the way the Desktop's
 * reasoning menu does: the whole ladder for a reasoning model, plus `none` unless it cannot switch off.
 */
export function ownModelChoices(result: unknown): ModelChoice[] {
  const providers = Array.isArray((result as Json | null)?.providers) ? ((result as Json).providers as Json[]) : [];
  const choices: ModelChoice[] = [];
  for (const provider of providers) {
    const slug = str(provider.slug);
    if (!slug || slug === PLATFORM_PROVIDER || provider.authenticated === false) continue;
    const capabilities = (provider.capabilities ?? {}) as Record<string, Json | undefined>;
    for (const model of Array.isArray(provider.models) ? (provider.models as unknown[]).map(str) : []) {
      if (!model) continue;
      const caps = capabilities[model];
      const reasoning = caps?.reasoning !== false;
      const efforts = reasoning ? [...(caps?.can_disable_reasoning === false ? [] : ['none']), ...HERMES_REASONING_EFFORTS] : [];
      choices.push({ value: `${slug}/${model}`, name: `${model} · ${str(provider.name) || slug}`, efforts });
    }
  }
  return choices;
}

export function configOptions(state: {
  models: ModelChoice[];
  model: string | null;
  effort: string | null;
  yolo: boolean;
}): Json[] {
  const options: Json[] = [{
    id: 'mode',
    name: 'Approvals',
    category: 'mode',
    type: 'select',
    currentValue: state.yolo ? 'yolo' : 'default',
    options: PERMISSION_MODES,
  }];
  if (state.models.length) {
    options.push({
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: state.model,
      options: state.models.map(({ value, name }) => ({ value, name })),
    });
  }
  const efforts = state.models.find((choice) => choice.value === state.model)?.efforts ?? [];
  if (efforts.length) {
    options.push({
      id: 'effort',
      name: 'Reasoning effort',
      category: 'thought_level',
      type: 'select',
      currentValue: state.effort && efforts.includes(state.effort) ? state.effort : null,
      options: efforts.map((effort) => ({ value: effort, name: effort })),
    });
  }
  return options;
}

// ── server requests ────────────────────────────────────────────────────────────

const APPROVAL_OPTIONS: Record<string, { name: string; kind: string }> = {
  once: { name: 'Allow once', kind: 'allow_once' },
  session: { name: 'Allow for this session', kind: 'allow_always' },
  always: { name: 'Always allow', kind: 'allow_always' },
  deny: { name: 'Deny', kind: 'reject_once' },
};

/** Hermes lists the answers it honours for this approval (`choices`, what Hermes Desktop's approval card renders):
 *  one ACP option each, in Hermes' order. */
export function approvalOptions(params: Json): { optionId: string; name: string; kind: string }[] {
  const choices = Array.isArray(params.choices) ? (params.choices as unknown[]).map(str) : [];
  return choices.filter((choice) => choice in APPROVAL_OPTIONS).map((choice) => ({ optionId: choice, ...APPROVAL_OPTIONS[choice]! }));
}

export type ClarifyQuestion = { qid: string; question: string; choices: string[] };

/** Hermes' clarify request is `questions[]`, answered with `{answers: {qid: text | null}}`. The single-question form
 *  v2026.9.24 still sends is not read: that Hermes gets no answer, which is its own "skip". */
export function clarifyQuestions(params: Json): ClarifyQuestion[] {
  return (Array.isArray(params.questions) ? (params.questions as Json[]) : []).map((raw, index) => ({
    qid: str(raw.qid) || String(index),
    question: str(raw.question),
    choices: Array.isArray(raw.choices) ? (raw.choices as unknown[]).map(str).filter(Boolean) : [],
  }));
}
