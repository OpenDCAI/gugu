import {
  BROWSER_DEFAULT_URL,
  BROWSER_PARTITION_PREFIX,
  BROWSER_TAB_URL_OPTIONS,
  normalizeBrowserUrl,
} from '@shared/browser';
import { PREVIEW_SCHEME } from '@shared/preview/preview-url';

const BROWSER_PARTITION_INSTANCE_PREFIX = `${BROWSER_PARTITION_PREFIX}-`;

export type WebviewAttachParams = {
  src?: string;
  partition?: string;
  preload?: string;
  [key: string]: unknown;
};

export type WebviewPreferences = {
  nodeIntegration?: boolean;
  nodeIntegrationInSubFrames?: boolean;
  nodeIntegrationInWorker?: boolean;
  contextIsolation?: boolean;
  sandbox?: boolean;
  webSecurity?: boolean;
  allowRunningInsecureContent?: boolean;
  /** Whether the guest may embed <webview>s of its own — nesting is a capability. */
  webviewTag?: boolean;
  /** Comma-separated Chromium runtime-enabled features the guest is built without. */
  disableBlinkFeatures?: string;
  preload?: string;
};

export type BrowserPageMountValidation =
  | { ok: true; partition: string; url: string }
  | { ok: false; reason: 'missing-partition' | 'unregistered-partition' | 'unsupported-url' };

export function isBrowserPartition(partition: string): boolean {
  return partition.startsWith(BROWSER_PARTITION_INSTANCE_PREFIX);
}

/**
 * #7274 页签要建网页之前核对:分区是登记过的浏览器配置、首个地址是浏览器页签能开的(或咕咕自己的预览协议)。
 */
export function validateBrowserPageMount(
  params: { partition?: string; src?: string },
  registeredPartitions: ReadonlySet<string>
): BrowserPageMountValidation {
  const partition = typeof params.partition === 'string' ? params.partition : '';
  if (!isBrowserPartition(partition)) {
    return { ok: false, reason: 'missing-partition' };
  }
  if (!registeredPartitions.has(partition)) {
    return { ok: false, reason: 'unregistered-partition' };
  }

  const src = typeof params.src === 'string' && params.src.trim() ? params.src : BROWSER_DEFAULT_URL;
  // #6264 别的机器上的网页:首个地址可能已经改写成 `gugu-preview://<id>/…`。那是咕咕自己的预览协议(分区里的
  // handler 只认浏览器页签的登记,id 即授权),❌ 当成不支持的地址拒掉 —— 拒掉的症状是页签永远白屏(d22 实机)。
  if (isPreviewPageUrl(src)) return { ok: true, partition, url: src };
  const normalized = normalizeBrowserUrl(src, BROWSER_TAB_URL_OPTIONS);
  if (!normalized.ok) {
    return { ok: false, reason: 'unsupported-url' };
  }

  return { ok: true, partition, url: normalized.url };
}

/** `gugu-preview://<id>/…`:咕咕自己的预览协议地址(有 id、能解析)。 */
export function isPreviewPageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${PREVIEW_SCHEME}:` && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}
