import type { CheckReadings } from '@shared/extensions/bridge-protocol';
import {
  EXTENSION_SNAPSHOT_MAX_BYTES,
  EXTENSION_STEP_WAIT_MS,
  isExtensionStepKey,
  type ExtensionStepKey,
  type ExtensionCheckReport,
  type ExtensionPicture,
  type ExtensionStepRequest,
  type ExtensionStepResult,
  type ExtensionStepTarget,
} from '@shared/extensions/extension-check';

/**
 * `app_check { steps }` (owner 10-12): what the agent that wrote an App does on the check's page as a person would.
 * A control is found by its role and accessible name in the page's accessibility tree, strictly (Playwright's
 * getByRole): CSS and coordinates break with the markup, and a name is what the person reads. mac1 10-12 (gugu-base
 * evidence/2026-10-12-app-check-steps): the hidden page's tree is whole, and CDP input reaches it as trusted events.
 */

/** A node of CDP's `Accessibility.getFullAXTree`, the fields read here. */
export interface AXNode {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: { name: string; value?: { value?: unknown } }[];
  backendDOMNodeId?: number;
}

/** Nodes that only wrap others: no line of their own, never a container a candidate is named by. */
const WRAPS = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak', 'RootWebArea', 'WebArea', 'ListMarker', 'Ignored']);
/** A field's text is its value: said once. */
const FIELD = /^(textbox|searchbox|combobox|spinbutton)$/i;
const STATES = ['checked', 'pressed', 'expanded', 'selected', 'disabled', 'level'];
const MAX_CANDIDATES = 12;
const LINE_MAX_CHARS = 300;
/** After a step acts, the page settles before the next, for at most this long. */
const STEP_SETTLE_MS = 2_000;
const POLL_MS = 200;

const roleOf = (node: AXNode) => String(node.role?.value ?? '');
const norm = (text: string) => text.replace(/\s+/g, ' ').trim();
const nameOf = (node: AXNode) => norm(String(node.name?.value ?? ''));
const said = (node: AXNode) => `${roleOf(node)}${nameOf(node) ? ` ${JSON.stringify(nameOf(node))}` : ''}`;
const property = (node: AXNode, name: string) => node.properties?.find((p) => p.name === name)?.value?.value;
const targetWords = (target: ExtensionStepTarget) =>
  `${target.role}${target.name !== undefined ? ` ${JSON.stringify(target.name)}` : ''}${target.within ? ` within ${JSON.stringify(target.within)}` : ''}`;

export class AXTree {
  private readonly byId: Map<string, AXNode>;
  constructor(readonly nodes: AXNode[]) {
    this.byId = new Map(nodes.map((node) => [node.nodeId, node]));
  }

  get root(): AXNode | undefined {
    return this.nodes.find((node) => !node.parentId || !this.byId.has(node.parentId));
  }

  children(node: AXNode): AXNode[] {
    return (node.childIds ?? []).flatMap((id) => this.byId.get(id) ?? []);
  }

  /** Nearest first. */
  ancestors(node: AXNode): AXNode[] {
    const up = node.parentId ? this.byId.get(node.parentId) : undefined;
    return up ? [up, ...this.ancestors(up)] : [];
  }

  descendants(node: AXNode): AXNode[] {
    return this.children(node).flatMap((child) => [child, ...this.descendants(child)]);
  }

  /** The text a person reads in it. */
  textOf(node: AXNode): string {
    return norm(this.descendants(node).filter((n) => !n.ignored && roleOf(n) === 'StaticText').map(nameOf).join(' '));
  }
}

/**
 * The shown nodes of a role among `pool`, and of them the ones a query names: by text in them (a container without a
 * name), else by name — the same name first, then one containing it, case aside, so 发布 never also finds 取消发布.
 */
function matching(tree: AXTree, pool: AXNode[], query: { role: string; name?: string; text?: string }) {
  const role = query.role.toLowerCase() === 'img' ? 'image' : query.role.toLowerCase();
  const ofRole = pool.filter((node) => !node.ignored && roleOf(node).toLowerCase() === role);
  const has = (got: string, want: string) => got.toLowerCase().includes(want.toLowerCase());
  if (query.text !== undefined) {
    // Nested containers that both hold the text: the innermost is the one meant.
    const holding = ofRole.filter((node) => has(tree.textOf(node), norm(query.text!)));
    return { ofRole, found: holding.filter((node) => !holding.some((inner) => inner !== node && tree.ancestors(inner).includes(node))) };
  }
  if (query.name === undefined) return { ofRole, found: ofRole };
  const want = norm(query.name).toLowerCase();
  const same = ofRole.filter((node) => nameOf(node).toLowerCase() === want);
  return { ofRole, found: same.length > 0 ? same : ofRole.filter((node) => has(nameOf(node), want)) };
}

/** Each with the `within` that would tell it apart: the node around it, by its name, else by its title or first words. */
function candidatesOf(tree: AXTree, nodes: AXNode[]): string[] {
  const named = nodes.slice(0, MAX_CANDIDATES).map((node) => {
    const around = tree.ancestors(node).find((up) => !up.ignored && !WRAPS.has(roleOf(up)));
    if (!around) return said(node);
    const title = tree.descendants(around).find((n) => /^(heading|strong)$/.test(roleOf(n)) && tree.textOf(n));
    const within = nameOf(around) ? { role: roleOf(around), name: nameOf(around) } : { role: roleOf(around), text: tree.textOf(title ?? around).slice(0, 30) };
    return `${said(node)} within ${JSON.stringify(within)}`;
  });
  return nodes.length > MAX_CANDIDATES ? [...named, `… and ${nodes.length - MAX_CANDIDATES} more`] : named;
}

export type Located = { node: AXNode } | { error: string; candidates: string[]; matched: number };

/** The one node a target names (inside the one its `within` names), or why not exactly one, with the candidates. */
export function locate(tree: AXTree, target: ExtensionStepTarget): Located {
  const one = (pool: AXNode[], query: { role: string; name?: string; text?: string }, what: string): Located => {
    const { found, ofRole } = matching(tree, pool, query);
    if (found.length === 1) return { node: found[0]! };
    const error = found.length > 1 ? `${found.length} match ${what}` : ofRole.length > 0 ? `nothing matches ${what}` : `no ${query.role} here at all`;
    return { error, candidates: candidatesOf(tree, found.length > 0 ? found : ofRole), matched: found.length };
  };
  const scope = target.within ? one(tree.nodes, target.within, `the within ${JSON.stringify(target.within)}`) : null;
  if (scope && 'error' in scope) return scope;
  return one(scope ? tree.descendants(scope.node) : tree.nodes, target, targetWords(target));
}

/**
 * The page as its accessibility tree outlines it, in ARIA YAML (Playwright's aria snapshot): a line a node — role, name,
 * states, a field's value — wrappers folded away, text its parent's name already says left out. At most
 * EXTENSION_SNAPSHOT_MAX_BYTES, cut at a line, saying how much more there was.
 */
export function ariaSnapshot(nodes: AXNode[]): string {
  const tree = new AXTree(nodes);
  const lines: string[] = [];
  const walk = (node: AXNode, depth: number, saidName: string) => {
    const role = roleOf(node);
    const name = nameOf(node);
    if (role === 'StaticText') {
      if (name && !saidName.includes(name)) lines.push(`${'  '.repeat(depth)}- text: ${JSON.stringify(name)}`);
      return;
    }
    const folded = node.ignored || !role || WRAPS.has(role);
    if (!folded) {
      const states = STATES.flatMap((state) => {
        const value = property(node, state);
        return value === true || value === 'true' ? [` [${state}]`] : value === undefined || value === false || value === 'false' || value === '' ? [] : [` [${state}=${String(value)}]`];
      });
      const value = node.value?.value;
      lines.push(`${'  '.repeat(depth)}- ${role}${name ? ` ${JSON.stringify(name)}` : ''}${states.join('')}${value !== undefined && value !== '' ? `: ${JSON.stringify(String(value))}` : ''}`);
      if (FIELD.test(role)) return;
    }
    for (const child of tree.children(node)) walk(child, folded ? depth : depth + 1, folded ? saidName : name || saidName);
  };
  const root = tree.root;
  if (root) walk(root, 0, '');
  const shown = lines.map((line) => (line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS)}…` : line));
  let bytes = 0;
  const cut = shown.findIndex((line) => (bytes += Buffer.byteLength(line) + 1) > EXTENSION_SNAPSHOT_MAX_BYTES - 80);
  return cut < 0 ? shown.join('\n') : [...shown.slice(0, cut), `- … ${shown.length - cut} more lines (the snapshot stops at ${EXTENSION_SNAPSHOT_MAX_BYTES / 1024} KB)`].join('\n');
}

/** What the steps need of the check: its page over CDP, its settling, what it has said and done, a picture. */
export interface StepHost {
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** In the page's own world (`webContents.executeJavaScript`). */
  evaluate(code: string): Promise<unknown>;
  /** False: the page stopped answering (its main thread stuck). */
  settle(ms: number): Promise<boolean>;
  said(): { errors: ExtensionCheckReport['errors']; console: ExtensionCheckReport['console']; readings: CheckReadings | null };
  picture(label: string): Promise<ExtensionPicture | null>;
  /** The phone: a tap, not a click. */
  touch: boolean;
  deadline: number;
}

export async function readTree(host: Pick<StepHost, 'cdp'>): Promise<AXTree> {
  await host.cdp('Accessibility.enable');
  return new AXTree(((await host.cdp('Accessibility.getFullAXTree')) as { nodes: AXNode[] }).nodes);
}

class StepFailure extends Error {
  constructor(message: string, readonly candidates?: string[]) {
    super(message);
  }
}

/** `work`, or a failure saying `late` once `deadline` passes: what a page or a picture never answers holds nothing up. */
export function byDeadline<T>(work: Promise<T>, deadline: number, late: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const over = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepFailure(late)), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([work, over]).finally(() => clearTimeout(timer));
}

/**
 * Until `look` finds it, for up to EXTENSION_STEP_WAIT_MS: a page may draw what a step wants after the check called it
 * settled (mac1 10-12: 片场 0.5.0's cards, and a click that found none) — Playwright's actions wait the same way.
 */
async function waitUntil<T>(host: StepHost, look: () => Promise<T | undefined>, late: (waited: string) => StepFailure): Promise<T> {
  const started = Date.now();
  // Never past the steps' time: a wait the deadline cut short says how long it waited.
  const until = Math.min(host.deadline, started + EXTENSION_STEP_WAIT_MS);
  for (;;) {
    const got = await look();
    if (got !== undefined) return got;
    if (Date.now() >= until) throw late(`${Math.round((Date.now() - started) / 100) / 10} s`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, until - Date.now())));
  }
}

/** The node a target names; more than one is the strict refusal at once, none after the wait. */
async function findOne(host: StepHost, target: ExtensionStepTarget, late?: (waited: string) => string): Promise<AXNode> {
  let missed = { error: '', candidates: [] as string[] };
  return waitUntil(
    host,
    async () => {
      const located = locate(await readTree(host), target);
      if ('node' in located) return located.node;
      if (located.matched > 1) throw new StepFailure(located.error, located.candidates);
      missed = located;
      return undefined;
    },
    (waited) => new StepFailure(late ? late(waited) : `${missed.error} (waited ${waited})`, missed.candidates),
  );
}

/** A person's hand on it: shown, not disabled, scrolled to; a click, or a tap on the phone. */
async function press(host: StepHost, node: AXNode): Promise<void> {
  if (property(node, 'disabled') === true) throw new StepFailure(`${said(node)} is disabled`);
  const backendNodeId = node.backendDOMNodeId;
  // An element not rendered fails to scroll too: the box read below says so.
  await host.cdp('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined);
  const box = await (host.cdp('DOM.getBoxModel', { backendNodeId }) as Promise<{ model: { border: number[] } }>).catch(() => null);
  const quad = box?.model.border ?? [];
  const [x0, y0, x1, , , y2] = quad as number[];
  if (quad.length < 8 || x1! - x0! < 1 || y2! - y0! < 1) throw new StepFailure(`${said(node)} is not shown`);
  const x = (x0! + x1!) / 2;
  const y = (y0! + y2!) / 2;
  if (host.touch) {
    await host.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await host.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return;
  }
  await host.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (const type of ['mousePressed', 'mouseReleased']) await host.cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}

/** Each key a `press` step has: its key code, and the text a key that types gives (Enter: a form's input submits it). */
const KEYS: Record<ExtensionStepKey, { code: number; text?: string }> = {
  Enter: { code: 13, text: '\r' },
  Escape: { code: 27 },
  Tab: { code: 9 },
  Backspace: { code: 8 },
  ArrowUp: { code: 38 },
  ArrowDown: { code: 40 },
  ArrowLeft: { code: 37 },
  ArrowRight: { code: 39 },
};

/** A key on what has the focus, down and up, as a person's: `rawKeyDown` for one that types nothing. */
async function key(host: StepHost, name: ExtensionStepKey): Promise<void> {
  const { code, text } = KEYS[name];
  const down = text ? { type: 'keyDown', text } : { type: 'rawKeyDown' };
  for (const event of [down, { type: 'keyUp' }]) await host.cdp('Input.dispatchKeyEvent', { ...event, key: name, code: name, windowsVirtualKeyCode: code });
}

/** What one step does, and says it did. */
async function act(host: StepHost, step: ExtensionStepRequest): Promise<string> {
  if ('click' in step) {
    await press(host, await findOne(host, step.click));
    return `${host.touch ? 'tapped' : 'clicked'} ${targetWords(step.click)}`;
  }
  if ('fill' in step) {
    const node = await findOne(host, step.fill);
    if (!FIELD.test(roleOf(node)) && !property(node, 'editable')) throw new StepFailure(`${said(node)} is not something to type in`);
    // As Playwright fills: the caret put there by hand, all of it selected, the text typed over it.
    await press(host, node);
    const { object } = (await host.cdp('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId })) as { object: { objectId: string } };
    await host.cdp('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { this.focus(); if (this.select) this.select(); else getSelection().selectAllChildren(this) }' });
    if (step.text) await host.cdp('Input.insertText', { text: step.text });
    else await key(host, 'Backspace');
    return `filled ${targetWords(step.fill)} with ${JSON.stringify(step.text)}`;
  }
  if ('press' in step) {
    // Refused before the steps ran (app_check); said here too for any other caller.
    if (!isExtensionStepKey(step.press)) throw new StepFailure(`no key "${step.press}"; press takes ${Object.keys(KEYS).join(', ')}`);
    await key(host, step.press);
    return `pressed ${step.press}`;
  }
  const goal = step.waitFor;
  const late = (waited: string) => `${'role' in goal ? targetWords(goal) : `the text ${JSON.stringify(goal.text)}`} did not show in ${waited}`;
  if ('role' in goal) {
    await findOne(host, goal, late);
    return `saw ${targetWords(goal)}`;
  }
  await waitUntil(
    host,
    async () => {
      const text = await host.evaluate('document.body ? document.body.innerText : ""');
      return typeof text === 'string' && text.toLowerCase().includes(norm(goal.text).toLowerCase()) ? true : undefined;
    },
    (waited) => new StepFailure(late(waited)),
  );
  return `saw the text ${JSON.stringify(goal.text)}`;
}

/** What the page said and handed back during one step: what is new since `before`. */
function since(before: ReturnType<StepHost['said']>, after: ReturnType<StepHost['said']>): Pick<ExtensionStepResult, 'errors' | 'console' | 'writes' | 'shown'> {
  const errors = after.errors.slice(before.errors.length);
  const logged = after.console.slice(before.console.length);
  const writes = (after.readings?.writes ?? 0) - (before.readings?.writes ?? 0);
  const shown = after.readings?.shown.slice(before.readings?.shown.length ?? 0) ?? [];
  return {
    ...(errors.length > 0 ? { errors } : {}),
    ...(logged.length > 0 ? { console: logged } : {}),
    ...(writes > 0 ? { writes } : {}),
    ...(shown.length > 0 ? { shown } : {}),
  };
}

/** The steps in order, each settled before the next; the first that fails stops them, the rest are not run. */
export async function runSteps(steps: readonly ExtensionStepRequest[], host: StepHost): Promise<{ results: ExtensionStepResult[]; pictures: ExtensionPicture[] }> {
  const results: ExtensionStepResult[] = [];
  const pictures: ExtensionPicture[] = [];
  let stopped: string | null = null;
  for (const [index, step] of steps.entries()) {
    const number = index + 1;
    if (stopped === null && Date.now() >= host.deadline) stopped = `not run: the steps' time was up (${index} of ${steps.length} done)`;
    if (stopped !== null) {
      results.push({ step: number, ok: null, error: stopped });
      continue;
    }
    const before = host.said();
    let result: ExtensionStepResult;
    try {
      // A poll past the deadline: a step's own waits end at it and say so; this is for work that never ends.
      const did = await byDeadline(act(host, step), host.deadline + POLL_MS, 'it did not finish within the steps\' time');
      if (!('waitFor' in step) && !(await host.settle(Math.max(0, Math.min(STEP_SETTLE_MS, host.deadline - Date.now()))))) {
        throw new StepFailure('the page stopped answering after it');
      }
      result = { step: number, ok: true, did, ...since(before, host.said()) };
    } catch (error) {
      const failure = error instanceof StepFailure ? error : new StepFailure(error instanceof Error ? error.message : String(error));
      result = { step: number, ok: false, error: failure.message, ...(failure.candidates?.length ? { candidates: failure.candidates } : {}), ...since(before, host.said()) };
    }
    if (step.look) {
      const picture = await byDeadline(host.picture(`after step ${number}`), host.deadline + POLL_MS, 'its picture did not come within the steps\' time').catch((error: Error) => {
        if (result.ok) result = { ...result, ok: false, error: error.message };
        return null;
      });
      if (picture) pictures.push(picture);
    }
    results.push(result);
    if (!result.ok) stopped = `not run: step ${number} failed`;
  }
  return { results, pictures };
}
