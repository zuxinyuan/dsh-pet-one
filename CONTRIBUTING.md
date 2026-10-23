# 贡献与版本规则

本文件定义 `dsh-pet-one` 的协作与版本纪律。所有改动都必须能在 30 秒内被回退，这是本仓库的第一原则——因为桌宠是**常驻进程**，一次坏发布会让用户桌面直接不可用。

## 1. 分支模型

| 分支 | 用途 | 保护 |
|---|---|---|
| `main` | 始终可运行，可随时构建安装 | 受保护，只接受 PR/merge，不直接 push |
| `feat/<模块>-<短描述>` | 新能力，如 `feat/nanobot-gateway` | — |
| `fix/<模块>-<短描述>` | 缺陷修复，如 `fix/live2d-position` | — |
| `hotfix/<版本>-<短描述>` | 线上事故，从 tag 拉出 | 修复后必须同时合回 main |
| `exp/<假设名>` | 一次性验证实验，允许脏，验证完可删 | 不进 main |

**理由**：桌宠同时存在 Swift 壳、DSH 宿主插件、Web 面板、Live2D 页面四块，任一块坏都会“整只不见”。用分支把风险隔开，比事后 `git revert` 便宜。

## 2. 提交信息

采用 Conventional Commits 的**精简子集**，只允许这 6 种前缀：

```
feat:     新能力（用户可见）
fix:      缺陷修复
docs:     仅文档
refactor: 不改行为的重构
build:    构建脚本、打包、依赖
chore:    杂务（.gitignore、格式化）
```

格式：`<type>(<scope>): <一句话>`，scope 取值见下表。

| scope | 覆盖范围 |
|---|---|
| `desktop` | `desktop/Sources/*.swift`、`Info.plist` |
| `panel` | `desktop/panel/`（星铁风面板） |
| `live2d` | `desktop/live2d-web/`、`Live2DWindow.swift` |
| `host` | `index.js`、`lib/host/*` |
| `client` | `lib/client.js`（页面内宠物） |
| `packs` | 角色包、`assets/packs` |
| `gateway` | nanobot 集成（未来） |
| `docs` | README、docs/、NOTICE |

示例：

```
feat(panel): 为工具页加入番茄钟倒计时
fix(live2d): 窗口改为主屏右下并恢复互斥切换
build(desktop): 清理 live2d-src 构建缓存，App 15MB → 11MB
```

**理由**：scope 和代码目录一一对应，`git log --oneline -- desktop/panel` 就能拉出某个子系统的完整演进，不需要读 diff 猜。

## 3. 版本与 tag

版本号 `MAJOR.MINOR.PATCH`，但语义按**用户可感知的范围**定，而不是严格 SemVer：

- `MAJOR`：形态或数据模型破坏性变更（例如换掉 `~/.dsh/pet-one/state.json` 结构，用户需要迁移）
- `MINOR`：新增一批能力（第二批：面板/Live2D/工具；第三批：nanobot 网关）
- `PATCH`：缺陷修复、文案、视觉微调

tag 一律 `vX.Y.Z` 附注释 tag：

```bash
git tag -a v0.3.0 -m "第二批：星铁面板、Live2D 自绘窗口、形态互斥"
```

**当前已发布**：

| tag | 内容 |
|---|---|
| `v0.1.0` | 宿主插件 + 桌面精灵图桌宠（第一批） |
| `v0.2.0` | 对话 / TTS / 番茄钟·闹钟·便签·小鱼干 / 面板 |
| `v0.3.0` | 星铁风面板、Live2D 自绘窗口、形态互斥、入场动画 |

## 4. 回退手册

```bash
# 回退到上一个发布（不丢历史）
git revert <bad-commit>          # 首选：生成反向提交
git checkout v0.2.0 -- .         # 仅取回文件（谨慎，需重新提交）

# 重新构建并安装
cd desktop && ./build.sh --install

# 桌面进程重启（不影响 DSH 主进程）
pkill -f "DSHPetOne.app/Contents/MacOS/DSHPetOne"; open ~/Applications/DSHPetOne.app
```

**注意**：宿主插件（`lib/host/*`）的改动需要重启 DSH 才生效，桌面 App 不需要。回退宿主代码时，务必在 PR 里写明“需要重启 DSH”。

## 5. 目录职责（谁该改哪里）

```
index.js, lib/host/       DSH 宿主插件（Node ESM, Cordis）
lib/client.js             页面内宠物（已默认禁用）
desktop/Sources/          Swift 桌面 App
desktop/panel/            星铁风面板（WKWebView + HTML/CSS/JS）
desktop/live2d-web/       Live2D 渲染页（vendor + 模型，模型不入库）
desktop/assets/packs/     角色素材（whale-girl MIT 入库；deep-chan 不入库）
docs/                     架构、决策记录、截图
scripts/                  辅助脚本（拉取受限资产、打包）
```

改 `lib/host/` 的人在 PR 里必须说明**是否需要重启 DSH**；改 `desktop/` 的人必须附上 `./build.sh` 输出末尾三行。

## 6. 不许进的提交

1. `refs/`、`references/`、`skeleton/` —— 800MB 级参考仓库，单独 clone
2. `desktop/live2d-web/model|vendor/` —— CC BY-NC-SA 模型与专有 Cubism Core，**不得再分发**
3. `desktop/assets/packs/deep-chan/` —— Personal-Use-Only 素材
4. `desktop/build/`、`node_modules/`、`.venv/`
5. 任何 API key、token、cookie（用 `.env` + `.env.example`）

`.gitignore` 已覆盖以上全部；`git diff --cached --stat` 提交前必须自查。

## 7. 一次典型改动流程

```bash
git checkout -b feat/gateway-nanobot
# ... 改代码 ...
cd desktop && ./build.sh --install    # 桌面改动必须能构建通过
cd .. && node --test test/host.test.js # 宿主改动必须测试通过
git add -A && git commit -m "feat(gateway): 接入 nanobot OpenAI 兼容 API"
git tag -a v0.4.0 -m "第三批：nanobot 网关"   # 仅在完成一个可交付批次时
```
