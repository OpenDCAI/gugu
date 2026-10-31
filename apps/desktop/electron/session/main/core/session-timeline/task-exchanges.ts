import { and, eq, gt, sql, inArray } from 'drizzle-orm';
import { db } from '@main/db/client';
import { messages, sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { taskExchangeFromRow, type TaskExchangePage, type TaskExchangeRequest } from '@shared/core/sessions/task-collaboration';

const PAGE_SIZE = 200;
const watchers = new Map<string, { request: TaskExchangeRequest; changed: () => void }>();

/** Reads only the named recipient's durable inbox, then filters the exact sender. No provider startup. */
export function readTaskExchanges(request: TaskExchangeRequest): TaskExchangePage {
  if (!request.conversationId || !request.fromSessionId || !Number.isSafeInteger(request.after ?? 0) || (request.after ?? 0) < 0) {
    throw new Error('Invalid task exchange address or cursor');
  }
  if (!db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, request.conversationId)).get()) {
    throw new Error('Task exchange recipient session is missing');
  }
  const position = sql<number>`${messages}.rowid`;
  const rows = db.select({ id: messages.id, position, sessionId: messages.sessionId, content: messages.content, timestamp: messages.timestamp, metadata: messages.metadata })
    .from(messages).where(and(eq(messages.sessionId, request.conversationId), gt(position, request.after ?? 0)))
    .orderBy(position).limit(PAGE_SIZE).all();
  return {
    entries: rows.flatMap((row) => { const entry = taskExchangeFromRow(row, request.fromSessionId); return entry ? [entry] : []; }),
    cursor: rows.at(-1)?.position ?? request.after ?? 0,
    hasMore: rows.length === PAGE_SIZE,
  };
}

export function watchTaskExchanges(id: string, request: TaskExchangeRequest, changed: () => void): void {
  watchers.set(id, { request, changed });
}
export function unwatchTaskExchanges(id: string): void { watchers.delete(id); }
/** Called after the accepted receipt is committed, including native startup delegations. */
export function taskExchangeRecorded(conversationId: string): void {
  for (const watcher of watchers.values()) {
    if (watcher.request.conversationId !== conversationId) continue;
    try { watcher.changed(); } catch (error) { log.warn('Task exchange projection failed after delivery was committed', { conversationId, error: String(error) }); }
  }
}


/** A host-only migration reader. It never starts providers or serves a panel request. */
export function readAssistantWorkReceipts(after=0,retry:number[]=[]) {
  if(!Number.isSafeInteger(after)||after<0||retry.length>32||retry.some(value=>!Number.isSafeInteger(value)||value<=0)) throw new Error('Invalid historical receipt cursor')
  const position=sql<number>`${messages}.rowid`
  const read=()=>db.select({id:messages.id,position,sessionId:messages.sessionId,content:messages.content,timestamp:messages.timestamp,
    metadata:messages.metadata,title:sessions.title,config:sessions.config,spawnedBySessionId:sessions.spawnedBySessionId})
    .from(messages).innerJoin(sessions,eq(sessions.id,messages.sessionId))
  const kind=sql`CASE WHEN json_valid(${messages.metadata}) THEN json_extract(${messages.metadata}, '$.kind') END = 'session-direct'`
  const scanned=read().where(and(kind,gt(position,after))).orderBy(position).limit(PAGE_SIZE).all()
  const rows=[...(retry.length?read().where(and(kind,inArray(position,retry))).all():[]),...scanned]
  const tail=db.select({position:sql<number>`coalesce(max(${position}), 0)`}).from(messages).get()?.position??after
  const cursor=scanned.length===PAGE_SIZE?(scanned.at(-1)?.position??after):Math.max(after,tail)
  const pending:number[]=[]
  return {entries:rows.flatMap(({metadata,config,...row})=>{
    try {
      const receipt=JSON.parse(metadata??'null')
      if(receipt?.state==='queued')pending.push(row.position)
      return receipt?.kind==='session-direct' && receipt.state==='accepted' ? [{...row,spawnedByRemote:config?.spawnedByRemote??null}] : []
    }catch{return []}
  }),cursor,hasMore:scanned.length===PAGE_SIZE,pending}
}
