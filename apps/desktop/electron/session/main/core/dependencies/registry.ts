import {
  CORE_DEPENDENCIES,
  type DependencyDescriptor,
  buildDescriptorFromProvider,
  buildDescriptorsFromProvider,
} from '@gugu/session-core/deps/runtime';
import { pluginRegistry } from '@gugu/session-plugins/agents';

export { buildDescriptorFromProvider };

/** 一个插件可能是几行:主程序 + 伴随程序(#6335,见 `buildDescriptorsFromProvider`)。 */
function buildAgentDependencies(): DependencyDescriptor[] {
  return pluginRegistry.getAll().flatMap(buildDescriptorsFromProvider);
}

export const DEPENDENCIES: DependencyDescriptor[] = [
  ...CORE_DEPENDENCIES,
  ...buildAgentDependencies(),
];
export const AGENT_DEPENDENCIES = DEPENDENCIES.filter(
  (dependency) => dependency.category === 'agent'
);

export function getDependencyDescriptor(id: string): DependencyDescriptor | undefined {
  return DEPENDENCIES.find((d) => d.id === id);
}

