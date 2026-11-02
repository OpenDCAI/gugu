let injected: (() => Promise<boolean>) | null = null;

/** The host owns the gate; importing it here would duplicate its cache across bundles. */
export function setSystemNotificationsUsable(next: () => Promise<boolean>): void {
  injected = next;
}

export function systemNotificationsUsable(): Promise<boolean> {
  if (!injected) throw new Error('system notification gate was never injected by the host');
  return injected();
}
