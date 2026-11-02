import {
  acpApiContract,
  acpRuntimeApiContract,
  TERMINAL_CHUNK_CAPABILITY,
} from '@gugu/session-core/acp';
import type { Controller } from '@gugu/session-wire/api';

/** Select a presentation per subscription, keeping old clients on their existing bounded string format. */
export function withTerminalOutputNegotiation(
  controller: Controller,
  chunkedController: Controller = controller,
): Controller {
  const legacy = acpApiContract.session.states.terminals.id;
  const chunked = acpRuntimeApiContract.session.states.terminalChunks.id;
  return {
    ...controller,
    resolveLive(topic, capabilities) {
      const separator = topic.indexOf('|');
      const ref = separator < 0 ? topic : topic.slice(0, separator);
      const supportsChunks = capabilities?.includes(TERMINAL_CHUNK_CAPABILITY) === true;
      if (ref === chunked && !supportsChunks) return null;
      const selected =
        ref === legacy && supportsChunks ? chunked + topic.slice(legacy.length) : topic;
      return (selected === topic ? controller : chunkedController).resolveLive(
        selected,
        capabilities,
      );
    },
  };
}
