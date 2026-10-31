import { messageForUser } from '@/lib/userFacingError';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Folder, ListFilter } from '@/lib/icons';
import type { ViewDefinition } from '@renderer/app/view-registry';
import { restoreArchivedSession } from '@renderer/features/sessions/restore-session-flow';
import { cloudWakeFailureText, formatAgo } from '@renderer/features/remote-hosts/connection-status';
import { MachinePicker } from '@renderer/features/remote-hosts/machine-picker';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { useWakeCloudOnce } from '@renderer/features/remote-hosts/use-wake-cloud-once';
import {
  describeImportFailure,
  importDeviceChoices,
  importDeviceState,
} from '@renderer/features/session-import/import-device';
import { countOutcomes, runImport, type ImportOutcome } from '@renderer/features/session-import/import-runner';
import { LOCAL_IMPORT_DEVICE, resolveImportSource } from '@renderer/features/session-import/import-source';
import { ImportSummary } from '@renderer/features/session-import/import-summary';
import { shortenPath } from '@renderer/features/session-import/session-row';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { PageContent, PageLayout } from '@renderer/lib/components/page-layout';
import { ShellTitlebar } from '@renderer/lib/components/titlebar/shell-titlebar';
import { toast } from '@renderer/lib/hooks/use-toast';
import { onMachineEvent, rpcOn } from '@renderer/lib/ipc';
import { useDebounce } from '@renderer/lib/hooks/useDebounce';
import { openLink } from '@/lib/guguLinks';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { SearchInput } from '@renderer/lib/ui/search-input';
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from '@renderer/lib/ui/combobox';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { SessionMessageKey } from '@renderer/localization/messages';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import {
  SESSION_HISTORY_SOURCES,
  SESSION_HISTORY_STATUSES,
  SESSION_HOME_SECTION_KEY,
  type SessionHistoryGuguRef,
  type SessionHistoryRow as SessionHistoryRowData,
  type SessionHistorySort,
  type SessionHistorySource,
  type SessionHistoryStatus,
} from '@shared/core/session-history/session-history';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import { STATUS_MESSAGE_KEY, SessionHistoryRow, historyOptionId, sourceLabel } from './session-history-row';
import { SessionHistorySectionBox } from './session-history-section-box';
import { useSessionHistory, useSessionHistoryDirectories } from './use-session-history';

// spec session-page「会话历史」(#6083)。形状照 设计同事 2026-09-23 给的参照(「直接 copy 这套会话历史」):
//   标题行(右侧一个动作)→ 搜索 + 一个分组筛选菜单 + 目录下拉 → 一目录一节(节头:文件夹图标、名字、
//   这个目录里出现过的 agent 图标、条数、···)→ 节内两行一条(标题 / 时间,右侧一个动作)。
// 我们自己多两样:按 session id 搜;节头的 agent 图标。
// 每节默认只露头 5 条、平铺、没有滚动条;随目录页也只带回这 5 条(主人 2026-09-25:「默认没有滑动条,点『显示更多』
// 之后才显示滑动条,否则前端压力太大;也不应该全部加载到内存里,应该是懒加载」)。点「显示更多」这一节才变成限高小窗,
// 当场按这一节要下一批,在窗里滚到底再要下一批;「收起」回到 5 条并把多要来的那些行扔掉。
// 只看某一节时(项目下拉选中它)不限高,整页就是这一节。
// 列表滚到底自动多要一批(❌ 翻页):不选目录时一批 = 若干个目录,选了目录时一批 = 若干条会话。
// 筛、排、聚合、截断都是主进程做完的(list-session-history),这里只按给定顺序画:本机索引是分轮的,
// 渲染侧对着半截索引排序会给出错的「最早 / 最晚」。
//
// 默认只看咕咕自己的会话(活跃 + 已归档):本机引擎磁盘上没导入的有几千条,默认混进来就把页面淹了
// (主人 2026-09-23 11:52 拍板);它们在筛选菜单「来源」里按引擎各一档。
//
// 行动作按状态分:活跃 → 打开;已归档 → 恢复回列表;未导入 → 导入(沿用导入管道:绑 provider 的
// session id、resume 原会话,❌ 搬副本)。批量导入 = 节头 ···「导入这一节未导入的」,行上不放勾选框。
//
// #6264 按机器(behavior gugu-server-multi-device「导入会话」):标题右边那一个机器选择器,默认本机。
// 选了别的机器,读的是那台机器的库与它磁盘上各家的原件,页面长相不变;导入 / 恢复 / 打开都作用在那台机器上
// —— 会话归原件所在的机器,❌ 原件跨机器搬。离线的也列着但选了只说一句它离线。

type SourceFilter = SessionHistorySource | 'all';
type StatusFilter = SessionHistoryStatus | 'all';
/** 目录筛选:undefined = 全部;null = 只看没有目录的;字符串 = 只看这个目录(与主进程参数同一含义)。 */
type DirectoryFilter = string | null | undefined;

/** 滚到底一次多要这么多(目录视图 = 目录数,只看某目录时 = 会话数)。 */
const BATCH_SIZE = 50;
/**
 * 每节默认露出几条 —— 随目录页也只带回这么多。❌ 一次把每节上百条都拉进渲染进程、都画出来:
 * 50 节 × 100 条就是 5000 行,本机原件一多面板就卡(主人 2026-09-25)。
 */
const SECTION_PREVIEW = 5;
/** 点开之后,小窗里每次多要这么多(当场一批,滚到窗底再一批)。 */
const SECTION_BATCH = 50;
/** 节头最多画几个 agent 图标:再多就成了一排噪音。 */
const SECTION_AGENT_ICONS = 3;
/** 搜索词像一个 session id 前缀时(不含空格、够长)才按「id 命中」高亮那一条;短词只是普通关键词。 */
const SESSION_ID_QUERY_MIN = 6;
const DEFAULT_SOURCE: SourceFilter = 'gugu';
/** 项目下拉的一档:value 编码同 encodeDirectory('' = 全部,NUL = 没有目录),label 是显示名,path 一起参与搜索。 */
type DirectoryOption = { value: string; label: string; path: string | null };
/** 目录下拉里「没有目录」那一档的选项值:下拉只认字符串,而这一档在主进程是 null;NUL 不可能是路径。 */
const NO_DIRECTORY_OPTION = '\u0000';

const SORT_KEY: Record<SessionHistorySort, SessionMessageKey> = {
  updated: 'sessionHistory.sortUpdated',
  lastPrompt: 'sessionHistory.sortLastPrompt',
  title: 'sessionHistory.sortTitle',
  added: 'sessionHistory.sortAdded',
};
/** 排序档照模板「排序方式」三档的顺序:更新时间 / 创建时间 / 按字母顺序。 */
const SORT_OPTIONS: readonly SessionHistorySort[] = ['updated', 'added', 'title'];

/** 一节 = 一个目录:从目录视图直接来,或「只看某目录」时由那一页会话拼成。 */
type Section = {
  key: string;
  directory: string | null;
  projectName: string | null;
  sessionCount: number;
  providers: string[];
  sessions: SessionHistoryRowData[];
  /** 这一节只带回了头几条,还有更多。 */
  truncated: boolean;
};

/** 在小窗里滚出来的那几批:按节 key 存,换筛选即清。`matched` 是那一路读法给的这一节总数。 */
type SectionPage = { rows: SessionHistoryRowData[]; matched: number };

function encodeDirectory(directory: DirectoryFilter): string {
  return directory === undefined ? '' : directory === null ? NO_DIRECTORY_OPTION : directory;
}

function decodeDirectory(value: string): DirectoryFilter {
  return value === '' ? undefined : value === NO_DIRECTORY_OPTION ? null : value;
}

function baseName(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/** 搜索词是不是某条会话的 session id(或 conversation id)的前缀:是就把那条当作「搜到的就是它」。 */
function matchesSessionId(row: SessionHistoryRowData, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length < SESSION_ID_QUERY_MIN || /\s/.test(q)) return false;
  return [row.providerSessionId, row.gugu?.sessionId].some((id) => !!id && id.toLowerCase().startsWith(q));
}

function uniqueProviders(rows: SessionHistoryRowData[]): string[] {
  const seen: string[] = [];
  for (const row of rows) if (row.providerId && !seen.includes(row.providerId)) seen.push(row.providerId);
  return seen;
}

// observer:名下机器上线 / 离线 / 改名时选择器跟着变。
export const SessionHistoryMainPanel = observer(function SessionHistoryMainPanel() {
  const { translate } = useSessionMessages();
  useEffect(() => remoteHostsStore.start(), []);
  const [deviceId, setDeviceId] = useState(LOCAL_IMPORT_DEVICE);
  const choices = importDeviceChoices(
    translate('task.deviceLocal'),
    [...remoteHostsStore.hosts.values()].map(({ device }) => device),
    (id) => remoteHostsStore.connectionState(id) === 'reconnecting'
  );
  const deviceState = importDeviceState(deviceId, choices);
  const deviceLabel = deviceState.device?.label ?? deviceId;
  // #7199 选了一台睡着的云电脑 = 要看它上面的会话:叫醒它(每次选中一次),醒了列表自己出来。
  useWakeCloudOnce(deviceState.device ? deviceId : null, deviceState.device ? (deviceState.device.cloudComputer === 'asleep' ? 'asleep' : 'other') : null);
  const wakeFailure = remoteHostsStore.wakeFailure(deviceId);
  const directTerminal = remoteHostsStore.device(deviceId)?.directTerminal === true;
  const importSource = useMemo(() => resolveImportSource(deviceId, directTerminal), [deviceId, directTerminal]);
  /** null = 本机。 */
  const machine = importSource.isLocal ? null : importSource.deviceId;
  const describe = (error: unknown, kind: 'list' | 'preview' | 'import') =>
    describeImportFailure(error, importSource, deviceLabel, kind, translate);
  const [source, setSource] = useState<SourceFilter>(DEFAULT_SOURCE);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [directory, setDirectory] = useState<DirectoryFilter>(undefined);
  const [sort, setSort] = useState<SessionHistorySort>('updated');
  const [rawQuery, setRawQuery] = useState('');
  const query = useDebounce(rawQuery, 200);
  const [limit, setLimit] = useState(BATCH_SIZE);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [sectionPages, setSectionPages] = useState<Readonly<Record<string, SectionPage>>>({});
  /** 点过「显示更多」的节:只有它们是限高小窗、会懒加载;其余节只露头几条。 */
  const [openSections, setOpenSections] = useState<ReadonlySet<string>>(() => new Set());
  const openSectionsRef = useRef(openSections);
  openSectionsRef.current = openSections;
  const [loadingSections, setLoadingSections] = useState<ReadonlySet<string>>(() => new Set());
  /** 换筛选 / 刷新就换一代:上一代还在路上的那批回来时直接丢掉,❌ 写进新筛选的节里。 */
  const sectionGeneration = useRef(0);
  const [isImporting, setIsImporting] = useState(false);
  const [importedCount, setImportedCount] = useState(0);
  const [outcomes, setOutcomes] = useState<ImportOutcome[] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  // 换任何筛选条件都从头要一批、收起详情。
  useEffect(() => {
    setLimit(BATCH_SIZE);
    setExpandedKey(null);
    sectionGeneration.current += 1;
    setSectionPages({});
    setOpenSections(new Set());
    setLoadingSections(new Set());
  }, [source, status, directory, sort, query, deviceId]);

  // 换机器 = 换一份清单:光标、上一次的报账与报错都属于上一台,一并清掉;项目下拉是那台机器的目录,回到全部。
  const selectDevice = (next: string) => {
    if (next === deviceId || isImporting) return;
    setDeviceId(next);
    setDirectory(undefined);
    setActiveKey(null);
    setOutcomes(null);
    setActionError(null);
  };

  const filters = {
    source: source === 'all' ? undefined : source,
    status: status === 'all' ? undefined : status,
    query,
    sort,
  };
  // 滚动加载 = 同一个请求把 limit 放大(主进程排好序再截,前面那截与上一批逐条相同),❌ 渲染侧拼多页。
  const paging = { limit };
  // 选了某个目录 = 只看那一节,按会话分页;没选 = 按目录分节、按目录分页,每节随行带回头几条。
  const narrowed = directory !== undefined;
  // 选着的机器离线了 / 不在名下了:问不到,不去问(只会挂满超时),下面直说。
  const reachable = deviceState.blocked === null;
  const sessions = useSessionHistory(narrowed && reachable ? { ...filters, directory, ...paging } : null, machine);
  const directories = useSessionHistoryDirectories(
    narrowed || !reachable ? null : { ...filters, ...paging, sessionsPerDirectory: SECTION_PREVIEW },
    machine
  );
  const current = narrowed ? sessions : directories;
  const data = current.page;

  const sections: Section[] = narrowed
    ? sessions.page && sessions.page.rows.length > 0
      ? [
          {
            key: directory ?? '',
            directory: directory ?? null,
            projectName:
              sessions.page.directories.find((entry) => entry.directory === directory)?.projectName ??
              sessions.page.rows.find((row) => row.projectName)?.projectName ??
              null,
            sessionCount: sessions.page.matched,
            providers: uniqueProviders(sessions.page.rows),
            sessions: sessions.page.rows,
            truncated: false,
          },
        ]
      : []
    : (directories.page?.rows ?? []).map((row) => ({
        key: row.key,
        directory: row.directory,
        projectName: row.projectName,
        sessionCount: row.sessionCount,
        providers: row.providers,
        sessions: row.sessions,
        truncated: row.sessionCount > row.sessions.length,
      }));
  // 一节眼下有哪些行:点开了、并且已经要来过更多的,就用那一批(它的头一截与目录页带回的逐条相同 —— 同一个排序,
  // 主进程排好再截);没点开的只露目录页带回的那几条。
  const isSectionOpen = (section: Section) => !narrowed && openSections.has(section.key);
  const sectionSessions = (section: Section) =>
    (isSectionOpen(section) ? sectionPages[section.key]?.rows : undefined) ?? section.sessions;
  const sectionHasMore = (section: Section) => {
    const page = sectionPages[section.key];
    return page ? page.rows.length < page.matched : section.truncated;
  };
  // 眼前的会话行(所有节拼起来):键盘光标与 session id 命中都对着它们。
  const rows = sections.flatMap(sectionSessions);
  const matched = data?.matched ?? 0;
  const loaded = narrowed ? rows.length : sections.length;
  const hasMore = loaded < matched;
  // 搜索词就是某条的 session id 前缀 → 那条就是用户要找的:光标落在它身上并上色。
  const idHit = query.trim() ? (rows.find((row) => matchesSessionId(row, query)) ?? null) : null;
  // activeKey 只记「用户点过哪条」,真正生效的光标在渲染时算:列表一变(换筛选、翻页、索引补进来一批),
  // 原来那条可能已经不在列表里,直接回落到第一条。❌ 用 effect 纠正 —— 那多一帧,而那一帧里动作指着一条
  // 已经不在列表里的会话。
  const active = rows.find((row) => row.key === activeKey) ?? idHit ?? rows[0] ?? null;
  const activeIndex = active ? rows.indexOf(active) : -1;
  const highlightedKey = rows.some((row) => row.key === activeKey) ? activeKey : (idHit?.key ?? null);

  // 列表末尾的哨兵进了视口就多要一批。limit 只增不减,上一批没回来时 loaded 不变 ⇒ 同一个 limit,不会连环触发。
  useEffect(() => {
    const node = moreRef.current;
    if (!node || !hasMore || current.isLoading) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setLimit((n) => Math.max(n, loaded + BATCH_SIZE));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loaded, current.isLoading]);

  // 光标换了一条才把它滚进视野 —— 按 key 认,❌ 按行对象:每一轮刷新、小窗里每来一批,行对象都是新的,
  // 按对象认会把光标那条(缺省是第一条)重新滚进来,正在往下翻的小窗和页面就被拽回顶上。
  const activeRowKey = active?.key ?? null;
  useEffect(() => {
    if (!activeRowKey) return;
    listRef.current
      ?.querySelector(`[data-row-key="${CSS.escape(activeRowKey)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeRowKey]);

  const refreshSessions = sessions.refresh;
  const refreshDirectories = directories.refresh;
  const refreshAll = useCallback(() => {
    refreshSessions();
    refreshDirectories();
    sectionGeneration.current += 1;
    setSectionPages({});
    setOpenSections(new Set());
    setLoadingSections(new Set());
  }, [refreshSessions, refreshDirectories]);

  // 归档 / 恢复不只发生在这个面板里:侧栏、⋯ 菜单、键盘连按两次、手机、agent 的 session_archive 都走所选机器上
  // 同一个 archiveSession / restoreSession,它每收一条、放回一条都发一次带 archivedAt 的 session:changed。
  // 面板开着时跟着它重拉;面板自己的「恢复」也靠这一条刷新(#6956)。❌ 轮询、❌ 定时刷新:没有这一条时,
  // 手机归档的那一行 10 秒后还写着 Open,点下去等满超时才报「打不开」。
  useEffect(
    () =>
      onMachineEvent(machine, sessionChangedChannel, ({ changes }) => {
        if ('archivedAt' in changes) refreshAll();
      }),
    [machine, refreshAll]
  );

  // 小窗滚到底:按这一节再要一批(同一套筛选 + 这一节,limit 放大;走本机索引的缓存 —— 目录页那几轮已经把它补新了)。
  // 同一节同时只要一批;回来的比手上的还少(索引在两次之间变了)就按回来的为准,❌ 拼两份。
  const inFlightSections = useRef(new Set<string>());
  const loadMoreInSection = useCallback(
    (section: Section) => {
      if (inFlightSections.current.has(section.key)) return;
      const have = sectionPages[section.key]?.rows.length ?? section.sessions.length;
      const generation = sectionGeneration.current;
      inFlightSections.current.add(section.key);
      setLoadingSections((current) => new Set(current).add(section.key));
      const settle = () => {
        inFlightSections.current.delete(section.key);
        setLoadingSections((current) => {
          const next = new Set(current);
          next.delete(section.key);
          return next;
        });
      };
      rpcOn(machine)
        .sessionHistory.list({
          source: source === 'all' ? undefined : source,
          status: status === 'all' ? undefined : status,
          query: query.trim() || undefined,
          sort,
          directory: section.directory,
          limit: have + SECTION_BATCH,
          mode: 'cached',
        })
        .then((page) => {
          if (generation !== sectionGeneration.current) return;
          // 在路上时这一节被收起了:这批不要了,❌ 攥在内存里。
          if (!openSectionsRef.current.has(section.key)) return;
          // 回来的没有比手上多 ⇒ 这一节已经到底(以回来的条数为准),不再要。
          const matched = page.rows.length > have ? page.matched : page.rows.length;
          setSectionPages((current) => ({ ...current, [section.key]: { rows: page.rows, matched } }));
        })
        .catch((error: unknown) => {
          if (generation !== sectionGeneration.current) return;
          log.error('load more sessions in a section failed', { key: section.key, error: String(error) });
          setActionError(messageForUser(error));
        })
        .finally(settle);
    },
    [sectionPages, source, status, query, sort, machine]
  );

  // 「显示更多」= 这一节变成限高小窗并当场要下一批;「收起」= 回到只露头几条,多要来的那些行一并扔掉。
  const openSection = (section: Section) => {
    const next = new Set(openSectionsRef.current).add(section.key);
    openSectionsRef.current = next;
    setOpenSections(next);
    loadMoreInSection(section);
  };
  const closeSection = (section: Section) => {
    const next = new Set(openSectionsRef.current);
    next.delete(section.key);
    openSectionsRef.current = next;
    setOpenSections(next);
    setSectionPages((current) => {
      const { [section.key]: _dropped, ...rest } = current;
      return rest;
    });
  };

  const selectRow = (row: SessionHistoryRowData) => {
    setActiveKey(row.key);
    // 点一下展开详情,再点一下收起 —— 详情住在这条下面,❌ 常驻的右栏。
    setExpandedKey((currentKey) => (currentKey === row.key ? null : row.key));
  };

  const openSession = async (ref: Omit<SessionHistoryGuguRef, 'runtime'>) => {
    // The one way a session is opened; another machine's with that machine and its project, so one the task list does not
    // draw opens too (the window mounts that machine's projects).
    try {
      await openLink({ kind: 'session', sessionId: ref.sessionId, projectId: ref.projectId, ...(machine ? { deviceId: machine } : {}) });
    } catch (e) {
      log.error('open session from session history failed', { ref, error: String(e) });
      setActionError(messageForUser(e));
    }
  };

  const restore = async (ref: Omit<SessionHistoryGuguRef, 'runtime'>) => {
    setActionError(null);
    try {
      if (machine) await remoteHostsStore.syncProjects(machine);
      // 会话 id 是这台机器从那台机器的应答里记下的,恢复的调用按它自己选线到那台机器。
      await restoreArchivedSession(ref);
      // 列表不在这里补刷:恢复发出的 session:changed 由上面那条订阅接住。
      toast({ title: translate('sessionHistory.restoredToast') });
    } catch (e) {
      log.error('restore archived session failed', { ref, error: String(e) });
      setActionError(messageForUser(e));
    }
  };

  const startImport = async (targets: SessionHistoryRowData[]) => {
    const sessionRows = targets.flatMap((row) => (row.local ? [row.local] : []));
    if (sessionRows.length === 0 || isImporting) return;
    setIsImporting(true);
    setActionError(null);
    setImportedCount(0);
    setOutcomes(null);
    try {
      // 建在所选那台机器上:原件在哪台,会话就归哪台。
      const results = await runImport(importSource, sessionRows, setImportedCount, (e) => describe(e, 'import'));
      const counts = countOutcomes(results);
      // 只导一条、且成功了 → 直接把用户送进那条会话;批量则留在面板里报账。
      const single = results.length === 1 ? results[0] : null;
      if (single && single.kind !== 'failed') {
        if (single.kind === 'existing') {
          toast({
            title: translate('sessionImport.alreadyImportedTitle'),
            description: translate('sessionImport.alreadyImportedDescription'),
          });
        }
        setIsImporting(false);
        await openSession({
          projectId: single.projectId,
          sessionId: single.sessionId,
        });
        return;
      }
      if (single && single.kind === 'failed') {
        // 导入失败的原文沿用导入面板从前那条文案(describeImportFailure 剥过壳 / 按机器说人话)。
        setActionError(translate('sessionImport.importFailed', { error: single.message }));
        setIsImporting(false);
        return;
      }
      setOutcomes(results);
      setIsImporting(false);
      if (counts.failed === 0) {
        toast({
          title: translate('sessionImport.importedToast', { count: counts.imported }),
          description:
            counts.existing > 0
              ? translate('sessionImport.existingToast', { count: counts.existing })
              : undefined,
        });
      }
      refreshAll();
    } catch (e) {
      log.error('import local session failed', e);
      setActionError(translate('sessionImport.importFailed', { error: describe(e, 'import') }));
      setIsImporting(false);
    }
  };

  const runAction = (row: SessionHistoryRowData) => {
    if (row.gugu && row.status === 'active') void openSession(row.gugu);
    else if (row.gugu && row.status === 'archived') {
      const { projectId, sessionId } = row.gugu;
      void restore({ projectId, sessionId });
    } else void startImport([row]);
  };

  // 键盘:上下移光标(跨节)、回车执行这一行的动作。焦点留在搜索框里也能用。
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (rows.length === 0) return;
    const target = event.target as Node | null;
    const fromSearch = target === searchRef.current;
    const fromList = !!target && !!listRef.current?.contains(target);
    if (!fromSearch && !fromList) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const base = activeIndex < 0 ? 0 : activeIndex;
      setActiveKey(rows[(base + delta + rows.length) % rows.length].key);
    } else if (event.key === 'Enter' && active) {
      event.preventDefault();
      runAction(active);
    }
  };

  const directoryFacet = data?.directories ?? [];
  const filtered = Boolean(
    query.trim() || source !== DEFAULT_SOURCE || status !== 'all' || directory !== undefined
  );
  const directoryLabel = (dir: string | null, projectName: string | null) =>
    dir === SESSION_HOME_SECTION_KEY
      ? translate('sessionHistory.taskHomeSection')
      : (projectName ?? (dir ? baseName(dir) : translate('sessionHistory.noDirectory')));
  // 候选 = 主进程给的全部目录(按条数倒序);从「查看全部」进来的目录若不在候选里(换了筛选)补上,选中项才有名字。
  const directoryOptions: DirectoryOption[] = [
    { value: '', label: translate('sessionHistory.directoryAll'), path: null },
    ...directoryFacet
      .filter((entry) => entry.directory !== null)
      .map((entry) => ({
        value: entry.directory!,
        label: directoryLabel(entry.directory, entry.projectName),
        path: entry.directory === SESSION_HOME_SECTION_KEY ? null : entry.directory,
      })),
    ...(typeof directory === 'string' && !directoryFacet.some((entry) => entry.directory === directory)
      ? [{ value: directory, label: directoryLabel(directory, null), path: directory }]
      : []),
    { value: NO_DIRECTORY_OPTION, label: translate('sessionHistory.noDirectory'), path: null },
  ];
  const directoryTriggerLabel =
    directoryOptions.find((option) => option.value === encodeDirectory(directory))?.label ??
    translate('sessionHistory.directoryAll');
  // 节头的名字 = 目录末级名(参照页就是「gugu」「Users」这样的一个词),完整路径悬停看。
  // 同一页里两节末级名撞了(一堆 …/task-home)才退回末两级,❌ 让两节长得一模一样。
  const baseNameCounts = new Map<string, number>();
  for (const section of sections) {
    if (section.directory && section.directory !== SESSION_HOME_SECTION_KEY && !section.projectName) {
      const name = baseName(section.directory);
      baseNameCounts.set(name, (baseNameCounts.get(name) ?? 0) + 1);
    }
  }
  const sectionLabel = (section: Section) => {
    if (section.projectName) return section.projectName;
    if (!section.directory) return translate('sessionHistory.noDirectory');
    if (section.directory === SESSION_HOME_SECTION_KEY) return translate('sessionHistory.taskHomeSection');
    const name = baseName(section.directory);
    return (baseNameCounts.get(name) ?? 0) > 1 ? shortenPath(section.directory, '') : name;
  };
  // 筛选菜单的触发钮上写着当前生效的筛选;默认(咕咕会话、不筛状态 / 时间)就写「咕咕会话」。
  const filterSummary = [
    source === 'all'
      ? translate('sessionHistory.sourceAll')
      : source !== DEFAULT_SOURCE
        ? translate('sessionHistory.sourceLocal', { engine: sourceLabel(source, translate) })
        : null,
    status !== 'all' ? translate(STATUS_MESSAGE_KEY[status]) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <PageLayout>
      {/* 几何照 设计同事 2026-09-23 的模板图量出来(1728×1050 视口):内容列 768px 居中、标题顶 64px、
          标题到筛选行 48px、筛选行到第一节 36px、节与节之间 48px。 */}
      <PageContent className="flex min-h-0 max-w-3xl flex-col pt-16 pb-12">
        <div onKeyDown={handleKeyDown} className="flex min-h-0 flex-col">
          {/* 标题行:左标题,右侧只在批量导入时显示进度(模板右侧是「全部删除」,我们不做删除)。 */}
          <div className="flex min-h-8 items-center justify-between gap-4 [-webkit-app-region:drag]">
            {/* #6264 看哪台机器:标题右边那一个机器选择器(与资源库、已安排、设置同一个组件、同一个位置)。 */}
            <div className="flex min-w-0 items-center gap-3">
              <h2 className="shrink-0 font-display text-2xl leading-8 font-normal text-foreground">{translate('sessionHistory.title')}</h2>
              <div data-testid="session-history-device" className="flex min-w-0 [-webkit-app-region:no-drag]">
                <MachinePicker machines={choices} selectedId={deviceId} onSelect={selectDevice} />
              </div>
            </div>
            {isImporting ? (
              <span className="flex items-center gap-2 text-xs text-foreground-muted" role="status" data-testid="session-history-importing">
                <Spinner size="sm" />
                {translate('sessionHistory.importingCount', { count: importedCount })}
              </span>
            ) : null}
          </div>

          {/* 筛选行(模板):搜索框占满剩余宽度 + 筛选菜单(类型 / 状态 / 排序方式)+ 项目下拉。
              搜索框用输入框统一的圆角矩形(与自动化 / 提示词库 / MCP / Agent 设置的搜索框同形),❌ 单独改胶囊(owner 2026-09-27)。 */}
          <div className="mt-12 flex flex-wrap items-center gap-2">
            <SearchInput
              ref={searchRef}
              autoFocus
              value={rawQuery}
              onChange={(event) => setRawQuery(event.target.value)}
              placeholder={translate('sessionHistory.searchPlaceholder')}
              aria-label={translate('sessionHistory.searchLabel')}
              role="combobox"
              aria-expanded={rows.length > 0}
              aria-controls="session-history-list"
              aria-activedescendant={active ? historyOptionId(active.key) : undefined}
              containerClassName="min-w-56 flex-1"
              data-testid="session-history-search"
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    className="w-36 justify-start font-normal text-foreground"
                    data-testid="session-history-filter"
                  />
                }
              >
                <ListFilter className="size-4 text-foreground-muted" />
                <span className="min-w-0 flex-1 truncate text-left">
                  {filterSummary || translate('sessionHistory.filterDefault')}
                </span>
                <ChevronDown className="size-4 text-foreground-muted" />
              </DropdownMenuTrigger>
              {/* 档名带引擎名和「本机未导入」,窄了会折成两行:给够宽度,档名不换行。 */}
              <DropdownMenuContent align="start" className="min-w-56 whitespace-nowrap">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{translate('sessionHistory.colSource')}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={source} onValueChange={(value) => setSource(value as SourceFilter)}>
                    <DropdownMenuRadioItem value="all" data-testid="session-history-filter-source-all">
                      {translate('sessionHistory.sourceAll')}
                    </DropdownMenuRadioItem>
                    {SESSION_HISTORY_SOURCES.map((value) => (
                      <DropdownMenuRadioItem key={value} value={value} data-testid={`session-history-filter-source-${value}`}>
                        {/* 本机引擎这几档里全是还没导入的(导入过的已经是咕咕会话),档名上说清楚。 */}
                        {value === 'gugu'
                          ? translate('sessionHistory.filterDefault')
                          : translate('sessionHistory.sourceLocal', { engine: sourceLabel(value, translate) })}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{translate('sessionHistory.colStatus')}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={status} onValueChange={(value) => setStatus(value as StatusFilter)}>
                    <DropdownMenuRadioItem value="all" data-testid="session-history-filter-status-all">
                      {translate('sessionHistory.statusAll')}
                    </DropdownMenuRadioItem>
                    {SESSION_HISTORY_STATUSES.map((value) => (
                      <DropdownMenuRadioItem key={value} value={value} data-testid={`session-history-filter-status-${value}`}>
                        {translate(STATUS_MESSAGE_KEY[value])}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{translate('sessionHistory.sortLabel')}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={sort} onValueChange={(value) => setSort(value as SessionHistorySort)}>
                    {SORT_OPTIONS.map((value) => (
                      <DropdownMenuRadioItem key={value} value={value} data-testid={`session-history-filter-sort-${value}`}>
                        {translate(SORT_KEY[value])}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {/* 项目下拉:可搜索(按项目名或路径),列出全部目录 —— 本机原件动辄上千个目录,❌ 只列前几个。 */}
            <Combobox
              items={directoryOptions}
              value={directoryOptions.find((option) => option.value === encodeDirectory(directory)) ?? null}
              onValueChange={(option: DirectoryOption | null) => {
                if (option) setDirectory(decodeDirectory(option.value));
              }}
              isItemEqualToValue={(a: DirectoryOption, b: DirectoryOption) => a.value === b.value}
              itemToStringLabel={(option: DirectoryOption) => option.label}
              filter={(option: DirectoryOption, text: string) => {
                const needle = text.trim().toLowerCase();
                return !needle || `${option.label}\n${option.path ?? ''}`.toLowerCase().includes(needle);
              }}
              autoHighlight
            >
              <ComboboxTrigger
                render={
                  <Button
                    variant="outline"
                    className="w-44 justify-start font-normal text-foreground"
                    aria-label={translate('sessionHistory.directoryLabel')}
                    data-testid="session-history-directory"
                  />
                }
              >
                <Folder className="size-4 text-foreground-muted" />
                <span className="min-w-0 flex-1 truncate text-left">{directoryTriggerLabel}</span>
                <ChevronDown className="size-4 text-foreground-muted" />
              </ComboboxTrigger>
              {/* 目录名动辄三四级路径,下拉按触发钮那么宽会截成「…/worktr…」:给它一个像样的宽度。 */}
              <ComboboxContent align="end" className="w-96">
                <ComboboxInput
                  showTrigger={false}
                  placeholder={translate('sessionHistory.directorySearch')}
                  data-testid="session-history-directory-search"
                />
                <ComboboxEmpty>{translate('sessionHistory.directoryNoMatch')}</ComboboxEmpty>
                <ComboboxList>
                  <ComboboxCollection>
                    {(option: DirectoryOption) => (
                      <ComboboxItem
                        key={option.value}
                        value={option}
                        data-testid={
                          option.value === ''
                            ? 'session-history-directory-all'
                            : option.value === NO_DIRECTORY_OPTION
                              ? 'session-history-directory-none'
                              : `session-history-directory-${option.value}`
                        }
                      >
                        <Folder className="size-4 shrink-0 text-foreground-muted" />
                        <span className="min-w-0 flex-1 truncate" title={option.path ?? undefined}>
                          {option.label}
                        </span>
                        {option.path ? (
                          // 路径是「你会敲出来的东西」,design.md:Mono 只干这一件事。
                          <span className="max-w-40 shrink truncate font-mono text-xs text-foreground-muted">
                            {shortenPath(option.path, '')}
                          </span>
                        ) : null}
                      </ComboboxItem>
                    )}
                  </ComboboxCollection>
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </div>

          {outcomes ? (
            <div className="mt-6 flex flex-col gap-2">
              <ImportSummary outcomes={outcomes} />
              <Button variant="ghost" size="sm" className="self-start" onClick={() => setOutcomes(null)}>
                {translate('common.close')}
              </Button>
            </div>
          ) : null}

          {/* 正文:一个项目一节。节头一行在面板外;面板 = 密度底色 + 6px 圆角,无外框、行间无线(ui-visual-spec §6.6)。 */}
          <div
            ref={listRef}
            id="session-history-list"
            role="listbox"
            aria-label={translate('sessionHistory.title')}
            aria-busy={current.isLoading || current.isIndexing}
            data-testid="session-history-list"
            className="mt-9 flex flex-col gap-12"
          >
            {deviceState.blocked ? (
              <div className="p-8 text-center" data-testid="session-history-device-blocked">
                <p className="text-sm leading-relaxed text-foreground-muted">
                  {deviceState.blocked === 'gone'
                    ? translate('sessionImport.deviceGone')
                    : deviceState.blocked === 'waking'
                      ? wakeFailure
                        ? cloudWakeFailureText(wakeFailure, deviceLabel, translate)
                        : translate('sessionImport.deviceWaking', { device: deviceLabel })
                    : (() => {
                        const ago = formatAgo(deviceState.device?.lastSeenAt, Date.now(), translate);
                        return ago
                          ? translate('sessionImport.deviceOffline', { device: deviceLabel, ago })
                          : translate('sessionImport.deviceOfflineNever', { device: deviceLabel });
                      })()}
                </p>
              </div>
            ) : current.isLoading ? (
              <div className="flex items-center justify-center gap-2 p-8 text-sm text-foreground-muted">
                <Spinner size="sm" />
                {translate('sessionImport.loading')}
              </div>
            ) : current.error ? (
              <div className="p-8 text-center">
                <p className="text-sm leading-relaxed text-foreground-destructive">
                  {/* 整句由 describeImportFailure 给:本机的原始诊断只作为插值穿过外壳,别的机器按原因说人话。 */}
                  {describe(current.cause, 'list')}
                </p>
                <Button size="sm" variant="outline" className="mt-3" onClick={refreshAll}>
                  {translate('common.retry')}
                </Button>
              </div>
            ) : sections.length === 0 ? (
              <div className="p-8 text-center" data-testid="session-history-empty">
                <p className="text-sm text-foreground-muted">
                  {filtered ? translate('sessionImport.emptyNoMatch') : translate('sessionHistory.emptyNone')}
                </p>
                {current.isIndexing && (
                  <p className="mt-1 text-xs leading-relaxed text-foreground-tertiary-muted">
                    {translate('sessionImport.emptyHintIndexing')}
                  </p>
                )}
              </div>
            ) : (
              sections.map((section) => {
                const sectionRows = sectionSessions(section);
                return (
                  <section key={section.key} data-testid="session-history-section" data-directory-key={section.key}>
                    <div className="mb-3 flex h-7 items-center gap-2 px-2">
                      <Folder className="size-4 shrink-0 text-foreground-muted" />
                      <span
                        className="truncate text-sm text-foreground"
                        title={section.directory === SESSION_HOME_SECTION_KEY ? undefined : (section.directory ?? undefined)}
                        data-testid="session-history-section-name"
                      >
                        {sectionLabel(section)}
                      </span>
                      {/* 我们的特色之一:这个目录里出现过的 agent,一排图标(最多 3 个)。 */}
                      {section.providers.length > 0 ? (
                        <span className="flex shrink-0 items-center gap-1" data-testid="session-history-section-agents">
                          {section.providers.slice(0, SECTION_AGENT_ICONS).map((providerId) => (
                            <AgentIcon key={providerId} id={providerId} size={14} />
                          ))}
                        </span>
                      ) : null}
                      <span className="ml-auto shrink-0 text-sm text-foreground-muted tabular-nums">
                        {translate('sessionHistory.sectionCount', { count: section.sessionCount })}
                      </span>
                      {/* ❌ 节头 ···(owner 2026-09-26):它里面的「查看全部」与小窗下的「显示更多」重复 —— 展开一节用「显示更多」,
                          只看一个项目用顶上的项目下拉;批量导入一并去掉,每行自己的「导入」还在。 */}
                    </div>
                    <SessionHistorySectionBox
                      capped={isSectionOpen(section)}
                      hasMore={isSectionOpen(section) && sectionHasMore(section)}
                      isLoadingMore={loadingSections.has(section.key)}
                      onReachEnd={() => loadMoreInSection(section)}
                    >
                      {sectionRows.map((row) => (
                        <SessionHistoryRow
                          key={row.key}
                          row={row}
                          isSelected={row.key === active?.key}
                          isHighlighted={row.key === highlightedKey}
                          isExpanded={expandedKey === row.key}
                          onSelect={() => selectRow(row)}
                          onAction={() => runAction(row)}
                          previewSource={importSource}
                          describePreviewError={(e) => describe(e, 'preview')}
                        />
                      ))}
                    </SessionHistorySectionBox>
                    {!narrowed && (section.truncated || isSectionOpen(section)) ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="mt-1 ml-2 text-foreground-muted"
                        data-testid={isSectionOpen(section) ? 'session-history-section-show-less' : 'session-history-section-show-more'}
                        aria-expanded={isSectionOpen(section)}
                        onClick={() => (isSectionOpen(section) ? closeSection(section) : openSection(section))}
                      >
                        {isSectionOpen(section)
                          ? translate('sessionHistory.showLess')
                          : translate('sessionHistory.showMore', { count: section.sessionCount })}
                      </Button>
                    ) : null}
                  </section>
                );
              })
            )}
          </div>

          {/* 脚部:滚动加载的哨兵 + 索引进度。模板上没有总计行 —— 总计只给读屏。 */}
          <div ref={moreRef} className="mt-6 flex min-h-4 flex-wrap items-center gap-3 text-xs text-foreground-muted">
            {hasMore ? <Spinner size="sm" /> : null}
            <span data-testid="session-history-total" className="sr-only">
              {narrowed
                ? translate('sessionHistory.total', { count: matched })
                : translate('sessionHistory.totalDirectories', { count: matched })}
            </span>
            {data && current.isIndexing && data.local ? (
              <span className="flex items-center gap-2" data-testid="session-history-progress" role="status" aria-live="polite">
                <Spinner size="sm" />
                {translate('sessionImport.indexing', { indexed: data.local.indexed, discovered: data.local.discovered })}
              </span>
            ) : null}
            {data && data.local === null ? <span>{translate('sessionHistory.localUnavailable')}</span> : null}
          </div>

          {actionError ? (
            <p className="text-sm leading-relaxed text-foreground-destructive">{actionError}</p>
          ) : null}
        </div>
      </PageContent>
    </PageLayout>
  );
});

export function SessionHistoryTitlebar() {
  return <ShellTitlebar />;
}

export const sessionHistoryView = {
  TitlebarSlot: SessionHistoryTitlebar,
  MainPanel: SessionHistoryMainPanel,
} satisfies ViewDefinition;
