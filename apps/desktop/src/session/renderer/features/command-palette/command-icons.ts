import { Archive, History, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpToLine, ChevronDown, ChevronUp, ExternalLink, FileDiff, Files, FolderOpen, FolderPlus, Globe, Library, MessageSquare, MessageSquarePlus, MessageSquareShare, Palette, Pin, RefreshCw, Settings, SquarePlus, SquareTerminal, Terminal, TextCursorInput, UserPlus, Users, Clock, type IconComponent } from '@/lib/icons'
import { Columns2, GitPullRequest, PanelBottom, PanelRight } from '@/lib/icons'

/**
 * Maps the string iconKey tokens defined in src/shared/commands.ts to their
 * IconComponent components. The shared layer stays free of renderer imports — it
 * stores only the string key, and the renderer resolves it here.
 */
export const COMMAND_ICONS = {
  settings: Settings,
  'folder-plus': FolderPlus,
  history: History,
  'folder-open': FolderOpen,
  library: Library,
  'square-plus': SquarePlus,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'message-square-plus': MessageSquarePlus,
  'columns-2': Columns2,
  'file-diff': FileDiff,
  'message-square': MessageSquare,
  'message-square-share': MessageSquareShare,
  palette: Palette,
  files: Files,
  terminal: Terminal,
  'panel-bottom': PanelBottom,
  'panel-right': PanelRight,
  'square-terminal': SquareTerminal,
  globe: Globe,
  'refresh-cw': RefreshCw,
  'text-cursor-input': TextCursorInput,
  'external-link': ExternalLink,
  'git-pull-request': GitPullRequest,
  'arrow-down-to-line': ArrowDownToLine,
  'arrow-up-to-line': ArrowUpToLine,
  pin: Pin,
  archive: Archive,
  'chevron-down': ChevronDown,
  'chevron-up': ChevronUp,
  users: Users,
  'user-plus': UserPlus,
  clock: Clock,
} satisfies Record<string, IconComponent>;

export type CommandIconKey = keyof typeof COMMAND_ICONS;

export function getCommandIcon(iconKey: string | undefined): IconComponent | undefined {
  if (!iconKey) return undefined;
  return (COMMAND_ICONS as Record<string, IconComponent>)[iconKey];
}
