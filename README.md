<div align="center">
<a id="readme-top"></a>

# Gugu 咕咕

**Gugu is an application built for AGI.**

### Let an Agent do the work.

Hand a task to an Agent. It calls on tools and devices as needed, coordinates the work and brings back the result.

**English** · [简体中文](README.zh-CN.md) · [About Gugu](#about-gugu) · [Website](https://gugu.nextmind.space/en/) · [Docs](https://gugu.nextmind.space/help/en/)

[![Claude Code](https://img.shields.io/badge/agent-Claude%20Code-C76B4A?style=flat-square)](#key-features) [![Codex](https://img.shields.io/badge/agent-Codex-252525?style=flat-square)](#key-features) [![MCP](https://img.shields.io/badge/tools-MCP-6A50D4?style=flat-square)](#key-features) [![Skills](https://img.shields.io/badge/workflows-Skills-328788?style=flat-square)](#key-features) [![Gugu Apps](https://img.shields.io/badge/extensions-Gugu%20Apps-E58F28?style=flat-square)](#key-features)

<img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-banner-en-20261031-v66.webp" width="100%" alt="Gugu 咕咕">

</div>

## Key features

### Everyday capabilities

<table>
<tr><td width="50%" valign="top"><h3>01 · Workspace</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-chat-file-split-motion-card-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-chat-file-split-motion-card-20261031-v66.webp" width="100%" alt="Workspace"></a><p>Work on tasks side by side. Arrange conversations, files, web pages and terminals together, or move them into separate windows.</p></td><td width="50%" valign="top"><h3>02 · Files and delivery</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-group-folder-edit-en-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-group-folder-edit-en-20261031-v66.webp" width="100%" alt="Files and delivery"></a><p>Write a document in the group folder together: @ an Agent and its edits appear in the file you have open. (The wait is shown at 2× speed.)</p></td></tr>
<tr><td><a href="#workspace-details">See it in use</a></td><td><a href="#files-details">See it in use</a></td></tr>
<tr><td width="50%" valign="top"><h3>03 · Personal assistant</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-connected-apps-card-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-connected-apps-card-20261031-v64.webp" width="100%" alt="Personal assistant"></a><p>Talk to your personal assistant, give it tasks and let it work with services you have connected.</p></td><td width="50%" valign="top"><h3>04 · Models and subscriptions</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-seven-day-usage-card-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-seven-day-usage-card-20261031-v66.webp" width="100%" alt="Models and subscriptions"></a><p>Use existing subscriptions or your API configuration and choose models per task. Inspect usage charts and the resource monitor.</p></td></tr>
<tr><td><a href="#assistant-details">See it in use</a></td><td><a href="#models-details">See it in use</a></td></tr>
</table>

### Advanced capabilities and development

<table>
<tr><td width="50%" valign="top"><h3>05 · Agent teamwork</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-parent-and-children-card-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-parent-and-children-card-20261031-v66.webp" width="100%" alt="Agent teamwork"></a><p>Give a larger task to an Agent and have it delegate work in parallel. Follow each Agent’s status and result separately.</p></td><td width="50%" valign="top"><h3>06 · Gugu Apps</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-app-market-install-en-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-app-market-install-en-20261031-v66.webp" width="100%" alt="Gugu Apps"></a><p>Inspect an App in the market, confirm the install and open it in the client; manage versions and enabled state in the same place.</p></td></tr>
<tr><td><a href="#agents-details">See it in use</a></td><td><a href="#apps-details">See it in use</a></td></tr>
<tr><td width="50%" valign="top"><h3>07 · MCP and Skills</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-session-tools-card-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-session-tools-card-20261031-v64.webp" width="100%" alt="MCP and Skills"></a><p>Manage Gugu’s MCP configurations in the resource library, inspect configurations from other engines, select tools per conversation and use tools and Skills supplied by Apps.</p></td><td width="50%" valign="top"><h3>08 · Devices and actions</h3><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-device-overview-card-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-device-overview-card-20261031-v64.webp" width="100%" alt="Device capabilities, Browser Use and Computer Use"></a><p>Agents run on computers or servers and use device capabilities as needed. Browser Use and Computer Use bring web and desktop actions into their tasks.</p></td></tr>
<tr><td><a href="#tools-details">See it in use</a></td><td><a href="#devices-details">See it in use</a></td></tr>
</table>

<a id="workspace-details"></a>

### Agent workspace

Projects, tasks, files and windows come together in one working surface.

- **Create Agents throughout a project** · Create an Agent directly in a project and give it a task.
- **Projects are separate from devices** · Bring sessions from different devices into one project to organize and follow their work together.
- **Live previews while Agents work** · Hover over a working Agent to preview its recent conversation, tool activity and progress before opening it.
- **Side chat, review, terminal and file browser** · Keep side chat, review, a terminal and the file browser in the workspace; enable TUI Mode in Settings to choose General or Terminal for a new task.
- **Split tasks, arrange files and detach windows** · Work on tasks side by side, split a conversation from its files, or move a tab into a separate window.
- **Import history from other Agents and harnesses** · Import conversation history from other Agents, harnesses or applications and continue existing work.

**The project sidebar’s new-task control and working-folder card**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-project-task-card-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-project-task-card-20261031-v66.webp" width="100%" alt="The project sidebar’s new-task control and working-folder card"></a></div>

**Split panes and windows: drag, compare, detach and restore**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-chat-file-split-motion-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-chat-file-split-motion-20261031-v66.webp" width="100%" alt="Split panes and windows: drag, compare, detach and restore"></a></div>

**Choose General or Terminal (TUI; enable it in Settings first) · parts shown at 2× speed**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-tui-terminal-en-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-tui-terminal-en-20261031-v66.webp" width="100%" alt="Choose General or Terminal (TUI; enable it in Settings first) · parts shown at 2× speed"></a></div>

**Hover over a working Agent to preview its recent conversation, tool activity and progress**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-working-agent-preview-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-working-agent-preview-20261031-v66.webp" width="100%" alt="Hover over a working Agent to preview its recent conversation, tool activity and progress"></a></div>

**Conversation history and source filter (Claude Code / Codex)**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-history-import-sources-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-history-import-sources-20261031-v66.webp" width="100%" alt="Conversation history and source filter (Claude Code / Codex)"></a></div>

<a id="files-details"></a>

### Group files and file collaboration

Documents and spreadsheets live in the group folder, and people and Agents work on the same file.

- **Live co-editing in the group folder** · Create a document in the group folder and keep writing while an Agent edits the same file; its changes appear in the editor you have open.
- **Pick cells in Gugu Office** · Open a spreadsheet from the folder in Gugu Office, select a range and put it in the composer as a reference for an Agent.
- **Quote a passage** · Select text in a document and bring it back to the conversation with its file name.
- **File storage management** · Inspect your file storage, used space and file-management tools.

**Gugu Office: select a column, put it in the composer and ask an Agent**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-office-pick-en-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-office-pick-en-20261031-v66.webp" width="100%" alt="Gugu Office: select a column, put it in the composer and ask an Agent"></a></div>

**Quote a passage: select text and bring it back with the file name**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-document-quote-motion-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-document-quote-motion-20261031-v66.webp" width="100%" alt="Quote a passage: select text and bring it back with the file name"></a></div>

<a id="assistant-details"></a>

### Personal assistant and connected apps

The personal assistant brings plans, files and external services together.

- **Give real tasks to your assistant** · Give your personal assistant an everyday plan or a specific job, then review its reply and results in one place.
- **Connect Google and other external apps** · Connect Google and other external apps to your personal assistant so it can use those services in its work.

**Personal assistant: order a weekend plan, schedule a reminder and find it under Tasks**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-assistant-schedule-en-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-assistant-schedule-en-20261031-v66.webp" width="100%" alt="Personal assistant: order a weekend plan, schedule a reminder and find it under Tasks"></a></div>


<a id="models-details"></a>

### Models, subscriptions and system resources

Models, subscriptions, usage and local resources each have a clear view.

- **Use the subscriptions you have, pick a model per task** · Keep your existing subscriptions and accounts, switch between them in Settings, and choose the model and permissions for each task.
- **Seven-day usage** · Review recent activity in the seven-day usage chart or choose another reporting period.
- **Resource monitor** · The resource monitor shows resource consumption while work runs, making current activity visible.

**Local resources and cloud storage in one view**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-resource-storage-en-20261031-v66.png"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-resource-storage-en-20261031-v66.png" width="100%" alt="Local resources and cloud storage in one view"></a></div>

**Engines and subscription settings**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-agent-engines-en-20261031-v66.png"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-agent-engines-en-20261031-v66.png" width="100%" alt="Engines and subscription settings"></a></div>


<a id="agents-details"></a>

### Have Agents work together

Give a larger task to an Agent and have it delegate work in parallel. Follow each Agent’s status and result separately.

- **Three-layer Agent collaboration** · One Agent can coordinate multiple workstreams and delegate subtasks to more Agents; the project sidebar keeps the parent task, child Agents and status visible.
- **Multi-person, multi-Agent collaboration** · For a more advanced workflow, two people bring their respective lead Agents into the same project or group, align goals, boundaries and ownership, then let their Agent teams work in parallel and return results to the shared space.


<a id="apps-details"></a>

### Build, install and share Gugu Apps

Inspect an App in the market, confirm the install and open it in the client; manage versions and enabled state in the same place.

- **Build and share your own Apps** · Have an Agent build a Gugu App. People use its interface while Agents work with the same data.
- **Open source, review and the App market** · Open-source your App and submit it for review. Once approved, it can enter the App market for others to install and use.

**Installed Apps: disable an App and enable it again**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-installed-apps-en-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-installed-apps-en-20261031-v66.webp" width="100%" alt="Installed Apps: disable an App and enable it again"></a></div>


**Paper Club: highlight a passage and ask an Agent about it in the group · parts shown at 2× speed**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-paper-club-reader-en-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-paper-club-reader-en-20261031-v66.webp" width="100%" alt="Paper Club: highlight a passage and ask an Agent about it in the group · parts shown at 2× speed"></a></div>


<a id="tools-details"></a>

### MCP, Skills and App tools

The resource library and session tools form the Agent’s working surface.

- **An integrated resource library** · The resource library brings prompts, Agents, integrations and MCP together by device so you can find and configure resources for your work.
- **Capabilities through MCP and Skills** · Bring web search, documents and spreadsheets, schedules and messages into tasks. Connect tools through MCP and use Skills for working procedures; manage MCP configurations in the resource library and select tools for each conversation.

**Resource library: MCP JSON config and integrations**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-resource-integrations-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-resource-integrations-20261031-v64.webp" width="100%" alt="Resource library: MCP JSON config and integrations"></a></div>

<a id="devices-details"></a>

### Devices, browser and desktop actions

Agents run on computers or servers and use device capabilities as needed. Browser Use and Computer Use bring web and desktop actions into their tasks.

- **Computer Use** · Use Computer Use to let an Agent operate desktop interfaces.
- **Import from your browser for Browser Use** · Import from your own browser, then use Browser Use to work with web pages as part of a task.
- **Connect devices through SSH or a tunnel** · Connect devices through SSH or a remote tunnel to bring other computers and servers into your workspace.

**Device capabilities and permissions**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-device-capabilities-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-device-capabilities-20261031-v64.webp" width="100%" alt="Device capabilities and permissions"></a></div>

**Browser Use: task panel and browser configuration**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-task-browser-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-task-browser-20261031-v66.webp" width="100%" alt="Browser Use: task panel and browser configuration"></a></div>

**SSH and remote tunnel setup**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-remote-ssh-setup-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-remote-ssh-setup-20261031-v66.webp" width="100%" alt="SSH and remote tunnel setup"></a></div>

### Conversations, groups and topics

- **Separate conversations and topics** · Separate discussions into conversations or topics and continue in their original context.
- **Groups and friends** · Create groups and invite friends to take part alongside Agents.
- **Mini Map** · In project conversations and tasks opened from Agent chats, hover over the Mini Map to preview turns and click to navigate a long conversation.

**Hover over the Mini Map to preview a conversation turn**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-minimap-preview-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-minimap-preview-20261031-v66.webp" width="100%" alt="Hover over the Mini Map to preview a conversation turn"></a></div>

**Open a topic from a message and continue the discussion beside the group**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-group-topic-20261031-v66.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-group-topic-20261031-v66.webp" width="100%" alt="Open a topic from a message and continue the discussion beside the group"></a></div>

**Group members are grouped into people and Agents**

<div align="center"><a href="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-group-members-20261031-v64.webp"><img src="https://github.com/OpenDCAI/gugu/releases/download/assets/gugu-readme-group-members-20261031-v64.webp" width="100%" alt="Group members are grouped into people and Agents"></a></div>

### Mobile

- **A minimal mobile workspace** · The mobile app keeps a simple interface and considered colors for checking and following work on the go.
- **Create tasks and Agents** · Create tasks and Agents on mobile and start work anywhere.

[More ways to use Gugu](https://gugu.nextmind.space/en/examples.html)

## About Gugu

If AGI arrives, it will not be one model solving everything. However capable a model becomes, it still needs a name, a place to belong, lasting context, tools, devices and collaborative relationships. Gugu provides these foundations so an Agent can take on more complete work as models improve.

[Read more about the idea](https://gugu.nextmind.space/en/about.html)

## Self-hosting and local development

| Repository | Contents |
| --- | --- |
| [OpenDCAI/gugu](https://github.com/OpenDCAI/gugu) | Desktop clients, Android, headless server and shared Agent runtime |
| [OpenDCAI/gugu-supabase](https://github.com/OpenDCAI/gugu-supabase) | Accounts, messages, sync, device communication and permissions |

See the [community setup guide](docs/guides/self-hosting.md) for configuration and startup, and [Contributing](CONTRIBUTING.md) for installation and checks.

## Contributing

Contribute code, documentation, translations or Gugu Apps: [Contributing](CONTRIBUTING.md) · [Issues and ideas](https://github.com/OpenDCAI/gugu/issues) · [App development](docs/guides/writing-a-tab-extension.md).

## License

[Modified Apache License 2.0](LICENSE) · [Third-party licenses](THIRD_PARTY_NOTICES.md)

<sub>Get the client: <a href="https://gugu.nextmind.space/en/#download">macOS</a> · <a href="https://download.gugu.nextmind.space/releases/windows/latest/gugu-windows-x64.exe">Windows</a> · <a href="https://download.gugu.nextmind.space/releases/linux/latest/gugu-linux-x86_64.AppImage">Linux</a> · <a href="https://download.gugu.nextmind.space/releases/android/latest/gugu-android.apk">Android</a></sub>
