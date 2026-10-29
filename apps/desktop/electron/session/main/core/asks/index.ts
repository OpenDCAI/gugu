/**
 * Ask: one question that stops an agent until a person answers.
 * Its session timeline owns the Settlement. Desktop/phone cards, installation sheets,
 * browser cards, Needs you and attention dots are views, never independent queues.
 * Host sources call ask(); runtime sources synchronize into that same timeline.
 * Register every source in sources.ts. respond() keeps the existing first-answer-wins
 * settlement and runtime delivery; the host handler lives in ask.ts.
 * This module owns deadlines, cancellation and archive withdrawal. Callers keep no clock.
 * Device needs_confirmation results and social invitations stay outside Ask.
 */
export { ask, withdrawAll, type AskAnswer, type AskResult } from './ask';
export { respond } from '../session-timeline/service';
