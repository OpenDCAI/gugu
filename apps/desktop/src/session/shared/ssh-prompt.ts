// #6264 ssh 经 askpass 问人的一个问题(新主机指纹 / 密码 / 密钥口令 / 验证码 / 只提醒)。
// 添加机器、卸载、直连终端三处共用这一份形状,界面上也是同一张卡片(SshPromptCard)。
// 放在 session/shared:会话页主进程(直连终端)与咕咕主体(设置 → 设备)都读得到。

export type SshPrompt = {
  id: string;
  kind: 'hostKey' | 'password' | 'passphrase' | 'otp' | 'notice';
  /** ssh 原文,只进「查看详情」和兜底展示。 */
  message: string;
  hostKey?: { host: string; keyType: string; fingerprint: string };
  /** password / passphrase 是给谁的:`alice@box`、`~/.ssh/id_ed25519`。 */
  subject?: string;
  /** otp / notice:服务器的原话(一行)。 */
  label?: string;
  /** 同样的问题这一轮里已经问过一次 = 上次的回答不对。 */
  retry?: boolean;
  /**
   * #6264「下次免密」:这是一次登录密码提问,且这条连接在它登上之后能替人把咕咕的钥匙装到那台机器上
   * (照 ssh-copy-id)。卡片据此在密码下面给「以后连这台机器不用再输密码」;口令 / 验证码 / 指纹 ❌ 给。
   */
  offerKeyInstall?: boolean;
};

/** 「下次免密」做完的结果:装好并验证过 / 没做成(为什么)。这次的密码登录不受它影响。 */
export type SshKeyInstallOutcome =
  | { status: 'installed' }
  | {
      status: 'failed';
      /**
       * not-accepted:钥匙放上去了,那台机器却不收钥匙登录(管理员关了、钥匙文件在别处、目录权限不对);
       * write-failed:那台机器的家目录写不进去;no-key:这台电脑上生成不了钥匙(找不到 ssh-keygen 之类);
       * unreachable:装 / 验的那一下没连上。
       */
      reason: 'not-accepted' | 'write-failed' | 'no-key' | 'unreachable';
    };
