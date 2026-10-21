# Main Process Patterns

## Controller Pattern

Each domain in `apps/desktop/electron/session/main/core/` exposes a `controller.ts` that defines RPC handlers:

```ts
// apps/desktop/electron/session/main/core/sessions/create-controller.ts
import { createRPCController } from '@shared/ipc/rpc';
import { createSession } from './createSession';
import { getTasks } from './getTasks';

export const sessionCreateController = createRPCController({
  createSession,
  getTasks,
  deleteTask,
  // ...
});
```

Controllers are assembled into the router in `apps/desktop/electron/session/main/rpc.ts`:

```ts
export const rpcRouter = createRPCRouter({
  tasks: sessionCreateController,
  projects: projectController,
  // ...
});
```

**Rules:**
- Controller handlers are imported functions — keep logic in separate operation files, not inline
- Each controller becomes an RPC namespace (e.g., `rpc.sessionCreate.createSession(...)` on the renderer)
- New domains need their controller added to `apps/desktop/electron/session/main/rpc.ts`


## Service Pattern

For stateful concerns, use singleton classes:

```ts
export class AppService {
  private cache = new Map();

  async initialize() { /* ... */ }
  async doSomething(id: string) { /* ... */ }
}

export const appService = new AppService();
```

**Rules:**
- Module-level singleton export
- Initialization method called from `apps/desktop/electron/session/main/index.ts`
- Services hold long-lived state (caches, subscriptions, connections)

## Provider Pattern

For domain logic with multiple backends (local vs SSH):

```
apps/desktop/electron/session/main/core/projects/
├── project-provider.ts          # Interface
├── impl/
│   ├── local-project-provider.ts
│   └── _ssh-project-provider.ts  # Prefixed with _ = not yet implemented
└── project-manager.ts           # Orchestrates providers
```

Used in: projects, filesystem (`local-fs.ts` / `ssh-fs.ts`), terminals (`local-terminal-provider.ts` / `ssh-terminal-provider.ts`)

## Result Type (`apps/desktop/electron/session/main/lib/result.ts`)

Explicit error handling via discriminated union:

```ts
import { ok, err, type Result } from '../lib/result';

async function doSomething(): Promise<Result<Data, SomeError>> {
  if (problem) return err({ type: 'not_found' as const });
  return ok(data);
}
```

**Rules:**
- Prefer `Result<T, E>` over thrown exceptions for expected failure modes
- Controllers convert Result types to IPC-compatible responses

## Event System (`apps/desktop/electron/session/main/lib/events.ts`)

Topic-based event emitter for main ↔ renderer communication:

```ts
import { events } from '../lib/events';

// Emit to a specific topic (e.g., session ID)
events.emit(ptyDataChannel, buffer, sessionId);

// Listen on a specific topic
const unsub = events.on(ptyDataChannel, (data) => {...}, sessionId);
```

Channel naming: without topic → `eventName`, with topic → `eventName.{topic}`

Event type definitions live in `apps/desktop/src/session/shared/events/`.
