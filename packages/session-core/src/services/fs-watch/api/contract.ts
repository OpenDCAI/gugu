import { defineContract, eventStream, procedure } from '@gugu/session-wire/api';
import { z } from 'zod';

export const watchKeySchema = z.object({
  root: z.string(),
  ignore: z.array(z.string()),
  recursive: z.boolean(),
  coarse: z.boolean(),
});

export const watchEventSchema = z.object({
  kind: z.enum(['create', 'update', 'delete']),
  path: z.string(),
});

export const watchEventsBatchSchema = z.object({
  kind: z.literal('events'),
  events: z.array(watchEventSchema),
});

export const watchResyncSchema = z.object({
  kind: z.literal('resync'),
});

export const watchReadySchema = z.object({
  kind: z.literal('ready'),
});

export const watchErrorSchema = z.object({
  kind: z.literal('error'),
  message: z.string(),
});

export const fsWatchContract = defineContract({
  events: eventStream({
    key: watchKeySchema,
    event: z.union([watchEventsBatchSchema, watchResyncSchema, watchReadySchema, watchErrorSchema]),
  }),
  /** 「下面可能变过」:按目录粒度兑现整棵树的订阅收一次 resync(见 WatchBackend.nudge)。不给 root = 全部。 */
  nudge: procedure({ input: z.object({ root: z.string().optional() }), output: z.boolean() }),
});

export type FsWatchKey = z.infer<typeof watchKeySchema>;
export type FsWatchEvent = z.infer<typeof watchEventSchema>;
export type FsWatchStreamEvent =
  | z.infer<typeof watchEventsBatchSchema>
  | z.infer<typeof watchResyncSchema>
  | z.infer<typeof watchReadySchema>
  | z.infer<typeof watchErrorSchema>;
