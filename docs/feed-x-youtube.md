# 动态接 X + YouTube（feed-x-youtube）

鲸鱼娘桌宠「动态」页签从手动空壳接到 **X + YouTube** 内容展示（最小可用 MVP）。
本页只讲怎么配、怎么刷，不写任何密钥进仓库。

## 它能做什么

- **X**：按账号 handle 或关键词拉取最新动态。
- **YouTube**：按频道 URL / channel id 拉取最新视频（公开 RSS，**无需 API key**）。
- **手动动态**：原「写动态」保留，来源标 `manual`，可删。
- **动态列表**：每条带 `source`（`x` / `youtube` / `manual`）、标题（外链）、摘要、时间。
- **刷新**：面板「刷新」按钮手动拉；或设「自动刷新（分钟）」>0 让它定时拉。
- **失败不崩**：某个来源挂了，列表顶部显示一行提示，手动动态照常。

## 怎么配置

打开桌宠面板「动态」页 → **设置**：

| 字段 | 说明 |
| --- | --- |
| X 账号 | handle，如 `elonmusk`（不含 `@`）；与「关键词」二选一 |
| X 关键词 | 可选，留空则按账号拉 |
| YouTube 频道 | 频道 URL（如 `https://www.youtube.com/channel/UC…`）或裸 `channel_id`（`UC…`） |
| 自动刷新（分钟） | `0` = 仅手动；`>0` = 每 N 分钟自动拉一次 |

点「保存来源」。需要立刻看到内容就点「刷新」。

## 凭证与安全（硬约束）

- **仓库里没有任何 X / YouTube 密钥。** 这是 MVP 的红线。
- **YouTube** 走公开 RSS（`https://www.youtube.com/feeds/videos.xml?channel_id=`），天然不需要 key。
- **X** 走你**自己提供的 RSS 源地址**，通过环境变量 `FEED_X_RSS_BASE` 注入（例如你自建的
  nitter / RSSHub 实例，如 `https://rsshub.example/x/user`）。该变量只含公开 URL、**不含任何 token**。
  - 没设 `FEED_X_RSS_BASE` 时，X 拉取会**优雅失败**（面板提示 `not-configured`），不会写死端点、不会崩。
  - 不读 magpie/DSB 的密钥、不缓存云端 token；后续要接本机 X CLI / magpie 也走同一「用户自带源」思路。

```bash
# 启动 dsh web 前（示例）
export FEED_X_RSS_BASE="https://rsshub.example/x/user"
```

## 本地验证

```bash
# 跑单元测试（含 X/YouTube 解析 + 失败容忍 + 去重）
node --test test/host.test.js

# 起 dsh web 后，看面板动态页；或 curl 看配置落库
curl -s localhost:$(dsh web port)/api/pet-one/state | grep -o '"feedSources":{[^}]*}'
```

## 接口（host 侧）

- `POST /api/pet-one/feed/config` — 保存来源配置（body: `{ x, youtube, refreshMinutes }`）
- `POST /api/pet-one/feed/refresh` — 手动拉取（body 可带 `fetchImpl`？否，仅供内部/测试）
- 桌面命令 `refresh-feed` 等价「刷新」按钮
- 数据存在 `<dshHome>/pet-one/state.json` 的 `feedSources` / `feedStatus`，**不在 botharness.db**

## 范围外（本 MVP 不做）

- 不发帖、不完整社交客户端、不碰 botharness.db 双写；
- 不强制一次接齐所有平台（先 X，再 YouTube）；不改任务 XP 看板。

## 文件

- `lib/host/feed-sources.js` — 来源拉取（YouTube RSS / X RSS，可注入 fetch 便于测试）
- `lib/host/feed.js` — 动态条目归一化（新增 `title` / `summary` / `link`）
- `lib/host/store.js` — `feedSources` / `feedStatus` 的默认与归一化
- `lib/host/service.js` — `configureFeedSources` / `refreshFeedSources` / 定时轮询
- `lib/host/routes.js` — `feed/config` / `feed/refresh`
- `desktop/panel/index.html` — 设置表单 + 富文本动态渲染
