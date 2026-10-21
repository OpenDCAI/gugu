import { Github } from 'lucide-react'
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

export function GithubAuthDisclaimer({
  onOpenAccountSettings,
}: {
  onOpenAccountSettings: () => void;
}) {
  const { translate } = useSessionMessages();
  return (
    <div className="flex w-full flex-col items-center justify-center gap-5 rounded-md border border-border bg-foreground/[0.02] p-8 dark:bg-foreground/[0.03]">
      <span className="relative flex size-8 items-center justify-center overflow-hidden">
        <Github className="size-4 text-foreground-muted" />
      </span>
      <p className="text-center text-sm font-normal text-foreground-muted">
        {translate('integrations.githubDisclaimer')}
      </p>
      <Button type="button" variant="outline" size="xs" onClick={onOpenAccountSettings}>
        {translate('integrations.openAccountSettings')}
      </Button>
    </div>
  );
}
