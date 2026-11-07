import { useLibraryHost } from '@renderer/features/library/library-host'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'

import { useEffect,useRef,useState, type ReactNode } from 'react';
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
  validationMessage: string;
  onSuccess: () => void;
  onClose: () => void;
  children: ReactNode;
};

export function SetupFormShell({
  providerId,
  editAccountId,
  getInput,
  canSubmit,
  validationMessage,
  onSuccess,
  onClose,
  children,
}: SetupFormShellProps) {
  const host = useLibraryHost();
  const { connectIntegration, isIntegrationMutating,cancelIntegrationAuthorization } = useIntegrationsContext();
  const { toast } = useToast();
  const { translate } = useSessionMessages();
  const [error, setError] = useState<string | null>(null);
  const isMutating = isIntegrationMutating(providerId);
  const submitting = useRef(false),mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (submitting.current && host.connectionMetadata?.verificationProtocol === 2) cancelIntegrationAuthorization(providerId);
    };
  },[host.connectionMetadata?.verificationProtocol,providerId,cancelIntegrationAuthorization]);

  const handleSubmit = async () => {
    if (isMutating) return;
    if (!canSubmit) { setError(validationMessage); return; }
    setError(null);
    submitting.current = true;

    try {
      const result = await connectIntegration(providerId, getInput(), editAccountId);
      if (!mounted.current) return;
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
      if (!mounted.current) return;
      // @@@raw detail — provider 返回的失败原因原样展示,缺失时才用本地化外壳。
      setError(e instanceof Error ? e.message : translate('integrations.connectFailed'));
    } finally { submitting.current = false; }
  };

  return (
    <>
      <DialogContentArea className="pt-1">
        {children}
        {error && (!host.connectionMetadataExpected || error === validationMessage) ? (
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
        <ConfirmButton onClick={() => void handleSubmit()} disabled={isMutating}>
          {isMutating && <LoadingIndicator size="inline" className="mr-2" />}
          {isMutating ? translate('integrations.credentialsVerifying') : translate('integrations.credentialsSubmit')}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}
