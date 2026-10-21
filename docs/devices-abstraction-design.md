# Devices 抽象 + 设备管理面板（设计）

## 意图
把「设备」做成一个**通用抽象 + 设置内管理面板**,让用户能：认清哪台是哪台/哪台是本机、给设备起友好名、增删改查、在 create-agent 时挑设备（含在 Linux 服务器等远程设备上启动 agent）。源于维护者需求：Linux 作服务端(不看它面板、主用 Mac、同账号多设备),create agent 时指定设备。

## 现状（已验证,别重造）
- **数据/路由骨架已在**：`create_owned_agent` 强制 `p_device_id`(迁移 `fix_create_owned_agent_device_required`);agent 创建走**设备命令**(`createAgentDeviceCommandInsert`)投到目标设备,由目标设备的 `deviceRuntimeHost`(`apps/desktop/electron/main.ts:255` 每台桌面启动即跑)`claimDeviceCommand` 原子认领并建本地记录。→ **跨设备「Mac 建、Linux 跑」全链真通**,前提是 Linux 真跑起 gugu(=#1726)。
- **`Device` 类型已存在**(`packages/core/src/shared/types/chat.ts`)：`device_id / label / hostname / platform / status / last_seen_at / is_online / capabilities{terminals,runtimes,host_runtime_capability}`。`listDevices`(`cloud/devices.ts`)已有。
- **痛点**：`label` 现在≈OS hostname(丑,如 `macpro12414141`)、不可改、无 rename RPC;create-agent 里的选择器被简化;无设备管理面板;分不清本机;UI 不好看。
- **本机可识别**：`platform.getLocalDeviceSelfSnapshot().device_id`(`apps/desktop/src/lib/chat.ts:1953`)已可用。
- **presence 实时已有**：`agentPresenceStore.ts`(`computeDeviceOnline`)、`deviceRpc.ts`(realtime channel)→ 复用,别自建。

## 领域模型：Device
| 字段 | 说明 |
|---|---|
| `device_id` | 不可变自然键(machine-id 派生) |
| `label` | **用户可编辑友好名**;默认=平台基名+序号(`Mac 1`/`Linux 1`),复用 #1183 「基名+不撞号序号」命名器 |
| `hostname` | 自动、技术细节、UI 小字副标 |
| `platform` | mac/linux/win —— **移动端(android/ios)不算 device**(领域定义,非过滤) |
| `is_online` | 派生、实时(复用 presence) |
| `capabilities` | `{terminals, runtimes, host_runtime_capability}` |
| 派生 `isCurrent` | `=== ` local device_id → 「本机」badge |
| 派生 `daysOffline` | 离线设备显示「N 天未上线」,帮认僵尸 |

## 决策（grilling 结论）
1. **命名**：`label` 可改,默认平台基名+序号,可编辑。本机打「本机」badge;hostname 降为小字。
2. **面板位置**：**设置内一个「设备」pane**(与现有设置面板并列),不单开顶级导航。
3. **「增」**：**启动 gugu 即自动注册**,无手动创建表单(面板只做查/改/删 + 一句引导)。
4. **「删」语义(分期)**：
   - Phase 1 = **a 拦 + c 显式级联**：无绑定 agent 直接删；有绑定 agent 则**默认拦住**、列出、要删须**显式勾选「连同 agent 一起删」+二次确认**。全程无静默、无 orphan 中间态。
   - **本机不可删**(在线且会重注册,删无意义 → 按钮禁用+标「本机正在运行」)。
   - 僵尸设备(重装→machine-id 变→旧行永离线)**纯手动删**,靠「N 天未上线」认;不自动清(防误杀关机几天的正经设备)。
5. **选设备(selector)**：**仅在线可选**;离线可见但置灰不可选;排序 **本机 → 其他在线 → 离线**,默认选本机(在线时)。**不排队等上线**。
6. **能力门控**：**平台级**(移动端非 device,桌面才可托管本机 agent);跑不了时 fail-loud 报错,不静默。
7. **抽象形态**：**前端更重的 store**(与 `store/chat` 同构),而非轻 hook(presence 一变即 stale)也非纯后端。

## 抽象结构
- **`apps/desktop/src/store/devices.tsx`**（单一事实源）：`list`(core service) + live online(复用 `agentPresenceStore`) + `isCurrent` + 排序 + `rename/remove` action + `refresh`。面板与 selector **都只订它**。
- **core service `packages/core/src/cloud/devices.ts`**：已有 `listDevices`,补 `renameDevice(id,label)` / `removeDevice(id,{cascade})` → 对应新增 supabase RPC + RLS(owner-only,`identity` schema)。
- **共享 `DeviceRow`**：平台图标 + label + 本机 badge + 在线/天数。selector(下拉,仅在线可选)与 panel(管理列表 + 改名/删除)复用。

## 分期
- **Phase 1**（本 issue）：store + `renameDevice`/`removeDevice` RPC(a+c 语义)+ 设置「设备」pane(查/改名/删,本机不可删,僵尸天数提示)+ create-agent selector 改用 store(排序/门控/仅在线可选)。
- **Phase 2**：**rebind**(把已有 agent 迁到另一台设备)→ 引入 orphan→救活;a 的「拦」处多一个「迁走」选项。
- **前提线**：#1726（Linux 跑 gugu）——已验证跨设备可用,不阻塞本设计。

## 暂缓/存疑
- **引擎级门控**(选 codex 只让 `runtimes` 含 codex 的设备可选):先不做(桌面都能装引擎,过度门控挡路),留待 `runtimes` 采集可靠后细化。
- `daysOffline` 无硬「僵尸」阈值,只显示天数由用户判断。
