import type { PluginIconAsset } from '@gugu/session-shared/plugins';

// 企业邮箱不是哪一家的品牌(腾讯企业邮、网易企业邮、阿里邮箱……都走这一个),给一个中性的信封;蓝色在明暗两套下都看得清。
const svg =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="4" width="20" height="16" rx="3" fill="#2F6BFF"/><path d="M5.5 8l6.5 4.6L18.5 8" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export const icon: PluginIconAsset = {
  kind: 'svg',
  alt: '企业邮箱',
  variants: [
    {
      minSize: 0,
      light: svg,
    },
  ],
};
