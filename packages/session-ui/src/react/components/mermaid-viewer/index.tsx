import { Dialog } from '@session-ui/react/primitives/dialog';
import { useMessages } from '../../localization/message-provider';
import * as styles from './mermaid-viewer-dialog.css';

export interface MermaidViewerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-rendered Mermaid SVG markup; null when rendering failed. */
  svg: string | null;
  /** The diagram is still being rendered (the first one also loads mermaid itself). */
  pending?: boolean;
  /** Human-readable title shown in the dialog header. */
  title?: string;
}

export function MermaidViewerDialog({ open, onOpenChange, svg, pending, title }: MermaidViewerDialogProps) {
  const { translate } = useMessages();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content size="xl">
        <Dialog.Header>
          <Dialog.Title>{title ?? 'Diagram'}</Dialog.Title>
        </Dialog.Header>
        <div className={styles.diagramContainer}>
          {pending ? (
            <p className={styles.unavailable}>{translate('transcript.mermaidDiagram')}</p>
          ) : svg ? (
            <div className={styles.diagram} dangerouslySetInnerHTML={{ __html: svg }} />
          ) : (
            <p className={styles.unavailable}>Couldn&apos;t render diagram.</p>
          )}
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
