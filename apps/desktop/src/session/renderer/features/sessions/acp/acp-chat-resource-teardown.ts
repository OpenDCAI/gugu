export interface RuntimeStoreLike {
  readonly isTransient: boolean;
  dispose(): void;
}

/**
 * Page teardown does not reliably run tab-provider disposal. Only runtime-only
 * stores may be stopped here; a durable source conversation must survive reload.
 */
export function disposeTransientStore(store: RuntimeStoreLike): void {
  if (store.isTransient) store.dispose();
}
