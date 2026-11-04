/** A PostgREST RPC is awaitable and can select columns before it is awaited. */
export function rpcQuery<Args extends unknown[], Result>(run: (...args: Args) => Result) {
  return (...args: Args) => {
    const result = Promise.resolve(run(...args));
    return Object.assign(result, { select: (_columns: string) => result });
  };
}
