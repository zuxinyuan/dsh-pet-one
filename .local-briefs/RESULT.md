# RESULT — in-panel edit / delete / IM bind (dsh-pet-one)

**Branch:** `feat/in-panel-bot-create`  **Brief:** `.local-briefs/2026-10-23-edit-delete-im-bind.md`
**Commit SHA:** `996eb91`

## 改动文件

| 文件 | 变更 |
|---|---|
| `lib/host/dsb.js` | 新增 `updatePersonaBot`（`registry.update`）、`deletePersonaBot`（`deletions.preview`+`confirm`）、`bindImChannel`（`externalMessaging.identity`，bind/unbind/update）。全部经 Cordis `botharness`，不直写 DB。 |
| `lib/host/service.js` | 新增 `updateBot` / `deleteBot` / `bindIm`；`drainDesktopCommands` 分发 `update-bot` / `delete-bot` / `bind-im`；`writeLive` 补齐 `imChannels` / `imBindings` / `botAction` 等字段；删除成功自动 `selectBot(null)`。 |
| `lib/host/bots.js` | bot 记录补 `description` / `model`（编辑表单预填用）；快照补 `imBindings`（解绑 UI 用），降级路径也补空数组。 |
| `desktop/Sources/main.swift` | `buildInfoPanel` 增加 `update-bot` / `delete-bot` / `bind-im` action → `queueCommand`，参数映射与 panel 对齐。 |
| `desktop/panel/index.html` | Bot 卡新增「编辑」表单（displayName/description/model + 删除确认）、IM 绑定表单（平台自动填 providerId + accountRef + 64hex fingerprint）、已绑定行「解绑」按钮；删除走浏览器 `confirm` 二次确认。 |
| `test/host.test.js` | 新增 10 个用例：updatePersonaBot / updateBot / update-bot 分发 / deletePersonaBot(preview+confirm) / deleteBot(异步+清选中) / delete-bot 分发 / bindImChannel(校验+dispatch) / bindIm / bind-im 分发。 |
| `docs/PLAN-in-panel-bot-create.md` | 状态更新；新增 §7 记录编辑/删除/IM 绑定的流向与约束复核。 |

## 测试结果

`npm test` → **42 过 / 0 挂**（基线 32，新增 10）。

## 手动 smoke（rebuild + 改 + 删 + 绑 各一步）

1. **rebuild 桌面**：`cd desktop && ./build.sh`，启动 `DSHPetOne.app`；确认面板「Bot」页能列出阵容。
2. **改**：点阵容行「编辑」→ 改名称/简介/模型 → 保存 → 阵容名即时刷新，DSB `persona_bots` 对应行更新。
3. **删**：点「编辑」→「删除」→ 浏览器二次确认 → 气泡提示「正在删除」→ 成功后「已删除」，`selectedBotSlug` 若命中则清空。受保护 Bot（Tob）返回 `protected-bot`。
4. **绑**：在 IM 渠道卡选「飞书 / Telegram」自动填 `providerId`，贴入 `accountRef` 与 64hex `fingerprint` →「绑定到当前 Bot」→ 已绑定行出现可「解绑」。DSB 禁用时均提示「Bot 模式没开」，宠物不崩。

## 仍未做的缺口

- **IM `update` 类型未暴露 UI**：`bindIm` 支持 `kind:'update'`（`id`+`expectedRevision`+`name`/`enabled`），但面板只做 bind / unbind。
- **模型目录下拉**：编辑/创建均自由文本（对齐 legacy `record.model` 字符串），无 catalog 下拉（brief 非目标，刻意不做）。
- **preset 选择器**：DSB API 支持但面板未暴露。
- **fingerprint 需手动从 DSB/dsh-im 账号准备处粘贴**，面板不做账号发现（禁止 nanobot）。
- **未跑真实 DSB 端到端**：测试用 mock `botharness`，需在已装 DeepSeekBot 的机器上按上面 smoke 验证真实 API。

## 推送说明

已 commit 到 `feat/in-panel-bot-create` 并更新 PR #1（非 main，未 force push）。
