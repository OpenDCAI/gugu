import type { ChatTranslator } from '../localization';
import type { ActivityActor, AgentActivityGroup } from './agent-activity';

export type ActivitySummaryPart = string | ActivityActor;
const distinct = (actors: readonly ActivityActor[]) => [...new Map(actors.map(actor => [actor.id, actor])).values()];

/** A compact action sentence, with independent real navigation targets rather than quoted message text. */
export function activitySummary(group: AgentActivityGroup, t: ChatTranslator, nameLimit = 2): ActivitySummaryPart[] {
  const received = group.events.filter(event => event.direction === 'received');
  const sent = group.events.filter(event => event.direction === 'sent');
  const pending = group.events.filter(event => event.direction === 'sending');
  const from = distinct(received.flatMap(event => event.actors));
  const to = distinct(sent.flatMap(event => event.actors));
  const groups = distinct(sent.flatMap(event => event.group ? [event.group] : []));
  const count = [...received, ...sent].reduce((sum, event) => sum + event.count, 0);
  const tokens: Record<string, ActivitySummaryPart[]> = {};
  const people = (key: string, actors: ActivityActor[], kind: 'agent' | 'group' | 'mixed' = 'agent') => {
    const names = actors.slice(0, nameLimit).flatMap((actor, index) => index ? [t('transcript.activitySeparator'), actor] : [actor]);
    // An unbound session can be another address of an already named agent. Keep the
    // message count, but do not claim a distinct person count before the host knows its owner.
    if (actors.length > nameLimit) names.push(t(kind === 'group' ? 'transcript.activityMoreGroups'
      : kind === 'mixed' || actors.some(actor => actor.id.startsWith('session:'))
        ? 'transcript.activityMoreDestinations' : 'transcript.activityMore', { count: actors.length }));
    tokens[key] = names;
    return `{${key}}`;
  };
  let text: string;
  if (!count) text = t('transcript.activitySending', { names: people('names', distinct(pending.flatMap(event => event.group ? [event.group] : event.actors))) });
  else if (!sent.length) text = t(count === 1 ? 'transcript.activityReceivedOne' : 'transcript.activityReceived', { names: people('names', from), count });
  else if (!received.length && groups.length && sent.every(event => event.group)) {
    text = t(count === 1 ? 'transcript.activityGroupSentOne' : 'transcript.activityGroupSent', { names: people('names', groups, 'group'), count });
  } else if (!received.length && !groups.length) text = t(count === 1 ? 'transcript.activitySentOne' : 'transcript.activitySent', { names: people('names', to), count });
  else {
    const direct = sent.filter(event => !event.group).flatMap(event => event.actors);
    text = t('transcript.activityExchanged', { names: people('names', distinct([...groups, ...direct, ...from]), groups.length ? 'mixed' : 'agent'), count });
  }
  return text.split(/(\{names\})/).flatMap(part => part === '{names}' ? tokens.names : [part]);
}

export const activitySummaryText = (parts: readonly ActivitySummaryPart[]) => parts.map(part => typeof part === 'string' ? part : part.name).join('');
