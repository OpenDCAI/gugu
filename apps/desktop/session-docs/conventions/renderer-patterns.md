# Renderer Patterns

All paths are relative to `apps/desktop/`.

## Modal System

All modals use a registry-based system. Only one modal can be active at a time.

- `apps/desktop/src/session/renderer/app/modal-registry.ts` — central registry mapping modal IDs to components
  (`createModal`, `modalRegistry`)
- `apps/desktop/src/session/renderer/lib/modal/modal-provider.tsx` — React context managing active modal state
  (`useModalContext`, `showModal`, `BaseModalProps`)
- `apps/desktop/src/session/renderer/lib/modal/modal-renderer.tsx` — renders the currently active modal
- `apps/desktop/src/session/renderer/lib/modal/modal-store.ts` — modal state store
- `apps/desktop/src/session/renderer/lib/modal/use-close-guard.ts` — close-guard hook

**Adding a modal:**
1. Create the component accepting `BaseModalProps<TResult>` (provides `onSuccess` and `onClose` callbacks)
2. Register it in `apps/desktop/src/session/renderer/app/modal-registry.ts`
3. Open it via the hook:

```tsx
const { showModal } = useModalContext();
showModal('myModal', { projectId: '123', onSuccess: (result) => {...} });
```

**Rules:**
- All modals must be registered in `apps/desktop/src/session/renderer/app/modal-registry.ts`
- `showModal` is type-safe — TypeScript infers required args from the registry
- `hasActiveCloseGuard` prevents dismissal during critical operations

## View System

Views use a registry + parameterized navigation pattern.

- `apps/desktop/src/session/renderer/app/view-registry.ts` — view definitions (required `MainPanel`, optional
  `WrapView` and `TitlebarSlot`) plus navigation guards (`setupNavigationGuards`)
- `apps/desktop/src/session/renderer/lib/layout/` — `provider.tsx`, `navigation-provider.tsx` (navigation and
  param persistence), `layout-provider.tsx` (panel collapse/expand/drag state),
  `panel-drag-store.ts`

**Key behaviors:**
- `navigate(viewId, params?)` (from `useNavigate`) is type-safe; params are optional when all fields are optional
- Params persist per-view (navigating away and back preserves params)
- `updateViewParams(viewId, partial)` updates params without re-navigating

**Rules:**
- Views are singletons — one per ViewId
- Add new views to `apps/desktop/src/session/renderer/app/view-registry.ts`

## PTY Frontend (`apps/desktop/src/session/renderer/lib/pty/`)

- `pty.ts` — `FrontendPty` class; subscribing fetches the main-process screen snapshot
  (`electron/session/main/core/pty/pty-screen.ts`: screen content plus terminal modes), and
  the main process hands over to live output without a gap, so there is no renderer-side
  buffer and no missed output
- `pty-session.ts` — session lifecycle
- `pty-pool-provider.tsx` — `TerminalPoolProvider` managing reusable xterm.js instances
- `pty-pane.tsx` — terminal pane component
- `prompt-injection.ts`, `pty-input-buffer.ts`, `pty-keybindings.ts`, `pty-clipboard.ts` — input handling

**Rules:**
- Historical output comes from the main-process screen snapshot; do not add renderer-side buffering
- `sessionId` format: `makePtySessionId(projectId, scopeId, leafId)` from
  `apps/desktop/src/session/shared/core/pty/ptySessionId.ts` — deterministic
- Panel drag pauses resizing to avoid jank (`apps/desktop/src/session/renderer/lib/layout/panel-drag-store.ts`)

## React Query Context Pattern

Context providers use React Query for data fetching with optimistic updates:

```tsx
// Pattern used in AppSettingsProvider, ProjectProvider, etc.
const { data } = useQuery({ queryKey: ['resource'], queryFn: () => rpc.ns.get() });
const mutation = useMutation({
  mutationFn: (args) => rpc.ns.update(args),
  onMutate: async (args) => {
    // optimistic update via queryClient.setQueryData
  },
  onError: () => {
    // rollback via queryClient.setQueryData with previous snapshot
  },
});
```

**Rules:**
- Contexts combine React Query + local state, not standalone useState
- Use `useAppSettingsKey(key)` for fine-grained per-setting hooks
- Optimistic updates must include rollback on error

## State Outside React

For state that must survive React unmounts or be shared across unrelated components:

- **`useSyncExternalStore`-compatible stores** — e.g., `panelDragStore` in `apps/desktop/src/session/renderer/lib/layout/`
- **Cross-feature stores** — `apps/desktop/src/session/renderer/lib/stores/` (navigation, dependencies, resource monitor, ...)
- **MobX task and project stores** — `apps/desktop/src/session/renderer/features/sessions/stores/` and
  `apps/desktop/src/session/renderer/features/projects/stores/`; access them through selectors
  (`session-selectors.ts`, `project-selectors.ts`) and task view hooks, never directly
