import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import type { ExtensionOrigin } from './upgrade';

/**
 * `gugu.cloud` (31): an App's own part of the cloud, as the person signed in. The host knows one rule and nothing of what any
 * App keeps there: an App calls `public.<its id>_*` and hears `gugu:<its id>:*`, and the database judges who may see and do
 * what. The id is what makes the part the App's own, so only an App whose id was reviewed where it was published has one:
 * the market's, or one shipped with gugu.
 */

const denied = (message: string) => Object.assign(new Error(message), { code: 'denied' as const });
const invalid = (message: string) => Object.assign(new Error(message), { code: 'invalid' as const });
const failed = (message: string) => Object.assign(new Error(message), { code: 'failed' as const });

const FUNCTION_NAME = /^[a-z0-9_]+$/;
const OWN_ID_ORIGINS: readonly (ExtensionOrigin | undefined)[] = ['market', 'preinstalled'];

/** Refused here when this App has no part of the cloud at all: a folder, a chat's bundle or a fork can name itself anything. */
function assertOwnId(app: CloudApp): void {
  if (!OWN_ID_ORIGINS.includes(app.origin)) throw denied(`gugu.cloud is for an App installed from the market; ${app.id} is not`);
}

export interface CloudApp { id: string; origin: ExtensionOrigin | undefined }

function functionOf(app: CloudApp, name: unknown): string {
  assertOwnId(app);
  if (typeof name !== 'string' || !FUNCTION_NAME.test(name)) throw invalid('Name a database function: lowercase letters, digits and _');
  const prefix = `${app.id.replaceAll('-', '_')}_`;
  if (!name.startsWith(prefix)) throw denied(`${app.id} may call only functions that start with ${prefix}`);
  return name;
}

function topicOf(app: CloudApp, topic: unknown): string {
  assertOwnId(app);
  const prefix = `gugu:${app.id}:`;
  if (typeof topic !== 'string' || !topic.startsWith(prefix) || topic.length === prefix.length) throw denied(`${app.id} may hear only topics that start with ${prefix}`);
  return topic;
}

/**
 * A private realtime channel as this host keeps one (signed in as the person, re-subscribed when it drops): `onSubscribed`
 * each time it is (re)subscribed. The desktop's main and the phone's page each have their own.
 */
export type CloudChannel = (
  topic: string,
  event: string,
  onPayload: (payload: Record<string, unknown>) => void,
  onSubscribed: () => void,
) => () => void;

export type CloudHeard = { subscribed: true } | { payload: Record<string, unknown> };

export function createAppCloud(platform: { account(): Promise<{ token: string }>; channel?: CloudChannel }) {
  async function client() {
    const { token } = await platform.account();
    return createGuguSupabaseClient({ schema: 'public', headers: { Authorization: `Bearer ${token}` } });
  }
  const answer = (result: { data: unknown; error: { message: string } | null }) => {
    // The database's reason word is the message: the App says it in its own words.
    if (result.error) throw failed(result.error.message);
    return result.data;
  };
  return {
    /** Over GET: PostgREST runs it in a read-only transaction, so a read cannot write whatever the function is. */
    async read(app: CloudApp, name: unknown, args: Record<string, unknown> = {}): Promise<unknown> {
      const fn = functionOf(app, name);
      // A query string has no null: an argument left out is the function's default.
      const given = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null && value !== undefined));
      return answer(await (await client()).rpc(fn, given, { get: true }));
    },
    async write(app: CloudApp, name: unknown, args: Record<string, unknown> = {}): Promise<unknown> {
      return answer(await (await client()).rpc(functionOf(app, name), args));
    },
    /** One event of one topic. Every (re)subscription says `subscribed`: a broadcast missed while away is not kept anywhere. */
    watch(app: CloudApp, topic: unknown, event: unknown, onHeard: (heard: CloudHeard) => void): () => void {
      const name = topicOf(app, topic);
      if (typeof event !== 'string' || !event) throw invalid('Name the event to hear');
      if (!platform.channel) throw failed('This host has no realtime channel');
      return platform.channel(name, event, (payload) => onHeard({ payload }), () => onHeard({ subscribed: true }));
    },
  };
}

export type AppCloud = ReturnType<typeof createAppCloud>;
