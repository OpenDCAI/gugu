/**
 * 编辑器一次读进来的上限。
 *
 * 这里是**两个数**,不是一个,因为「多大算大」和「多大算读不了」是两件事(#5763):
 *
 * - `EDITOR_CONFIRM_FILE_BYTES` —— **默认不替你打开的那条线**。到了这儿只是说
 *   「这个文件很大,打开要花时间、而且没有语法着色」,然后给一个「仍然打开」的按钮。
 *   它对齐的是 Monaco 自己开始退化的门槛:`monaco-editor` 0.55.1 的
 *   `TextModel.LARGE_FILE_SIZE_THRESHOLD` 正是 20 MB(另一条是 30 万行),到那儿它关掉
 *   语法着色。所以这条线的含义是「代价从这里开始」,❌ 不是「到此为止」。
 *
 * - `EDITOR_HARD_MAX_FILE_BYTES` —— **真正读不了的那条线**。正文要以字符串跨进程搬到
 *   渲染端,这是那条通道扛得住的量,也是 `IFileSystem` 早就有的 `MAX_READ_BYTES`。
 *   超过它,按钮不给了 —— ❌ 给一个按下去还是失败的按钮比不给更糟。
 *
 * 形态取自 VS Code:超限时它弹一张警告占位卡,带「Open Anyway」与「Configure Limit」两个动作,
 * 前者用 `limits.size = Number.MAX_VALUE` 重开一次
 * (`microsoft/vscode` `src/vs/workbench/common/editor.ts` 的 `createTooLargeFileError`)。
 * 它的默认门槛按来源分:本机 1024 MB、远程 10 MB、Web 50 MB
 * (`src/vs/platform/files/common/files.ts` 的 `getLargeFileConfirmationLimit`),
 * 理由写在注释里 —— 远程那条低是为了不白扛一次跨网传输。
 *
 * 我们照抄那个**理由**,不照抄那个数:VS Code 把文件流式灌进模型,咱们是整块跨进程搬字符串,
 * 所以硬顶低得多,而「问一句」的那条线取引擎自己开始退化的点更有依据。
 *
 * ⚠️ 此前这条路不传上限,于是落到 `IFileSystem` 的默认值 200 KB —— 那个默认值是给 SSH 远程
 * 读盘设的流量保护,本机读盘顺手继承它没有道理(#5750)。
 */

/** 本机文件:超过这个体积先问一句,不直接打开。 */
export const EDITOR_CONFIRM_FILE_BYTES = 20 * 1024 * 1024;

// ⚠️ 远程(SSH)工作区还没有自己的门槛:VS Code 给远程 10 MB,理由是一次跨网传输的代价是真的,
// 不该在用户点头前替他花掉。我们要区分本机/远程,得把项目类型从 project store 穿过
// SessionTabContext 与 FileModelContext 两层,那是单独一条改动 —— ❌ 先放一个没接上的常量在这儿
// 假装做了。目前远程与本机同用上面那条线,机制(问一句 + 仍然打开)两边一致。

/** 无论用户怎么点,超过这个体积编辑器都读不了(= `IFileSystem` 的 MAX_READ_BYTES)。 */
export const EDITOR_HARD_MAX_FILE_BYTES = 100 * 1024 * 1024;
