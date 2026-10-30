import type { WebContents, WebContentsDidStartNavigationEventParams } from 'electron';
import { isSupportedBrowserNavigationUrl } from './browser-navigation';

type Navigation = { unsafeLoading(): boolean };
const navigation = new WeakMap<WebContents, Navigation>();

/** Installed when contents are created, before a future protocol lease can miss a start event. */
export function trackPageNavigation(contents: WebContents): Navigation {
  const existing = navigation.get(contents);
  if (existing) return existing;
  // A late observer cannot infer an in-flight destination from the last committed URL.
  let destination: string | null | undefined = contents.isLoading() ? null : undefined;
  const started = (event: WebContentsDidStartNavigationEventParams) => {
    if (event.isMainFrame) destination = event.url;
  };
  const redirected = (_event: unknown, url: string, _inPlace: boolean, main: boolean) => {
    if (main) destination = url;
  };
  const committed = () => { destination = undefined; };
  const stopped = () => { if (!contents.isLoading()) destination = undefined; };
  const destroyed = () => {
    contents.removeListener('did-start-navigation', started);
    contents.removeListener('did-redirect-navigation', redirected);
    contents.removeListener('did-navigate', committed);
    contents.removeListener('did-stop-loading', stopped);
    navigation.delete(contents);
  };
  const state = { unsafeLoading: () => contents.isLoading() && destination !== undefined
    && (destination === null || !isSupportedBrowserNavigationUrl(destination)) };
  navigation.set(contents, state);
  contents.on('did-start-navigation', started);
  contents.on('did-redirect-navigation', redirected);
  contents.on('did-navigate', committed);
  contents.on('did-stop-loading', stopped);
  contents.once('destroyed', destroyed);
  return state;
}
