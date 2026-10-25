# 任务指引 · Pagewalk 投喂（quest-pagewalk）

把 [Pagewalk](https://github.com/hamad501/pagewalk)（本地隐私优先的 Chrome 扩展：录操作 → 自动截图 → 导出 HTML/Markdown）的产出，一键转成「指引」可用的图文讲解，**不必手抄步骤**。

本包与 [quest-walkthrough](./quest-walkthrough.md) 共用同一套 schema（commit `0d1220b`，分支 `feat/quest-walkthrough-html`），**不另起字段**：

```jsonc
"guide": {
  "walkthrough": { "html": "media/<cardId>-pagewalk.html", "caption": "副标题" },
  "media": [
    { "type": "image", "src": "media/<cardId>-shot-01.png", "caption": "Step 1 文案" }
  ]
}
```

渲染以 walkthrough 包为准（面板「指引」页内嵌打开 `guide.walkthrough.html`）。本包只负责**导入管线 + 文档**。

> 硬约束：不替用户做本人证据任务；不改 XP/计分；不碰 `botharness.db`；不写密钥；不合 main。

## 1. 安装 Pagewalk（Chrome 扩展）

无需构建、无需 npm、无需账号，全程本地。

1. 克隆或下载 <https://github.com/hamad501/pagewalk>。
2. 打开 `chrome://extensions`，右上角开启**开发者模式**。
3. 点**加载已解压的扩展程序**，选择下载目录。
4. 点工具栏里的 Pagewalk 图标，打开侧边栏。

> 装不了扩展（无 Chrome / 受限环境）也行：本包导入器直接吃一份手写或他处导出的 HTML/MD + 截图，不必真装扩展。

## 2. 录制并导出

1. 侧边栏点 **Start Capture**，去目标页面正常操作（每步自动截图）。
2. 完成点 **Complete**，在查看器里可改文案、重排步骤、加标注。
3. 导出，任选其一：
   - **Standalone HTML**（离线单文件，截图已内嵌）—— 推荐。
   - **Markdown**（步骤 + `![](截图.png)` 引用）。
4. 把导出文件连同截图，**整目录**拷到：

```
quest-guide/imports/pagewalk/<card-id>/
   ├─ pagewalk.html   ← 或 index.html / pagewalk.md（导入器自动发现）
   ├─ shot-01.png
   └─ shot-02.png
```

`<card-id>` 用任务卡 id，如 `2026-10-25-galaxy-ops-12`。导出文件名随意，导入器按 `pagewalk.html → index.html → pagewalk.md → *.md` 的优先级自动挑主导出文件，截图按目录内真实存在的图片配对。

### Pagewalk 导出结构（导入器识别的形态）

HTML（Standalone）：

```html
<section class="pw-step">
  <h3>Step 1: 打开页面</h3>
  <img src="shot-01.png" alt="..." />
</section>
```

Markdown：

```md
## Step 1: 打开页面
![说明](shot-01.png)
```

导入器对两种格式都做了容错：找不到 `.pw-step` 时，退化为「全部 `<img>` + 全部 `Step N` 标题」按序配对；Markdown 同理。所以即使 Pagewalk 改版了导出结构，只要「有步骤文字 + 有截图文件名」就能吃进去。

## 3. 导入（投喂给指引）

```bash
node bin/pagewalk-import.mjs <card-id> [importDir] [--caption "副标题"] [--dry-run]
```

示例（默认 `importDir = quest-guide/imports/pagewalk/<card-id>`）：

```bash
node bin/pagewalk-import.mjs 2026-10-25-galaxy-ops-12 \
  --caption "由 Pagewalk 录制生成：从 issue 列表到复制含「12」那一行"
```

导入器会：

1. 解析导出 → 提炼 `steps`（文案）与截图列表。
2. 把截图原文件**拷进** `quest-guide/media/`（加 `<card-id>-` 前缀防重名）。
3. 生成**单文件离线 walkthrough HTML**（截图以 base64 内嵌）写入 `quest-guide/media/<card-id>-pagewalk.html`。
4. **合并进 `card.json`**：只填/补 `guide.walkthrough` 与 `guide.media`，保留既有 `steps / paths / stuck_reply / 其它 media`（追加去重，**不覆盖**你之前手加的热区截图）。

`--dry-run` 只打印计划、不写盘，便于先在 CI 或本地预览。

产出后，面板切到「指引」页即可内嵌打开这份图文讲解，照着点。

## 4. 与 Walkthrough-Creator 路线：二选一 / 并用

| 路线 | 适用 | 产物 |
|------|------|------|
| **Pagewalk**（本包） | 录浏览器操作流程、自动截图、零手工 | `guide.walkthrough.html` + `guide.media[]` 截图 |
| **Walkthrough-Creator**（见 [quest-walkthrough](./quest-walkthrough.md)） | 已有截图、手动点热区、写步骤文案 | 同样落在 `guide.walkthrough` / `guide.media` |

两者**写同一组字段**，因此：

- 同一张卡只能挂一份 `walkthrough.html`（后导入的会覆盖；`media[]` 则追加）。
- 想要 Pagewalk 自动截图 + 手工热区？先跑 Pagewalk 导入产出 walkthrough，再手动在 `card.json` 的 `media` 条目里补 `hotspots`（`{x,y,w,h,label}`，坐标按图片百分比 0–100）。

## 5. 资产路由与安全

- 读取范围被限制在 `quest-guide` 目录内，扩展名白名单（`.html .htm .svg .png .jpg .jpeg .gif .webp`），杜绝路径穿越（沿用 walkthrough 包的 `service.questGuideAsset`）。
- 截图在 walkthrough HTML 里 base64 内嵌，单文件即离线可用；同时原文件落在 `media/`，供 `guide.media[]` 引用。
- 不写仓库外任何位置、不写密钥。

## 6. 测试

```bash
node --test test/pagewalk-import.test.js
```

覆盖：HTML / Markdown 解析、`buildWalkthroughHtml` 的 standalone 产出（base64 内嵌、无外部引用）、端到端导入（写盘 + `card.json` 合并不覆盖既有 media）、`--dry-run` 不写盘。

> 仓库样例：`quest-guide/imports/pagewalk/2026-10-25-galaxy-ops-12/`（一份假 Pagewalk 导出，含 HTML + MD 两种形态与占位截图），跑上面的命令即可复现「指引能吃下 Pagewalk」的证明。
