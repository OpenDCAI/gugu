import { useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpToLine, FileText, Heart, Moon, RefreshCw, Sparkles, Zap } from '@/lib/icons';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { useToast } from '@renderer/lib/hooks/use-toast';
import type { BaselineStatus, HealthNight, HealthSignal, HealthSummary, HealthWorkout } from '@gugu/core/shared/healthSummary';
import type { AssistantContext, AssistantPageProps } from './assistant-context';
import { usePhoneHealth, useMemoryNotes, type PhoneHealthView } from './assistant-data';
import { AssistantEmpty, AssistantRow, AssistantSection, PageHead, Tile } from './assistant-ui';

type T = ReturnType<typeof useTranslation<'assistant'>>['t'];

/** 「分析健康报告」收的文件:报告多是 PDF 或拍照 / 截图。 */
export const HEALTH_REPORT_ACCEPT = 'application/pdf,image/*';

/** 它记的健康记录:记忆里文件名以 health 开头的那几条(解读里请它这么起名)。 */
export const isHealthNote = (file: string) => /^health[_-]/i.test(file);

/**
 * 健康(入口在「记忆」首页那张「健康」卡):
 * 页头 → 读不到时如实说是哪一种并给下一步 →「今天」关键指标(两列小卡:值、基线状态、7 天小柱)→ 昨晚 → 锻炼 → 身体 →
 * 你的健康分析(让它解读;它记进记忆的 health_* 那几条)→ 分析健康报告(选 PDF / 图片,放进和它的聊天,人看过再发)。
 * 数据是此刻经设备动作问主人的手机读的(phone-health.ts),与云电脑上的它 device_call 同一条路;❌ 叫醒云电脑。
 */
export function AssistantHealthPage({ context }: AssistantPageProps) {
  const { t } = useTranslation('assistant');
  const health = usePhoneHealth();
  const view = health.data;
  return (
    <div className="ta-page" data-testid="assistant-health" data-state={health.isLoading ? 'loading' : health.isError ? 'error' : view?.state}>
      <PageHead
        title={t('health.title')}
        sub={view?.state === 'ok' ? t('health.from', { device: view.label, time: clock(view.summary.generated_at) }) : undefined}
        action={
          <button
            type="button"
            className="ta-circle"
            aria-label={t('health.refresh')}
            title={t('health.refresh')}
            disabled={health.isFetching}
            onClick={() => void health.refetch()}
            data-testid="assistant-health-refresh"
          >
            {health.isFetching ? <LoadingIndicator size="inline" /> : <RefreshCw />}
          </button>
        }
      />
      {health.isLoading ? (
        <AssistantEmpty>
          <span className="inline-flex items-center gap-2">
            <LoadingIndicator size="inline" />
            {t('health.loading')}
          </span>
        </AssistantEmpty>
      ) : health.isError || !view ? (
        <div className="ta-card" data-testid="assistant-health-error">
          <AssistantEmpty title={t('health.state.errorTitle')} action={<RetryButton onRetry={() => void health.refetch()} t={t} />}>
            {t('health.state.errorBody')}
          </AssistantEmpty>
        </div>
      ) : view.state === 'ok' ? (
        <HealthBody summary={view.summary} t={t} />
      ) : (
        <ConnectCard view={view} onRetry={() => void health.refetch()} t={t} />
      )}
      <Analysis context={context} t={t} />
      <ReportUpload context={context} t={t} />
    </div>
  );
}

/** 读不到:「让健康状况一目了然」那张卡,下面一句说清是哪一种、去哪弄好。 */
function ConnectCard({ view, onRetry, t }: { view: Exclude<PhoneHealthView, { state: 'ok' }>; onRetry: () => void; t: T }) {
  const device = 'label' in view ? view.label : '';
  const line = (() => {
    switch (view.state) {
      case 'no-phone':
        return t('health.state.noPhone');
      case 'old-app':
        return t('health.state.oldApp', { device });
      case 'offline':
        return view.lastSeenAt ? t('health.state.offline', { device, time: serverTime(view.lastSeenAt) }) : t('health.state.offlineNever', { device });
      case 'not_granted':
        return t('health.state.notGranted', { device });
      case 'os_permission':
        return view.detail ?? t('health.state.osPermission', { device });
      case 'unsupported':
        return t('health.state.unsupported', { device });
      case 'failed':
        return t('health.state.failed', { message: view.message });
      case 'unreadable':
        return t('health.state.unreadable', { problem: view.problem });
    }
  })();
  const retry = view.state === 'offline' || view.state === 'failed';
  return (
    <div className="ta-card ta-health-connect" data-testid={`assistant-health-${view.state}`}>
      <span className="ta-tile-icon">
        <Heart />
      </span>
      <h2 className="ta-card-title">{t(view.state === 'unreadable' ? 'health.state.unreadableTitle' : 'health.emptyStateTitle')}</h2>
      <p className="ta-page-sub">{t('health.emptyStateSubtitle')}</p>
      <div className="ta-card-divider" />
      <p className="ta-health-line">{line}</p>
      {retry ? <RetryButton onRetry={onRetry} t={t} /> : null}
    </div>
  );
}

function RetryButton({ onRetry, t }: { onRetry: () => void; t: T }) {
  return (
    <button type="button" className="ta-pill-btn" onClick={onRetry} data-testid="assistant-health-retry">
      {t('health.retry')}
    </button>
  );
}

/** 读到了的那一大块(手机「健康」页同一份:数据在手机本机读,画法照这里)。 */
export function HealthBody({ summary, t }: { summary: HealthSummary; t: T }) {
  const missing = summary.missing_types.map((type) => t(`health.type.${type}`, { defaultValue: type }));
  const unreadable = summary.unreadable.map((u) => t(`health.type.${u.type}`, { defaultValue: u.type }));
  const notes = [
    missing.length ? t('health.missing', { names: missing.join('、') }) : null,
    unreadable.length ? t('health.unreadableTypes', { names: unreadable.join('、') }) : null,
    summary.background.supported && !summary.background.granted ? t('health.backgroundHint') : null,
  ].filter(Boolean);
  const body = (Object.entries(summary.body) as Array<[keyof HealthSummary['body'], { value: number; at: string } | null]>).filter(([, v]) => v);
  return (
    <>
      <AssistantSection title={t('health.today')} bare testId="assistant-health-today">
        {summary.signals.length === 0 ? (
          <div className="ta-card">
            <AssistantEmpty>{t('health.emptySignals')}</AssistantEmpty>
          </div>
        ) : (
          <div className="ta-grid">
            {summary.signals.map((signal) => (
              <SignalCard key={signal.key} signal={signal} t={t} />
            ))}
          </div>
        )}
      </AssistantSection>
      {summary.last_night ? <NightCard night={summary.last_night} t={t} /> : null}
      {summary.granted_types.includes('exercise') ? (
        <AssistantSection title={t('health.workouts')} testId="assistant-health-workouts">
          {summary.workouts.length === 0 ? (
            <AssistantRow title={t('health.noWorkouts')} />
          ) : (
            summary.workouts.map((w) => <WorkoutRow key={`${w.start}-${w.exercise_type}`} workout={w} t={t} />)
          )}
        </AssistantSection>
      ) : null}
      {body.length > 0 ? (
        <AssistantSection title={t('health.body')} testId="assistant-health-body">
          {body.map(([key, v]) => (
            <AssistantRow key={key} title={t(`health.bodyItem.${key}`)} detail={dateTime(v!.at)} trailing={bodyValue(key, v!.value, t)} />
          ))}
        </AssistantSection>
      ) : null}
      {notes.length > 0 ? (
        <div className="ta-page-sub ta-pad flex flex-col gap-1" data-testid="assistant-health-notes">
          {notes.map((note) => (
            <span key={note}>{note}</span>
          ))}
        </div>
      ) : null}
    </>
  );
}

const STATUS_TONE: Record<BaselineStatus, 'good' | 'ok' | 'warn' | 'bad'> = {
  optimal: 'good',
  typical: 'ok',
  above: 'warn',
  below: 'warn',
  high: 'bad',
  low: 'bad',
};

const SIGNAL_ICON: Record<HealthSignal['key'], ReactNode> = {
  sleep: <Moon />,
  steps: <Zap />,
  resting_hr: <Heart />,
  hrv: <Heart />,
  active_kcal: <Zap />,
};

/** 一张关键指标:值 + 单位、基线状态、最近 7 天的小柱(最新那根高亮)。 */
function SignalCard({ signal, t }: { signal: HealthSignal; t: T }) {
  const max = Math.max(1, ...signal.series.map((p) => p.value ?? 0));
  const cumulative = signal.key === 'steps' || signal.key === 'active_kcal';
  return (
    <div className="ta-tile ta-health-metric" data-testid={`assistant-health-signal-${signal.key}`} data-status={signal.status ?? undefined}>
      <span className="flex items-center gap-2">
        <span className="ta-health-metric-icon">{SIGNAL_ICON[signal.key]}</span>
        <span className="ta-tile-sub">{t(`health.signal.${signal.key}`)}</span>
      </span>
      <span className="ta-health-value">{signal.value === null ? t('health.noData') : signalValue(signal.key, signal.value, t)}</span>
      <span className="ta-tile-sub">
        {signal.status ? (
          <span className="ta-health-status" data-tone={STATUS_TONE[signal.status]}>
            {t(`health.status.${signal.status}`)}
          </span>
        ) : cumulative && signal.value !== null ? (
          t('health.todaySoFar')
        ) : null}
        {signal.baseline !== null ? <span> · {t('health.baseline', { value: signalValue(signal.key, signal.baseline, t) })}</span> : null}
      </span>
      <span className="ta-health-bars" aria-hidden>
        {signal.series.map((point, index) => (
          <span
            key={point.date}
            className="ta-health-bar"
            data-latest={index === signal.series.length - 1 ? '' : undefined}
            data-empty={point.value === null ? '' : undefined}
            style={{ height: `${Math.max(6, Math.round(((point.value ?? 0) / max) * 100))}%` }}
          />
        ))}
      </span>
    </div>
  );
}

const STAGES = ['deep', 'light', 'rem', 'awake', 'asleep_unstaged'] as const;

/** 昨晚(睡眠卡):入睡 / 醒来、睡了多久、卧床多久、分期条。 */
function NightCard({ night, t }: { night: HealthNight; t: T }) {
  const stages = night.stages;
  const total = stages ? STAGES.reduce((sum, key) => sum + stages[key], 0) : 0;
  return (
    <AssistantSection title={t('health.lastNight')} bare testId="assistant-health-night">
      <div className="ta-card flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="ta-health-value">{duration(night.asleep_minutes, t)}</span>
          <span className="ta-tile-sub">{t('health.inBed', { duration: duration(night.in_bed_minutes, t) })}</span>
        </div>
        <span className="ta-tile-sub">{t('health.bedWake', { bed: clock(night.start), wake: clock(night.end) })}</span>
        {stages && total > 0 ? (
          <>
            <span className="ta-health-stages" aria-hidden>
              {STAGES.filter((key) => stages[key] > 0).map((key) => (
                <span key={key} data-stage={key} style={{ flexGrow: stages[key] }} />
              ))}
            </span>
            <span className="flex flex-wrap gap-x-4 gap-y-1">
              {STAGES.filter((key) => stages[key] > 0).map((key) => (
                <span key={key} className="ta-tile-sub inline-flex items-center gap-2">
                  <span className="ta-health-dot" data-stage={key} />
                  {t(`health.stage.${key}`)} {duration(stages[key], t)}
                </span>
              ))}
            </span>
          </>
        ) : null}
      </div>
    </AssistantSection>
  );
}

function WorkoutRow({ workout, t }: { workout: HealthWorkout; t: T }) {
  const facts = [
    duration(workout.minutes, t),
    workout.active_kcal !== null ? `${workout.active_kcal} ${t('health.unit.kcal')}` : null,
    workout.distance_m !== null && workout.distance_m > 0 ? `${(workout.distance_m / 1000).toFixed(2)} ${t('health.unit.km')}` : null,
    workout.hr_avg !== null ? t('health.workoutHr', { avg: workout.hr_avg, max: workout.hr_max ?? '—' }) : null,
  ].filter(Boolean);
  return (
    <AssistantRow
      leading={
        <span className="ta-tile-icon">
          <Zap />
        </span>
      }
      title={workout.title || workout.name}
      detail={`${dateTime(workout.start)} · ${facts.join(' · ')}`}
    />
  );
}

/** 你的健康分析:让它解读(往聊天里填一句,人看过再发);它记进记忆的 health_* 几条列在这里,点进去是那条记忆。 */
function Analysis({ context, t }: { context: AssistantContext; t: T }) {
  const name = context.assistant.display_name;
  const notes = useMemoryNotes(context.readiness === 'ready' ? context.machine : undefined);
  const healthNotes = (notes.data?.notes ?? []).filter((note) => isHealthNote(note.file));
  return (
    <AssistantSection
      title={t('health.analysisTitle')}
      action={
        <button type="button" className="ta-pill-btn" onClick={() => context.askInChat(t('health.analyzePrompt'))} data-testid="assistant-health-analyze">
          <Sparkles />
          {t('health.analyze', { name })}
        </button>
      }
      testId="assistant-health-analysis"
    >
      {healthNotes.length === 0 ? (
        <AssistantRow title={t('health.analysisEmpty', { name })} />
      ) : (
        healthNotes.map((note) => (
          <AssistantRow
            key={note.file}
            leading={
              <span className="ta-tile-icon">
                <FileText />
              </span>
            }
            title={note.title}
            detail={note.description || note.body.slice(0, 80)}
            onClick={() => context.go({ tab: 'memory', sub: `note:${note.file}` })}
            testId={`assistant-health-note-${note.file}`}
          />
        ))
      )}
    </AssistantSection>
  );
}

/** 分析健康报告(聊天「+」里那一项):选一份 PDF / 图片,连同一句交代放进和它的聊天,人看过再发。 */
function ReportUpload({ context, t }: { context: AssistantContext; t: T }) {
  const input = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  return (
    <AssistantSection title={t('health.addData')} bare testId="assistant-health-add">
      <div className="ta-grid">
        <Tile
          icon={<ArrowUpToLine />}
          title={t('health.analyzeReport')}
          sub={t('health.analyzeReportDescription')}
          onClick={() => input.current?.click()}
          testId="assistant-health-report"
        />
      </div>
      <input
        ref={input}
        type="file"
        accept={HEALTH_REPORT_ACCEPT}
        className="hidden"
        data-testid="assistant-health-report-input"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          if (files.length === 0) return;
          context.askInChat(t('health.healthReportMessage'), files);
          toast({ title: t('health.reportPicked', { name: context.assistant.display_name }) });
        }}
      />
    </AssistantSection>
  );
}

// ── 写法 ─────────────────────────────────────────────────────────────────────

function duration(totalMinutes: number, t: T): string {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  return h > 0 ? `${h} ${t('health.unit.hour')} ${m} ${t('health.unit.minute')}` : `${m} ${t('health.unit.minute')}`;
}

function signalValue(key: HealthSignal['key'], value: number, t: T): string {
  switch (key) {
    case 'sleep':
      return duration(value, t);
    case 'steps':
      return `${Math.round(value).toLocaleString()} ${t('health.unit.steps')}`;
    case 'resting_hr':
      return `${Math.round(value)} ${t('health.unit.bpm')}`;
    case 'hrv':
      return `${Math.round(value)} ${t('health.unit.ms')}`;
    case 'active_kcal':
      return `${Math.round(value).toLocaleString()} ${t('health.unit.kcal')}`;
  }
}

function bodyValue(key: keyof HealthSummary['body'], value: number, t: T): string {
  if (key === 'weight_kg') return `${value} ${t('health.unit.kg')}`;
  if (key === 'respiratory_rate') return `${value} ${t('health.unit.perMinute')}`;
  return `${value}${t('health.unit.percent')}`;
}

/** 手机给的是带偏移的手机本地时间:时刻原样取「HH:MM」,❌ 换成这台电脑的时区(人看的是手机那边的作息)。 */
function clock(iso: string): string {
  const match = /T(\d{2}:\d{2})/.exec(iso);
  return match ? match[1]! : iso;
}

/** 手机给的时间(带偏移的手机本地时间)按手机那边的钟面原样取。 */
function dateTime(iso: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(iso);
  return match ? `${Number(match[1])}/${Number(match[2])} ${match[3]}` : serverTime(iso);
}

/** 库里记的时间(设备最后在线,UTC):换成这台电脑的本地时间。 */
function serverTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
