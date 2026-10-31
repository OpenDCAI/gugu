import { platform } from '@/platform';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { messageForUser } from '@/lib/userFacingError';
import { AlertCircle, Check, Copy, ExternalLink } from '@/lib/icons'
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { LibraryHostScope } from '@renderer/features/library/library-host-scope';
import { useLibraryHost, type LibraryHost } from '@renderer/features/library/library-host';
import { rpc } from '@renderer/lib/ipc';
import { openShellFeedback } from '@renderer/lib/open-shell-feedback';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { useGithubContext } from '@renderer/lib/providers/github-context-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { log } from '@renderer/utils/logger';
import {
  githubAuthDeviceCodeChannel,
  githubAuthErrorChannel,
  githubAuthSuccessChannel,
} from '@shared/events/githubEvents';
import type { GitHubUser } from '@shared/github';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';

export type GithubDeviceFlowModalArgs = {
  onError?: (error: string) => void;
  /**
   * 资源库看的是别的机器时(#6264):设备码在那台机器上申请、登录结果存在那台机器上;
   * 设备码 / 成功 / 失败三条事件由那台机器在这次登录进行中转过来。不给 = 本机。
   */
  host?: LibraryHost;
};

type GithubDeviceFlowModalProps = BaseModalProps<void> & GithubDeviceFlowModalArgs;

export function GithubDeviceFlowModal({ host, ...props }: GithubDeviceFlowModalProps) {
  return (
    <LibraryHostScope host={host}>
      <GithubDeviceFlowModalBody {...props} />
    </LibraryHostScope>
  );
}

function GithubDeviceFlowModalBody({ onSuccess, onClose, onError }: Omit<GithubDeviceFlowModalProps, 'host'>) {
  const { toast } = useToast();
  const { cancelGithubConnect: cancelLocal } = useGithubContext();
  const library = useLibraryHost();
  const events = library.github;
  const cancelGithubConnect = useCallback(() => {
    if (library.remote) void library.github.authCancel();
    else cancelLocal();
  }, [library, cancelLocal]);

  // Presentational state - updated via IPC events from main process
  const [userCode, setUserCode] = useState<string>('');
  const [verificationUri, setVerificationUri] = useState<string>('');
  const [timeRemaining, setTimeRemaining] = useState<number>(900);
  const [copied, setCopied] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [browserOpening, setBrowserOpening] = useState(false);
  const [browserOpenCountdown, setBrowserOpenCountdown] = useState(3);

  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const hasAutocopied = useRef(false);
  const hasOpenedBrowser = useRef(false);
  const authSucceededRef = useRef(false);

  // Cancel the auth flow if the modal is dismissed before auth completes
  useEffect(() => {
    return () => {
      if (!authSucceededRef.current) {
        cancelGithubConnect();
      }
    };
  }, [cancelGithubConnect]);

  // Countdown timer for code expiration
  useEffect(() => {
    if (success || error) return;

    countdownIntervalRef.current = setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev <= 1) {
          setError('Code expired. Please try again.');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
    };
  }, [success, error]);

  // Reset state on mount (new auth flow)
  useEffect(() => {
    setSuccess(false);
    setError(null);
    setUser(null);
    setCopied(false);
    hasAutocopied.current = false;
    hasOpenedBrowser.current = false;
  }, []);

  const copyToClipboard = useCallback(
    async (code: string, isAutomatic = false) => {
      try {
        await platform.writeClipboardText(code);

        setCopied(true);

        if (!isAutomatic) {
          toast({
            title: '✓ Code copied',
            description: 'Paste it in GitHub to authorize',
          });
        }

        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        log.error('Failed to copy:', err);
        if (!isAutomatic) {
          toast({
            title: translateSessionMessage('task.copyFailed'),
            description: messageForUser(err),
            variant: 'destructive',
          });
        }
      }
    },
    [toast]
  );

  const openGitHub = useCallback(() => {
    if (verificationUri) {
      void rpc.app.openExternal(verificationUri);
    }
  }, [verificationUri]);

  // Subscribe to auth events from main process
  useEffect(() => {
    // Device code received - display to user
    const cleanupDeviceCode = events.onEvent(githubAuthDeviceCodeChannel, (data) => {
      setUserCode(data.userCode);
      setVerificationUri(data.verificationUri);
      setTimeRemaining(data.expiresIn);

      // Auto-copy code
      if (!hasAutocopied.current) {
        hasAutocopied.current = true;
        void copyToClipboard(data.userCode, true);

        // Show countdown and open browser after 3 seconds
        setBrowserOpening(true);
        let countdown = 3;
        const countdownTimer = setInterval(() => {
          countdown--;
          setBrowserOpenCountdown(countdown);
          if (countdown <= 0) {
            clearInterval(countdownTimer);
          }
        }, 1000);

        setTimeout(() => {
          setBrowserOpening(false);
          if (!hasOpenedBrowser.current) {
            hasOpenedBrowser.current = true;
            void rpc.app.openExternal(data.verificationUri);
          }
        }, 3000);
      }
    });

    // Auth successful
    const cleanupSuccess = events.onEvent(githubAuthSuccessChannel, (data) => {
      authSucceededRef.current = true;
      setSuccess(true);
      setUser(data.user);

      // Auto-close after showing success animation
      setTimeout(() => {
        onSuccess();
      }, 1000); // 1 second is enough to see success
    });

    // Auth error
    const cleanupError = events.onEvent(githubAuthErrorChannel, (data) => {
      setError(messageForUser(data.message || data.error));

      if (onError) {
        onError(data.error);
      }

      toast({
        title: translateSessionMessage('github.authFailed'),
        description: messageForUser(data.message || data.error),
        variant: 'destructive',
      });
    });

    // Cleanup listeners on unmount
    return () => {
      cleanupDeviceCode();
      cleanupSuccess();
      cleanupError();
    };
  }, [copyToClipboard, events, onError, onSuccess, toast]);

  const handleClose = () => {
    onClose();
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Keyboard shortcuts (Escape is handled by DialogContent's onEscapeKeyDown)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
        e.preventDefault();
        void copyToClipboard(userCode);
      } else if (e.key === 'Enter') {
        openGitHub();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
        e.preventDefault();
        openGitHub();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [copyToClipboard, openGitHub, userCode]);

  const title = success ? 'GitHub connected' : error ? 'Authentication failed' : 'Authorize GitHub';

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="gap-4">
        {success ? (
          <div className="rounded-lg border border-border/60 bg-background/60 p-3">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background-success">
                <Check className="h-4 w-4 text-foreground-success" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">You're connected to GitHub</p>
                {user ? (
                  <div className="mt-1 flex min-w-0 items-center gap-2">
                    {user.avatar_url ? (
                      <img
                        src={user.avatar_url}
                        alt={user.name || user.login}
                        className="h-5 w-5 shrink-0 rounded-full"
                      />
                    ) : null}
                    <p className="text-foreground-muted truncate text-xs">@{user.login}</p>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : error ? (
          <div className="rounded-lg border border-border-destructive bg-background-destructive p-3">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-foreground-destructive" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground-destructive">
                  GitHub authorization failed
                </p>
                <p className="mt-1 text-xs text-foreground-destructive/80">{error}</p>
              </div>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-foreground-muted">
              Enter this one-time code in GitHub to authorize gugu.
            </p>

            <button
              type="button"
              onClick={() => copyToClipboard(userCode)}
              disabled={!userCode}
              className="rounded-lg border border-border bg-background/60 p-4 text-left transition-colors hover:border-border-1 hover:bg-row-hover active:bg-row-press disabled:pointer-events-none"
              aria-label={copied ? 'Code copied' : 'Copy authorization code'}
            >
              {userCode ? (
                <p className="gg-type-display text-center font-mono text-3xl font-semibold tracking-wider text-foreground select-all">
                  {userCode}
                </p>
              ) : (
                <div className="flex items-center justify-center gap-2 text-sm text-foreground-muted">
                  <LoadingIndicator size="inline" />
                  Waiting for GitHub...
                </div>
              )}
            </button>

            <div className="space-y-2 text-sm">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-background-2 text-xs text-foreground-muted">
                  1
                </span>
                <p className="text-foreground-muted">
                  Paste the code in GitHub. The code has already been copied.
                </p>
              </div>
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-background-2 text-xs text-foreground-muted">
                  2
                </span>
                <p className="text-foreground-muted">Authorize gugu.</p>
              </div>
            </div>

            {browserOpening ? (
              <div className="rounded-lg border border-border-info bg-background-info p-3 text-sm text-foreground-info">
                Opening GitHub in {browserOpenCountdown}s...
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-3 text-xs text-foreground-muted">
              <div className="flex min-w-0 items-center gap-2">
                <LoadingIndicator size="inline" />
                <span>Waiting for authorization</span>
                {timeRemaining > 0 ? (
                  <span>Code expires in {formatTime(timeRemaining)}</span>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => openShellFeedback()}
                className="shrink-0 underline-offset-3 hover:text-foreground hover:underline focus:text-foreground focus:underline"
              >
                Having trouble?
              </button>
            </div>
          </>
        )}
      </DialogContentArea>
      <DialogFooter>
        {error || success ? (
          <Button variant="outline" onClick={handleClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => copyToClipboard(userCode)}
              disabled={!userCode || copied}
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? 'Copied' : 'Copy code'}
            </Button>
            <Button onClick={openGitHub} disabled={!verificationUri || browserOpening}>
              <ExternalLink className="h-4 w-4" />
              Open GitHub
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}
