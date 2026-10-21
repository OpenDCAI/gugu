import z from 'zod';

/**
 * 插件写给人看的一句话,中英两份都由插件自己带(owner 方向经 125 10-07:插件自描述,加一家集成不动渲染层)。
 * ❌ 不收纯字符串:一个口子两种形状就是两条路,哪家漏了中文也查不出来。
 * 线上不走这个形状:主进程按请求方的界面语言解析成一句话,没给 / 不认的语言用 `en`
 * (`apps/desktop/electron/session/main/core/integrations/integration-payload-builder.ts`)——
 * 老桌面把这几格直接当文本画,对象会让它整页抛错。
 */
export const localizedTextSchema = z.object({
  en: z.string().min(1),
  'zh-CN': z.string().min(1),
});

export type LocalizedText = z.infer<typeof localizedTextSchema>;
