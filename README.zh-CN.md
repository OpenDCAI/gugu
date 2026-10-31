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
<tr><td width="50%" valign="top"><h3>01 · 工作台</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-chat-file-split-motion-card-20261031-v64.gif"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-chat-file-split-motion-card-20261031-v64.gif" width="100%" alt="工作台"></a><p>多个任务同屏处理；会话、文件、网页和终端也能并排，或者拖成独立窗口。</p></td><td width="50%" valign="top"><h3>02 · 文件与交付</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-group-file-collaboration-motion-card-20261031-v64.gif"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-group-file-collaboration-motion-card-20261031-v64.gif" width="100%" alt="文件与交付"></a><p>在群里共享文件，打开文件预览，在阅读、编辑和对照之间切换；选段可带回对话继续讨论。</p></td></tr>
<tr><td><a href="#workspace-details">看实际使用</a></td><td><a href="#files-details">看实际使用</a></td></tr>
<tr><td width="50%" valign="top"><h3>03 · 个人助理</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-connected-apps-card-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-connected-apps-card-20261031-v64.webp" width="100%" alt="个人助理"></a><p>在个人助理里交流和交办任务，把已连接的外部服务交给它使用。</p></td><td width="50%" valign="top"><h3>04 · 模型与订阅</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-seven-day-usage-card-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-seven-day-usage-card-20261031-v64.webp" width="100%" alt="模型与订阅"></a><p>沿用已有订阅或 API 配置，按任务选择模型；通过用量图和资源监视器查看使用情况。</p></td></tr>
<tr><td><a href="#assistant-details">看实际使用</a></td><td><a href="#models-details">看实际使用</a></td></tr>
</table>

### 进阶与开发者功能

<table>
<tr><td width="50%" valign="top"><h3>05 · 多 Agent 协作</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-parent-and-children-card-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-parent-and-children-card-20261031-v64.webp" width="100%" alt="多 Agent 协作"></a><p>把大任务交给一个 Agent，它拆给其他 Agent 并行处理；你可以单独跟进每个 Agent 的状态和结果。</p></td><td width="50%" valign="top"><h3>06 · Gugu App</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-installed-apps-card-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-installed-apps-card-20261031-v64.webp" width="100%" alt="Gugu App"></a><p>让 Agent 按需求做 App；人在界面里操作，Agent 读写同一份数据。市场、版本和已安装的 App 都在客户端里管理。</p></td></tr>
<tr><td><a href="#agents-details">看实际使用</a></td><td><a href="#apps-details">看实际使用</a></td></tr>
<tr><td width="50%" valign="top"><h3>07 · MCP 与 Skills</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-session-tools-card-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-session-tools-card-20261031-v64.webp" width="100%" alt="MCP 与 Skills"></a><p>在资源库管理咕咕自己的 MCP、查看各引擎已有配置，在会话里选择工具，并使用 App 带来的工具和 Skills。</p></td><td width="50%" valign="top"><h3>08 · 设备与行动</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-device-overview-card-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-device-overview-card-20261031-v64.webp" width="100%" alt="设备能力、Browser Use 与 Computer Use"></a><p>Agent 跑在具体的电脑或服务器上，按任务调用设备能力；通过 Browser Use 与 Computer Use，把网页和电脑上的操作接进任务。</p></td></tr>
<tr><td><a href="#tools-details">看实际使用</a></td><td><a href="#devices-details">看实际使用</a></td></tr>
</table>

<a id="workspace-details"></a>

### Agent 工作台

多个任务同屏处理；会话、文件、网页和终端也能并排，或者拖成独立窗口。

- **在项目里随处创建 Agent** · 在项目中直接创建 Agent，把任务交给它。
- **项目与设备分离** · 同一个项目可以汇集来自不同设备的会话，在一处组织和跟进。
- **工作状态的缩略预览** · 悬停正在工作的 Agent，预览它最近的对话、工具活动和当前进度，再切过去跟进。
- **侧边聊天、审阅、终端和文件浏览** · 侧边聊天、审阅、终端和文件浏览都能留在工作空间；在设置中开启 TUI Mode 后，新建任务可选择「通用」或「终端」。
- **任务分屏、文件并排和独立窗口** · 多个任务并排处理；同一任务里的会话与文件也能分屏，页签可以放进独立窗口。
- **导入其他 Agent 与 Harness 的历史** · 导入其他 Agent、Harness 或软件中的会话历史，把已有工作接着做下去。
- **定时任务** · 把任务安排在指定时间或按周期执行。

**项目侧栏的新建入口与工作文件夹卡片**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-project-task-card-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-project-task-card-20261031-v64.webp" width="100%" alt="项目侧栏的新建入口与工作文件夹卡片"></a></div>

**分屏与独立窗口：拖动、并排查看、弹出与放回**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-chat-file-split-motion-20261031-v64.gif"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-chat-file-split-motion-20261031-v64.gif" width="100%" alt="分屏与独立窗口：拖动、并排查看、弹出与放回"></a></div>

**新任务输入区选择通用或终端（TUI；需先在设置中开启）**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-conversation-terminal-20261031-v64.gif"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-conversation-terminal-20261031-v64.gif" width="100%" alt="新任务输入区选择通用或终端（TUI；需先在设置中开启）"></a></div>

**悬停工作中的 Agent，查看最近对话、工具活动与进度**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-working-agent-preview-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-working-agent-preview-20261031-v64.webp" width="100%" alt="悬停工作中的 Agent，查看最近对话、工具活动与进度"></a></div>

**会话历史与来源筛选（Claude Code / Codex）**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-history-import-sources-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-history-import-sources-20261031-v64.webp" width="100%" alt="会话历史与来源筛选（Claude Code / Codex）"></a></div>

<a id="files-details"></a>

### 群文件与文件协作

在群里共享文件，打开文件预览，在阅读、编辑和对照之间切换；选段可带回对话继续讨论。

- **群文件、打开与协作编辑** · 在群里共享文件，打开文件预览，在阅读、编辑和对照之间切换；选段可带回对话继续讨论。
- **文件存储管理** · 查看自己的文件存储、已用空间和文件管理入口。

**在客户端预览表格，五列完整显示**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-xlsx-table-start-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-xlsx-table-start-20261031-v64.webp" width="100%" alt="在客户端预览表格，五列完整显示"></a></div>

**群文件：从聊天打开文件，再切换阅读、编辑与对照**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-group-file-collaboration-motion-20261031-v64.gif"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-group-file-collaboration-motion-20261031-v64.gif" width="100%" alt="群文件：从聊天打开文件，再切换阅读、编辑与对照"></a></div>

**选段引用：从文档选择内容并带文件名回到输入框**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-document-quote-motion-20261031-v64.gif"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-document-quote-motion-20261031-v64.gif" width="100%" alt="选段引用：从文档选择内容并带文件名回到输入框"></a></div>

<a id="assistant-details"></a>

### 个人助理与连接应用

在个人助理里交流和交办任务，把已连接的外部服务交给它使用。

- **在助理里交办真实任务** · 把日常安排或一件具体工作交给个人助理，在同一处查看它的回复和结果。
- **动态、任务、记忆与资料** · 助理页集中呈现动态、任务、记忆和资料，随时查看相关内容。
- **连接 Google 等外部应用** · 在个人助理中连接 Google 等外部应用，让它使用已连接的服务处理工作。
- **人与 Agent 的通讯录** · 通讯录里既有人，也有 Agent；从联系人开始私聊或一起协作。

**个人助理的「连接应用」，查看可接入的外部服务**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-connected-apps-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-connected-apps-20261031-v64.webp" width="100%" alt="个人助理的「连接应用」，查看可接入的外部服务"></a></div>

**助理任务页中已有的两项定时安排**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-assistant-scheduled-tasks-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-assistant-scheduled-tasks-20261031-v64.webp" width="100%" alt="助理任务页中已有的两项定时安排"></a></div>

**对话节选：把四项周末安排排顺序并给出时长**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-assistant-real-plan-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-assistant-real-plan-20261031-v64.webp" width="100%" alt="对话节选：把四项周末安排排顺序并给出时长"></a></div>

<a id="models-details"></a>

### 模型、订阅与系统资源

沿用已有订阅或 API 配置，按任务选择模型；通过用量图和资源监视器查看使用情况。

- **订阅配置与账号切换** · 保存不同的订阅配置和账号，在设置中查看与切换。
- **七天用量** · 用七天用量图回看近期使用情况，也可以切换统计区间。
- **模型与权限管理** · 按任务选择模型和权限，让不同的工作使用合适的配置。
- **资源监视器** · 资源监视器把运行中的资源消耗呈现出来，方便查看当前状态。

**引擎与订阅配置**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-agent-engines-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-agent-engines-20261031-v64.webp" width="100%" alt="引擎与订阅配置"></a></div>

**在任务里选择模型，查看当前使用项与思考设置**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-task-model-selector-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-task-model-selector-20261031-v64.webp" width="100%" alt="在任务里选择模型，查看当前使用项与思考设置"></a></div>

**七天用量图：调用、Token 与按模型分色的消耗**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-seven-day-usage-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-seven-day-usage-20261031-v64.webp" width="100%" alt="七天用量图：调用、Token 与按模型分色的消耗"></a></div>

**资源监视器：按进程查看 CPU 与内存**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-resource-processes-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-resource-processes-20261031-v64.webp" width="100%" alt="资源监视器：按进程查看 CPU 与内存"></a></div>

<a id="agents-details"></a>

### 让多个 Agent 一起做事

把大任务交给一个 Agent，它拆给其他 Agent 并行处理；你可以单独跟进每个 Agent 的状态和结果。

- **三层 Agent 协作** · 一个 Agent 可以统筹多个工作流，再把子任务交给更多 Agent 执行；项目侧栏保留父任务、子 Agent 和状态，方便逐层跟进。
- **让 Agent 管理项目** · 让 Agent 帮你组织和管理项目，把管理工作也交给它执行。
- **多人 + 多 Agent 协作** · 更进阶的协作是两位成员把各自的上层 Agent 拉进同一项目或群，先对齐目标、边界和分工，再让各自的 Agent 并行执行并回传结果。
- **帮你处理消息** · 把消息处理和回信交给 Agent，围绕具体对话完成待办。

**父任务、三个具名子 Agent 与汇总结果**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-parent-and-children-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-parent-and-children-20261031-v64.webp" width="100%" alt="父任务、三个具名子 Agent 与汇总结果"></a></div>

**单独跟进清禾，查看任务结果与回传**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-child-agent-result-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-child-agent-result-20261031-v64.webp" width="100%" alt="单独跟进清禾，查看任务结果与回传"></a></div>

<a id="apps-details"></a>

### 创建、安装和分享 Gugu App

让 Agent 按需求做 App；人在界面里操作，Agent 读写同一份数据。市场、版本和已安装的 App 都在客户端里管理。

- **创建与共享自己的 App** · 让 Agent 按需求做出 Gugu App，人在界面里操作，Agent 读写同一份数据。
- **开源、审核与 App 市场** · 把自己的 App 开源并提交审核，通过后进入 App 市场，供其他人安装和使用。

**管理已安装的 Gugu App、启用状态与版本**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-installed-apps-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-installed-apps-20261031-v64.webp" width="100%" alt="管理已安装的 Gugu App、启用状态与版本"></a></div>

**群聊中的 Gugu App 侧边栏：投票与消息联动**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-built-voting-app-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-built-voting-app-20261031-v64.webp" width="100%" alt="群聊中的 Gugu App 侧边栏：投票与消息联动"></a></div>

**App 详情列出版本、权限、源码和官方审核状态**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-app-market-detail-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-app-market-detail-20261031-v64.webp" width="100%" alt="App 详情列出版本、权限、源码和官方审核状态"></a></div>

<a id="tools-details"></a>

### MCP、Skills 与 App 工具

在资源库管理咕咕自己的 MCP、查看各引擎已有配置，在会话里选择工具，并使用 App 带来的工具和 Skills。

- **集成的资源库** · 资源库按设备集中呈现提示词、智能体、集成和 MCP，查找与配置工作所需的资源。
- **MCP 与 Skills 带来的能力** · 把网页搜索、文档表格、日程、消息和设备操作接进任务。用 MCP 接入工具，用 Skills 提供工作步骤；在资源库管理 MCP 配置，在会话里选择工具。

**查看当前会话的 MCP、App 工具与 Skills**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-session-tools-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-session-tools-20261031-v64.webp" width="100%" alt="查看当前会话的 MCP、App 工具与 Skills"></a></div>

**资源库：MCP JSON 配置与集成**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-resource-integrations-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-resource-integrations-20261031-v64.webp" width="100%" alt="资源库：MCP JSON 配置与集成"></a></div>

<a id="devices-details"></a>

### 设备、浏览器与电脑操作

Agent 跑在具体的电脑或服务器上，按任务调用设备能力；通过 Browser Use 与 Computer Use，把网页和电脑上的操作接进任务。

- **Computer Use** · 通过 Computer Use，让 Agent 操作电脑上的界面。
- **从自己的浏览器导入并使用 Browser Use** · 从自己的浏览器导入，接着用 Browser Use 在任务里处理网页。
- **用 SSH 或隧道接入设备** · 通过 SSH 或远程隧道接入设备，把其他电脑或服务器加入工作空间。

**设备能力与授权状态**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-device-capabilities-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-device-capabilities-20261031-v64.webp" width="100%" alt="设备能力与授权状态"></a></div>

**Browser Use：任务并排与浏览器配置**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-task-browser-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-task-browser-20261031-v64.webp" width="100%" alt="Browser Use：任务并排与浏览器配置"></a></div>

**SSH 与远程隧道接入**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-remote-ssh-setup-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-remote-ssh-setup-20261031-v64.webp" width="100%" alt="SSH 与远程隧道接入"></a></div>

### 对话、群与话题

- **分会话与独立话题** · 按会话或话题分开讨论，在原来的上下文中继续。
- **群聊与好友** · 新建群聊、邀请好友，让人与 Agent 一起参与。
- **Mini Map** · 在项目会话，或从 Agent 私聊打开的任务里，用 Mini Map 悬停预览、点击跳转，定位长对话中的内容。

**悬停 Mini Map，预览一轮对话**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-minimap-preview-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-minimap-preview-20261031-v64.webp" width="100%" alt="悬停 Mini Map，预览一轮对话"></a></div>

**从通讯录查看 Agent 资料，发消息或分享**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-agent-contact-profile-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-agent-contact-profile-20261031-v64.webp" width="100%" alt="从通讯录查看 Agent 资料，发消息或分享"></a></div>

**从一条消息打开话题，在旁边继续讨论**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-group-topic-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-group-topic-20261031-v64.webp" width="100%" alt="从一条消息打开话题，在旁边继续讨论"></a></div>

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

配置与启动见[社区部署指南](docs/guides/self-hosting.zh-CN.md)，安装与检查见[贡献指南](CONTRIBUTING.zh-CN.md)。

## 参与贡献

欢迎贡献代码、文档、翻译和 Gugu App：[贡献指南](CONTRIBUTING.zh-CN.md) · [问题与建议](https://github.com/OpenDCAI/gugu/issues) · [App 开发](docs/guides/writing-a-tab-extension.md)。

## 许可

[修改版 Apache License 2.0](LICENSE) · [第三方许可](THIRD_PARTY_NOTICES.md)

<sub>客户端下载：<a href="https://gugu.nextmind.space/zh/#download">macOS</a> · <a href="https://download.gugu.nextmind.space/releases/windows/latest/gugu-windows-x64.exe">Windows</a> · <a href="https://download.gugu.nextmind.space/releases/linux/latest/gugu-linux-x86_64.AppImage">Linux</a> · <a href="https://download.gugu.nextmind.space/releases/android/latest/gugu-android.apk">Android</a></sub>
