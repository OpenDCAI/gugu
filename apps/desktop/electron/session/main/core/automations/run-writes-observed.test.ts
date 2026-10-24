import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every insert or update of automation_runs in the main process goes through `writeRuns` in repo.ts, which signals
 * each written run to the activity journal. A run written anywhere else changes status without the journal seeing
 * it (skipped cron runs were once written that way), so this scan rejects any other write site. It recognizes the
 * table by name (`automationRuns`, `schema.automationRuns`, `automation_runs` in SQL text or interpolated into it);
 * a write through the table bound to another name is not seen, so keep the name.
 */
const ELECTRON = fileURLToPath(new URL('../../../../', import.meta.url));
const REPO = 'session/main/core/automations/repo.ts';
/** Writes outside the activity journal's concern, each with why. */
const EXEMPT: Record<string, string> = {
  'migrations/session-naming/index.ts':
    'one-time data migration that rewrites the stored session config snapshot format; it never changes a run status',
};
const RAW_WRITE = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?)\s+["`]?automation_runs\b/i;

type Site = { file: string; line: number; insideWriteRuns: boolean };

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'drizzle' ? [] : sourceFiles(path);
    return /\.(?:ts|mts|mjs|js)$/.test(entry.name) && !/\.test\.|\.d\.ts$/.test(entry.name) ? [path] : [];
  });
}

/** The drizzle table, under its own name or read off a namespace (`schema.automationRuns`). */
function isRunsTable(node: ts.Node | undefined): boolean {
  if (!node) return false;
  if (ts.isIdentifier(node)) return node.text === 'automationRuns';
  return ts.isPropertyAccessExpression(node) && node.name.text === 'automationRuns';
}

/** SQL text, with the table written in where it is interpolated (sql`UPDATE ${automationRuns} ...`). */
function templateText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) =>
      (isRunsTable(span.expression) ? 'automation_runs' : ' ? ') + span.literal.text).join('');
  }
  return null;
}

function insideWriteRuns(node: ts.Node): boolean {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'writeRuns'
      && parent.arguments[1] === child) return true;
  }
  return false;
}

function runWriteSites(): Site[] {
  const sites: Site[] = [];
  for (const path of sourceFiles(ELECTRON)) {
    const text = readFileSync(path, 'utf8');
    if (!text.includes('automationRuns') && !/automation_runs/i.test(text)) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const record = (node: ts.Node) => sites.push({ file: relative(ELECTRON, path),
      line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, insideWriteRuns: insideWriteRuns(node) });
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ['insert', 'update'].includes(node.expression.name.text)
        && isRunsTable(node.arguments[0])) {
        record(node);
      } else {
        const raw = templateText(node);
        if (raw !== null && RAW_WRITE.test(raw)) record(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

describe('automation run writes are observed', () => {
  it('writes automation_runs only through writeRuns, so every status change reaches the activity journal', () => {
    const sites = runWriteSites();
    const unobserved = sites.filter((site) => !(site.file === REPO && site.insideWriteRuns) && !(site.file in EXEMPT));
    expect(unobserved, 'insert or update automation_runs through writeRuns in repo.ts').toEqual([]);
    // The scan sees the real write sites: insert, scheduled insert, queue, skip, start, update.
    expect(sites.filter((site) => site.file === REPO).length).toBeGreaterThanOrEqual(6);
  });
});
