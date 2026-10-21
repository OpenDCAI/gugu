import { AcpChatStore } from './acp-chat-store';
import { disposeTransientStore } from './acp-chat-resource-teardown';
import { forgetTranscriptShown } from './acp-chat-transcript-keep';

const GRACE_MS = 5_000;

function disposeStore(store: AcpChatStore): void {
  forgetTranscriptShown(store);
  store.dispose();
}

type Entry = {
  store: AcpChatStore;
  refCount: number;
  graceTimer: ReturnType<typeof setTimeout> | null;
};

/**
 * Per-task ref-counted manager for AcpChatStore instances.
 *
 * Each distinct conversationId is ref-counted; the store is disposed
 * after GRACE_MS once the last retain is released.
 */
export class AcpChatResourceManager {
  private readonly _entries = new Map<string, Entry>();

  constructor(
    private readonly projectId: string,
    private readonly sessionId: string
  ) {}

  acquire(
    sessionId: string,
    runtimeView?: {
      id: string;
      forkFromProviderSessionId: string;
      forkedFromSessionId?: string;
    }
  ): AcpChatStore {
    const resourceId = runtimeView?.id ?? sessionId;
    let entry = this._entries.get(resourceId);
    if (entry) {
      entry.refCount++;
      if (entry.graceTimer !== null) {
        clearTimeout(entry.graceTimer);
        entry.graceTimer = null;
      }
      return entry.store;
    }
    const store = new AcpChatStore(sessionId, this.projectId, runtimeView);
    entry = { store, refCount: 1, graceTimer: null };
    this._entries.set(resourceId, entry);
    return store;
  }

  get(sessionId: string): AcpChatStore | undefined {
    return this._entries.get(sessionId)?.store;
  }

  sessionIds(): string[] {
    return Array.from(this._entries.keys());
  }

  release(sessionId: string): void {
    const entry = this._entries.get(sessionId);
    if (!entry) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount > 0) return;

    if (entry.store.isTransient) {
      disposeStore(entry.store);
      this._entries.delete(sessionId);
      return;
    }

    // Schedule disposal after grace period.
    entry.graceTimer = setTimeout(() => {
      const e = this._entries.get(sessionId);
      if (!e || e.refCount > 0) return;
      disposeStore(e.store);
      this._entries.delete(sessionId);
    }, GRACE_MS);
  }

  dispose(): void {
    for (const [, entry] of this._entries) {
      if (entry.graceTimer !== null) clearTimeout(entry.graceTimer);
      disposeStore(entry.store);
    }
    this._entries.clear();
  }
}

const _registry = new Map<string, AcpChatResourceManager>();

function disposeTransientStoresOnPageTeardown(): void {
  for (const manager of _registry.values()) {
    for (const sessionId of manager.sessionIds()) {
      const store = manager.get(sessionId);
      if (store) disposeTransientStore(store);
    }
  }
}

// A renderer reload can bypass React/tab-provider disposal. Install one process-local
// listener for all task managers; each manager remains scoped to its own stores.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', disposeTransientStoresOnPageTeardown);
  window.addEventListener('beforeunload', disposeTransientStoresOnPageTeardown);
}

type VisualEvidenceTurn = Parameters<
  AcpChatStore['chatState']['transcript']['history']['seed']
>[0][number];

type VisualEvidenceAnchor = {
  snapshot: (sessionId: string) => {
    knownSessionIds: string[];
    target: null | {
      historyLoading: boolean;
      loadError: null | { kind: string; message: string };
      hasSession: boolean;
      storeShape: boolean;
    };
  };
  seedTranscript: (
    sessionId: string,
    input: {
      turns: VisualEvidenceTurn[];
      collapsedIds: string[];
      attachmentDataUrls: Record<string, string>;
      /**
       * Live terminal state the seeded rows reference by id.
       *
       * An execute row does not carry its terminal's output or exit status in
       * the transcript — it asks the session for them by terminal id, because
       * both are readings about a process the client owns rather than anything
       * the provider reported. Seeding turns alone therefore reaches only the
       * half of an execute row that survives replay; without this the other
       * half is unreachable from a fixture and could not be measured at all.
       */
      terminals?: VisualEvidenceTerminal[];
    }
  ) => void;
};

type VisualEvidenceTerminal = {
  terminalId: string;
  outputText?: string;
  exitStatus?: { exitCode: number | null; signal: string | null };
};

const visualEvidenceAttachmentDataUrls = new WeakMap<AcpChatStore, Map<string, string>>();

export function resolveVisualEvidenceAttachmentDataUrl(
  store: AcpChatStore,
  id: string
): string | undefined {
  return visualEvidenceAttachmentDataUrls.get(store)?.get(id);
}

function findStore(sessionId: string): AcpChatStore | undefined {
  return _registry.get(sessionId)?.get(sessionId);
}

/**
 * Read-only store lookup for UI that decorates a conversation it does not own
 * (the timeline rail, the outputs popover) — ❌ never `getAcpChatResourceManager`,
 * which *creates* a manager and needs a projectId nobody at that call site has.
 */
export function findAcpChatStore(
  sessionId: string
): AcpChatStore | undefined {
  return findStore(sessionId);
}

function requireStore(sessionId: string): AcpChatStore {
  const store = findStore(sessionId);
  if (!store) {
    throw new Error(`session chat evidence store is missing for ${sessionId}`);
  }
  return store;
}

const visualEvidenceAnchor: VisualEvidenceAnchor = {
  snapshot(sessionId) {
    const knownSessionIds = Array.from(_registry.values()).flatMap((manager) =>
      manager.sessionIds()
    );
    const store = findStore(sessionId);
    return {
      knownSessionIds,
      target: store
        ? {
            historyLoading: store.historyLoading,
            loadError: store.loadError
              ? { kind: store.loadError.kind, message: store.loadError.message }
              : null,
            hasSession: store.session !== null,
            storeShape: Boolean(store.chatState.transcript.history.seed),
          }
        : null,
    };
  },
  seedTranscript(sessionId, input) {
    const store = requireStore(sessionId);
    visualEvidenceAttachmentDataUrls.set(store, new Map(Object.entries(input.attachmentDataUrls)));
    store.installVisualEvidenceFixture(input.turns, input.collapsedIds, input.terminals ?? []);
  },
};

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (
    window as unknown as {
      __GUGU_SESSION_CHAT_E2E__?: VisualEvidenceAnchor;
    }
  ).__GUGU_SESSION_CHAT_E2E__ = visualEvidenceAnchor;
}

export function getAcpChatResourceManager(
  sessionId: string,
  projectId: string
): AcpChatResourceManager {
  const existing = _registry.get(sessionId);
  if (existing) return existing;
  const manager = new AcpChatResourceManager(projectId, sessionId);
  _registry.set(sessionId, manager);
  return manager;
}

export function releaseAcpChatResourceManager(sessionId: string): void {
  const manager = _registry.get(sessionId);
  if (!manager) return;
  manager.dispose();
  _registry.delete(sessionId);
}
