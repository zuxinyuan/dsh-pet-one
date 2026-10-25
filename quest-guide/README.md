# 任务指引（quest-guide）

鲸鱼娘桌宠的「今日任务指引」：DeepSeek BOT / 桌宠负责**展示**指引，soulmate 负责**写任务卡**。
本目录只放任务卡，不放任何密钥、不写云端。

## soulmate 怎么喂任务卡

把一张任务卡丢到仓库的 `quest-guide/` 目录即可。文件名二选一：

- `quest-guide/card.json`（或 `.yaml` / `.yml`）——**常驻卡**，每次都展示。
- `quest-guide/<日期>.json`（如 `2026-10-25.json`）——按本地日期键加载，过期不展示。

JSON 优先；想用 YAML 也行（极简结构：`issue #5` 里的 `#` 不会被当成注释）。

## 任务卡 schema（固定字段）

```jsonc
{
  "id": "2026-10-25-galaxy-ops-12",        // 必填，≤120 字符，任务唯一标识
  "title": "抄 galaxy-ops #5 含「12」的一行", // 必填，≤200，面板标题
  "goal": "打开 issue，把含「12」的那一行原样贴回", // 必填，≤500，今天要干嘛
  "accept": "用户贴出含「12」的原文一行，或回「没看过」", // 可选，≤500，完成判定
  "forbid": "不要替用户总结 issue",          // 可选，≤500，红线
  "guide": {                                // 必填，指引主体
    "steps": [                              // 必填，1–20 条字符串，点哪、走哪
      "打开浏览器或 gh：renderg-repo/galaxy-ops issue #5",
      "在正文里搜「12」",
      "把含「12」的那一整行原样复制",
      "粘贴给 soulmate；若没打开过就只回：没看过"
    ],
    "paths": [                              // 可选，≤20，可点击/可复制的路径
      "https://github.com/renderg-repo/galaxy-ops/issues/5",
      "gh issue view 5 -R renderg-repo/galaxy-ops"
    ],
    "stuck_reply": "卡在登录/权限就说「打不开」" // 可选，≤500，卡住回一句
  }
}
```

完整 JSON Schema 见 `schema.json`。host 侧校验（`validateCard`）只强制 `id` / `title` / `goal` / `guide.steps` 非空；
其余字段缺失会按安全空值处理，超长会被截断。

## 为什么会展示内置样例

找不到卡、或卡校验不过时，桌宠**不会崩**，而是回退到内置样例（`lib/host/quest-guide.js` 里的 `DEFAULT_CARD`），
保证面板永远有内容。所以即使你今天没喂卡，指引页也会显示一份默认样例。

## 分工（硬约束）

- **soulmate**：写每天的 `goal` / `accept` / `forbid`（短），以及 `guide.steps` / `paths` / `stuck_reply`。
- **DeepSeek BOT / 桌宠**：读卡、校验、在面板「指引」页渲染，把 `stuck_reply` 给到卡住的会话。
- 不改动看板 XP 计分；不让云端 Grok/soulmate 做逐步手把手；不把私钥写进仓库。

## 本地验证

启动 `dsh web` 后：

```bash
curl -s localhost:$(dsh web port)/api/pet-one/quest-guide | head
```

应返回含 `card` 的 JSON。面板切到「指引」页即可看到渲染结果。
