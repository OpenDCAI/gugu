import { QueryClientProvider } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { AppMenuEvents } from './app/app-menu-events';
import { AuxWindowHost } from './app/aux-window-host';
import { ComposerEmbedRoot } from './app/composer-embed-root';
import { SessionCreateEmbedRoot } from './app/session-create-embed-root';
import { Workspace } from './app/workspace';
import { ExtensionViewLayer } from './features/extensions/extension-view-layer';
import { IntegrationsProvider } from './features/integrations/integrations-provider';
import { WorkspaceLayoutContextProvider } from './lib/layout/layout-provider';
import { WorkspaceViewProvider } from './lib/layout/provider';
import { ModalRenderer } from './lib/modal/modal-renderer';
import { GithubContextProvider } from './lib/providers/github-context-provider';
import { ThemeProvider } from './lib/providers/theme-provider';
import { TerminalPoolProvider } from './lib/pty/pty-pool-provider';
import { queryClient } from './lib/query-client';
import { getEmbedView, subscribeEmbedView } from './lib/stores/embed-view';
import { RightSidebarProvider } from './lib/ui/right-sidebar';
import { TooltipProvider } from './lib/ui/tooltip';

function AppContent() {
  // gugu #2549: composer-only embed (对话页原地创建 Agent) bypasses the Workspace entirely — it's a
  // lightweight root the host (gugu MainLayout) reactively switches to on the SAME persistent instance
  // the session page uses (see lib/stores/embed-view.ts for why it must stay one instance). A standalone
  // session page never calls __EMDASH_SET_EMBED_VIEW__, so this stays 'workspace'.
  const embedView = useSyncExternalStore(subscribeEmbedView, getEmbedView);

  const renderContent = () => {
    // Composer-only embed: no window-controls overlay — it is never the top-level window content,
    // only a shadow-mounted subtree inside a gugu draft slot.
    if (embedView === 'composer') {
      return <ComposerEmbedRoot />;
    }
    if (embedView === 'session-create') {
      return <SessionCreateEmbedRoot />;
    }
    return <Workspace />;
  };

  return (
    <TooltipProvider delay={300}>
      <WorkspaceLayoutContextProvider>
        <TerminalPoolProvider>
          <GithubContextProvider>
            <IntegrationsProvider>
              <WorkspaceViewProvider>
                <AppMenuEvents />
                <RightSidebarProvider>
                  <ThemeProvider>
                    <ModalRenderer />
                    <ExtensionViewLayer />
                    <AuxWindowHost />
                    {renderContent()}
                  </ThemeProvider>
                </RightSidebarProvider>
              </WorkspaceViewProvider>
            </IntegrationsProvider>
          </GithubContextProvider>
        </TerminalPoolProvider>
      </WorkspaceLayoutContextProvider>
    </TooltipProvider>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppContent />
    </QueryClientProvider>
  );
}
