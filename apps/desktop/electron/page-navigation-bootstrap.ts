import { app, webContents } from 'electron';
import { trackPageNavigation } from './session/main/core/browser/page-navigation-tracker';

// Observe destinations before a page loads, including before any App requests a lease.
app.on('web-contents-created', (_event, contents) => { trackPageNavigation(contents); });
for (const contents of webContents.getAllWebContents()) trackPageNavigation(contents);
