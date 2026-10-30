/** Coalesce a quiet burst, including events arriving during an asynchronous dependency check. */
export function previewReloadQueue(check: (paths?: string[]) => Promise<boolean>, reload: () => void, onError: (error: unknown) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let disposed = false;
  let pending = false;
  let resync = false;
  let dirty = false;
  const paths = new Set<string>();
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { void flush(); }, 200);
  }
  async function flush() {
    if (disposed || running) return;
    running = true;
    pending = false;
    const batch = resync ? undefined : [...paths];
    paths.clear();
    resync = false;
    try { dirty = await check(batch) || dirty; }
    catch (error) { if (!disposed) onError(error); }
    finally {
      running = false;
      if (!disposed) {
        if (pending) schedule();
        else if (dirty) { dirty = false; reload(); }
      }
    }
  }
  return {
    changed(changedPaths?: readonly string[]) {
      if (disposed) return;
      pending = true;
      if (!changedPaths) resync = true;
      else for (const path of changedPaths) paths.add(path);
      schedule();
    },
    dispose() { disposed = true; clearTimeout(timer); paths.clear(); },
  };
}
