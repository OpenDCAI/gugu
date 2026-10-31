/**
 * PermissionBand — a composer-docked band that surfaces an ACP permission
 * request to the user.
 *
 * Renders flush above the composer input box, styled like NoticeBand but with
 * a SplitButton instead of a dismiss button.  A "1 of N" counter is shown when
 * multiple requests are queued, so the user knows more are coming.
 *
 * Tone mapping from ACP PermissionOption.kind:
 *   allow_*  → accept
 *   reject_* → reject
 *   other    → neutral
 */

import { cx } from '@session-ui/styles/utilities/cx';
import { ShieldAlertIcon } from '../../../icons'
import * as React from 'react';
import { SplitButton, type SplitButtonOption } from '@session-ui/react/primitives/split-button';
import * as styles from './permission-band.css';
import { useMessages } from '../../localization/message-provider';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ComposerPermissionOption = {
  optionId: string;
  name: string;
  kind: string;
  /** Optional host-localized label. Provider names are kept as a fallback. */
  label?: string;
};

export type ComposerPermissionRequest = {
  requestId: string;
  /** Pre-formatted action verb, e.g. "Read a File", "Execute". */
  title: string;
  description?: string;
  options: ComposerPermissionOption[];
  /** Status prefix shown before the provider action title. */
  statusLabel?: string;
};

export interface PermissionBandProps {
  request: ComposerPermissionRequest;
  /** Total pending count including this one. Used to render "1 of N". */
  queueCount?: number;
  /** Called with the chosen optionId. Rejection is represented by reject_* options. */
  onResolve: (optionId: string) => void;
  className?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function kindToTone(kind: string): SplitButtonOption['tone'] {
  if (kind.startsWith('allow_')) return 'accept';
  if (kind.startsWith('reject_')) return 'reject';
  return 'neutral';
}

function defaultSelectedId(options: ComposerPermissionOption[]): string | undefined {
  return (
    options.find((o) => o.kind === 'allow_once')?.optionId ??
    options.find((o) => o.kind.startsWith('allow_'))?.optionId ??
    options[0]?.optionId
  );
}

// ── PermissionBand ────────────────────────────────────────────────────────────

export function PermissionBand({
  request,
  queueCount = 1,
  onResolve,
  className,
}: PermissionBandProps) {
  const { translate } = useMessages();
  const splitOptions: SplitButtonOption[] = request.options.map((o) => ({
    id: o.optionId,
    label: o.label ?? o.name,
    tone: kindToTone(o.kind),
  }));

  const [selectedId, setSelectedId] = React.useState<string | undefined>(() =>
    defaultSelectedId(request.options)
  );

  // Reset selection when the request changes (a new request came in after resolving).
  // request.options is intentionally excluded: we only want to reset on a new request (new requestId),
  // not every time the options array reference changes while the same request is displayed.
  React.useEffect(() => {
    setSelectedId(defaultSelectedId(request.options));
  }, [request.requestId]);

  return (
    <div data-slot="composer-permission-request" className={cx(styles.band, className)}>
      <ShieldAlertIcon className={styles.bandIcon} aria-hidden />

      {/* Context label */}
      <span className={styles.bandLabel}>
        <span className={styles.bandLabelStrong}>
          {request.statusLabel ?? translate('composer.allow')}
        </span>{' '}
        <span>{request.title}</span>
        {request.description && <span title={request.description} style={{ display: 'block', whiteSpace: 'pre-wrap' }}>{request.description}</span>}
        {queueCount > 1 && (
          <span className={styles.bandCounter}>
            {translate('composer.queuePosition', { current: 1, total: queueCount })}
          </span>
        )}
      </span>

      {/* Split button */}
      <SplitButton
        options={splitOptions}
        selectedId={selectedId}
        onSelectedChange={setSelectedId}
        onAction={onResolve}
        size="sm"
        variant="secondary"
        className={styles.bandAction}
      />
    </div>
  );
}
