import crypto from 'node:crypto';

export function computeWorkspaceKey(absolutePath: string): string {
  return crypto.createHash('sha256').update(`local:${absolutePath}`).digest('hex');
}
