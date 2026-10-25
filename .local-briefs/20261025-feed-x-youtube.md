# Brief · 20261025-feed-x-youtube

## 目标
把桌宠「动态」从手动空壳接到 **X + YouTube** 内容展示（最小可用）。用户确认需要。

## 非目标
- 不做完整社交客户端；不发帖；不碰 botharness.db 双写
- 不强制一次接齐所有平台（先 X，再 YouTube）
- 不改任务 XP 看板

## 范围（仓）
`zuxinyuan/dsh-pet-one`（当前应在 `main` @ 含 quest-guide）。新分支 `feat/feed-x-youtube` 或独立 worktree。

## 产品要求（MVP）
1. **设置**：面板或配置里能填/选
   - X：用户 handle 或列表关键词（至少一种）；凭证走已有 magpie/DSB/系统钥匙串，禁止写死密钥进仓
   - YouTube：channel URL / channel id（至少一种）
2. **拉取**：定时或手动「刷新」；失败 fail-soft，动态页显示错误一句，不崩
3. **展示**：动态列表里带 `source`（`x` / `youtube` / `manual`）、标题/摘要、外链、时间；保留现有手动发帖
4. **文档**：`quest-guide` 同风格短 README：怎么配账号、刷新间隔

## 实现提示
- 现有 `lib/host/feed.js` + `POST /api/pet-one/feed/create|delete` + store `feedPosts`
- X：优先本机已有 X CLI / magpie / 公开 RSS 代理；不要为云端 token 硬编码
- YouTube：RSS `https://www.youtube.com/feeds/videos.xml?channel_id=` 通常够 MVP（无需 API key）
- 测试：normalize + 假数据源；可选对 RSS 做一次真实拉取（可 mock）

## 交付
- 提交在 `feat/feed-x-youtube`；**先不推 main**（digest 里给 push/PR 建议，等协调者/用户点头）
- digest → `…/digests/20261025-feed-x-youtube.md`

## 模型
hy3；`CODEBUDDY_IS_SANDBOX=1` + `--permission-mode bypassPermissions`
