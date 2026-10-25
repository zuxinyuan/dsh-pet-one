# 桌宠姿态状态机（Pose FSM）· MVP

状态机把桌宠的「表现」从「会话活动相位（activity phase）」里抽出来，单独成一层。
会话相位（idle/waiting/thinking/tool/review/done/failed）继续驱动气泡文字与微表情；
**姿态（pose）** 是更粗粒度的、可被指令锁定、也能随宿主/任务状态自动切换的宠物表现。

> 范围：本 MVP 用**占位序列帧 + SVG 线稿**表现姿态，不接真实社区立绘、不做 Live2D。
> 真立绘/图集是另一包（另收），换皮只需把帧丢到约定目录（见末尾）。

## 1. 状态表

| 姿态 pose | 含义 | 默认表现（SVG） | 自动来源 |
| --- | --- | --- | --- |
| `idle` | 待机 | 轻微浮动 bob | 无进行中任务、且距离上次活动未超阈值 |
| `working` | 工作中 | 摆动 wiggle | 存在进行中会话（waiting/thinking/tool/review 任一） |
| `celebrate` | 庆祝 | 弹跳 bounce + 开心眼 | 一个回合（turn）刚完成 |
| `slack` | 摸鱼 | 缓慢呼吸 + 眯眼 | 自动模式下空闲超过 `slackAfterMs`（默认 5 分钟） |
| `pet` | 互动反馈（瞬态） | 腮红 + 开心眼 | 点击/摸头（本地 600ms 瞬态，覆盖一切） |
| `drag` | 拖拽反馈（瞬态） | 倾斜 tilt | 拖拽宠物（本地 1200ms 瞬态，覆盖一切） |

**优先级**（每帧解析）：`瞬态反馈(pet/drag)` > `手动锁定姿态(setPose)` > `自动目标(来自宿主状态)`。

## 2. 指令入口（命令式切姿态）

### 面板
设置面板新增「姿态」区段：
- 下拉框：`自动（跟随任务/宿主）` / `idle` / `working` / `celebrate` / `slack`
- 选具体姿态 = 手动锁定（mode=manual）；选「自动」= 回到自动（mode=auto）
- 点击宠物 → `pet` 反馈；拖拽宠物 → `drag` 反馈

### API（同源 JSON）
```
POST /api/pet-one/pose
{ "pose": "working" }          # 手动锁定；pose="auto" 回到自动
{ "pose": "idle", "ttl": 8000 }# 可选 ttl(ms)，到期自动回退到 auto

POST /api/pet-one/pose/react
{ "kind": "pet" | "drag" }     # 瞬态反馈，不影响 mode
```
返回 `{ ok, pose: { pose, react, mode, autoTarget } }`。非法 pose/kind → `{ ok:false, error }`。

### 状态快照（GET /api/pet-one/state）
新增字段：
- `pose` — 当前生效姿态（含瞬态 pet/drag）
- `poseMode` — `auto` | `manual`
- `poseAutoTarget` — 自动模式下推导的目标姿态
- `sprites` — 当前皮肤的占位/换皮帧 URL 映射（见 §4）

## 3. 自动切换规则

自动模式（`poseMode==='auto'`）下，每帧由宿主/活动状态推导：

1. **有进行中任务** → `working`
   （`activity.activeCount > 0` 或 phase ∈ {waiting, thinking, tool, review}）
2. **回合完成**（`turn/end` 且 `reason==='completed'`）→ 触发 `celebrate`
   - `celebrate` 保持 `celebrateMs`（默认 4000ms）后，**自动回落**到当时的自动目标
   - 若期间又出现进行中任务，回落时直接到 `working`
3. **空闲**（无活动）→ `idle`
4. **空闲超过 `slackAfterMs`**（默认 5 分钟，自动模式且仅当 idle）→ `slack`
   - 一旦活动恢复立即回到 `working`，slack 清零

手动模式（`setPose` 锁定，或带 ttl 的临时锁定）：
- 始终显示锁定的 pose，直到 `ttl` 到期或收到 `pose:"auto"`
- 瞬态 `pet`/`drag` 仍可在手动模式下短暂覆盖

## 4. 换皮目录约定（素材）

占位帧与未来真立绘使用统一目录约定（已被 `/api/pet-one/sprites` 路由直接服务，**无需改代码**）：

```
desktop/assets/sprites/<skin>/<pose>/frameN.png
                              └─ idle | working | celebrate | slack | pet | drag
                                 （可多帧 frame0/frame1… 做序列动画；MVP 每姿态 1 帧）
```

- 默认皮肤 `whale` 已生成 6 个占位帧（纯色方块，便于识别），由
  `scripts/gen-pose-sprites.mjs` 生成。
- 新增皮肤：新建 `desktop/assets/sprites/<新skin>/<pose>/frameN.png`，
  启动后 `GET /api/pet-one/state` 的 `sprites` 字段会自动包含其 URL。
- `services` 在构造时扫描该目录生成目录（tolerant：缺失/部分缺失不报错）。
- 真立绘落到另一收集包，**不要**直接塞进内置 `whale` 调色板皮肤。

## 5. 实现位置

- `lib/host/pose.js` — 纯逻辑 `PoseMachine`（可注入时钟，单测覆盖）
- `lib/host/service.js` — 实例化并接入：回合完成 `celebrate()`；`view()` 注入 pose/sprites；
  `setPose()` / `poseReact()`；`buildSpriteCatalog()` 扫描目录
- `lib/host/routes.js` — `POST /pose`、`POST /pose/react`、`GET /sprites/...`
- `lib/client.js` — `root.dataset.pose` 驱动 CSS；面板姿态控件；点击/拖拽本地瞬态反馈
- `test/pose.test.js` — 状态机单测 + service/route 往返

## 6. 验收手测步骤（可复现）

1. `dsh plugin --profile web add link:<repo>` 后重启 `dsh web`，打开桌宠面板。
2. 面板「姿态」选 `working` → 宠物开始摆动（手动锁定）。
3. 选「自动」→ 发起一个会话，模型思考/调用工具时自动变 `working`；回合结束弹 `celebrate` 后回落 `idle`。
4. 直接 `curl -XPOST localhost:<port>/api/pet-one/pose -d '{"pose":"slack"}'` → 宠物眯眼呼吸。
5. 点击宠物 → 短暂 `pet` 反馈；拖拽 → 短暂 `drag` 倾斜。
6. 直接访问 `http://localhost:<port>/api/pet-one/sprites/whale/working/frame0.png` 应返回占位 PNG。
