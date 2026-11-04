import type { MoveDeps, MoveJournal } from './assistant-move';

export type MoveJournalStorage = {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  clear(): Promise<void>;
};

export function parseMoveJournal(raw: string): MoveJournal {
  const value = JSON.parse(raw) as MoveJournal;
  if (!value || !['to-cloud', 'to-computer'].includes(value.direction) || typeof value.assistantId !== 'string'
    || !Number.isFinite(value.startedAt) || !Array.isArray(value.done)
    || !(value.schedules === null || Array.isArray(value.schedules))
    || (value.source !== null && (!value.source || !['cloud', 'computer'].includes(value.source.kind) || typeof value.source.deviceId !== 'string'))) {
    throw new Error('The move recovery record is invalid');
  }
  return value;
}

/** localStorage is a UI cache; native storage is the recovery authority. */
export async function durableMoveJournal(cache: MoveDeps['journal'], storage: MoveJournalStorage): Promise<MoveDeps['journal']> {
  const raw = await storage.read();
  let current = raw === null ? cache.load() : parseMoveJournal(raw);
  if (current) await cache.save(current);
  return {
    load: () => current,
    async save(value) {
      const serialized = JSON.stringify(value);
      await storage.write(serialized);
      if (await storage.read() !== serialized) throw new Error('The move recovery record could not be verified');
      current = parseMoveJournal(serialized);
      await cache.save(current);
    },
    async clear() {
      await storage.clear();
      current = null;
      await cache.clear();
    },
  };
}
