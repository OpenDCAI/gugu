#!/usr/bin/env node
// ACP bridge for Hermes over `hermes serve` — the tui_gateway JSON-RPC that Hermes Desktop / TUI / Dashboard use.
// Gugu is a Hermes desktop client: sessions, per-session model / reasoning / approvals, steering, slash commands
// and history are Hermes' own, through the same calls its desktop makes. Design: builds/hermes/SERVE-BRIDGE-DESIGN.md.
import { createInterface } from 'node:readline';
import { platformModelFacts } from './codex-model-catalog.mjs';
import { connectGateway, GatewayError, type Gateway, type GatewayEvent } from './hermes-serve/gateway.ts';
import {
  approvalOptions,
  clarifyQuestions,
  configOptions,
  HERMES_REASONING_EFFORTS,
  ownModelChoices,
  parseModelValue,
  planUpdate,
  platformModelChoices,
  PLATFORM_PROVIDER,
  replayUpdates,
  titlePreview,
  toolCallComplete,
  toolCallStart,
  usageUpdate,
  type Json,
  type ModelChoice,
} from './hermes-serve/mapping.ts';
import { managedOverlay, startServe, type AcpMcpServer, type Serve } from './hermes-serve/serve.ts';

/**
 * The serve contract this bridge is written against. Hermes reports it in every session's info; a different
 * number means the methods/events below may have changed shape ⇒ refuse the session, loudly (spec
 * hermes-session-bundle says how a bump is found and what to update).
 */
const DESKTOP_CONTRACT = 8;

const hermesBin = process.env.GUGU_HERMES_BIN?.trim();
if (!hermesBin) {
  process.stderr.write('[hermes-serve-acp] GUGU_HERMES_BIN is required\n');
  process.exit(2);
}
const platformBaseUrl = process.env.GUGU_HERMES_PLATFORM_BASE_URL?.trim() ?? '';
const platformKey = process.env.GUGU_HERMES_PLATFORM_KEY?.trim() ?? '';
const platformModel = process.env.GUGU_HERMES_PLATFORM_MODEL?.trim() ?? '';
const platformRelay = platformBaseUrl && platformKey ? { baseUrl: platformBaseUrl, apiKey: platformKey } : null;
const platformFacts = process.env.GUGU_PLATFORM_MODELS?.trim() ? platformModelFacts(process.env.GUGU_PLATFORM_MODELS) : null;

/** The child env: everything this bridge was given, minus what is the bridge's own input. */
function serveEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GUGU_HERMES_BIN', 'GUGU_HERMES_PLATFORM_BASE_URL', 'GUGU_HERMES_PLATFORM_KEY', 'GUGU_HERMES_PLATFORM_MODEL', 'GUGU_PLATFORM_MODELS']) {
    delete env[key];
  }
  return env;
}

// ── ACP stdio ───────────────────────────────────────────────────────────────────

const write = (message: Json) => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id: unknown, result: unknown, error?: Json) =>
  write(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result });
const notify = (method: string, params: Json) => write({ jsonrpc: '2.0', method, params });

let acpNextId = 1;
const acpPending = new Map<number, { resolve(value: Json): void; reject(error: Error): void }>();
function acpRequest(method: string, params: Json): Promise<Json> {
  const id = acpNextId++;
  return new Promise((resolve, reject) => {
    acpPending.set(id, { resolve, reject });
    write({ jsonrpc: '2.0', id, method, params });
  });
}

// ── state (one Hermes session per bridge process, as the runtime owns one conversation per adapter) ──────

let serve: Serve | null = null;
let gateway: Gateway | null = null;
let starting: Promise<Gateway> | null = null;
let shuttingDown = false;
let session: { stored: string; runtime: string } | null = null;
let info: Json = {};
let models: ModelChoice[] = [];
const selected = { model: null as string | null, effort: null as string | null, yolo: false };
/** Settles when Hermes announces the agent it builds in the background after session.create / resume:
 *  `session.info`, or `error` when the build failed. */
let agentBuilt: Promise<void> = Promise.resolve();
let announceAgentBuilt = () => {};

type PendingPrompt = {
  acpId: unknown;
  started: boolean;
  /** Steers Hermes accepted into this prompt's turn (checked against history at the turn's end). */
  steers: string[];
  /** Further ACP prompts Hermes folded into this turn (`prompt.submit` answered `steered`). */
  joined: unknown[];
  streamedText: boolean;
  streamedReasoning: boolean;
};
/** ACP prompts not answered yet, in submit order — Hermes runs turns in that order (FIFO attribution). */
const prompts: PendingPrompt[] = [];
/** The prompt whose turn is running (between `message.start` and `message.complete`); null = Hermes-initiated. */
let current: PendingPrompt | null = null;
let turnRunning = false;
/** Steers that arrived between `prompt.submit` and that turn's `message.start` (Hermes has no agent yet: 4010). */
let heldSteers: { text: string; resolve(outcome: string): void }[] = [];
const runningTools = new Map<string, string>();
/** Hermes server request id → the ACP request standing for it, so `request.cancel` can withdraw it. */
const serverRequestCancels = new Map<string, (reason: string) => void>();

const sessionUpdate = (update: Json) => {
  if (session) notify('session/update', { sessionId: session.stored, update });
};
const currentOptions = () => configOptions({ models, ...selected });

function requireGateway(): Gateway {
  if (!gateway || !session) throw new Error('no Hermes session');
  return gateway;
}

// ── serve lifecycle ────────────────────────────────────────────────────────────

async function ensureGateway(mcpServers: AcpMcpServer[] | undefined): Promise<Gateway> {
  if (gateway) return gateway;
  if (!starting) {
    starting = (async () => {
      serve = await startServe({
        bin: hermesBin as string,
        overlay: managedOverlay(mcpServers ?? [], platformRelay),
        env: serveEnv(),
        onExit: (code, signal) => {
          // Before READY the failure reaches the request that started serve; after it, the session is gone.
          if (!shuttingDown && gateway) {
            process.stderr.write(`[hermes-serve-acp] hermes serve exited (code=${code} signal=${signal})\n`);
            process.exit(code && code !== 0 ? code : 1);
          }
        },
      });
      const connected = await connectGateway(serve.port, serve.token, { onEvent, onServerRequest, onClose });
      // Needs Hermes 0.21.5+: the floor is declared in Hermes' session-bundle descriptor, so the host's version gate
      // says so before this bridge ever starts.
      await connected.request('client.capabilities', { server_requests: true });
      // Upstream bug: MCP servers only the managed overlay declares are never discovered (the discovery gate reads
      // the user's own config.yaml), so Gugu's MCP comes in through Hermes' own reload, before any session exists
      // (measured 2026-10-04). Delete once the supported Hermes discovers them.
      if (mcpServers?.length) await connected.request('reload.mcp', { confirm: true });
      gateway = connected;
      return connected;
    })().finally(() => {
      starting = null;
    });
  }
  return starting;
}

function onClose(reason: string) {
  if (shuttingDown) return;
  process.stderr.write(`[hermes-serve-acp] ${reason}\n`);
  process.exit(1);
}

function checkContract(liveInfo: Json) {
  const contract = Number(liveInfo.desktop_contract);
  if (contract !== DESKTOP_CONTRACT) {
    throw new Error(
      `This Hermes speaks serve contract ${String(liveInfo.desktop_contract)}; Gugu supports contract ${DESKTOP_CONTRACT}. `
      + 'Update Gugu (or use a Hermes release that reports this contract).',
    );
  }
}

// ── models / settings ────────────────────────────────────────────────────────────

const stripCustom = (provider: string) => provider.replace(/^custom:/, '');

async function loadModels(gw: Gateway) {
  if (platformFacts) {
    models = platformModelChoices(platformFacts);
  } else {
    try {
      models = ownModelChoices(await gw.request('model.options', { session_id: session?.runtime, explicit_only: true }));
    } catch (error) {
      process.stderr.write(`[hermes-serve-acp] model.options failed: ${(error as Error).message}\n`);
      models = [];
    }
  }
  adoptInfo(info);
}

/** `session.info` is Hermes' own account of what the session runs on; the options mirror it. */
function adoptInfo(next: Json) {
  info = { ...info, ...next };
  const model = typeof info.model === 'string' ? info.model : '';
  const provider = stripCustom(typeof info.provider === 'string' ? info.provider : '');
  if (model && provider) {
    const value = `${provider}/${model}`;
    if (!models.some((choice) => choice.value === value)) {
      // The running model is not in the catalog Hermes listed (e.g. set in the user's config by hand): still
      // offer it, with Hermes' own ladder.
      models.push({ value, name: model, efforts: platformFacts ? [] : ['none', ...HERMES_REASONING_EFFORTS] });
    }
    selected.model = value;
  }
  selected.effort = typeof info.reasoning_effort === 'string' && info.reasoning_effort ? info.reasoning_effort : null;
  selected.yolo = info.yolo === true;
}

async function setConfigOption(params: Json): Promise<Json> {
  const gw = requireGateway();
  const runtimeSessionId = session!.runtime;
  const configId = String(params.configId ?? '');
  const value = String(params.value ?? '').trim();
  const invalid = (message: string) => Object.assign(new Error(message), { code: -32602 });
  if (configId === 'mode') {
    if (value !== 'default' && value !== 'yolo') throw invalid(`unknown approvals mode: ${value}`);
    // Session scope; `scope: 'global'` would rewrite the user's `approvals.mode`.
    await gw.request('config.set', { key: 'yolo', value: value === 'yolo' ? 'on' : 'off', session_id: runtimeSessionId });
    selected.yolo = value === 'yolo';
  } else if (configId === 'model') {
    const target = parseModelValue(value);
    if (!target || !models.some((choice) => choice.value === value)) {
      throw invalid(`unknown model: ${value}; this session offers ${models.map((choice) => choice.value).join(', ')}`);
    }
    const set = (confirm: boolean) => gw.request('config.set', {
      key: 'model',
      value: `${target.model} --provider ${target.provider} --session`,
      session_id: runtimeSessionId,
      ...(confirm ? { confirm_expensive_model: true } : {}),
    });
    // The user picked it in Gugu's menu; Hermes' "expensive model" confirmation is that pick.
    const result = await set(false);
    if (result.confirm_required) await set(true);
    // `deferred` (busy turn, or any compute-host session) = applied from the next turn; it is still this pick.
    selected.model = value;
  } else if (configId === 'effort') {
    const efforts = models.find((choice) => choice.value === selected.model)?.efforts ?? [];
    if (!efforts.includes(value)) throw invalid(`unknown reasoning effort: ${value}; this model offers ${efforts.join(', ')}`);
    // Upstream bug: a `config.set reasoning` that lands while Hermes builds the session's agent is acknowledged and
    // lost (measured 2026-10-04). It waits for the built agent, as Hermes' own
    // model setter does. Delete the wait once the supported Hermes applies a mid-build pick.
    await agentBuilt;
    // Hermes Desktop's composer path: session-scoped, takes effect on the next request, never writes config.yaml.
    await gw.request('config.set', { key: 'reasoning', value, session_id: runtimeSessionId });
    selected.effort = value;
  } else {
    throw invalid(`unsupported configId: ${configId}`);
  }
  return { configOptions: currentOptions() };
}

// ── commands ────────────────────────────────────────────────────────────────────

/** Commands Gugu offers through its own UI (model, effort, approvals, sessions, fork …) — not repeated as `/`. */
const GUGU_OWNED_COMMANDS = new Set(['model', 'new', 'reset', 'clear', 'branch', 'fork', 'stop', 'yolo', 'reasoning',
  'resume', 'sessions', 'switch', 'handoff', 'profile', 'skin', 'pet', 'hatch', 'wake', 'journey', 'browser', 'title', 'help']);

async function publishCommands(gw: Gateway) {
  try {
    const catalog = await gw.request('commands.catalog', { session_id: session?.runtime });
    const meta = (catalog.commands ?? {}) as Record<string, Json | undefined>;
    const pairs = Array.isArray(catalog.pairs) ? (catalog.pairs as unknown[][]) : [];
    const commands = pairs
      .map(([name, description]) => ({ name: String(name ?? '').replace(/^\/+/, ''), description: String(description ?? '') }))
      // `desktop` set = Hermes Desktop replaces it with its own UI, so GUI clients do not offer it.
      .filter(({ name }) => name && !GUGU_OWNED_COMMANDS.has(name) && meta[name]?.desktop == null);
    const skills = Object.entries((catalog.skills ?? {}) as Record<string, Json>)
      .map(([name, skill]) => ({ name, description: String(skill.description ?? '') }));
    sessionUpdate({ sessionUpdate: 'available_commands_update', availableCommands: [...commands, ...skills] });
  } catch (error) {
    process.stderr.write(`[hermes-serve-acp] commands.catalog failed: ${(error as Error).message}\n`);
  }
}

/** Hermes Desktop's slash flow (`use-prompt-actions/slash.ts`): slash.exec, then its dispatch directive. */
async function runSlash(gw: Gateway, prompt: PendingPrompt, command: string, submit: (text: string) => Promise<void>) {
  const name = command.split(/\s+/, 1)[0] ?? '';
  const arg = command.slice(name.length).trim();
  const reply = (output: string) => {
    sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: output } });
    settle(prompt, { stopReason: 'end_turn' });
  };
  if (GUGU_OWNED_COMMANDS.has(name)) {
    reply(`/${name} is done from Gugu's own controls (the model / reasoning / approvals menus and the session list).`);
    return;
  }
  let dispatch: Json;
  try {
    dispatch = await gw.request('slash.exec', { session_id: session!.runtime, command });
  } catch {
    dispatch = await gw.request('command.dispatch', { session_id: session!.runtime, name, arg });
  }
  const type = String(dispatch.type ?? '');
  if (type === 'alias' && dispatch.target) {
    await runSlash(gw, prompt, `${String(dispatch.target)}${arg ? ` ${arg}` : ''}`, submit);
  } else if ((type === 'send' || type === 'skill') && String(dispatch.message ?? '').trim()) {
    await submit(String(dispatch.message));
  } else {
    const notice = String(dispatch.notice ?? '').trim();
    const output = String(dispatch.output ?? '').trim();
    reply([dispatch.warning ? `warning: ${String(dispatch.warning)}` : '', notice, output].filter(Boolean).join('\n') || `/${name}: no output`);
  }
}

// ── turns ───────────────────────────────────────────────────────────────────────

function settle(prompt: PendingPrompt, result: Json | null, error?: Json) {
  const index = prompts.indexOf(prompt);
  if (index >= 0) prompts.splice(index, 1);
  for (const acpId of [prompt.acpId, ...prompt.joined]) respond(acpId, result, error);
}

function promptText(blocks: unknown): { text: string; images: { data: string; mimeType: string }[] } {
  const list = Array.isArray(blocks) ? (blocks as Json[]) : [];
  const texts: string[] = [];
  const images: { data: string; mimeType: string }[] = [];
  for (const block of list) {
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block.type === 'image' && typeof block.data === 'string') images.push({ data: block.data, mimeType: String(block.mimeType ?? 'image/png') });
    else if (block.type === 'resource_link' && typeof block.uri === 'string') texts.push(block.uri);
    else if (block.type === 'resource' && typeof (block.resource as Json | undefined)?.text === 'string') {
      texts.push(String((block.resource as Json).text));
    }
  }
  return { text: texts.join('\n'), images };
}

async function handlePrompt(id: unknown, params: Json) {
  const gw = requireGateway();
  const runtimeSessionId = session!.runtime;
  const prompt: PendingPrompt = { acpId: id, started: false, steers: [], joined: [], streamedText: false, streamedReasoning: false };
  prompts.push(prompt);
  const { text, images } = promptText(params.prompt);
  for (const image of images) {
    const ext = image.mimeType.split('/')[1] ?? 'png';
    await gw.request('image.attach_bytes', { session_id: runtimeSessionId, content_base64: image.data, ext });
  }
  const submit = async (body: string) => {
    // `queued: true` only guards the boundary race: a prompt that lands while the previous turn finalizes would
    // otherwise fall under the user's `display.busy_input_mode` (default `interrupt`) and redirect that turn.
    const result = await gw.request('prompt.submit', { session_id: runtimeSessionId, text: body, queued: true, title_preview: titlePreview(text) });
    if (result.status === 'steered' || result.status === 'redirected') {
      // Hermes folded this text into the running turn: it has no turn of its own and ends with that one.
      const index = prompts.indexOf(prompt);
      if (index >= 0) prompts.splice(index, 1);
      (current ?? prompts[0])?.joined.push(id);
    }
  };
  const trimmed = text.trimStart();
  if (trimmed.startsWith('/') && images.length === 0) await runSlash(gw, prompt, trimmed.slice(1).trim(), submit);
  else await submit(text);
}

function onTurnStart() {
  turnRunning = true;
  current = prompts.find((prompt) => !prompt.started) ?? null;
  if (current) current.started = true;
  const held = heldSteers;
  heldSteers = [];
  for (const steer of held) void steerNow(steer.text).then(steer.resolve);
}

async function onTurnComplete(payload: Json) {
  const turn = current;
  turnRunning = false;
  current = null;
  for (const steer of heldSteers.splice(0)) steer.resolve('promptRequired');
  if (turn && !turn.streamedText && typeof payload.text === 'string' && payload.text) {
    sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: payload.text } });
  }
  if (turn && !turn.streamedReasoning && typeof payload.reasoning === 'string' && payload.reasoning) {
    sessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: payload.reasoning } });
  }
  const usage = usageUpdate(payload.usage);
  if (usage) sessionUpdate(usage);
  if (!turn) return;
  if (turn.steers.length > 0 && (await steerLeftOver(turn))) {
    // The model's last step had no tool call: Hermes hands the steer back and runs it as the next turn
    // (`turn_finalizer` pending_steer → queue). That turn still answers this ACP prompt.
    turn.started = false;
    turn.steers = [];
    turn.streamedText = false;
    turn.streamedReasoning = false;
    return;
  }
  const status = payload.status;
  if (status === 'error') {
    settle(turn, null, {
      code: -32603,
      message: String(payload.error || payload.failure_reason || 'Hermes turn failed'),
      data: { errorSurface: payload.error_surface ?? null },
    });
  } else {
    settle(turn, { stopReason: status === 'interrupted' ? 'cancelled' : 'end_turn' });
  }
}

/** History is updated before `message.complete` is emitted: an accepted steer missing as a user row was handed back. */
async function steerLeftOver(turn: PendingPrompt): Promise<boolean> {
  try {
    const history = await requireGateway().request('session.history', { session_id: session!.runtime });
    const rows = Array.isArray(history.messages) ? (history.messages as Json[]) : [];
    const userTexts = rows.filter((row) => row.role === 'user').map((row) => String(row.text ?? ''));
    return turn.steers.some((steer) => !userTexts.some((row) => row.includes(steer)));
  } catch (error) {
    process.stderr.write(`[hermes-serve-acp] session.history failed: ${(error as Error).message}\n`);
    return false;
  }
}

async function steerNow(text: string): Promise<string> {
  const turn = current;
  if (!turn || !turnRunning) return 'promptRequired';
  const result = await requireGateway().request('session.steer', { session_id: session!.runtime, text });
  // `queued` = appended after the next tool result (or before the next API call) of this same turn.
  if (result.status === 'queued' || result.status === 'redirected') {
    turn.steers.push(text);
    return 'injected';
  }
  return 'promptRequired';
}

/** `_session/steering`: a message for the running turn, joined at its next tool boundary; never an interrupt. */
async function handleSteering(params: Json): Promise<string> {
  const blocks = Array.isArray(params.prompt) ? (params.prompt as Json[]) : [];
  if (!session || blocks.some((block) => block.type !== 'text')) return 'promptRequired'; // Hermes steers plain text only
  const { text } = promptText(blocks);
  if (turnRunning && current) return steerNow(text);
  // Submitted but its turn has not started (agent still building): hold until `message.start`, then steer.
  if (prompts.some((prompt) => !prompt.started)) return new Promise((resolve) => heldSteers.push({ text, resolve }));
  return 'promptRequired';
}

// ── Hermes → ACP ────────────────────────────────────────────────────────────────

function onEvent({ type, runtimeSessionId, payload }: GatewayEvent) {
  if (type === 'request.cancel') {
    serverRequestCancels.get(String(payload.id ?? ''))?.(String(payload.reason ?? 'cancelled'));
    return;
  }
  if (!session || runtimeSessionId !== session.runtime) return;
  switch (type) {
    case 'message.start':
      onTurnStart();
      return;
    case 'message.delta':
      if (current) current.streamedText = true;
      sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(payload.text ?? '') } });
      return;
    case 'message.interim':
      if (!payload.already_streamed) {
        sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(payload.text ?? '') } });
      }
      return;
    case 'reasoning.delta':
    case 'thinking.delta':
      if (current) current.streamedReasoning = true;
      sessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: String(payload.text ?? '') } });
      return;
    case 'message.complete':
      void onTurnComplete(payload);
      return;
    case 'tool.start':
      runningTools.set(String(payload.tool_id ?? ''), String(payload.name ?? ''));
      sessionUpdate(toolCallStart(payload));
      return;
    case 'tool.complete':
      runningTools.delete(String(payload.tool_id ?? ''));
      sessionUpdate(toolCallComplete(payload));
      return;
    case 'todo.updated':
      sessionUpdate(planUpdate(payload.todos));
      return;
    case 'session.usage': {
      const usage = usageUpdate(payload.usage);
      if (usage) sessionUpdate(usage);
      return;
    }
    case 'session.title':
      sessionUpdate({ sessionUpdate: 'session_info_update', title: String(payload.title ?? '') });
      return;
    case 'session.info': {
      announceAgentBuilt();
      const before = JSON.stringify(currentOptions());
      adoptInfo(payload);
      const after = currentOptions();
      if (JSON.stringify(after) !== before) sessionUpdate({ sessionUpdate: 'config_option_update', configOptions: after });
      return;
    }
    case 'subagent.start':
    case 'subagent.progress':
    case 'subagent.complete': {
      const parent = [...runningTools].filter(([, name]) => name === 'delegate_task');
      if (parent.length !== 1) return;
      const line = [payload.goal, payload.status, payload.summary ?? payload.text].filter(Boolean).join(' · ');
      sessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: parent[0]![0], content: [{ type: 'content', content: { type: 'text', text: String(line) } }] });
      return;
    }
    case 'error':
      announceAgentBuilt();
      process.stderr.write(`[hermes-serve-acp] hermes error: ${String(payload.message ?? '')}\n`);
      return;
    case 'notification.show':
      if (payload.level === 'error' || payload.level === 'warn') {
        process.stderr.write(`[hermes-serve-acp] hermes ${String(payload.level)}: ${String(payload.text ?? '')}\n`);
      }
      return;
    default:
      return; // desktop-only and informational events (skin, pet, voice, preview, status …)
  }
}

/** Ask the person through ACP; a withdrawn request (`request.cancel`) settles as declined. */
function askPerson(requestId: string, params: Json): Promise<string | null> {
  return new Promise((resolve) => {
    serverRequestCancels.set(requestId, () => resolve(null));
    acpRequest('session/request_permission', { sessionId: session?.stored, ...params }).then(
      (answer) => {
        const outcome = (answer.outcome ?? {}) as Json;
        resolve(outcome.outcome === 'selected' ? String(outcome.optionId ?? '') : null);
      },
      () => resolve(null),
    ).finally(() => serverRequestCancels.delete(requestId));
  });
}

async function onServerRequest(method: string, params: Json): Promise<Json> {
  const requestId = String(params.request_id ?? `${method}-${Date.now()}`);
  if (method === 'approval') {
    const terminals = [...runningTools].filter(([, name]) => name === 'terminal');
    const choice = await askPerson(requestId, {
      toolCall: {
        toolCallId: terminals.length === 1 ? terminals[0]![0] : `approval-${requestId}`,
        title: String(params.description ?? params.command ?? 'Run command'),
        kind: 'execute',
        status: 'pending',
        rawInput: { command: params.command ?? '' },
      },
      options: approvalOptions(params),
    });
    return { choice: choice && ['once', 'session', 'always'].includes(choice) ? choice : 'deny' };
  }
  if (method === 'clarify') {
    const questions = clarifyQuestions(params);
    const answers: Record<string, string | null> = {};
    for (const question of questions) {
      if (question.choices.length === 0) {
        answers[question.qid] = null; // free text has no ACP form here: skipped, Hermes' own "no answer"
        continue;
      }
      // pi's choose-one shape: every option `allow_once`, none refusing, so the runtime classes it a question, not an
      // approval. (`other`, codex's choice, fails the ACP v1 schema the host validates with: -32602.)
      const picked = await askPerson(`${requestId}-${question.qid}`, {
        toolCall: { toolCallId: `clarify-${requestId}-${question.qid}`, title: question.question, kind: 'other', status: 'pending' },
        options: question.choices.map((choice, index) => ({ optionId: String(index), name: choice, kind: 'allow_once' })),
      });
      answers[question.qid] = picked === null ? null : (question.choices[Number(picked)] ?? null);
    }
    return { answers };
  }
  // sudo / secret / vault / preview / terminal.read / window.read / tour / display.install.sudo: nothing in Gugu
  // answers these, and an empty value is Hermes' own "declined".
  process.stderr.write(`[hermes-serve-acp] declined hermes request ${method}\n`);
  return { value: '' };
}

// ── ACP → Hermes ────────────────────────────────────────────────────────────────

async function openSession(created: Json, gw: Gateway) {
  agentBuilt = new Promise((done) => { announceAgentBuilt = done; });
  const liveInfo = (created.info ?? {}) as Json;
  checkContract(liveInfo);
  session = { stored: String(created.stored_session_id ?? created.session_id ?? ''), runtime: String(created.session_id ?? '') };
  if (!session.stored || !session.runtime) throw new Error('hermes returned no session id');
  info = {};
  adoptInfo(liveInfo);
  await loadModels(gw);
}

async function handleRequest(id: unknown, method: string, params: Json) {
  if (method === 'initialize') {
    respond(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        sessionCapabilities: { close: {} },
      },
      agentInfo: { name: 'hermes-serve', version: String(DESKTOP_CONTRACT) },
      _meta: { steering: { supported: true } },
    });
    return;
  }
  if (method === 'session/new') {
    const gw = await ensureGateway(params.mcpServers as AcpMcpServer[] | undefined);
    const seed = ((params._meta as Json | undefined)?.systemPrompt as Json | undefined)?.append;
    const created = await gw.request('session.create', {
      cwd: params.cwd,
      source: 'acp',
      // Gugu's system block as a hidden seed row — how Hermes Desktop seeds model-facing scaffolding. It is
      // persisted with the session (a load does not re-seed) and never names the session (titles read only
      // the turn's own text, `title_preview`).
      ...(typeof seed === 'string' && seed.trim() ? { messages: [{ role: 'user', content: seed, display_kind: 'hidden' }] } : {}),
      ...(platformModel ? { model: platformModel, provider: `custom:${PLATFORM_PROVIDER}` } : {}),
    });
    await openSession(created, gw);
    respond(id, { sessionId: session!.stored, configOptions: currentOptions() });
    void publishCommands(gw);
    return;
  }
  if (method === 'session/load') {
    const gw = await ensureGateway(params.mcpServers as AcpMcpServer[] | undefined);
    const resumed = await gw.request('session.resume', { session_id: String(params.sessionId ?? ''), source: 'acp' });
    await openSession({ ...resumed, stored_session_id: resumed.stored_session_id ?? params.sessionId }, gw);
    // Replay before answering: the host leaves its load window when it gets the response.
    if (((params._meta as Json | undefined)?.history as Json | undefined)?.replay !== false) {
      for (const update of replayUpdates(resumed.messages)) sessionUpdate(update);
    }
    respond(id, { configOptions: currentOptions() });
    void publishCommands(gw);
    return;
  }
  if (method === 'session/prompt') {
    await handlePrompt(id, params);
    return; // answered at its turn's `message.complete`
  }
  if (method === 'session/set_config_option') {
    respond(id, await setConfigOption(params));
    return;
  }
  if (method === '_session/steering') {
    respond(id, { outcome: await handleSteering(params) });
    return;
  }
  if (method === 'session/close') {
    if (session && gateway) await gateway.request('session.close', { session_id: session.runtime });
    respond(id, {});
    return;
  }
  respond(id, null, { code: -32601, message: `unsupported ACP method: ${method}` });
}

function handleNotification(method: string) {
  if (method !== 'session/cancel' || !session || !gateway) return;
  for (const cancel of [...serverRequestCancels.values()]) cancel('cancelled');
  // The prompt answers at the interrupted turn's `message.complete` (`cancelled`).
  void gateway.request('session.interrupt', { session_id: session.runtime }).catch((error: Error) => {
    process.stderr.write(`[hermes-serve-acp] session.interrupt failed: ${error.message}\n`);
  });
}

let settingsQueue: Promise<void> = Promise.resolve();
const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on('line', (line) => {
  let message: Json;
  try {
    message = JSON.parse(line) as Json;
  } catch {
    process.stderr.write(`[hermes-serve-acp] non-JSON ACP input: ${line.slice(0, 200)}\n`);
    return;
  }
  if (message.id !== undefined && !message.method) {
    const pending = acpPending.get(Number(message.id));
    if (!pending) return;
    acpPending.delete(Number(message.id));
    if (message.error !== undefined) pending.reject(new Error(String((message.error as Json).message ?? 'ACP request failed')));
    else pending.resolve((message.result ?? {}) as Json);
    return;
  }
  const method = String(message.method ?? '');
  if (message.id === undefined) {
    handleNotification(method);
    return;
  }
  const run = () => handleRequest(message.id, method, (message.params ?? {}) as Json).catch((error: Error & { code?: number; data?: unknown }) => {
    const prompt = prompts.find((entry) => entry.acpId === message.id);
    if (prompt) prompts.splice(prompts.indexOf(prompt), 1);
    respond(message.id, null, {
      code: error instanceof GatewayError || typeof error.code === 'number' ? (error.code as number) : -32603,
      message: error.message || String(error),
      ...(error.data !== undefined ? { data: error.data } : {}),
    });
  });
  // Settings apply one at a time: model and effort read and write the same selection.
  if (method === 'session/set_config_option') settingsQueue = settingsQueue.then(run, run);
  else void run();
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const pending of acpPending.values()) pending.reject(new Error('ACP host connection closed'));
  gateway?.close();
  const stopping = serve ? serve.stop() : Promise.resolve();
  stopping.then(() => process.exit(0), (error: Error) => {
    process.stderr.write(`[hermes-serve-acp] hermes serve did not stop: ${error.message}\n`);
    process.exit(1);
  });
}

reader.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
