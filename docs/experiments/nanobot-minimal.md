# 实验记录：nanobot 最小可验证实验（2026-10-23）

**假设**：本机能在 30 分钟内跑起 nanobot 的 OpenAI 兼容 API，内存与冷启动可接受。

**结论**：成立。安装 21.9s、冷启动 1.09s、常驻 101–109MB，实际搭建 < 5 分钟。

> **补充（同日晚些）**：本机 magpie 网关（`127.0.0.1:3425`）可用，已用真实模型 `group/deepseek-flash` 重跑全链路，见第 9 节。

---

## 环境

- macOS（Apple Silicon）
- `uv 0.12.19`
- 实验目录 `/tmp/nanobot-lab`（隔离 `HOME`，不污染 `~/.nanobot`）
- 未接任何 IM 渠道（按实验设计）
- **未使用真实 LLM key**：DSH 的凭据受保护不可读，改用本地 mock OpenAI 服务验证链路

## 步骤与结果

### 1. 建 venv 并安装

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python "nanobot-ai[api]"
```

结果：**21.9 秒**装完，`import nanobot` 正常。

### 2. 空配置启动（负向用例）

```bash
HOME=/tmp/nanobot-lab/home .venv/bin/nanobot serve
```

结果：进程**立即退出**：

```
Error: No provider is configured for model 'anthropic/claude-opus-4-5'.
```

→ 结论：必须先写 provider 配置，部署脚本要预检。

### 3. 配 mock provider 后启动

```json
{
  "providers": {
    "custom": { "apiKey": "sk-mock", "apiBase": "http://127.0.0.1:8931/v1" }
  },
  "agents": { "defaults": { "provider": "custom", "model": "mock" } }
}
```

结果：
- 冷启动到 `/health` = **1.09s**
- `/v1/models` 返回 `mock`
- 空闲 RSS = **108.9 MB**

### 4. 一次完整对话

```bash
curl http://127.0.0.1:8900/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"session_id":"petone-lab"}'
```

结果：

```json
{
  "choices": [{"message": {"role":"assistant","content":"pong from mock"}}],
  "usage": {"prompt_tokens": 7277, "completion_tokens": 7, "total_tokens": 7284}
}
```

- 延迟 **4.91s**
- RSS 涨到 **181.3 MB**
- 注意 `prompt_tokens=7277`：nanobot 每次都带完整 system prompt（工具/技能/记忆说明），这是延迟与成本的主要来源

### 5. 流式

`stream: true` 首字节 **0.06s**，SSE 格式与 OpenAI 一致，以 `data: [DONE]` 结束。

### 6. 会话隔离

`session_id=lab-a` / `lab-b` 分别落盘：

```
~/.nanobot/sessions/<hash>/YXBpOmxhYi1h.jsonl   # base64("api:lab-a")
~/.nanobot/sessions/<hash>/YXBpOmxhYi1i.jsonl
```

→ 映射 DSH 会话时文件名可直接对应。

### 7. provider 故障

杀掉 mock 后请求返回 **HTTP 200**，内容为：

```
Error calling LLM: Connection error.
```

`/health` 仍返回 `{"status":"ok"}`。

→ **必须做伪成功识别**，否则宠物会把错误当正常回复念出来。

### 8. 重启持久化

`kill` 后重启到 `/health` = **0.56s**，会话与 workspace 文件保留。

---

## 数据汇总

| 指标 | 值 |
|---|---|
| 安装 | 21.9 s |
| 冷启动 | 1.09 s |
| 重启 | 0.56 s |
| 空闲 RSS | 108.9 MB |
| 请求后 RSS | 181.3 MB |
| 非流式延迟 | 4.91 s |
| 流式首字节 | 0.06 s |
| 单轮 prompt tokens | 7277 |

## 复现方式

```bash
mkdir -p /tmp/nanobot-lab && cd /tmp/nanobot-lab
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python "nanobot-ai[api]"
# 写 config.json（provider 指到任意 OpenAI 兼容端点或 mock）
HOME=/tmp/nanobot-lab/home .venv/bin/nanobot serve
```

## 未验证

- 真实 provider 下的首轮延迟（mock 无法代表）
- 多轮会话的 RSS 增长曲线
- 渠道（TG/飞书）真实收发
- Dream 记忆整理的实际行为


---

## 9. 真实模型复跑（magpie 网关）

**背景**：第一轮因 DSH 凭据受保护不可读，只能用 mock。后发现本机 `magpie` 网关（端口 3425）提供 OpenAI 兼容接口，DSH 默认模型即 `group/deepseek-flash`，可直接指向它，**无需读取 DSH 凭据**。

配置：

```json
{
  "providers": {"custom": {"apiKey": "local-magpie", "apiBase": "http://127.0.0.1:3425/v1"}},
  "agents": {"defaults": {"provider": "custom", "model": "group/deepseek-flash"}}
}
```

结果：

| 指标 | 值 |
|---|---|
| 冷启动 → health | 0.56 s |
| 空闲 RSS | 101.5 MB |
| 第 1 轮延迟 | 4.41 s（prompt 7451 / completion 14） |
| 第 2 轮同 session | 2.10 s，能记住上一轮 ✅ |
| 新 session | 干净，无历史 ✅ |
| 3 轮后 RSS | 157.8 MB |

**踩坑记录**（都已写进评估文档的部署建议）：

1. `pkill -f "nanobot serve"` **杀不掉**——nanobot 用 `setproctitle` 把进程名改成了 `nanobot`，命令行里没有 `serve` 了。要按**端口**杀：`lsof -nP -iTCP:8900 -sTCP:LISTEN -t | xargs kill -9`。
2. macOS **没有 `setsid`**，守护只能用 `nohup ... & disown` 或 `launchd`。
3. 端口被占时，新进程不会报错退出，而是**静默失败**；`/health` 仍由旧进程响应，导致“配置改了但行为没变”。必须用 `lsof` 校验端口归属。
