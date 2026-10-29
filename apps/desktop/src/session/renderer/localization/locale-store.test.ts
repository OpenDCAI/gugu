import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { enUSMessages, type SessionMessageLookupKey, zhCNMessages } from './messages';
import { enUSProjectMessages } from './messages-projects';
import { registerSessionLocaleResources, translateSessionMessage } from './locale-store';

const pluralSuffix = /_(zero|one|two|few|many|other)$/;
type MessageCatalog = Readonly<Record<string, string>>;
const projectMessagePrefix = /^(browser|projects)\./;

function projectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return projectSourceFiles(path);
    if (!['.ts', '.tsx'].includes(extname(entry.name)) || entry.name.includes('.test.')) return [];
    return [path];
  });
}

function projectConsumerKeys(): string[] {
  const featuresRoot = fileURLToPath(new URL('../features/', import.meta.url));
  const keys = new Set<string>();

  // 项目目录之外也有项目词条的读者:侧栏的项目行,和示例项目那一块(#709)。
  for (const domain of ['browser', 'projects', 'sidebar', 'sample-project']) {
    for (const path of projectSourceFiles(join(featuresRoot, domain))) {
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) && projectMessagePrefix.test(node.text)) {
          keys.add(node.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }

  return [...keys].sort();
}

/**
 * The same connectedness rule, applied to the task catalog's `tabs.` domain.
 *
 * 加这一条是因为原来的检查只覆盖 project 目录:把 `tabs.unavailableTitle` 的用法改回硬编码
 * 英文,三条 i18n 闸全绿 —— 实测过。一个抓不住回退的闸等于没有,而「文案硬编码」正是这
 * 个域最容易复发的那种改动。
 */
function tabsConsumerKeys(): string[] {
  const tabsRoot = fileURLToPath(new URL('../features/tabs/', import.meta.url));
  const keys = new Set<string>();

  for (const path of projectSourceFiles(tabsRoot)) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) && node.text.startsWith('tabs.')) keys.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return [...keys].sort();
}

function tabsCatalogLookupKeys(): string[] {
  return [
    ...new Set(
      Object.keys(enUSMessages)
        .filter((key) => key.startsWith('tabs.'))
        .map((key) => key.replace(pluralSuffix, ''))
    ),
  ].sort();
}

function projectCatalogLookupKeys(): string[] {
  return [
    ...new Set(
      Object.keys(enUSProjectMessages).map((key) => key.replace(pluralSuffix, ''))
    ),
  ].sort();
}

function interpolationVariables(message: string): string[] {
  return [...message.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)]
    .map((match) => match[1])
    .sort();
}

function incompletePluralForms(messages: MessageCatalog): string[] {
  const pluralForms = new Map<string, Set<string>>();

  for (const key of Object.keys(messages)) {
    const match = key.match(pluralSuffix);
    if (!match) continue;
    const base = key.slice(0, -match[0].length);
    const forms = pluralForms.get(base) ?? new Set<string>();
    forms.add(match[1]);
    pluralForms.set(base, forms);
  }

  return [...pluralForms].flatMap(([base, forms]) => [
    ...(forms.has('one') ? [] : [`${base}_one`]),
    ...(forms.has('other') ? [] : [`${base}_other`]),
  ])
    .sort();
}

function assertSessionCatalogsAligned(enUS: MessageCatalog, zhCN: MessageCatalog): void {
  const enUSKeys = Object.keys(enUS).sort();
  const zhCNKeys = Object.keys(zhCN).sort();
  const missingInZhCN = enUSKeys.filter((key) => !(key in zhCN));
  const unexpectedInZhCN = zhCNKeys.filter((key) => !(key in enUS));
  if (missingInZhCN.length || unexpectedInZhCN.length) {
    throw new Error(
      `Task catalog key parity mismatch: missing in zh-CN [${missingInZhCN.join(', ')}]; ` +
        `unexpected in zh-CN [${unexpectedInZhCN.join(', ')}]`
    );
  }

  for (const key of enUSKeys) {
    const enUSVariables = interpolationVariables(enUS[key]);
    const zhCNVariables = interpolationVariables(zhCN[key]);
    if (enUSVariables.join('\0') !== zhCNVariables.join('\0')) {
      throw new Error(
        `Task catalog interpolation mismatch at ${key}: ` +
          `en-US [${enUSVariables.join(', ')}]; zh-CN [${zhCNVariables.join(', ')}]`
      );
    }
  }

  const enUSMissingPluralForms = incompletePluralForms(enUS);
  const zhCNMissingPluralForms = incompletePluralForms(zhCN);
  if (enUSMissingPluralForms.length || zhCNMissingPluralForms.length) {
    throw new Error(
      `Task catalog plural pairing mismatch: en-US missing [${enUSMissingPluralForms.join(', ')}]; ` +
        `zh-CN missing [${zhCNMissingPluralForms.join(', ')}]`
    );
  }
}

describe('task locale resources', () => {
  afterEach(async () => {
    await i18n.changeLanguage('zh-CN');
  });

  it('keeps task catalog keys, interpolation variables, and plural forms aligned', () => {
    expect(() => assertSessionCatalogsAligned(enUSMessages, zhCNMessages)).not.toThrow();
  });

  it('keeps unrecoverable-conversation copy focused on user state and actions', () => {
    const keys = [
      'chat.providerSessionMissingTitle',
      'chat.providerSessionMissingDescription',
      'chat.providerSessionMissingLegacyDescription',
    ] as const;
    const enUSCopy = keys.map((key) => enUSMessages[key]).join(' ');
    const zhCNCopy = keys.map((key) => zhCNMessages[key]).join(' ');

    expect(enUSCopy).not.toMatch(/provider|engine|recording|session identity|honest way|shell/i);
    expect(zhCNCopy).not.toMatch(/Provider|引擎|首轮|咕咕|空壳|诚实的出路|存量/);
    expect(enUSMessages['chat.providerSessionMissingAction']).toBe('Start again');
    expect(zhCNMessages['chat.providerSessionMissingAction']).toBe('重新开始');
    // #6949: the dead end offers archiving (the button reuses「归档任务」), never deleting.
    expect(enUSMessages['chat.providerSessionMissingLegacyDescription']).not.toMatch(/delete/i);
    expect(zhCNMessages['chat.providerSessionMissingLegacyDescription']).not.toMatch(/删除/);
  });

  it('identifies a missing locale key', () => {
    const enUS = { 'test.parity': 'Parity' };
    const zhCN = {};
    // These fixtures are intentionally invalid. Repairing one must fail its meta-test.
    expect(zhCN).not.toHaveProperty('test.parity');
    expect(() =>
      assertSessionCatalogsAligned(enUS, zhCN)
    ).toThrow('missing in zh-CN [test.parity]');
  });

  it('identifies an interpolation mismatch', () => {
    const enUS = { 'test.greeting': 'Hello {name}' };
    const zhCN = { 'test.greeting': '你好，{person}' };
    expect(interpolationVariables(enUS['test.greeting'])).not.toEqual(
      interpolationVariables(zhCN['test.greeting'])
    );
    expect(() =>
      assertSessionCatalogsAligned(enUS, zhCN)
    ).toThrow('interpolation mismatch at test.greeting');
  });

  it('identifies a missing plural form', () => {
    const enUS = { 'test.files_one': '{count} file' };
    const zhCN = { 'test.files_one': '{count} 个文件' };
    expect(enUS).not.toHaveProperty('test.files_other');
    expect(zhCN).not.toHaveProperty('test.files_other');
    expect(() =>
      assertSessionCatalogsAligned(enUS, zhCN)
    ).toThrow('plural pairing mismatch: en-US missing [test.files_other]');
  });

  it('registers the task namespace and translates synchronously', async () => {
    registerSessionLocaleResources();
    await i18n.changeLanguage('en-US');
    expect(translateSessionMessage('chat.modelUnavailableTitle', { agentName: 'Codex' })).toBe(
      'Codex cannot run on the selected model.'
    );
    await i18n.changeLanguage('zh-CN');
    expect(translateSessionMessage('chat.modelUnavailableTitle', { agentName: 'Codex' })).toBe(
      'Codex 无法使用所选模型。'
    );
  });

  it('translates project chrome in both supported locales', async () => {
    registerSessionLocaleResources();
    await i18n.changeLanguage('en-US');
    expect(translateSessionMessage('browser.urlLabel')).toBe('Browser URL');
    // 原本用 projects.remote.hostFromLocalConfig 当样本;远程项目入口 2026-09-05 下线后
    // 那个键连同目录一并删了(#5052)。换一个仍在的项目域带插值键,覆盖意图不变:
    // 「项目域文案在两个 locale 都译得出、且插值真的被替换」。
    expect(translateSessionMessage('projects.error.notFoundAtPath', { path: '/tmp/build-box' })).toBe(
      'No project found at /tmp/build-box'
    );
    await i18n.changeLanguage('zh-CN');
    expect(translateSessionMessage('browser.urlLabel')).toBe('浏览器地址');
    expect(translateSessionMessage('projects.error.notFoundAtPath', { path: '/tmp/build-box' })).toBe(
      '在 /tmp/build-box 找不到项目'
    );
  });

  it('keeps every project catalog lookup key connected to production code', () => {
    expect(projectConsumerKeys()).toEqual(projectCatalogLookupKeys());
  });

  it('keeps every tabs catalog key connected to production code', () => {
    // Both directions matter: an orphaned key means the UI went back to a literal,
    // and a consumed key that is missing from the catalog fails loudly at lookup.
    expect(tabsConsumerKeys()).toEqual(tabsCatalogLookupKeys());
  });

  it('resolves plural resources with the same count used for translation', async () => {
    const pluralLookupKey: SessionMessageLookupKey<
      'test.pluralFiles_one' | 'test.pluralFiles_other'
    > = 'test.pluralFiles';
    registerSessionLocaleResources();
    i18n.addResource('en-US', 'session', 'test.pluralFiles_one', '{count} file');
    i18n.addResource('en-US', 'session', 'test.pluralFiles_other', '{count} files');
    i18n.addResource('zh-CN', 'session', 'test.pluralFiles_one', '{count} 个文件');
    i18n.addResource('zh-CN', 'session', 'test.pluralFiles_other', '{count} 个文件');

    await i18n.changeLanguage('en-US');
    expect(translateSessionMessage(pluralLookupKey, { count: 1 })).toBe('1 file');
    expect(translateSessionMessage(pluralLookupKey, { count: 3 })).toBe('3 files');
    await i18n.changeLanguage('zh-CN');
    expect(translateSessionMessage(pluralLookupKey, { count: 1 })).toBe('1 个文件');
    expect(translateSessionMessage(pluralLookupKey, { count: 3 })).toBe('3 个文件');
  });

  it('fails loudly for a missing task key', () => {
    expect(() => translateSessionMessage('task.missing')).toThrow('Missing session translation');
  });
});
