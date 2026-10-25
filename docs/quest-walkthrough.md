# 任务指引 · 图文讲解（quest-walkthrough）

把「指引」从纯文字卡升级成**能像「艺术」页一样打开的单文件 HTML 图文讲解**（截图 + 热区/步骤说明），或者给纯文字卡附上截图与热区。参考开源 [Walkthrough-Creator](https://github.com/shangle/Walkthrough-Creator/)（MIT）。

> 不替用户做本人证据任务、不改 XP 计分、不碰 botharness.db、不写密钥、不合 main。

## 两种呈现方式

任务卡 `guide` 下新增两个**可选**字段，二者都不影响旧纯文字卡的渲染（fail-soft）：

### 1. 单文件 HTML 图文讲解（`walkthrough`）

```jsonc
"guide": {
  "walkthrough": {
    "html": "samples/galaxy-ops-12-walkthrough.html", // 相对 quest-guide 目录
    "caption": "照着点：从 issue 列表到复制含「12」那一行"
  }
}
```

面板「指引」页会像艺术页一样内嵌打开这份 HTML（iframe，同源资产路由 `/api/pet-one/quest-guide/asset?path=...`）。

### 2. 截图 + 热区（`media[]`）

```jsonc
"guide": {
  "media": [
    {
      "type": "image",                                  // image | html
      "src": "media/galaxy-ops-12-placeholder.svg",     // 相对路径或 http(s)/file URL
      "caption": "issue #5 正文占位截图",
      "hotspots": [                                    // 坐标按图片百分比 0–100
        { "x": 4, "y": 33, "w": 60, "h": 8, "label": "含「12」的那一行" }
      ]
    }
  ]
}
```

- `type: "image"`：渲染截图，hotspots 用 CSS 绝对定位红框 + 序号叠加。
- `type: "html"`：同 `walkthrough`，内嵌一份单文件 HTML 资产。

## 用 Walkthrough-Creator 产出讲解

1. 安装/打开 Walkthrough-Creator（GUI 可选；本功能不要求安装）。
2. 拖入截图、点出热点、写步骤文案，导出一个**自包含** `walkthrough.html`（图可 base64 或随附相对路径）。
3. 把导出的文件放到 `quest-guide/samples/`（或 `quest-guide/media/`），卡里填**相对 quest-guide 目录**的路径。
4. 验收：面板切到「指引」页，应能看到内嵌的图文讲解并可照着点。

> 样例：`quest-guide/samples/galaxy-ops-12-walkthrough.html`（占位截图 + 3 个假热点 + 步骤）。`quest-guide/media/galaxy-ops-12-placeholder.svg` 是占位截图，可被真截图替换。

## soulmate 的分工（硬约束）

- **soulmate**：只写 `goal` / `accept` / `forbid` 与 `guide.steps` / `paths` / `stuck_reply`（短）。
- **media / HTML 讲解**：由本地 Agent 或用户用 Walkthrough-Creator 生成后，填相对路径即可，soulmate 不必手搓 HTML。

## 资产路由与安全

- 读取范围被限制在 `quest-guide` 目录内，并限制扩展名白名单（`.html .htm .svg .png .jpg .jpeg .gif .webp`），杜绝路径穿越。
- 不允许读取仓库其它位置或任意文件。
- 资产不进 git 之外的地方，不写密钥。
