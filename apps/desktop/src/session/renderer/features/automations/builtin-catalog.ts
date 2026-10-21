import { BookOpen, Bug, FlaskConical, Mail, Search, Wrench } from '@/lib/icons'
import type { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { BuiltinAutomationTemplate } from './automation-template';

type Translate = ReturnType<typeof useSessionMessages>['translate'];

// @@@raw prompt — initialPrompt 是发给智能体的提示词内容,defaultTrigger.expr 是原始 cron;
// 两者都是数据,只有模板的 name/description/category 是展示 chrome。
const TEST_COVERAGE_PROMPT =
  'Inspect recent merged code for meaningful regression risk and add the smallest deterministic tests for weakly covered behavior. Prioritize new code paths, bug fixes without tests, edge-case parsing, concurrency, permissions, validation, shared utilities, and core flows. Avoid low-signal snapshots and cosmetic-only changes. Follow existing test conventions, run relevant validation, and summarize what risky behavior is now covered.';

export function buildBuiltinAutomationCatalog(translate: Translate): BuiltinAutomationTemplate[] {
  return [
    {
      id: 'critical-bug-finder',
      category: translate('automations.templateCategoryCodeQuality'),
      name: translate('automations.templateNameBugSweep'),
      description: translate('automations.templateBugSweep'),
      icon: Bug,
      defaultTrigger: { expr: '0 10 * * 1', tz: 'UTC' },
      defaultSessionConfig: {
        initialPrompt:
          'Inspect recent code changes for high-severity correctness bugs, regressions, race conditions, data loss risks, and broken edge cases. If you find a real issue, implement the smallest safe fix and validate it with targeted tests.',
      },
    },
    {
      id: 'daily-change-summary',
      category: translate('automations.templateCategoryStatusReports'),
      name: translate('automations.templateNameDailyDigest'),
      description: translate('automations.templateDailyDigest'),
      icon: Mail,
      defaultTrigger: { expr: '0 9 * * 1', tz: 'UTC' },
      defaultSessionConfig: {
        initialPrompt:
          'Create a concise daily digest of notable repository changes from the previous day. Highlight shipped work, risky changes, migrations, open blockers, and recommended follow-ups.',
      },
    },
    {
      id: 'codebase-vulnerability-scan',
      category: translate('automations.templateCategorySecurity'),
      name: translate('automations.templateNameSecurityAudit'),
      description: translate('automations.templateSecurityAudit'),
      icon: Search,
      defaultTrigger: { expr: '0 11 * * 1', tz: 'UTC' },
      defaultSessionConfig: {
        initialPrompt:
          'Review the repository for validated high-impact security vulnerabilities. Focus on authentication, authorization, injection, secret handling, unsafe filesystem or shell usage, SSRF, deserialization, and privilege boundaries. Avoid noisy theoretical findings; only report or fix exploitable issues.',
      },
    },
    {
      id: 'test-coverage',
      category: translate('automations.templateCategoryCodeQuality'),
      name: translate('automations.templateNameTestCoverage'),
      description: translate('automations.templateTestCoverage'),
      icon: FlaskConical,
      defaultTrigger: { expr: '0 10 * * 2', tz: 'UTC' },
      defaultSessionConfig: { initialPrompt: TEST_COVERAGE_PROMPT },
    },
    {
      id: 'reported-bugs',
      category: translate('automations.templateCategoryIncidents'),
      name: translate('automations.templateNameBugReport'),
      description: translate('automations.templateBugReport'),
      icon: Wrench,
      defaultTrigger: { expr: '0 10 * * 1', tz: 'UTC' },
      defaultSessionConfig: {
        initialPrompt:
          'Review recent bug reports described in linked issues, project docs, or prompt notes. For actionable issues, reproduce or reason through the failure, identify the responsible code path, implement the smallest safe fix, add regression coverage, and prepare a PR summary. If no bug-report details are available, report what information is needed instead of guessing.',
      },
    },
    {
      id: 'docs-generator',
      category: translate('automations.templateCategoryDocumentation'),
      name: translate('automations.templateNameDocs'),
      description: translate('automations.templateDocs'),
      icon: BookOpen,
      defaultTrigger: { expr: '0 14 * * 5', tz: 'UTC' },
      defaultSessionConfig: {
        initialPrompt:
          'Find recently changed or under-documented developer-facing code. Add concise documentation that explains behavior, setup, examples, sharp edges, and validation steps. Prefer updating existing docs over creating duplicate pages.',
      },
    },
  ];
}
