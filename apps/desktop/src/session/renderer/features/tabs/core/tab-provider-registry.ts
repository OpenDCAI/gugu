import { log } from '@renderer/utils/logger';
import type { OpenTarget, TabProvider, TabResource } from './tab-provider';

// ── Type aliases ──────────────────────────────────────────────────────────────

// oxlint-disable-next-line typescript/no-explicit-any
export type AnyTabProvider = TabProvider<any, any, any, any>;

/**
 * Extract the literal kind union from a typed registry.
 */
export type KindOf<R extends TabRegistry> =
  R extends TypedTabRegistry<infer P> ? P[number]['kind'] : string;

/**
 * Extract the OpenArgs type for a given kind from a typed registry.
 */
export type OpenArgsOf<R extends TabRegistry, K extends KindOf<R>> =
  R extends TypedTabRegistry<infer P>
    ? Extract<P[number], { kind: K }> extends TabProvider<K, infer _S, infer _T, infer A>
      ? A
      : unknown
    : unknown;

/**
 * Extract the resource type (T) for a given kind from a typed registry.
 */
export type ResourceOf<R extends TabRegistry, K extends KindOf<R>> =
  R extends TypedTabRegistry<infer P>
    ? Extract<P[number], { kind: K }> extends TabProvider<K, infer _S, infer T, infer _A>
      ? T
      : TabResource
    : TabResource;

/**
 * Strongly-typed discriminated union of all open-arg shapes in a registry.
 * Used by the public layout-level open() entry point.
 *
 * Each member is { kind: K } & OpenArgsOf<R, K>, so callers get
 * exhaustive completions and type errors for unknown kinds.
 */
export type TabOpenArgs<R extends TabRegistry> = {
  [K in KindOf<R>]: { kind: K } & OpenArgsOf<R, K>;
}[KindOf<R>];

/**
 * Control flags that may accompany any TabOpenArgs call.
 * Stripped before the args reach onBeforeOpen.
 */
export interface TabOpenOptions {
  /** When true, opens as a preview tab (replaced on next preview open). */
  preview?: boolean;
  /**
   * When true and the tab is already open (single-mount hit), replace its
   * current state with the new open args. Ignored for multi-mount providers.
   */
  overrideState?: boolean;
  /**
   * 新开的这一格要不要抢焦点。默认 true。
   *
   * false 是给**宿主替用户摆上去**的 tab 用的:启用的扩展在每条会话页都有一格
   * (behavior tab-extensions),那一格不能在会话打开的一瞬间把对话顶下去。
   */
  activate?: boolean;
  /**
   * 开在对话右边并排(spec session-page「并排」):agent 打开的、从对话里点开的走这条。
   * 认哪一枚是对话由会话页那一侧挂上来(PaneLayoutStore.setPairAnchor);没有对话 = 照常开在 `target`。
   * 和 `activate` 一起:人点开的(默认 true)= 连好后把并排亮到屏上;agent 打开的传 false = 用户正看着别的就
   * ❌ 切走,一对只在页签条上连好(spec session-page「并排」:不切走正在看的)。
   */
  beside?: boolean;
  /**
   * Which pane to open into. Defaults to 'active' (focused pane).
   * 'right'/'left' will split if needed; { paneId } targets an explicit pane.
   */
  target?: OpenTarget;
}

// ── Registry interface ────────────────────────────────────────────────────────

/**
 * Registry of tab providers, constructed via createTabRegistry.
 * Each PaneStore holds a reference; React chrome reads it off the store
 * through PaneContext so no extra React context is needed.
 */
export interface TabRegistry {
  /** Adds an application-compiled provider after construction. Duplicate kinds throw. */
  register(provider: AnyTabProvider): void;
  get(kind: string): AnyTabProvider;
  all(): AnyTabProvider[];
  has(kind: string): boolean;
  /**
   * Removes a provider that arrived after construction. Returns whether one was
   * there to remove. Panes demote that kind's open tabs to placeholders rather
   * than closing them — uninstalling an extension must not cost the user the
   * tabs they left open, but it must stop the extension from still drawing them.
   */
  unregister(kind: string): boolean;
  /**
   * Notifies when a provider arrives after construction. Panes use this to
   * revive tabs they had to show as unavailable: a kind that registers late
   * (an extension loading after the layout was restored, or a built-in behind
   * an async import) must not cost the user the tabs they left open.
   * Returns an unsubscribe function.
   */
  onProviderRegistered(listener: (kind: string) => void): () => void;
  /** The mirror of onProviderRegistered, for when a provider goes away. */
  onProviderUnregistered(listener: (kind: string) => void): () => void;
  /**
   * Asks every pane to close its open tabs of this kind — the deliberate
   * counterpart of unregister's placeholder rule. Unregister keeps tabs because
   * losing a provider is not the user's doing (an uninstall, a late load);
   * this is for when it is: disabling an extension from the panel means "stop
   * showing it", and a tab left behind as a placeholder would be litter the
   * user has to close by hand (owner, #5265). Fire this before unregister.
   *
   * `which` narrows it to some of them, by their state: an App's tabs taken out of every session close, the ones it
   * opened for a file stay (摩擦单 F98).
   */
  closeKind(kind: string, which?: (state: unknown) => boolean): void;
  onKindClosed(listener: (kind: string, which?: (state: unknown) => boolean) => void): () => void;
}

/** Typed registry that retains the full provider tuple for type inference. */
export interface TypedTabRegistry<P extends readonly AnyTabProvider[]> extends TabRegistry {
  /** @internal Used for type-level inference only; do not call at runtime. */
  readonly _providers: P;
}

// ── Factories ─────────────────────────────────────────────────────────────────

/**
 * Identity helper that captures the generic parameters so providers
 * can be authored as plain object literals without losing type inference.
 *
 * ```ts
 * export const myTabProvider = createTabProvider({
 *   kind: 'my-kind',
 *   mount: { type: 'single', dedupKey: (s) => s.id },
 *   initialize: (entry, handle, ctx) => { ... },
 *   dispose: (entry, resource, ctx) => { ... },
 *   ...
 * });
 * ```
 */
export function createTabProvider<K extends string, S, T extends TabResource, OpenArgs = S>(
  impl: TabProvider<K, S, T, OpenArgs>
): TabProvider<K, S, T, OpenArgs> {
  return impl;
}

/**
 * Builds a TypedTabRegistry whose const tuple remains the static type source.
 * Additional providers may be registered at runtime without widening that tuple.
 * Call once per view that needs a tab surface (e.g. in session-tab-registry.ts).
 */
export function createTabRegistry<const P extends readonly AnyTabProvider[]>(
  providers: P
): TypedTabRegistry<P> {
  const map = new Map<string, AnyTabProvider>();
  const listeners = new Set<(kind: string) => void>();
  const removalListeners = new Set<(kind: string) => void>();
  const closeListeners = new Set<(kind: string, which?: (state: unknown) => boolean) => void>();

  // One listener's failure must not decide whether the others hear about the
  // change, nor whether the change appears to have happened at all — the map is
  // already updated by the time these run.
  const notify = (targets: Set<(kind: string) => void>, kind: string, what: string): void => {
    for (const listener of targets) {
      try {
        listener(kind);
      } catch (error) {
        log.error(`[TabRegistry] ${what} listener failed for kind ${kind}:`, error);
      }
    }
  };

  const register = (provider: AnyTabProvider): void => {
    if (map.has(provider.kind)) {
      throw new Error(`Tab provider already registered for kind: ${provider.kind}`);
    }
    map.set(provider.kind, provider);
    notify(listeners, provider.kind, 'registration');
  };

  // Construction-time providers predate every listener, so nothing is missed by
  // notifying inside register().
  for (const provider of providers) register(provider);

  const registry: TypedTabRegistry<P> = {
    register,
    unregister(kind: string): boolean {
      if (!map.delete(kind)) return false;
      notify(removalListeners, kind, 'removal');
      return true;
    },
    onProviderRegistered(listener: (kind: string) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onProviderUnregistered(listener: (kind: string) => void): () => void {
      removalListeners.add(listener);
      return () => removalListeners.delete(listener);
    },
    closeKind(kind: string, which?: (state: unknown) => boolean): void {
      for (const listener of closeListeners) {
        try {
          listener(kind, which);
        } catch (error) {
          log.error(`[TabRegistry] close listener failed for kind ${kind}:`, error);
        }
      }
    },
    onKindClosed(listener: (kind: string, which?: (state: unknown) => boolean) => void): () => void {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    get(kind: string): AnyTabProvider {
      const def = map.get(kind);
      if (!def) throw new Error(`No tab provider registered for kind: ${kind}`);
      return def;
    },
    all(): AnyTabProvider[] {
      return [...map.values()];
    },
    has(kind: string): boolean {
      return map.has(kind);
    },
    // oxlint-disable-next-line typescript/no-explicit-any
    _providers: providers as any,
  };
  return registry;
}
