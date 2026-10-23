# 纳管 nanobot 技术评估

> 版本：v1（2026-10-23）
> 实验环境：macOS（Apple Silicon），uv 0.12.19，CPython 3.12.13
> 模型：本机 magpie 网关 `http://127.0.0.1:3425/v1`，`group/deepseek-flash`（实测真实调用）
> 结论先行：**可以纳管，成本中等偏低；最大的风险不是技术，而是“双脑记忆不一致”和“渠道需要公网”**。

---

## 0. 一句话结论

nanobot 适合当**渠道 + 定时 + 记忆整理**的后台，不适合当**理解你项目的那个大脑**。因此本项目的架构是：**DSH 主脑、nanobot 渠道桥、宠物做形象与入口**（ADR-007）。实测本机常驻 101–181MB、冷启动 1.09s、重启 0.56s，技术上完全可常驻。

---

## 1. 实测数据（本机）

| 指标 | 实测值 | 测试条件 |
|---|---|---|
| 安装耗时 | **21.9 s** | `uv pip install "nanobot-ai[api]"`，含全部依赖（离线缓存未命中） |
| 冷启动 → `/health` 可用 | **1.09 s** | `nanobot serve`，mock provider |
| kill 后重启 → `/health` | **0.56 s** | 会话文件已存在 |
| 常驻 RSS（空闲） | **101–109 MB** | 仅 API，未接渠道 |
| 单次请求后 RSS | **181 MB** | 7.3k token system prompt + 1 轮对话 |
| 非流式响应延迟 | **4.9 s** | 大头是 nanobot 自组 prompt（7277 token）+ mock 调用 |
| 流式首字节 | **0.06 s** | `stream: true`，SSE |
| 会话落盘 | `~/.nanobot/sessions/<hash>/<base64(session_id)>.jsonl` | 按 session 隔离 |
| provider 失败行为 | **不崩、不 5xx**；把 `Error calling LLM: Connection error.` 写进 assistant 内容；`/health` 仍 ok | 杀掉 mock provider |
| 无 provider 配置 | **直接退出**：`Error: No provider is configured for model ...` | `config.json = {}` |

### 1.1 真实模型实测（magpie 网关，2026-10-23 补充）

| 指标 | 实测值 |
|---|---|
| 冷启动 → `/health` | **0.56 s** |
| 空闲 RSS | **101.5 MB** |
| 第 1 轮延迟（冷） | **4.41 s** |
| 第 2 轮延迟（同 session） | **2.10 s** |
| 单轮 prompt tokens | **7451**（system prompt + 22 个工具） |
| 单轮 completion tokens | 14–53 |
| 3 轮后 RSS | **157.8 MB** |
| 会话记忆 | 同 `session_id` 能回忆上一轮 ✅ |
| 会话隔离 | 新 `session_id` 干净 ✅ |

**成本估算**（DeepSeek 官方价：输入 2 元/百万、缓存 0.5 元/百万、输出 8 元/百万）：

| 场景 | 单轮 | 20 轮/天 | 100 轮/天 |
|---|---|---|---|
| 无缓存 | 0.0150 元 | 9.0 元/月 | **45 元/月** |
| 90% 缓存命中 | 0.0050 元 | 3.0 元/月 | **15 元/月** |

> **关键发现：7451 token 里有约 7000 是 nanobot 自带的固定开销**（22 个工具定义 + AGENTS/SOUL/USER/HEARTBEAT 四个 bootstrap 文件 + 记忆说明）。这部分**每轮都发**，与 DSH 的 system prompt 高度重复。若不做精简，单纯“转发一句话”也要付 7k token 的代价。

### 由此得出的三条工程要求

1. **必须做“伪成功”识别**：客户端不能只看 HTTP 200，要匹配 `content` 里是否以 `Error calling LLM` 开头，或直接用 `usage.prompt_tokens == 0` 判断。
2. **必须有 provider 才能启动**：配了 mock/真 provider 才起得来。部署脚本要先校验配置，否则进程起来又立刻死，看起来像“崩溃循环”。
3. **内存要盯**：单请求涨 80MB，长时间多会话可能继续涨。上线后要采样 `RSS` 并设阈值（比如 >400MB 重启）。

---

## 2. Python 3.11+ runtime 方案对比

nanobot 要求 `>=3.11`。本机系统 `/usr/bin/python3` 是 3.9（Live2D 页面当前用的就是它，起 `http.server` 够用，跑 nanobot 不行）。

| 方案 | 命令 | 优点 | 缺点 | 适用 |
|---|---|---|---|---|
| **A. uv 独立 venv（推荐）** | `uv venv --python 3.12 .venv && uv pip install "nanobot-ai[api]"` | 21.9s 装完；不污染系统；锁文件可复现；uv 已在机器上 | 需要 uv（已具备） | **本机 + 服务器统一用这个** |
| B. uv tool install | `uv tool install nanobot-ai` | 全局 `nanobot` 命令，升级简单 | 隔离在 `~/.local/share/uv/tools`，多实例共用一份依赖，不便锁定版本 | 个人临时用 |
| C. pyenv | `pyenv install 3.11.x` | 版本管理细 | 编译慢（10min+），与 brew python 易冲突 | 需要 3.11 精确版本时 |
| D. Docker | `docker run` | 服务器上最干净；渠道隔离 | macOS 上 Docker 常驻 2GB+；文件/端口映射麻烦；本机不划算 | **仅服务器** |
| E. 依赖 DSH runtime | 复用 `~/.dsh/dsh-runtimes/...` | 无新增 | DSH 运行时是 3.9/3.14？版本不保证，且会随 DSH 升级耦合 | 不推荐 |

**结论**：
- 本机：**A**（uv venv，装在 `~/Library/Application Support/DSHPetOne/gateway/`，不走系统 python）
- 服务器：**A 或 D**；如果服务器只跑 nanobot，A 更省资源；若还要跑别的，D 更干净

---

## 3. 渠道鉴权方式（按落地难度排序）

| 渠道 | 鉴权方式 | 是否需要公网 | 难度 | 备注 |
|---|---|---|---|---|
| **Telegram** | BotFather 拿 token；长轮询或 webhook | 轮询**不需要**公网 | ★☆☆ | **首选**，最适合“服务器掉线也能工作” |
| **飞书 Lark** | 自建应用 app_id/app_secret；事件订阅需**回调 URL** | 需要公网 HTTPS | ★★☆ | 企业自建应用可只对内部开放 |
| **Discord** | Bot token + Gateway 长连接 | 不需要 | ★☆☆ | 与 TG 同级 |
| **Slack** | Socket Mode（不需要公网）或 Events API | Socket 模式不需要 | ★★☆ | 工作区审批较慢 |
| **钉钉** | Stream 模式（Stream 库，不需要公网） | 不需要 | ★★☆ | 需要企业内部应用 |
| **企业微信** | 回调 URL + 加解密 | 需要公网 | ★★★ | 配置最繁琐 |
| **微信（个人号）** | 扫码登录 + 本地协议桥 | 不需要 | ★★★ | 有封号风险，不建议主力 |
| **QQ** | 官方 botpy token | 不需要 | ★★☆ | 需申请 |
| **Teams** | Azure Bot + JWT | 需要公网 | ★★★ | 企业场景才用 |
| **邮件** | IMAP/SMTP（授权码） | 不需要 | ★☆☆ | 适合“通知”而不是“对话” |
| **Signal** | signal-cli 本地桥 | 不需要 | ★★★ | 需要额外进程 |
| **Matrix** | homeserver 账号 + access token | 可选 | ★★☆ | 自建服务器友好 |

**双机切换的现实约束**：
- **长轮询型**（TG/Discord/钉钉 Stream/Slack Socket）：两端**不能同时跑**，否则同一消息被两边同时消费（TG 会报 `Conflict: terminated by other getUpdates`）。→ 必须靠“主端选举”，备端不轮询。
- **Webhook 型**（飞书/企微/Teams）：DNS/回调 URL 只能指向一个入口，切换要做 DNS 或反代切换。→ **这是双机方案里最麻烦的部分**。

**建议首批渠道**：Telegram（主）+ 邮件（通知）+ 飞书（你工作时用），避开个人微信。

---

## 4. DSH ↔ nanobot 会话映射设计

### 4.1 现状

- 宠物通过 `ctx.agents.get(sessionId).followup(...)` 往 **DSH 会话** 发消息
- nanobot 用 `session_id` 隔离会话，落盘 `sessions/<hash>/<base64>.jsonl`

### 4.2 映射策略：**一个 DSH 会话 ↔ 一个 nanobot session**，但**不是 1:1 复制历史**

```
DSH session "abc123"
   ↓ 用户在面板说话
followup("abc123", "帮我看下今天的日程")
   ↓ 宠物同时把这条转发给 nanobot（可选）
POST /v1/chat/completions { session_id: "dsession:abc123", messages:[...] }
   ↓ nanobot 执行（cron 查询 / IM 发送 / 记忆整理）
   ↓ 返回结果
宠物气泡显示 nanobot 的回复（与 DSH 的回复分开呈现）
```

**关键决策**：
- **不把 DSH 的历史塞给 nanobot**。nanobot 的 7277 token system prompt 已经很大，再塞历史会让每轮成本暴涨，且两个大脑的“记忆”会互相污染。
- nanobot 只处理**明确路由给它**的请求（日程、提醒、发消息、查记忆），其余走 DSH。
- 路由用**前缀或意图分类**，不做“让模型自己决定”，否则不可预测。

### 4.3 标记位设计

| 场景 | 标记 | 处理 |
|---|---|---|
| 用户在面板说普通话 | 默认 | 走 DSH |
| 用户说 `/nb <内容>` 或点“渠道”按钮 | 显式 | 走 nanobot |
| nanobot 推来的 IM 消息 | `source: gateway` | 注入 DSH 会话作为用户消息（附渠道与发送者） |
| 宠物主动通知 | `source: pet-notify` | 走 nanobot 的 message 工具外发 |

### 4.4 双机下的会话

- `session_id` 里带机器标识（`dsession:abc123@mac` / `@srv`）
- 不做跨机历史同步（ADR-008），切换后是“新的一段对话”
- 若未来要同步，从 `sessions/*.jsonl` 增量同步即可，文件格式简单

---

## 5. 失败回退点（必须写进代码）

| 失败点 | 表现 | 回退动作 |
|---|---|---|
| provider 未配置 | 进程启动即退出 | 启动前校验 `config.json`，缺失则不起 gateway，宠物只用 DSH |
| provider 报错 | 200 + `Error calling LLM...` | 内容识别 → 气泡显示“渠道大脑暂时不可用”，不写进记忆 |
| nanobot 进程挂了 | 连接拒绝 | 宠物侧 30s 重试；连续 3 次失败 → 面板显示“网关离线” |
| 端口冲突（8900） | 启动失败 | 读 `config.json` 的 api 端口，冲突则自动换 +1 |
| 双机同时轮询 TG | `Conflict: terminated by other getUpdates` | 主端选举（心跳 + 文件锁），备端不启动渠道 |
| 渠道回调 URL 切换 | 消息丢失 | 切换窗口内两端都记录 webhook 但只主端处理 |
| 内存膨胀 | RSS > 400MB | 自动重启 gateway（保留会话文件，不影响历史） |
| Python 环境损坏 | import 失败 | `uv sync` 重建；或回退到上一个 venv 快照 |

---

## 6. 部署形态建议（本机 + 服务器）

### 本机（Mac）

```
~/Library/Application Support/DSHPetOne/gateway/
├── .venv/                 # uv venv 3.12
├── config.json            # provider + channels（key 用 ${ENV} 插值）
├── home/.nanobot/         # 会话、记忆、workspace
└── run.sh                 # 启动脚本（含 HOME 隔离）
```

用 `launchd` 常驻（`~/Library/LaunchAgents/com.dshpetone.gateway.plist`），`KeepAlive` + `ThrottleInterval`。

### 服务器

- 优先 **Docker**：镜像固定版本，渠道依赖不污染主机
- 数据卷：`/data/.nanobot`
- 反代：Caddy（自动 HTTPS）+ 只对飞书/企微 webhook 开放
- 与本机通信：**不直连**。两端各自跑自己的 nanobot，靠“主端选举”决定谁处理渠道；宠物只连本机的 `127.0.0.1:8900`

### 为什么不让本机直接连服务器 nanobot

跨机调用要过公网、要鉴权、要处理 NAT 与断线重连；而收益（共享一份会话）我们已决定放弃（ADR-008）。**本机优先、服务器兜底**是成本最低的双活。

---

## 7. 工作量估算（给 Q2-C“全套”用）

| 模块 | 工作量 | 风险 |
|---|---|---|
| 实验与文档 | 0.5 天（已完成） | — |
| 本机 gateway 安装 + launchd + 健康检查 | 1 天 | 低 |
| 宠物 ↔ nanobot 路由（`/nb` 前缀 + 显式按钮） | 1.5 天 | 中：伪成功识别、超时 |
| Telegram 渠道接入 | 0.5 天 | 低 |
| 飞书 webhook + 公网入口 | 2 天 | 高：需要公网与备案/域名 |
| 双机主端选举 + 心跳 | 2 天 | 中：脑裂 |
| cron / Dream 记忆联动 | 1 天 | 低 |
| 面板“网关状态”页签 | 0.5 天 | 低 |
| **合计** | **约 9 天** | 主要是渠道与双机 |

> 若砍掉飞书公网与双机，只做 **Telegram + 本机**，合计约 **3 天**。

---

## 8. 未解决 / 待验证（共同未知）

0. **双份 system prompt 的成本**：nanobot 7451 token + DSH 自身上下文，每轮叠加。需决定是否裁剪 nanobot 的工具集（`mcp`/`my`/`spawn` 等按需开）。
1. **nanobot 的 Dream 记忆格式**未实测：是否可直接给 DSH 当“长期记忆”读？→ 需看 `nanobot/skills/dream` 或 `memory/` 实现。
2. **多会话并发时的内存增长曲线**未测：单请求 +80MB 是常态还是泄漏？→ 需压测 100 轮。
3. **渠道消息去重**：nanobot 自身是否处理 TG 重投递？→ 需读 `channels/` 实现。
4. **DSH 侧注入外部消息**是否会触发自动化/工具循环？→ 需在临时 DSH 实例里验证。
5. **服务器与本机的 `session_id` 命名空间**是否会撞车？→ 设计里已用 `@mac/@srv` 后缀，需实测。

---

## 9. 参考

- nanobot 仓库：https://github.com/HKUDS/nanobot
- OpenAI 兼容 API：`docs/openai-api.md`
- 配置：`docs/configuration.md`
- 部署：`docs/deployment.md`
- 本机实验数据：本文第 1 节（2026-10-23）
