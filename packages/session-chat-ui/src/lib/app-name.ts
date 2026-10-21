/**
 * An App's name as the person reads it, by its id — for a delivery an App sent ("from App X"). The envelope carries
 * the id (agents call tools with it); the host names it from what it has installed, in the interface language. `null`
 * = the host does not have that App: the card shows the id.
 */
import { createContext, useContext } from 'solid-js';

const AppNameContext = createContext<(appId: string) => string | null>(() => null);

export const AppNameProvider = AppNameContext.Provider;

/** Reactive accessor; returns `null` when the host declared no resolver. */
export function useAppName(): (appId: string) => string | null {
  return useContext(AppNameContext);
}
