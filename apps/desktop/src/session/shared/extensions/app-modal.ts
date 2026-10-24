import { z } from 'zod';
import { bundlePathSchema } from './manifest';

/** A page of the installed App, under the same sandbox and grants as its opener. */
export const appModalOptionsSchema = z.strictObject({
  id: z.string().min(1),
  entry: bundlePathSchema.refine((entry) => !/[?#:%]/.test(entry), 'entry must name a bundle file'),
  title: z.string().trim().min(1),
  size: z.enum(['xs', 'sm', 'md', 'lg', 'xl']).default('md'),
  data: z.unknown().optional(),
});
export type AppModalOptions = z.infer<typeof appModalOptionsSchema>;
export type AppModalFocus = 'first' | 'last';
export interface AppModalPage {
  id: string;
  extensionId: string;
  appName: string;
  title: string;
  size: AppModalOptions['size'];
  entryUrl: string;
  partition: string;
}

/** Shell replies over the existing App bridge; never exposed on window.gugu. */
export type AppModalHostAction = { id: string } & (
  | { type: 'bind'; webContentsId: number }
  | { type: 'dismiss'; error?: string }
  | { type: 'focus'; edge: AppModalFocus }
);

interface AppModalOutcome { result: unknown; error?: string }
export interface AppModalSession<T> {
  id: string;
  opener: number;
  child: number | null;
  binding: T;
  options: AppModalOptions;
  outcome: Promise<AppModalOutcome>;
  settle(outcome: AppModalOutcome): void;
}

/** Shared lifetime of modal pages on desktop and phone; the adapters own transport and presentation. */
export class AppModalSessions<T> {
  private readonly sessions = new Map<string, AppModalSession<T>>();

  constructor(private readonly finished: (session: AppModalSession<T>, result: unknown, error?: string) => void | Promise<void>) {}

  open(opener: number, binding: T, args: unknown): AppModalSession<T> {
    const parsed = appModalOptionsSchema.safeParse(args);
    if (!parsed.success) throw Object.assign(new Error(parsed.error.message), { code: 'invalid' });
    if (this.sessions.has(parsed.data.id)) throw Object.assign(new Error('This modal is already open'), { code: 'invalid' });
    let settle!: (outcome: AppModalOutcome) => void;
    const outcome = new Promise<AppModalOutcome>((resolve) => { settle = resolve; });
    const session = { id: parsed.data.id, opener, binding, options: parsed.data, child: null, outcome, settle };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): AppModalSession<T> {
    const session = this.sessions.get(id);
    if (!session) throw Object.assign(new Error('This App modal is no longer open'), { code: 'not-found' });
    return session;
  }

  forPage(page: number): AppModalSession<T> {
    for (const session of this.sessions.values()) if (session.child === page) return session;
    throw Object.assign(new Error('Only a modal page can close its modal'), { code: 'invalid' });
  }

  bind(id: string, child: number): AppModalSession<T> {
    const session = this.get(id);
    if (session.opener === child || (session.child !== null && session.child !== child)) {
      throw Object.assign(new Error('This modal already has its content page'), { code: 'invalid' });
    }
    session.child = child;
    return session;
  }

  async close(id: string, result: unknown = null, error?: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    if (session.child !== null) await this.pageGone(session.child);
    try { await this.finished(session, result, error); }
    finally { session.settle({ result, ...(error ? { error } : {}) }); }
  }

  async result(session: AppModalSession<T>): Promise<unknown> {
    const outcome = await session.outcome;
    if (outcome.error) throw Object.assign(new Error(outcome.error), { code: 'failed' });
    return outcome.result;
  }

  async pageGone(page: number): Promise<void> {
    const closing = [...this.sessions.values()].filter((session) => session.opener === page || session.child === page);
    await Promise.all(closing.map((session) => this.close(session.id)));
  }
}
