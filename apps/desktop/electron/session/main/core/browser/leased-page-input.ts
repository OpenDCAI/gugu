type Send = (method: string, params: Record<string, unknown>, sessionId?: string) => Promise<unknown>;
type Held = { method: string; params: Record<string, unknown>; sessionId?: string };

/** Mechanical teardown of controls dispatched by this page lease, without replaying any original intent. */
export class LeasedPageInput {
  private readonly held = new Map<string, Held>();
  private closing = false;
  sent(method: string, params: Record<string, unknown>, sessionId: string | undefined, native: Promise<unknown>): void {
    if (this.closing || !method.startsWith('Input.')) return;
    const prefix = `${sessionId ?? ''}:`;
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') {
      for (const [key, held] of this.held) if (key.startsWith(`${prefix}mouse:`)) {
        held.params.x = params.x; held.params.y = params.y;
      }
      return;
    }
    let key: string | undefined, release: Held | undefined, ending = false;
    if (method === 'Input.dispatchKeyEvent') {
      key = `${prefix}key:${String(params.code ?? params.windowsVirtualKeyCode ?? params.key)}`;
      if (params.type === 'keyDown' || params.type === 'rawKeyDown') {
        const up: Record<string, unknown> = { type: 'keyUp', modifiers: 0 };
        for (const field of ['key', 'code', 'windowsVirtualKeyCode', 'nativeVirtualKeyCode', 'location', 'isKeypad']) if (params[field] !== undefined) up[field] = params[field];
        release = { method, params: up, sessionId };
      } else ending = params.type === 'keyUp';
    } else if (method === 'Input.dispatchMouseEvent' && typeof params.button === 'string' && params.button !== 'none') {
      key = `${prefix}mouse:${params.button}`;
      if (params.type === 'mousePressed') release = { method, sessionId,
        params: { type: 'mouseReleased', button: params.button, buttons: 0, x: params.x, y: params.y, modifiers: 0, clickCount: 1 } };
      else ending = params.type === 'mouseReleased';
    } else if (method === 'Input.dispatchTouchEvent') {
      key = `${prefix}touch`;
      if (params.type === 'touchStart' || params.type === 'touchMove') release = { method, sessionId, params: { type: 'touchCancel', touchPoints: [], modifiers: 0 } };
      else ending = params.type === 'touchEnd' || params.type === 'touchCancel';
    } else if (method === 'Input.dispatchDragEvent') {
      key = `${prefix}drag`;
      if (params.type === 'dragEnter' || params.type === 'dragOver') release = { method, sessionId, params: { ...params, type: 'dragCancel', modifiers: 0 } };
      else ending = params.type === 'drop' || params.type === 'dragCancel';
    }
    if (!key) return;
    if (release) this.held.set(key, release); // Native dispatch happened, even if its result becomes uncertain.
    if (ending) {
      const previous = this.held.get(key), id = key;
      void native.then(() => { if (this.held.get(id) === previous) this.held.delete(id); }, () => {});
    }
  }
  async release(send: Send): Promise<void> {
    this.closing = true;
    const controls = [...this.held.values()]; this.held.clear();
    // They enter the same ordered native protocol after every already-dispatched down.
    const results = await Promise.allSettled(controls.map(control => send(control.method, control.params, control.sessionId)));
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Leased page input release failed');
  }
}
