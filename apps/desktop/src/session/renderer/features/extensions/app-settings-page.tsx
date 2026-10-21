import { useEffect, useId, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { ArrowUp, Monitor } from '@/lib/icons';
import { NEW_SESSION_DRAFT_KEY, composerDrafts } from '@renderer/features/sessions/composer-drafts';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/lib/ui/select';
import { Switch } from '@renderer/lib/ui/switch';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { AppSettings } from '@shared/extensions/app-settings';
import { localizedManifestText } from '@shared/extensions/catalog';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import { ComputerUseAccess, switchesComputerControl } from './computer-use-access';
import { installedExtensionsStore } from './installed-extensions-store';
import './panel/app-store.css';
import './app-settings-page.css';

type Tab = 'overview' | 'settings';

/**
 * Resident host page of an App without a page of its own (#7289). Overview = what to ask an agent; Settings =
 * what its author declared. Permissions, which agents get it, switching off, uninstalling and program
 * failures stay on its App page.
 */
export const AppSettingsPage = observer(function AppSettingsPage({ manifest, active }: { manifest: ExtensionManifest; active: boolean }) {
  const { translate: t, locale } = useSessionMessages();
  const { navigate } = useNavigate();
  const prefix = useId();
  const text = localizedManifestText(manifest, locale);
  const icon = installedExtensionsStore.appIcons[manifest.id];
  const fields = manifest.settings ?? [];
  const tabs = [...(text.examples.length > 0 ? ['overview' as const] : []), ...(fields.length > 0 ? ['settings' as const] : [])];
  const [tab, setTab] = useState<Tab>(tabs[0] ?? 'overview');
  const [stored, setStored] = useState<AppSettings | null>(null);
  const [values, setValues] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = values !== null && JSON.stringify(values) !== JSON.stringify(stored);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const fail = (cause: unknown) => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); };
    void rpc.extensions.openSettings({ extensionId: manifest.id }).then(result => {
      if (!result.success || !result.data) throw new Error(result.error ?? t('appSettings.readFailed'));
      const loaded = result.data;
      if (disposed) return;
      // Input typed before the page was moved or hidden stays until it is saved.
      setStored(previous => previous ?? loaded);
      setValues(previous => previous ?? loaded);
    }).catch(fail);
    return () => { disposed = true; };
  }, [manifest.id, active, t]);

  const save = async () => {
    if (!values) return;
    setSaving(true);
    setError(null);
    try {
      // An emptied field goes back to the author's default, which its placeholder shows.
      const settings = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''));
      const result = await rpc.extensions.setSettings({ extensionId: manifest.id, settings });
      if (!result.success || !result.data) throw new Error(result.error ?? t('appSettings.saveFailed'));
      setStored(result.data);
      setValues(result.data);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const change = (key: string, value: string | boolean) => {
    setValues(previous => ({ ...previous, [key]: value }));
    setSaved(false);
  };
  /** Same as 「对 agent 说」 on the App page: a new task with this sentence already in its box. */
  const ask = (example: string) => {
    composerDrafts.set(NEW_SESSION_DRAFT_KEY, example);
    navigate('new-session');
  };

  return <main className="tool-app-page" aria-label={text.name}>
    <div className="tool-app-content">
      <header className="tool-app-header">
        {icon ? <img className="tool-app-icon" src={icon} alt="" /> : <Monitor className="tool-app-icon text-foreground-muted" />}
        <div className="tool-app-heading">
          <div className="tool-app-title"><h1>{text.name}</h1><span>v{manifest.version}</span></div>
          {text.description ? <p>{text.description}</p> : null}
        </div>
      </header>
      {/* #7317 Computer Use is the switch of computer control: the permissions it needs are given here, once. */}
      {active && switchesComputerControl(manifest) ? <ComputerUseAccess /> : null}
      {tabs.length > 1 ? <div className="tool-app-tabs" role="tablist" aria-label={text.name}>
        {tabs.map(name => <button key={name} type="button" role="tab" id={`${prefix}-${name}-tab`} aria-selected={tab === name}
          aria-controls={`${prefix}-${name}`} tabIndex={tab === name ? 0 : -1} onClick={() => setTab(name)}
          onKeyDown={event => {
            if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
            event.preventDefault();
            const next = tabs[(tabs.indexOf(name) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
            setTab(next);
            document.getElementById(`${prefix}-${next}-tab`)?.focus();
          }}>{t(`appSettings.${name}`)}</button>)}
      </div> : null}

      {tabs.includes('overview') ? <section id={`${prefix}-overview`} role={tabs.length > 1 ? 'tabpanel' : undefined}
        aria-labelledby={tabs.length > 1 ? `${prefix}-overview-tab` : undefined} hidden={tab !== 'overview'}>
        <h2>{t('extensions.askAgent')}</h2>
        <div className="mk-asks">
          {text.examples.map(example => <button type="button" className="mk-ask" key={example} title={t('extensions.askAgentHint')} onClick={() => ask(example)}>
            <span>{example}</span>
            <ArrowUp className="size-3.5" />
          </button>)}
        </div>
      </section> : null}

      {tabs.includes('settings') ? <form id={`${prefix}-settings`} role={tabs.length > 1 ? 'tabpanel' : undefined}
        aria-labelledby={tabs.length > 1 ? `${prefix}-settings-tab` : undefined} hidden={tab !== 'settings'} className="tool-app-fields"
        onSubmit={event => { event.preventDefault(); if (dirty) void save(); }}>
        {fields.map(field => {
          const id = `${prefix}-${field.key}`;
          const about = field.description ? `${id}-about` : undefined;
          const description = field.description ? <p id={about}>{field.description}</p> : null;
          if (field.type === 'boolean') return <div key={field.key} className="tool-app-toggle">
            <div><label htmlFor={id}>{field.title}</label>{description}</div>
            <Switch id={id} checked={values?.[field.key] === true} disabled={saving || !values} aria-describedby={about}
              onCheckedChange={checked => change(field.key, checked)} />
          </div>;
          return <div key={field.key} className="tool-app-field">
            <label htmlFor={id}>{field.title}</label>
            {field.type === 'select' ? <Select items={field.options.map(option => ({ value: option.value, label: option.title }))}
              value={typeof values?.[field.key] === 'string' ? values[field.key] as string : null}
              onValueChange={value => { if (value !== null) change(field.key, value); }} disabled={saving || !values}>
              <SelectTrigger id={id} aria-describedby={about}><SelectValue /></SelectTrigger>
              <SelectContent>{field.options.map(option => <SelectItem key={option.value} value={option.value}>{option.title}</SelectItem>)}</SelectContent>
            </Select> : <Input id={id} value={String(values?.[field.key] ?? '')} maxLength={4096} disabled={saving || !values} spellCheck={false}
              placeholder={typeof field.default === 'string' ? field.default : undefined} aria-describedby={about}
              onChange={event => change(field.key, event.target.value)} />}
            {description}
          </div>;
        })}
        {dirty ? <div><Button type="submit" size="sm" disabled={saving}>{t('appSettings.save')}</Button></div>
          : saved ? <p role="status" className="tool-app-saved">{t('appSettings.saved')}</p> : null}
      </form> : null}

      {error ? <p role="alert" className="tool-app-error">{error}</p> : null}
    </div>
  </main>;
});
