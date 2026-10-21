import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'

import { useState, type ReactNode } from 'react';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import { DialogContentArea, DialogFooter } from '@renderer/lib/ui/dialog';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useIntegrationsContext } from './integrations-provider';
import type { IntegrationFormInput } from './types';

export type SetupFormProps = {
  onSuccess: () => void;
  onClose: () => void;
};

type SetupFormShellProps = {
  providerId: string;
  /** #7240「编辑凭据」:改的是哪个已存账号。 */
  editAccountId?: string;
  getInput: () => IntegrationFormInput;
  canSubmit: boolean;
  onSuccess: () => void;
  onClose: () => void;
  children: ReactNode;
};

export function SetupFormShell({
  providerId,
  editAccountId,
  getInput,
  canSubmit,
  onSuccess,
  onClose,
  children,
}: SetupFormShellProps) {
  const { connectIntegration, isIntegrationMutating } = useIntegrationsContext();
  const { toast } = useToast();
  const { translate } = useSessionMessages();
  const [error, setError] = useState<string | null>(null);
  const isMutating = isIntegrationMutating(providerId);

  const handleSubmit = async () => {
    setError(null);

    try {
      const result = await connectIntegration(providerId, getInput(), editAccountId);
      if (!result.success) {
        setError(result.error);
        return;
      }

      toast({
        title: translate('integrations.connectedToast'),
        description: translate('integrations.connectedToastDescription'),
      });
      onSuccess();
    } catch (e) {
      // @@@raw detail — provider 返回的失败原因原样展示,缺失时才用本地化外壳。
      setError(e instanceof Error ? e.message : translate('integrations.connectFailed'));
    }
  };

  return (
    <>
      <DialogContentArea className="pt-1">
        {children}
        {error ? (
          <p className="text-xs text-foreground-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {translate('common.cancel')}
        </Button>
        {/* 「授权配置」:「保存并连接」→「正在验证…」(连上之前要真去对方那边核一遍)。 */}
        <ConfirmButton onClick={() => void handleSubmit()} disabled={!canSubmit || isMutating}>
          {isMutating && <LoadingIndicator size="inline" className="mr-2" />}
          {isMutating ? translate('integrations.credentialsVerifying') : translate('integrations.credentialsSubmit')}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}
