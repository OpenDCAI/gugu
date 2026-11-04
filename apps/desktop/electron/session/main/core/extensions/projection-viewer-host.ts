import { log } from '@main/lib/logger';
import { ExtensionProjectionViewers } from './extension-projection-viewers';
import { openProjectionViewer } from './projection-viewer-provider';
import { extensionsService } from './extensions-root';

export const extensionProjectionViewers = new ExtensionProjectionViewers(extensionId => {
  const service = extensionsService(); service.get(extensionId);
  if (!service.isEnabled(extensionId) || !service.hasCapability(extensionId, 'agents:tools')) throw new Error('App projection access was revoked');
}, openProjectionViewer, error => log.warn('App projection viewer cleanup failed', { error: String(error) }));
