# Brief: in-panel edit / delete / IM bind (dsh-pet-one)

## 目标
在分支 `feat/in-panel-bot-create`（PR https://github.com/zuxinyuan/dsh-pet-one/pull/1）上实现桌宠面板内：
1. **编辑**已有 PersonaBot（displayName / persona / model 等 DSB 已支持字段）
2. **删除** PersonaBot（走 DSB API，需确认/二次确认 UX）
3. **IM 绑定**：把飞书/Telegram 等作为渠道绑到选中 bot（用 DSB 自带 IM，禁止 nanobot）

## 非目标
- 不自己实现第二套大脑
- 不直接写 `~/.dsh/botharness/botharness.db`
- 不合并 PR、不 push 到 main（可 push 当前 feature 分支）
- 不写密钥/token；日志脱敏

## 工作目录
`/Users/zuxinyuan/Documents/02-Projects/New project/GitHubProject/dsh-pet-one/`
当前 tip 约 `78f449a`。先 `git checkout feat/in-panel-bot-create && git pull`。

## 技术约束（ADR）
- ADR-010/012/013：大脑=DSH/DeepSeekBot；创建/改删/绑渠道都走 botharness Cordis API；聊天走 ChannelStore；无 SQLite 直写。
- 桌宠 state 可写 `~/.dsh/pet-one/state.json`（已有 selectedBotSlug）。

## 实现提示
- 先在 `~/.dsh/profiles/desktop/node_modules/@botharness/` 找到 update/delete/IM bind 的真实 API 名称与字段，再接线 panel → Swift queueCommand → host。
- 复用已有 create / select-bot / chat target+botSlug 路径风格。
- 更新 `docs/PLAN-in-panel-bot-create.md`。
- `npm test` 全绿后再 commit + push 到同分支（更新 PR #1）。

## 验收交回
1. commit SHA + 改动文件列表
2. 测试结果（几过几挂）
3. 手动 smoke 步骤（rebuild、改/删/绑各一步）
4. 仍未做的缺口
5. 若需用户确认再 push：说明本地已 commit 未 push

## 硬禁
- 不用付费模型思考题外扩 scope
- 不 force push、不改 main
- 不把 Telegram token 写进文件
