import { pluginRegistry } from '@gugu/session-plugins/agents';
import { bootAgentConfigRuntimeProcess } from '@gugu/session-runtime/agent-config/node';

bootAgentConfigRuntimeProcess({
  pluginRegistry,
});
