import type { LocalSessionRow } from '@shared/core/session-import/session-import';
import type { SessionImportSource } from './import-source';

export type ImportOutcome =
  | { kind: 'imported'; row: LocalSessionRow; projectId: string; sessionId: string }
  | { kind: 'existing'; row: LocalSessionRow; projectId: string; sessionId: string }
  | { kind: 'failed'; row: LocalSessionRow; message: string };

/**
 * 逐条导入选中的会话。
 *
 * **一条失败不中断其余**：批量导入里「全或无」是最糟的选择 —— 一条读不出来的会话
 * 会把另外十九条好的一起毁掉，而用户还看不出是哪条坏的。失败的原地记原因，成功的照样留下。
 *
 * **串行而不是并发**：每条都要找/建项目、挂工作区、写库；二十条并排打上去只会互相拖慢，
 * 还把各自的失败原因搅在一起。慢一点，但每条的结果都说得清。
 */
export async function runImport(
  source: Pick<SessionImportSource, 'importSession'>,
  rows: LocalSessionRow[],
  onProgress: (done: number) => void,
  /** 失败原因怎么说给人听(本机 / 别的机器说法不同,见 describeImportFailure)。 */
  describeFailure: (error: unknown) => string
): Promise<ImportOutcome[]> {
  const outcomes: ImportOutcome[] = [];
  for (const row of rows) {
    try {
      // #6264 建在 source 那台机器上:原件在哪台,会话就归哪台。
      const result = await source.importSession({
        engine: row.engine,
        providerSessionId: row.providerSessionId,
        filePath: row.filePath,
        title: row.title,
        cwd: row.cwd,
      });
      outcomes.push({
        kind: result.alreadyImported ? 'existing' : 'imported',
        row,
        projectId: result.projectId,
        sessionId: result.sessionId,
      });
    } catch (error) {
      outcomes.push({ kind: 'failed', row, message: describeFailure(error) });
    }
    onProgress(outcomes.length);
  }
  return outcomes;
}

export function countOutcomes(outcomes: ImportOutcome[]) {
  return {
    imported: outcomes.filter((o) => o.kind === 'imported').length,
    existing: outcomes.filter((o) => o.kind === 'existing').length,
    failed: outcomes.filter((o) => o.kind === 'failed').length,
  };
}
