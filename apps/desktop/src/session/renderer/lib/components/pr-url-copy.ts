import { messageForUser } from '@/lib/userFacingError';
import { log } from '@renderer/utils/logger';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';

export async function copyPrUrl(url: string): Promise<boolean> {
  try {
    await rpc.app.clipboardWriteText(url);

    toast({ title: 'PR URL copied' });
    return true;
  } catch (error) {
    log.error('clipboard copy failed', { error });
    toast({ title: messageForUser(error), variant: 'destructive' });
    return false;
  }
}
