/**
 * 示例项目(#709)的全部内容:一次真跑(真 agent、真咕咕)原样固化下来,打包在 app 里,随界面语言换一份;❌ 进库、❌ 调模型、
 * ❌ 手写。人这一边的话是跑的时候人写的,其余都是 agent 那一趟真做出来的。由 scripts/dev/freeze-sample-project.mjs 生成。
 */
export type SampleFile = {
  /** 对话里链接到它用的 id(示例自己的,❌ 是任何真文件)。 */
  id: string;
  name: string;
  mimeType: 'text/markdown' | 'text/csv';
  text: string;
  /** 跑的那一次服务端记下的这一版的 sha256,固化时逐字节核对过。 */
  sha256: string;
};

/** 任务那一趟里,它做的一步:它中途说的话、搜了什么、写了哪些文件、放进群文件夹、回到群里。 */
export type SampleStep =
  | { kind: 'said'; text: string }
  | { kind: 'searched'; queries: readonly string[] }
  | { kind: 'wrote'; files: readonly string[] }
  | { kind: 'shared'; files: readonly string[] }
  | { kind: 'posted' };

/**
 * `owner` = 打开它的这个人(用他自己的名字和头像);`agent` = 接手任务的那一个。
 * `mentionsOwner`:这一条是回给人的(群里 @ 他),名字照看的人自己的写。
 */
export type SampleMessage = { id: string; time: string; /** 这一条上面另起一行时刻(群聊同一条规矩,按真时间算好的)。 */ divider?: true } & (
  | { kind: 'task'; text: string }
  | { kind: 'text'; from: 'owner' | 'agent'; text: string; replyTo?: string; mentionsOwner?: true }
  /** 文件卡。项目群的文件是从主人电脑上发出来的,所以 agent 放进群里的文件卡也是主人那一侧的 —— 照真的样子。 */
  | { kind: 'file'; from: 'owner' | 'agent'; file: string }
);

export type SampleProjectContent = {
  agent: { name: string; engine: 'codex' };
  messages: readonly SampleMessage[];
  files: readonly SampleFile[];
  task: { startedAt: string; endedAt: string; steps: readonly SampleStep[] };
};
