import React from 'react';
import { rpc } from '../ipc';
import { Button } from '../ui/button';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

type ErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
};

type ErrorBoundaryProps = {
  children?: React.ReactNode;
};

function ErrorFallback({ message, onReload }: { message: string; onReload: () => void }) {
  const { translate } = useSessionMessages();
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background p-6">
      {/* 整屏只有这一个对象 ⇒ 既不需要投影抬起来、也不需要画框把它圈出来
          (design.md:「a box drawn to repair weak hierarchy」)。层级交给 bg-background-1 这一阶底色。 */}
      <div className="bg-background-1 text-foreground max-w-xl rounded-md p-6">
        <h1 className="mb-2 text-lg font-semibold">{translate('error.title')}</h1>
        <p className="text-foreground-muted mb-4 text-sm break-all">{message}</p>
        <Button variant="default" onClick={onReload}>
          {translate('error.reload')}
        </Button>
      </div>
    </div>
  );
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  handleReload = () => {
    void rpc.viewState.reset().finally(() => {
      try {
        window.location.reload();
      } catch {}
    });
  };

  render() {
    if (!this.state.hasError) return this.props.children as React.ReactElement;
    const message = this.state.error?.message || translateSessionMessage('error.unexpected');
    return <ErrorFallback message={message} onReload={this.handleReload} />;
  }
}
