import { useEffect } from 'react';
import { commandRegistry } from './registry';
import type { CommandProvider } from './types';

/** Component-owned handlers live for exactly as long as their surface. */
export function useCommandProvider(provider: CommandProvider): void {
  useEffect(() => commandRegistry.register(provider), [provider]);
}
