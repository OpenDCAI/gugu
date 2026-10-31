<div align="center">
<a id="readme-top"></a>

# 咕咕 Gugu

**咕咕是一个面向 AGI 的应用。**

### 别自己做，让 Agent 来。

你把事情直接交给 Agent，它按任务需要调用工具和设备，组织协作，交回结果。

[English](README.md) · **简体中文** · [关于咕咕](#关于咕咕) · [官网](https://gugu.nextmind.space/zh/) · [文档](https://gugu.nextmind.space/help/)

[![Claude Code](https://img.shields.io/badge/agent-Claude%20Code-C76B4A?style=flat-square)](#主要功能) [![Codex](https://img.shields.io/badge/agent-Codex-252525?style=flat-square)](#主要功能) [![MCP](https://img.shields.io/badge/tools-MCP-6A50D4?style=flat-square)](#主要功能) [![Skills](https://img.shields.io/badge/workflows-Skills-328788?style=flat-square)](#主要功能) [![Gugu Apps](https://img.shields.io/badge/extensions-Gugu%20Apps-E58F28?style=flat-square)](#主要功能)

<img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-banner-zh-20261031-v47.webp" width="100%" alt="咕咕 Gugu">

</div>

## 主要功能

### 基础功能

<table>
<tr><td width="50%" valign="top"><h3>01 · 工作台</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-chat-file-split-motion-card-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-chat-file-split-motion-card-20261031-v66.webp" width="100%" alt="工作台"></a><p>多个任务同屏处理；会话、文件、网页和终端也能并排，或者拖成独立窗口。</p></td><td width="50%" valign="top"><h3>02 · 文件与交付</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-group-folder-edit-zh-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-group-folder-edit-zh-20261031-v66.webp" width="100%" alt="文件与交付"></a><p>在群文件夹里一起写文档：@ Agent 后，它的修改直接出现在你打开的文件里。（等待段 ×2 快放）</p></td></tr>
<tr><td><a href="#workspace-details">看实际使用</a></td><td><a href="#files-details">看实际使用</a></td></tr>
<tr><td width="50%" valign="top"><h3>03 · 个人助理</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-connected-apps-card-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-connected-apps-card-20261031-v64.webp" width="100%" alt="个人助理"></a><p>在个人助理里交流和交办任务，把已连接的外部服务交给它使用。</p></td><td width="50%" valign="top"><h3>04 · 模型与订阅</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-seven-day-usage-card-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-seven-day-usage-card-20261031-v66.webp" width="100%" alt="模型与订阅"></a><p>沿用已有订阅或 API 配置，按任务选择模型；通过用量图和资源监视器查看使用情况。</p></td></tr>
<tr><td><a href="#assistant-details">看实际使用</a></td><td><a href="#models-details">看实际使用</a></td></tr>
</table>

### 进阶与开发者功能

<table>
<tr><td width="50%" valign="top"><h3>05 · 多 Agent 协作</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-parent-and-children-card-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-parent-and-children-card-20261031-v66.webp" width="100%" alt="多 Agent 协作"></a><p>把大任务交给一个 Agent，它拆给其他 Agent 并行处理；你可以单独跟进每个 Agent 的状态和结果。</p></td><td width="50%" valign="top"><h3>06 · Gugu App</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-app-market-install-zh-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-app-market-install-zh-20261031-v66.webp" width="100%" alt="Gugu App"></a><p>从市场查看 App 详情、确认安装，再在客户端打开已安装的 App；版本和启用状态也在这里管理。</p></td></tr>
<tr><td><a href="#agents-details">看实际使用</a></td><td><a href="#apps-details">看实际使用</a></td></tr>
<tr><td width="50%" valign="top"><h3>07 · MCP 与 Skills</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-session-tools-card-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-session-tools-card-20261031-v64.webp" width="100%" alt="MCP 与 Skills"></a><p>在资源库管理咕咕自己的 MCP、查看各引擎已有配置，在会话里选择工具，并使用 App 带来的工具和 Skills。</p></td><td width="50%" valign="top"><h3>08 · 设备与行动</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-device-overview-card-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-device-overview-card-20261031-v64.webp" width="100%" alt="设备能力、Browser Use 与 Computer Use"></a><p>Agent 跑在具体的电脑或服务器上，按任务调用设备能力；通过 Browser Use 与 Computer Use，把网页和电脑上的操作接进任务。</p></td></tr>
<tr><td><a href="#tools-details">看实际使用</a></td><td><a href="#devices-details">看实际使用</a></td></tr>
</table>

<a id="workspace-details"></a>

### Agent 工作台

项目、任务、文件和窗口在同一工作面里组合。

- **在项目里随处创建 Agent** · 在项目中直接创建 Agent，把任务交给它。
- **项目与设备分离** · 同一个项目可以汇集来自不同设备的会话，在一处组织和跟进。
- **工作状态的缩略预览** · 悬停正在工作的 Agent，预览它最近的对话、工具活动和当前进度，再切过去跟进。
- **侧边聊天、审阅、终端和文件浏览** · 侧边聊天、审阅、终端和文件浏览都能留在工作空间；开启 TUI Mode 后，新建任务输入区可在「通用」和「终端」之间切换；终端任务会在工作区里显示真实 TUI 输出。
- **任务分屏、文件并排和独立窗口** · 多个任务并排处理；同一任务里的会话与文件也能分屏，页签可以放进独立窗口。
- **导入其他 Agent 与 Harness 的历史** · 导入其他 Agent、Harness 或软件中的会话历史，把已有工作接着做下去。

**项目侧栏的新建入口与工作文件夹卡片**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-project-task-card-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-project-task-card-20261031-v66.webp" width="100%" alt="项目侧栏的新建入口与工作文件夹卡片"></a></div>

**分屏与独立窗口：拖动、并排查看、弹出与放回**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-chat-file-split-motion-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-chat-file-split-motion-20261031-v66.webp" width="100%" alt="分屏与独立窗口：拖动、并排查看、弹出与放回"></a></div>

**新任务输入区选择通用或终端（TUI；需先在设置中开启）· 部分片段 ×2 快放**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-tui-terminal-zh-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-tui-terminal-zh-20261031-v66.webp" width="100%" alt="新任务输入区选择通用或终端（TUI；需先在设置中开启）· 部分片段 ×2 快放"></a></div>

**悬停工作中的 Agent，查看最近对话、工具活动与进度**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-working-agent-preview-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-working-agent-preview-20261031-v66.webp" width="100%" alt="悬停工作中的 Agent，查看最近对话、工具活动与进度"></a></div>

**会话历史与来源筛选（Claude Code / Codex）**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-history-import-sources-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-history-import-sources-20261031-v66.webp" width="100%" alt="会话历史与来源筛选（Claude Code / Codex）"></a></div>

<a id="files-details"></a>

### 群文件与文件协作

文档和表格放在群文件夹里，人和 Agent 改的是同一份文件。

- **群文件夹里实时协作** · 在群文件夹新建文档，自己接着写，同时让 Agent 改同一份文件；它的修改直接出现在打开的编辑器里。
- **在咕咕办公里框选单元格** · 从文件夹用咕咕办公打开表格，框选一片区域放进输入框，作为引用交给 Agent。
- **选段引用** · 在文档里选中一段，带着文件名回到对话。
- **文件存储管理** · 查看自己的文件存储、已用空间和文件管理入口。

**咕咕办公：框选一列，放进输入框问 Agent（等待段 ×4 快放）**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-office-pick-zh-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-office-pick-zh-20261031-v66.webp" width="100%" alt="咕咕办公：框选一列，放进输入框问 Agent（等待段 ×4 快放）"></a></div>

**选段引用：从文档选择内容并带文件名回到输入框**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-document-quote-motion-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-document-quote-motion-20261031-v66.webp" width="100%" alt="选段引用：从文档选择内容并带文件名回到输入框"></a></div>

<a id="assistant-details"></a>

### 个人助理与连接应用

个人助理把日常安排、资料和外部服务放在同一处。

- **在助理里交办真实任务** · 把日常安排或一件具体工作交给个人助理，在同一处查看它的回复和结果。
- **连接 Google 等外部应用** · 在个人助理中连接 Google 等外部应用，让它使用已连接的服务处理工作。

**个人助理：把周末安排排顺、设成定时提醒，并在任务页看到它**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-assistant-schedule-zh-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-assistant-schedule-zh-20261031-v66.webp" width="100%" alt="个人助理：把周末安排排顺、设成定时提醒，并在任务页看到它"></a></div>


<a id="models-details"></a>

### 模型、订阅与系统资源

模型、订阅、用量和本机资源可以分开查看。

- **沿用已有订阅，按任务选模型** · 沿用已有的订阅和账号，在设置中切换；每个任务各自选择模型和权限。
- **七天用量** · 用七天用量图回看近期使用情况，也可以切换统计区间。
- **资源监视器** · 资源监视器把运行中的资源消耗呈现出来，方便查看当前状态。

**本机资源与云端存储，一处查看**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-resource-storage-zh-20261031-v66.png"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-resource-storage-zh-20261031-v66.png" width="100%" alt="本机资源与云端存储，一处查看"></a></div>

**引擎与订阅配置**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-agent-engines-zh-20261031-v66.png"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-agent-engines-zh-20261031-v66.png" width="100%" alt="引擎与订阅配置"></a></div>


<a id="agents-details"></a>

### 让多个 Agent 一起做事

从父任务拆分工作，再逐个跟进 Agent 的结果。

- **三层 Agent 协作** · 一个 Agent 可以统筹多个工作流，再把子任务交给更多 Agent 执行；项目侧栏保留父任务、子 Agent 和状态，方便逐层跟进。
- **多人 + 多 Agent 协作** · 更进阶的协作是两位成员把各自的上层 Agent 拉进同一项目或群，先对齐目标、边界和分工，再让各自的 Agent 并行执行并回传结果。


<a id="apps-details"></a>

### 创建、安装和分享 Gugu App

App 从市场安装，版本和启用状态在客户端管理。

- **创建与共享自己的 App** · 让 Agent 按需求做出 Gugu App，人在界面里操作，Agent 读写同一份数据。
- **开源、审核与 App 市场** · 把自己的 App 开源并提交审核，通过后进入 App 市场，供其他人安装和使用。

**论文共读：划出一段、在群里问 Agent · 部分片段 ×2 快放**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-paper-club-reader-zh-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-paper-club-reader-zh-20261031-v66.webp" width="100%" alt="论文共读：划出一段、在群里问 Agent · 部分片段 ×2 快放"></a></div>

**已安装 App：停用后再启用**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-installed-apps-zh-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-installed-apps-zh-20261031-v66.webp" width="100%" alt="已安装 App：停用后再启用"></a></div>


<a id="tools-details"></a>

### MCP、Skills 与 App 工具

资源库和会话工具共同组成 Agent 的工作面。

- **集成的资源库** · 资源库按设备集中呈现提示词、智能体、集成和 MCP，查找与配置工作所需的资源。
- **MCP 与 Skills 带来的能力** · 把网页搜索、文档表格、日程和消息接进任务。用 MCP 接入工具，用 Skills 提供工作步骤；在资源库管理 MCP 配置，在会话里选择工具。


**资源库：MCP JSON 配置与集成**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-resource-integrations-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-resource-integrations-20261031-v64.webp" width="100%" alt="资源库：MCP JSON 配置与集成"></a></div>

<a id="devices-details"></a>

### 设备、浏览器与电脑操作

设备页把电脑、浏览器和授权状态放在同一处。

- **Computer Use** · 通过 Computer Use，让 Agent 操作电脑上的界面。
- **从自己的浏览器导入并使用 Browser Use** · 从自己的浏览器导入，接着用 Browser Use 在任务里处理网页。
- **用 SSH 或隧道接入设备** · 通过 SSH 或远程隧道接入设备，把其他电脑或服务器加入工作空间。


**Browser Use：任务并排与浏览器配置**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-task-browser-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-task-browser-20261031-v66.webp" width="100%" alt="Browser Use：任务并排与浏览器配置"></a></div>

**SSH 与远程隧道接入**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-remote-ssh-setup-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-remote-ssh-setup-20261031-v66.webp" width="100%" alt="SSH 与远程隧道接入"></a></div>

### 对话、群与话题

- **分会话与独立话题** · 按会话或话题分开讨论，在原来的上下文中继续。
- **群聊与好友** · 新建群聊、邀请好友，让人与 Agent 一起参与。
- **Mini Map** · 在项目会话，或从 Agent 私聊打开的任务里，用 Mini Map 悬停预览、点击跳转，定位长对话中的内容。

**悬停 Mini Map，预览一轮对话**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-minimap-preview-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-minimap-preview-20261031-v66.webp" width="100%" alt="悬停 Mini Map，预览一轮对话"></a></div>


**群成员分别列出人与 Agent**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-group-members-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-group-members-20261031-v64.webp" width="100%" alt="群成员分别列出人与 Agent"></a></div>

### 手机端

- **极简的移动工作空间** · 手机端保留简洁的界面和配色，随时查看与跟进工作。
- **新建任务与 Agent** · 在手机端新建任务与 Agent，随时开始工作。

[更多用法](https://gugu.nextmind.space/zh/examples.html)

## 关于咕咕

如果 AGI 到来，它不会只是一个模型解决一切；模型再聪明，也需要名字、归属、长期上下文、工具、设备和协作关系。咕咕为 Agent 提供这些基础，让它随着模型变强而承担更完整的工作。

[阅读更多理念](https://gugu.nextmind.space/zh/about.html)

## 自己部署与本地开发

| 仓库 | 内容 |
| --- | --- |
| [OpenDCAI/gugu](https://github.com/OpenDCAI/gugu) | 桌面客户端、Android、无界面服务器与共享 Agent 运行代码 |
| [OpenDCAI/gugu-supabase](https://github.com/OpenDCAI/gugu-supabase) | 账号、消息、同步、设备通信与权限 |

配置与启动见[社区部署指南](docs/self-hosting.zh-CN.md)，安装与检查见[贡献指南](CONTRIBUTING.zh-CN.md)。

## 参与贡献

欢迎贡献代码、文档、翻译和 Gugu App：[贡献指南](CONTRIBUTING.zh-CN.md) · [问题与建议](https://github.com/OpenDCAI/gugu/issues) · [App 开发](docs/writing-a-tab-extension.md)。

## 许可

[修改版 Apache License 2.0](LICENSE) · [第三方许可](THIRD_PARTY_NOTICES.md)

<sub>客户端下载：<a href="https://gugu.nextmind.space/zh/#download">macOS</a> · <a href="https://download.gugu.nextmind.space/releases/windows/latest/gugu-windows-x64.exe">Windows</a> · <a href="https://download.gugu.nextmind.space/releases/linux/latest/gugu-linux-x86_64.AppImage">Linux</a> · <a href="https://download.gugu.nextmind.space/releases/android/latest/gugu-android.apk">Android</a></sub>
