# Plan: 面板内创建 PersonaBot（像 Grok Bot）

**日期**：2026-10-23（Asia/Shanghai）  
**状态**：调查完成；创建路径 + model + `target:'bot'` 透传 + **多 bot 选择器** + **面板内编辑 / 删除 / IM 绑定**均已落地（本分支）  
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
| **创建按钮** | **有**（名称 / 可选人格 / 可选 model） | `panel/index.html` `#createBotForm` → `create-bot` |
| 编辑 / 删 / 绑渠道 | 无 | ADR-010 代价条 |

~~已知缺口：桌面 `sendChat` 丢 `target:'bot'`~~ **已修**（见 §5）：`main.swift` 把 `target` / `botSlug` 写入 `commands.json`；`drainDesktopCommands` 透传给 `chat(text, options)`。

---

## 3. Gap list → 面板内创建

要达到「像 Grok Bot 一样在面板里建 PersonaBot」：

1. **UI**：阵容卡「创建」→ 名称 + 可选人格 + 可选模型（渠道/preset 目录稍后）
2. **桌面桥**：`webkit` action → `commands.json` kind `create-bot`
3. **Host**：`PetOneService.createBot` → `botharness.creations.create`（**不** SQLite 直写）
4. **反馈**：创建成功后强制刷新 `readBots({force:true})`，气泡/脉冲提示
5. **多 bot 选中聊天**：**已做**（阵容点选 → `selectedBotSlug` 持久化 → chat 透传）
6. **后续仍不做**：Model catalog 下拉、preset、Git/zip、编辑 SOUL、绑定 IM

---

## 4. 最小 UI+API 流（复用 DSB，无第二脑）

```
Panel [创建] → post('create-bot', {displayName, persona?, model?})
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

**本分支已做**：

- `createPersonaBot` + service 命令 + 面板「创建」表单（名称 + 可选人格 + **可选 model**）
- Host / Swift / 面板透传 `model`（及可选 `preset`，API 已支持；UI 暂只暴露 model）到 `botharness.creations.create`
- **桌面 chat `target:'bot'` + `botSlug` 透传**：panel → `main.swift` `queueCommand` → `drainDesktopCommands` → `chat(text, {target, botSlug})` → `sendToBot`
- **多 bot 选择器**：阵容行可点选；`selectedBotSlug` 写入宠物 `state.json`（**非** `botharness.db`）+ panel `localStorage`；footer 目标钮显示短名；历史/定时按所选 bot 过滤；创建成功后自动选中新生 bot
- `writeLive()` 补齐 `bots` / `botBridge` / `selectedBotSlug` 等字段（此前只在 `view()`，桌面读不到阵容）
- **面板内编辑 / 删除 / IM 绑定（见 §7）**：`registry.update` / `deletions.preview+confirm` / `externalMessaging.identity` 三套 Cordis API 全部经 `botharness`，不直写 DB；面板「编辑」表单复用 create 风格，删除走浏览器 `confirm` 二次确认 + DSB preview/confirm 双保险；IM 绑定表单走 `bind-im` → `bindIm`，已绑定行支持 `unbind`
- `test/host.test.js` 增补 10 个用例覆盖上述三条路径（dsb 函数 + service 命令分发）
- 计划本文档（§7 更新）

**仍打开 / 刻意不做**：

- Model catalog 下拉（目前是自由文本，对齐 legacy `record.model` 字符串；不另起第二脑）
- preset 选择器、Git / zip / Marketplace 导入
- 改 ADR-010 正文（可另开 ADR-014「面板可创建」）

**验收**：

1. Bot 模式已开时，面板创建（可填 model）→ `persona_bots` 多一行且出现 DM；DSB 禁用时提示「Bot 模式没开」且宠物仍活。
2. 面板切到「Bot」目标发消息 → `commands.json` 含 `target:"bot"` → Host 走 `sendToBot`（非会话 agent）。
3. 阵容有 ≥2 个 bot 时：点选非默认 bot → 发消息 → `commands.json` 含对应 `botSlug`；重启面板后仍选中同一位（`state.json` / localStorage）。

---

## 6. 多 bot 选择器流

```
Panel 点选阵容行
  → selectedBotSlug (localStorage) + post('select-bot', {botSlug})
  → main.swift queueCommand("select-bot")
  → PetOneService.selectBot → state.json.selectedBotSlug
  → writeLive → live.json.selectedBotSlug / bots / botBridge

Panel 发送（target=bot）
  → post('chat', {text, target:'bot', botSlug})
  → chat(text, {target, botSlug}) 优先 options.botSlug，否则 resolveSelectedBotSlug()
  → sendToBot(ctx, botSlug, text)   // ADR-013 Cordis，不直写 SQLite
```


## 7. 面板内编辑 / 删除 / IM 绑定（本次新增）

### 7.1 编辑 PersonaBot

```
Panel [编辑] → post('update-bot', {botSlug, displayName, description?, model?, roles?})
  → main.swift queueCommand("update-bot", …)
  → commands.json → drainDesktopCommands
  → updatePersonaBot(ctx, …) → botharness.registry.update(slug, patch)
  → resetBotCache + readBots({force:true}) → live.json → 阵容刷新
```

- 可编辑字段对齐 `registry.update` 的 PersonaBotPatch：`displayName`（必填校验 ≤512）、`description`（≤160）、`model`、`preset`、`roles`（≤8）。
- 空 patch 返回 `empty-patch`；DSB 缺失返回 `dsb-unavailable`（提示「Bot 模式没开」）。

### 7.2 删除 PersonaBot

```
Panel [删除]（编辑表单内）
  → 浏览器 confirm 二次确认
  → post('delete-bot', {botSlug, eraseMemory?})
  → main.swift queueCommand("delete-bot")
  → deleteBot → deletePersonaBot → botharness.deletions.preview(slug) 取 token
                                          → botharness.deletions.confirm(slug, token, eraseMemory)
  → 若删除的是当前选中 bot：selectBot(null)
  → resetBotCache + readBots({force:true}) → live.json 刷新
```

- 受保护 bot（如 Tob）由 DSB 返回 `protected-bot`，提示「受保护的 Bot 不能删」。
- 删除为异步（preview+confirm）；`botAction` 脉冲先 `pending:true`，完成后置成功/失败行。

### 7.3 绑定 IM 渠道（飞书 / Telegram / …）

```
Panel [绑定到当前 Bot]（IM 渠道卡）
  → post('bind-im', {botSlug, kind:'bind', providerId, accountRef, fingerprint(64hex)})
  → main.swift queueCommand("bind-im")
  → bindIm → bindImChannel → botharness.externalMessaging.identity(slug, {kind:'bind', providerId, accountRef, fingerprint})
  → 已绑定行 [解绑] → kind:'unbind' + id + expectedRevision
```

- 绑定走 DSB 自带 `externalMessaging`，**禁止** nanobot；`providerId` 形如 `dsh-im/telegram`（面板下拉自动填，可手改）。
- `fingerprint` 必须 64 位 hex（来自 DSB / dsh-im 账号准备），否则 `invalid-fingerprint`。
- IM 渠道列表（只读）来自 `messaging_bindings`（`imChannels` / `imBindings`）；绑定结果经 `refreshBotsAfterMutation` 刷新。

### 7.4 约束复核

- ADR-011：所有失败走 `{ok:false}`，不拖垮宠物；DSB 缺失时降级提示。
- ADR-013：编辑 / 删除 / 绑全部经 Cordis `botharness`，**不**直写 `botharness.db`。
- ADR-012：不引入 nanobot（IM 绑定复用 DSB `externalMessaging`）。
- 不写密钥 / token：fingerprint 由用户从 DSB 账号准备处粘贴，不落文件明文。
