/**
 * codex 的推理档词表 —— 插件的 `effort.effortOptions` 与平台模型 catalog 共用这一份。
 *
 * 平台模型的档位来自网关目录(#6447),而目录的取值来自 models.dev;交给 codex 的 `model_catalog_json`
 * 之前必须收窄到这张表:codex 解析 `supported_reasoning_levels` 时遇到一个它不认识的档名会拒掉
 * **整份** catalog,那条会话上的每个平台模型一起起不来。
 *
 * 标签用中文与工具栏其余控件(询问/完全访问)一致;描述译自 codex 目录里该档的原文。
 * 六档标签互不重名 —— codex 自己的中文包把 xhigh 和 max 都译成「极高」,别照抄。
 */
export const CODEX_EFFORT_OPTIONS = {
  low: { name: '低', description: '快速回应，推理较浅' },
  medium: { name: '中', description: '兼顾速度与推理深度，适合日常任务' },
  high: { name: '高', description: '更深的推理，适合复杂问题' },
  xhigh: { name: '极高', description: '超高推理深度，适合疑难问题' },
  max: { name: '最高', description: '最大推理深度，留给最难的问题' },
  ultra: { name: '超量', description: '最大推理，并自动分派子任务' },
} as const;
