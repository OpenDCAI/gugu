import type { TurnFileRef } from '@gugu/session-core/session-record/contract';

type ComposerSendPort = {
  started?(): void;
  unsettled(): boolean;
  waitForUploads(): Promise<void>;
  hasFailedAttachments(): boolean;
  files(): TurnFileRef[];
  status(value: 'waiting' | 'blocked' | null): void;
  deliver(text: string, files: TurnFileRef[]): void | Promise<void>;
  committed(): void;
};

/** The editor keeps custody of its live draft until persistence succeeds; failures never rewrite it. */
export async function sendComposerInput(value: string, port: ComposerSendPort): Promise<void> {
  if (value.trim() || port.unsettled() || port.files().length) port.started?.();
  if (port.unsettled()) {
    port.status('waiting');
    await port.waitForUploads();
  }
  const failed = port.unsettled() || port.hasFailedAttachments();
  port.status(failed ? 'blocked' : null);
  if (failed) return;
  const files = port.files();
  const text = value.trim();
  if (!text && files.length === 0) return;
  try { await port.deliver(text, files); } catch { return; }
  port.committed();
}
