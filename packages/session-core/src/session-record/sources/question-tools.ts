import type { SessionUpdate } from '@agentclientprotocol/sdk';

import type { SettlementOption, SettlementQuestion } from '../contract';
import { asRecord } from './shared';

/**
 * 「这条工具调用其实是在问用户」。
 *
 * ACP 没有「提问」这一档 SessionUpdate —— 提问在协议里走的是 `session/request_permission`
 * 那条**请求应答**，而请求应答不进会话记录，记录里只留下工具调用本身。所以读侧要认回来，
 * 只能按工具名。名单写死是有意的：只认确知会**阻塞等人回答**的那几个，
 * ❌ 别按 "ask"/"question" 之类的子串猜 —— 猜错的代价是给一条普通工具调用挂上一个
 * 永远等不到回答的待办。
 */
export const QUESTION_TOOL_NAMES = [
  'AskUserQuestion', // Claude
  'request_user_input', // codex
  'question', // opencode
  'ExitPlanMode', // Claude 的计划批准
] as const;

export type QuestionToolName = (typeof QUESTION_TOOL_NAMES)[number];

/**
 * 「这条工具调用是在请人批一份计划」（#7139）。认法同提问：按 `toolCallName`（供应商报的名，没有就是标题）。
 * 名单 = 经 `session/request_permission` 等人批计划、而且名字到得了咕咕的几家；桌面的计划卡与「等的是计划」共用。
 * droid（标题「Approve Spec」）、gemini（标题是一句话）不报工具名，❌ 按标题猜。
 */
export const PLAN_APPROVAL_TOOL_NAMES = [
  'ExitPlanMode', // Claude（`_meta.claudeCode`）、qoder（`_meta.qoder`）、kimi 与 qwen 准备帧的标题
  'exit_plan_mode', // qwen（`_meta.toolName`）
] as const;

export function isPlanApprovalToolName(name: string | null | undefined): boolean {
  return (PLAN_APPROVAL_TOOL_NAMES as readonly string[]).includes(name ?? '');
}

/** 等读者自己答的那次调用（提问或批计划）：桌面上不折进「用了 N 个工具」、也不收进回合折叠。 */
export function isQuestionOrPlanToolName(name: string | null | undefined): boolean {
  return isQuestionToolName(name) || isPlanApprovalToolName(name);
}

export type RecordQuestion = {
  /** 与 `Settlement.itemId` 同一个身份：provider 的 toolCallId。 */
  itemId: string;
  toolName: string;
  /** 卡片形态：要人点「同意/拒绝」还是从选项里挑一个。 */
  kind: 'permission' | 'question';
  /** 问的是什么。 */
  title: string;
  /** 次要说明（AskUserQuestion 的 header、ExitPlanMode 的计划正文）。 */
  detail?: string;
  options: SettlementOption[];
  /** AskUserQuestion 的全部题目;`title` / `options` 是第一题。 */
  questions?: SettlementQuestion[];
};

/**
 * 提问正文的长度上限。
 *
 * ExitPlanMode 的"问题"就是整份计划，实测能到几十 KB —— 这条 Settlement 每次变化都会经
 * Realtime 广播到手机，原样带上去等于把一份计划发很多遍。裁掉的部分在会话正文里本来就有，
 * 卡片只需要够认出"在问什么"。
 */
const PROMPT_LIMIT = 500;

function clip(text: string): string {
  return text.length <= PROMPT_LIMIT ? text : `${text.slice(0, PROMPT_LIMIT)}…`;
}

export function isQuestionToolName(name: string | null | undefined): name is QuestionToolName {
  return (QUESTION_TOOL_NAMES as readonly string[]).includes(name ?? '');
}

/**
 * 从一条 `tool_call` 里认出提问并取出选项。不是提问返回 null。
 *
 * `optionId` 取 **label 原文**，不是序号。
 *
 * 这不是"拿文案当键"：AskUserQuestion 的回答协议本身就是 label —— 本机真实记录里
 * `toolUseResult.answers` 长这样 `{"<问题原文>":"<选中的 label>"}`，回执正文也是
 * `"<问题>"="<label>"`。label 就是 provider 自己认得的那个字符串，序号才是读侧
 * 凭空造的、发回去 agent 认不得的东西（契约 SettlementOption 上写死了这条）。
 */
export function readQuestion(update: SessionUpdate): RecordQuestion | null {
  if (update.sessionUpdate !== 'tool_call') return null;
  const toolName = update.title;
  if (!isQuestionToolName(toolName)) return null;

  const raw = parseRawInput(update.rawInput);
  const questions = Array.isArray(raw?.questions) ? raw.questions.map(asRecord).filter((q): q is Record<string, unknown> => q !== null) : [];
  const question = questions[0] ?? null;
  const plan = typeof raw?.plan === 'string' ? raw.plan : null;
  const title =
    (typeof question?.question === 'string' && question.question) || plan || toolName;
  const header = typeof question?.header === 'string' ? question.header : null;
  const detail = header ?? (question ? undefined : (plan ?? undefined));

  const options = readOptions(question);

  return {
    itemId: update.toolCallId,
    toolName,
    // ExitPlanMode 是"同意就往下走"，没有备选项；其余几个才是从几项里挑一个。
    kind: toolName === 'ExitPlanMode' ? 'permission' : 'question',
    title: clip(title),
    ...(detail !== undefined && detail !== title ? { detail: clip(detail) } : {}),
    options,
    ...(toolName !== 'ExitPlanMode' && questions.length > 0
      ? {
          // 题面与 label 原样,❌ 裁剪:回答协议按问题原文与 label 原文对账,裁过的对不上。
          questions: questions.map((q) => ({
            question: typeof q.question === 'string' ? q.question : '',
            ...(typeof q.header === 'string' ? { header: q.header } : {}),
            // Claude 叫 multiSelect、opencode 叫 multiple;codex 只有单选。
            multiSelect: q.multiSelect === true || q.multiple === true,
            options: readOptions(q)
          }))
        }
      : {})
  };
}

/**
 * 没人在咕咕里认领的一问,provider 把它做完了(`tool_call_update` 带终局 status):是不是真有人答了。
 * 答了 ⇒ 在别处答的(卡写「已在其他端回答」);没答 ⇒ 这一问已经不需要回答了。
 *
 * 各家「没答」长得不一样,判据按工具只写在这张表里:
 * - Claude(AskUserQuestion / ExitPlanMode):Esc 拒答、驳回计划、会话先结束都带 `is_error` ⇒ 记录源报 failed;
 *   正常结束 = 答了 / 批了(10-12 评审扫真实记录:Chole 答 33 / 没答 6,mac1 52 / 21,没答的全带 is_error)。
 * - opencode `question`:关掉是 error「The user dismissed this question」⇒ failed;正常结束 = 答了
 *   (mac1 真库 11 条:答 3 条全 completed、关 5 条全 error、3 条没结束)。
 * - codex `request_user_input`:没答的几种结局**都是正常输出**,provider 不判失败 —— 「is unavailable in Default mode」、
 *   咕咕适配器渲染不出来时如实回的 `{"answers":{}}`、选择器上 Esc 的「aborted by user」、「can only be used by the root
 *   thread」(mac1 真实 rollout 12 次里 11 次是这些)⇒ 只有输出里解析出非空的 answers 才是答了。
 */
const ANSWERED_WHEN_COMPLETED: Record<QuestionToolName, (output: string | null) => boolean> = {
  AskUserQuestion: () => true,
  ExitPlanMode: () => true,
  question: () => true,
  request_user_input: codexAnswered,
};

/** `toolName` 认不出(不是提问工具)⇒ 不说它被答过。 */
export function questionAnswered(
  toolName: string | null,
  update: { status?: string | null; content?: readonly unknown[] | null; rawOutput?: unknown }
): boolean {
  if (update.status !== 'completed' || !isQuestionToolName(toolName)) return false;
  return ANSWERED_WHEN_COMPLETED[toolName](outputText(update));
}

/** 真回答 `{"answers":{"<题 id>":{"answers":["<选中的 label>"]}}}`;其余(纯文本的几种、空的 `{"answers":{}}`)都不是。 */
function codexAnswered(output: string | null): boolean {
  if (output === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return false;
  }
  const answers = asRecord(asRecord(parsed)?.answers);
  return answers !== null && Object.keys(answers).length > 0;
}

function outputText(update: { content?: readonly unknown[] | null; rawOutput?: unknown }): string | null {
  const texts = (update.content ?? []).flatMap((block) => {
    const inner = asRecord(asRecord(block)?.content);
    return typeof inner?.text === 'string' ? [inner.text] : [];
  });
  if (texts.length > 0) return texts.join('\n');
  if (typeof update.rawOutput === 'string') return update.rawOutput;
  return update.rawOutput === undefined || update.rawOutput === null ? null : JSON.stringify(update.rawOutput);
}

function readOptions(question: Record<string, unknown> | null): SettlementOption[] {
  const options: SettlementOption[] = [];
  const rawOptions = Array.isArray(question?.options) ? question.options : [];
  for (const entry of rawOptions) {
    const record = asRecord(entry);
    const label = typeof record?.label === 'string' ? record.label : null;
    if (!label) continue;
    const description = typeof record?.description === 'string' ? record.description : null;
    options.push({
      optionId: label,
      name: label,
      ...(description ? { description: clip(description) } : {})
    });
  }
  return options;
}

function parseRawInput(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return asRecord(value);
}
