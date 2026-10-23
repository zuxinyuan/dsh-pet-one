# Plan: 面板内创建 PersonaBot（像 Grok Bot）

**日期**：2026-10-23（Asia/Shanghai）  
**状态**：调查完成；最小创建路径已落地（本分支）  
**关闭的决策（soulmate）**：在宠物面板内创建 PersonaBot，**不** deep-link-only 到 DSB，**不** 走 nanobot。ADR-010/012/013 仍成立：大脑是 DSH/DSB；**禁止**直写 `botharness.db`。

---

## 1. DSB 今天如何创建 PersonaBot

### 1.1 UI 路径（DeepSeek Harness / Bot 模式）

证据：`~/.dsh/profiles/desktop/node_modules/@botharness/ui/lib/client.js`

1. Roster 菜单 → **Create Bot**（`roster.menu.createBot`）
2. 子项：Start empty / Import from GitHub / Import from zip
3. 表单字段：名称 `displayName`、Persona 预设（blank / colleague / roleplay）、标签 `roles`、简介 `description`、可选 Memory 目录
4. 提交：`actions.createBot({ displayName, persona?, roles, description?, memoryLocation? })`
5. 客户端：`createPersonaBot(call, input)` → `unwrap(call, "create" | "createFromGit", input)`（RPC 到 Host bridge）

相关文案键：`bot.create.title`、`bot.create.persona.*`、`bot.create.name.*`。

Onboarding 也有入口：`requestBotCreation()` → 同一套 Create Bot UI。

### 1.2 Host / Cordis API（可复用）

包：`@botharness/core@1.4.1`（`~/.dsh/profiles/desktop/node_modules/@botharness/core/dist/index.mjs`）

| 层 | 符号 / 调用 | 作用 |
|---|---|---|
| Cordis 服务 | `ctx.provide("botharness", core)` | 宠物已用 `ctx.get('botharness')`（见 ADR-013 / `lib/host/dsb.js`） |
| 创建服务 | `core.creations = createBotCreation({ database, registry, channels })` | 幂等创建 + 预留 slug + DM |
| 创建方法 | `creations.create(input, operationKey?)` | 写 registry + `channels.getOrCreateDm`；有 key 时记 `bot_creation_operations` |
| Bridge（UI RPC） | `bridge.create(payload)` in `createBridgeMethods` | 校验 `displayName` 等后调 `creations.create` |
| Tob 工具 | `createTobBotCreationOperations` command `"create"` | 允许字段：`operationKey, displayName, description, roles, avatar, persona, coreMemory` |

**`creations.create` 输入（与 bridge 对齐）**：

- **必填**：`displayName`（非空，≤512，无控制字符）
- **可选**：`persona`, `coreMemory`, `roles`（≤8）, `description`（trim ≤160 字符，Tob 路径）, `model`, `preset`, `workspaces`, `avatar`, `memoryLocation`
- **幂等**：`operationKey` 须匹配 `/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/`；同 key + 同 payload 可重试恢复 identity/DM

**返回**：`{ record, channelId, receipt? }`；失败抛 `BotCreationError`（code 如 `creation-key-conflict`, `creation-memory-conflict`, …）。

**表**：`persona_bots`、`bot_creation_operations`（本机目前 0 行操作记录；唯一 bot 是 Tob）。

### 1.3 本机现状

- `~/.dsh/botharness/botharness.db` → 仅 **Tob**（`bot-ead8dcfb579740739201c4f0b6745f00`，`tob_identity` 单例）
- 插件：`deepseekbot@1.4.1` + `@botharness/*@1.4.1` under `~/.dsh/profiles/desktop/node_modules/`

---

## 2. 宠物面板当前暴露什么

| 能力 | 现状 | 证据 |
|---|---|---|
| 阵容列表 | 有：读 SQLite `persona_bots`（目前只有 Tob） | `lib/host/bots.js` `readBots()`；`desktop/panel/index.html` `#botList` |
| 定时 / IM / 历史 | 有（只读） | 同上 + `source_events` / `messaging_bindings` |
| 发消息给 Bot | 有（ChannelStore） | `lib/host/dsb.js` `sendToBot`；ADR-013 |
| **创建按钮** | **无**；文案写「去 DSH 的 Bot 模式创建一个」 | `panel/index.html` empty state + footer hint |
| 编辑 / 删 / 绑渠道 | 无 | ADR-010 代价条 |

已知缺口（旁路，非本 PR 必做）：桌面 `sendChat` 未把 panel 的 `target:'bot'` 写入 `commands.json`（`main.swift` 只传 `text`；`service.drainDesktopCommands` 调 `this.chat(command.text)` 无 options）——Bot 发送在 Cordis/HTTP 路径可用，桌面队列路径可能仍走会话。

---

## 3. Gap list → 面板内创建

要达到「像 Grok Bot 一样在面板里建 PersonaBot」：

1. **UI**：阵容卡「创建」→ 名称 + 可选人格（模型/渠道稍后）
2. **桌面桥**：`webkit` action → `commands.json` kind `create-bot`
3. **Host**：`PetOneService.createBot` → `botharness.creations.create`（**不** SQLite 直写）
4. **反馈**：创建成功后强制刷新 `readBots({force:true})`，气泡/脉冲提示
5. **后续（本 PR 不做）**：模型选择、角色预设模板、Git/zip 导入、编辑 SOUL、绑定 IM、多 bot 选中聊天、修 desktop `target` 透传

---

## 4. 最小 UI+API 流（复用 DSB，无第二脑）

```
Panel [创建] → post('create-bot', {displayName, persona?})
  → main.swift queueCommand("create-bot", …)
  → ~/.dsh/pet-one/commands.json
  → PetOneService.drainDesktopCommands
  → createPersonaBot(ctx, …)
  → ctx.get('botharness').creations.create(input, operationKey)
  → registry + DM channel（DSB 自己的一致性路径）
  → resetBotCache + readBots({force:true}) → live.json → 面板刷新
```

约束对齐：

- ADR-011：失败返回 `{ok:false}`，不拖垮宠物
- ADR-013：经 Cordis `botharness`，不直写 DB
- ADR-012：不引入 nanobot

---

## 5. 本晚落地 vs 剩余

**本分支已做（最小安全切片）**：

- `createPersonaBot` + service 命令 + 面板「创建」表单（名称 + 可选人格）
- 计划本文档

**刻意不做**：

- 模型 / preset / Git / zip / Marketplace
- 编辑、删除、渠道绑定
- 修 chat `target` 桌面透传（另开 issue/PR）
- 改 ADR-010 正文（可另开 ADR-014「面板可创建」）

**验收**：Bot 模式已开时，面板创建 → `persona_bots` 多一行且出现 DM；DSB 禁用时提示「Bot 模式没开」且宠物仍活。
