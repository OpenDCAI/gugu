import { ReplicaState } from '@gugu/session-wire';
import { transcriptTurnSchema, type TranscriptTurn } from '@gugu/session-core/acp';
import { replySource } from '@gugu/session-core/session-record/reply-process';
import { parseConversationLink } from '@gugu/core/shared/ui/guguLink';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { peekAcpRuntimeClient } from '../acp/controller';

/** A host-observed current input, never a guess from cached history or the last work on a reused agent. */
export function activitySourceOf(turn: TranscriptTurn | null): string | undefined {
  if (!turn || turn.outcome || turn.endedAt !== undefined) return undefined;
  if (turn.items.filter(item => item.kind === 'message' && item.role === 'user').length !== 1) return undefined;
  const facts = replySource(turn);
  const link = facts?.sourceLink ? parseConversationLink(facts.sourceLink) : null;
  return link?.messageId && link.messageId === facts?.messageId?.replace(/^msg:/, '').toLowerCase() ? facts?.sourceLink : undefined;
}

export async function readCurrentActivitySource(sessionId: string): Promise<string | undefined> {
  return (await readCurrentActivityInput(sessionId))?.source_link;
}

/** Bounded original input, observed from the active turn rather than a tool's repeated instructions. */
export function activityInputOf(turn: TranscriptTurn | null): { source_link: string; source_message_id: string; source_summary: string } | undefined {
  const source = activitySourceOf(turn);
  if (!source || !turn) return undefined;
  const input = turn.items.find(item => item.kind === 'message' && item.role === 'user');
  if (input?.kind !== 'message') return undefined;
  const body = readDeliveryEnvelope(input.text)?.body ?? '';
  const characters = Array.from(body.replace(/\s+/g, ' ').trim());
  return { source_link: source, source_message_id: parseConversationLink(source)!.messageId!,
    source_summary: characters.slice(0, 200).join('') + (characters.length > 200 ? '…' : '') };
}

export async function readCurrentActivityInput(sessionId: string): Promise<ReturnType<typeof activityInputOf>> {
  const client = await peekAcpRuntimeClient();
  if (!client) return undefined;
  const replica = new ReplicaState<TranscriptTurn | null>(client.session.state({ sessionId }, 'activeTurn'), { schema: transcriptTurnSchema.nullable() });
  try {
    await replica.ready;
    return activityInputOf(replica.current());
  } finally { await replica.dispose(); }
}

export function currentAssistantWorkInput(turn:TranscriptTurn|null):string|undefined {
  if(!turn||turn.outcome||turn.endedAt!==undefined)return undefined
  const inputs=turn.items.filter(item=>item.kind==='message'&&item.role==='user')
  return inputs.length===1&&inputs[0].kind==='message'?inputs[0].text:undefined
}

const ASSISTANT_WORK_INPUT_TIMEOUT_MS=5_000

/** Same active-turn replica as source attribution; never guess from a reused session's last job.
 * Every session_message passes here, pty included: a session the ACP runtime does not hold has no active
 * turn to bind (NOT_FOUND = no input), and a stalled runtime fails this send loudly instead of hanging it. */
export async function readCurrentAssistantWorkInput(sessionId:string,timeoutMs=ASSISTANT_WORK_INPUT_TIMEOUT_MS):Promise<string|undefined> {
  const client=await peekAcpRuntimeClient()
  if(!client)return undefined
  const replica=new ReplicaState<TranscriptTurn|null>(client.session.state({sessionId},'activeTurn'),{schema:transcriptTurnSchema.nullable()})
  let timer:ReturnType<typeof setTimeout>|undefined
  try {
    await Promise.race([replica.ready,new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new Error(`The current turn of ${sessionId} could not be read within ${timeoutMs}ms`)),timeoutMs)
    })])
    return currentAssistantWorkInput(replica.current())
  } catch(error) {
    if((error as {code?:unknown}|null)?.code==='NOT_FOUND')return undefined
    throw error
  } finally {clearTimeout(timer);await replica.dispose()}
}
