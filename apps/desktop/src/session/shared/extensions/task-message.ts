export type TaskMessageIntent = 'pause' | 'continue';

/** A fixed conversation shortcut, never an arbitrary message or a selected target. */
export function taskMessageIntent(args: Record<string, unknown>): TaskMessageIntent {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 || !Object.hasOwn(args, 'intent')
    || args.intent !== 'pause' && args.intent !== 'continue') {
    throw Object.assign(new Error('A task message accepts only intent: pause or continue'), { code: 'invalid' });
  }
  return args.intent;
}

/** Host-owned words; Apps choose an intent but cannot supply text. */
export function taskMessageText(intent: TaskMessageIntent, locale: string): string {
  return locale.toLowerCase().startsWith('zh')
    ? intent === 'pause' ? '请暂停。' : '请继续。'
    : intent === 'pause' ? 'Please pause.' : 'Please continue.';
}
