import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3, BookOpen, Checklist, Compass, Globe, Sun, TrendingUp, WalletCards, X, Zap } from '@/lib/icons';

/**
 * #7199 「发现组件」:推荐几个起点 + 「描述你想持续关注的内容…」,加上以后由它负责按时更新。
 * 不走服务端的模板目录与 plan(追问 1–3 个)/ create(建定时任务)接口 ——
 * 这两步交给它在聊天里做:「添加组件」把一句带着需求的话接进输入框(只填不发,人按发送那一下就是确认),
 * 它先问清盯什么、多久更新、几点前要好,再往 today.json 的 widgets 里加一张、给自己排定时任务按时重写它。
 * 推荐的起点是写死的一份(统一的一套,❌ 按人现生成);点一个 = 把它的起始需求填进下面的框,人可以改。
 * 桌面包一层对话框、手机推一页(❌ 底部抽屉),里面这一份共用。
 */

type TemplateId = 'weather' | 'todos' | 'news' | 'stocks' | 'competitors' | 'industry' | 'spending' | 'flights' | 'learning';
const TEMPLATE_GROUPS: readonly { id: 'day' | 'watch' | 'life'; templates: readonly { id: TemplateId; icon: ReactNode }[] }[] = [
  {
    id: 'day',
    templates: [
      { id: 'weather', icon: <Sun /> },
      { id: 'todos', icon: <Checklist /> },
      { id: 'news', icon: <Globe /> },
    ],
  },
  {
    id: 'watch',
    templates: [
      { id: 'stocks', icon: <TrendingUp /> },
      { id: 'competitors', icon: <BarChart3 /> },
      { id: 'industry', icon: <Zap /> },
    ],
  },
  {
    id: 'life',
    templates: [
      { id: 'spending', icon: <WalletCards /> },
      { id: 'flights', icon: <Compass /> },
      { id: 'learning', icon: <BookOpen /> },
    ],
  },
];

export function WidgetDiscover({ name, askInChat, onClose, layout }: { name: string; askInChat: (draft: string) => void; onClose: () => void; layout: 'dialog' | 'page' }) {
  const { t } = useTranslation('assistant');
  const [want, setWant] = useState('');
  const [picked, setPicked] = useState<TemplateId | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const pick = (id: TemplateId) => {
    setPicked(id);
    setWant(t(`today.discover.template.${id}.starter`));
    // 起始需求多半要人补一句(「哪几只股票」):光标放到末尾,接着写。
    requestAnimationFrame(() => {
      const box = input.current;
      if (!box) return;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    });
  };
  const add = () => {
    const text = want.trim();
    if (!text) return;
    askInChat(t('today.discover.request', { want: text }));
    onClose();
  };
  return (
    <div className="ta-discover" data-layout={layout} data-testid="assistant-widget-discover">
      <div className="ta-discover-head">
        <div className="min-w-0">
          <h2 className="ta-dialog-title">{t('today.discover.title')}</h2>
          <p className="ta-page-sub">{t('today.discover.sub', { name })}</p>
        </div>
        {layout === 'dialog' ? (
          <button type="button" className="ta-circle" aria-label={t('today.discover.close')} onClick={onClose}>
            <X />
          </button>
        ) : null}
      </div>
      <div className="ta-discover-groups">
        {TEMPLATE_GROUPS.map((group) => (
          <section key={group.id} className="ta-section" data-testid={`assistant-discover-group-${group.id}`}>
            <h3 className="ta-section-title">{t(`today.discover.group.${group.id}`)}</h3>
            <div className="ta-discover-grid">
              {group.templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className="ta-tile ta-discover-tile"
                  aria-pressed={picked === template.id}
                  onClick={() => pick(template.id)}
                  data-testid={`assistant-discover-${template.id}`}
                >
                  <span className="ta-tile-icon">{template.icon}</span>
                  <span className="ta-tile-title">{t(`today.discover.template.${template.id}.title`)}</span>
                  <span className="ta-tile-sub">{t(`today.discover.template.${template.id}.body`)}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      <div className="ta-discover-compose">
        <textarea
          ref={input}
          className="ta-input"
          value={want}
          placeholder={t('today.discover.placeholder')}
          onChange={(e) => {
            setWant(e.target.value);
            if (!e.target.value.trim()) setPicked(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add();
          }}
          data-testid="assistant-discover-input"
        />
        <p className="ta-tile-sub ta-pad">{picked ? t('today.discover.startingPoint') : t('today.discover.hint', { name })}</p>
        <button type="button" className="ta-wide-btn" data-tone="primary" onClick={add} disabled={!want.trim()} data-testid="assistant-discover-add">
          {t('today.addWidget')}
        </button>
      </div>
    </div>
  );
}
