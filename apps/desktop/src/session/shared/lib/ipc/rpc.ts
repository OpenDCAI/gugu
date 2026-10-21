// @@@task-web-host — 注册器只认这个形状,不认 electron 的 IpcMain:宿主可能把请求从 WebSocket 接进来。
export type RpcIpcMainLike = {
  handle(
    channel: string,
    listener: (event: { sender: { id: number } }, ...args: unknown[]) => unknown
  ): void;
};

// oxlint-disable-next-line typescript/no-explicit-any
type ProcedureMap = Record<string, (...args: any[]) => unknown>;

const senderHandlerSymbol = Symbol.for('emdash.rpc.senderHandler');

type SenderAwareHandler<TArgs extends unknown[], TReturn> = ((...args: TArgs) => TReturn) & {
  [senderHandlerSymbol]: (senderId: number, ...args: TArgs) => TReturn;
};

export function withSender<TArgs extends unknown[], TReturn>(
  handler: (senderId: number, ...args: TArgs) => TReturn
): (...args: TArgs) => TReturn {
  const publicHandler = (() => {
    throw new Error('Sender-aware RPC handlers can only be invoked through IPC');
  }) as unknown as SenderAwareHandler<TArgs, TReturn>;
  Object.defineProperty(publicHandler, senderHandlerSymbol, {
    value: handler,
  });
  return publicHandler;
}

export function createRPCController<T extends ProcedureMap>(handlers: T): T {
  return handlers;
}

// Groups multiple controllers under a shared namespace prefix so they can be
// registered as rpc.<group>.<namespace>.<procedure>() at the next level up.
export function createRPCNamespace<T extends Record<string, ProcedureMap>>(controllers: T): T {
  return controllers;
}

// Accepts both flat controllers (ProcedureMap values) and namespace groups
// (Record<string, ProcedureMap> values) at the top level.
// oxlint-disable-next-line typescript/no-explicit-any
type RouterMap = Record<string, Record<string, any>>;

export function createRPCRouter<T extends RouterMap>(routers: T): T {
  return routers;
}

// Recursively walks the handler tree and registers every leaf function with
// ipcMain at its full dot-joined path (e.g. "git.commit", "git.worktree.commit").
function registerHandlers(ipcMain: RpcIpcMainLike, prefix: string, value: unknown): void {
  if (typeof value === 'function') {
    ipcMain.handle(prefix, (event, ...args: unknown[]) => {
      const senderHandler = (value as Partial<SenderAwareHandler<unknown[], unknown>>)[
        senderHandlerSymbol
      ];
      if (senderHandler) return senderHandler(event.sender.id, ...args);
      return (value as (...a: unknown[]) => unknown)(...args);
    });
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      registerHandlers(ipcMain, `${prefix}.${key}`, child);
    }
  }
}

export function registerRPCRouter(router: RouterMap, ipcMain: RpcIpcMainLike): void {
  for (const [ns, handlers] of Object.entries(router)) {
    registerHandlers(ipcMain, ns, handlers);
  }
}

// Recursively maps every leaf function to its async client equivalent.
// Non-function values recurse, so both 2-level (rpc.gitRepository.fetch) and
// 3-level (rpc.workspace.gitWorktree.commit) shapes are handled by a single type.
type IpcClient<R> = {
  [K in keyof R]: R[K] extends (...args: infer A) => infer Ret
    ? (...args: A) => Promise<Awaited<Ret>>
    : IpcClient<R[K]>;
};

// 客户端会被当成值传递(props、context、日志),React 开发版这类工具会反射读它:
// `.name` / `.toString()` / `Symbol.toPrimitive` / `toJSON` / `$$typeof`。这些键❌ 当成频道路径,
// 否则拿到的是又一个代理,转字符串时抛「Cannot convert object to primitive value」,整次提交中断。
// 路由里没有任何方法叫这些名字。
const NOT_A_CHANNEL = new Set(['then', 'toJSON', '$$typeof', 'asymmetricMatch', 'nodeType']);

function reflectiveKey(target: object, key: string | symbol): boolean {
  return typeof key !== 'string' || key in target;
}

// Returns a callable Proxy that accumulates the dot-joined channel path on each
// property access and calls invoke() when invoked as a function.
// Supports arbitrary nesting depth without any knowledge of the router shape.
function makeChannelProxy(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  parts: string[]
): unknown {
  return new Proxy(
    function (...args: unknown[]) {
      return invoke(parts.join('.'), ...args);
    },
    {
      get(target, key) {
        if (typeof key === 'string' && NOT_A_CHANNEL.has(key)) return undefined;
        if (reflectiveKey(target, key)) return Reflect.get(target, key);
        return makeChannelProxy(invoke, [...parts, key as string]);
      },
    }
  );
}

export function createRPCClient<Router extends RouterMap>(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
): IpcClient<Router> {
  return new Proxy(
    {},
    {
      get(target, ns) {
        if (typeof ns === 'string' && NOT_A_CHANNEL.has(ns)) return undefined;
        if (reflectiveKey(target, ns)) return Reflect.get(target, ns);
        return makeChannelProxy(invoke, [ns as string]);
      },
    }
  ) as IpcClient<Router>;
}
