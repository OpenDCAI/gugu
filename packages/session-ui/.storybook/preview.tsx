import type { Decorator, Preview } from '@storybook/react-vite';
import React from 'react';
import { ThemeProvider } from '../src/react/primitives/theme-provider';
import type { ThemeId } from '../src/react/primitives/theme-provider';
import { MessageProvider, type MessageTranslator } from '../src/react/components';
// Third-party CSS loaded globally so all stories can rely on them without
// individual imports. Vite handles these in the Storybook build.
import 'devicon/devicon.min.css';
// @@@task-fusion (#2802) — 包按源码消费,不再有 lib 产物 `dist/style.css`;
// @gugu/session-chat-ui 的入口(src/index.tsx)自己就带 styles/global.css 副作用。
import '@gugu/session-chat-ui';
import '../src/react/chat-ui/chat-theme.css';
// Opt-in element-defaults (body bg/fg, scrollbars, selection) using --em-* tokens.
import '../src/styles/base.css';

const SURFACE_FAMILIES = [
  'none',
  'sunken',
  'base',
  'base-emphasis',
  'elevated',
  'elevated-emphasis',
] as const;
type SurfaceFamily = (typeof SURFACE_FAMILIES)[number];

const STORY_MESSAGES: Record<string, string> = {
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.download': 'Download',
  'common.downloading': 'Downloading…',
  'common.installing': 'Installing…',
  'common.restart': 'Restart',
  'common.search': 'Search',
  'composer.addAttachment': 'Add attachment',
  'composer.agent': 'Agent',
  'composer.agentLocked': '{agentName} - cannot switch agents after the session starts',
  'composer.allow': 'Allow',
  'composer.cancelEdit': 'Cancel edit',
  'composer.contextUsage': 'Context usage',
  'composer.contextWindowUsed': 'Context window: {percent}% used',
  'composer.cost': 'Cost: {cost}',
  'composer.default': 'Default',
  'composer.defaultValue': 'Default ({value})',
  'composer.deleteQueuedPrompt': 'Delete queued prompt',
  'composer.dismissNotice': 'Dismiss notice',
  'composer.dragToReorder': 'Drag to reorder',
  'composer.editQueuedPrompt': 'Edit queued prompt {index}',
  'composer.effort': 'Thinking',
  'composer.manageModels': 'Manage models',
  'composer.modelDetailContext': 'Context',
  'composer.modelDetailSpeed': 'Speed',
  'composer.modelDetailIntelligence': 'Intelligence',
  'composer.effortReset': 'Reset to the model default',
  'composer.effortUnset': 'Not set — the agent picks its own.',
  'composer.effortLocked': "This session can't change the thinking level right now.",
  'composer.followUpPlaceholder': 'Add a follow-up',
  'composer.imageOnlyPrompt': 'Image-only prompt',
  'composer.messagePlaceholder': 'Message…',
  'composer.model': 'Model',
  'composer.notSelected': 'Not selected',
  'composer.permissions': 'Permissions…',
  'composer.queuePosition': '({current} of {total})',
  'composer.queuedPrompts': 'Queued prompts',
  'composer.removeAttachment': 'Remove {name}',
  'composer.cancelAttachment': 'Stop sending {name}',
  'composer.retryAttachment': 'Retry',
  'composer.reorderQueuedPrompt': 'Reorder queued prompt {index}',
  'composer.saveQueuedPrompt': 'Save queued prompt',
  'composer.searchAgents': 'Search agents…',
  'composer.sendMessage': 'Send message',
  'composer.sendNowCancelsTurn': 'Send now - cancels the active turn',
  'composer.sendNowSteersTurn': 'Send now - into the active turn',
  'composer.sendQueuedPromptNow': 'Send queued prompt now',
  'composer.sessionClosed': 'Session closed',
  'composer.stopGeneration': 'Stop generation',
  'composer.tokens': 'Tokens',
  'composer.viewImage': 'View image: {name}',
  greeting: 'Hello',
  'update.available': 'Update available',
  'update.availableVersion': 'Available version: {version}',
  'update.check': 'Check for updates',
  'update.checking': 'Checking for updates…',
  'update.current': 'Current version: {version}',
  'update.downloading': 'Downloading update…',
  'update.installing': 'Installing update…',
  'update.ready': 'Update ready',
  'update.unavailable': 'No update available',
  'update.version': 'Version {version}',
};

const storyTranslator: MessageTranslator = (key, values) => {
  const template = STORY_MESSAGES[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    String(values?.[name] ?? `{${name}}`),
  );
};

const withTheme: Decorator = (Story, context) => {
  const colorMode = (context.globals['colorMode'] as ThemeId) ?? 'light';
  const surface = (context.globals['surface'] as SurfaceFamily) ?? 'none';
  // Fullscreen stories own their layout — don't inject padding/min-height that
  // would stack on top of a story's own h-screen and overflow the viewport.
  const fullscreen = context.parameters?.['layout'] === 'fullscreen';

  const surfaceClass = surface !== 'none' ? `surface-${surface}` : '';
  // Set the design-system font on the frame (inline style) so story content wins
  // over Storybook's preview base body font; native controls pick it up via the
  // `font: inherit` reset in theme.base.css.
  const frameStyle: React.CSSProperties = fullscreen
    ? {
        height: '100vh',
        fontFamily: 'var(--em-font-sans)',
        backgroundColor: surface !== 'none' ? 'var(--em-surface)' : 'var(--em-background)',
      }
    : {
        minHeight: '100vh',
        padding: '2rem',
        fontFamily: 'var(--em-font-sans)',
        backgroundColor: surface !== 'none' ? 'var(--em-surface)' : 'var(--em-background)',
      };

  // ThemeProvider (default target="documentElement") applies the theme class to
  // <html> so portal-rendered elements inherit tokens automatically. All CSS is
  // loaded as side-effects by importing ThemeProvider — no separate CSS imports
  // are needed here.
  return (
    <ThemeProvider theme={colorMode} className={surfaceClass} style={frameStyle}>
      <MessageProvider locale="en-US" translate={storyTranslator}>
        <Story />
      </MessageProvider>
    </ThemeProvider>
  );
};

const preview: Preview = {
  decorators: [withTheme],
  globalTypes: {
    colorMode: {
      description: 'Color mode',
      toolbar: {
        title: 'Color mode',
        icon: 'circlehollow',
        items: [
          { value: 'light', title: 'Light', icon: 'sun' },
          { value: 'dark', title: 'Dark', icon: 'moon' },
          { value: 'solarized-light', title: 'Solarized Light', icon: 'sun' },
          { value: 'solarized-dark', title: 'Solarized Dark', icon: 'moon' },
        ],
        dynamicTitle: true,
      },
    },
    surface: {
      description: 'Surface backdrop',
      toolbar: {
        title: 'Surface',
        icon: 'component',
        items: SURFACE_FAMILIES.map((s) => ({ value: s, title: s === 'none' ? 'Default' : s })),
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    colorMode: 'light',
    surface: 'none',
  },
  parameters: {
    controls: { matchers: { color: /(background|color)$/i, date: /date/i } },
    docs: { codePanel: true },
  },
};

export default preview;
