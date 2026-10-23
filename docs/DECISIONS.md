# 决策记录（ADR）

每个决策记录**背景 / 选项 / 结论 / 代价**。回退时先读这里：很多决策是“用代价换能力”的权衡，回退前要知道会失去什么。

---

## ADR-001 桌面 App 用 Swift/AppKit，不用 Electron / Tauri

**日期**：2026-10-23　**状态**：已采纳

**背景**：需要 macOS 上常驻、透明、置顶、全空间可见的窗口，并且要和 DSH（Electron 应用）并存。

**选项**：
1. Electron —— 与 DSH 同栈，但常驻内存 200MB+，且需要再打包一个 Chromium
2. Tauri —— 体积小，但需要 Rust 工具链，Live2D 页面仍需 WebView
3. Swift/AppKit 原生 —— 内存 ~30MB，直接控制 `NSPanel` 层级/`collectionBehavior`

**结论**：选 3。桌宠是“永远开着”的进程，内存和层级控制优先级高于跨平台。

**代价**：只有 macOS；需要 `swiftc` 工具链（系统自带）；UI 迭代比 Web 慢——后来用 WKWebView 面板缓解（见 ADR-003）。

---

## ADR-002 页面内宠物默认关闭，只保留桌面形态

**日期**：2026-10-23　**状态**：已采纳

**背景**：第一阶段在 DSH Web GUI 里也画了一只宠物（`lib/client.js`），结果桌面和页面同时出现，用户反馈“桌面上为何没那个小桌宠”“页面上的可以直接取消”。

**结论**：`lib/client.js` 保留代码但默认 `unmount()`，通过 `~/.dsh/pet-one/page-hidden` 标记 + 宿主 `view().pageHidden` 控制；恢复用 `rm ~/.dsh/pet-one/page-hidden`。

**代价**：页面内不再有任何宠物反馈；如需恢复要手动删标记并重启 DSH。

---

## ADR-003 面板用 WKWebView + 自绘 HTML，而非原生控件

**日期**：2026-10-23　**状态**：已采纳

**背景**：用户要求面板“仿星穹铁道风格”。原生 AppKit 做斜切角、发光、粒子成本极高。

**结论**：`desktop/panel/index.html` 单文件（内联 CSS/JS），Swift 通过 `WKScriptMessageHandler` 收动作、`evaluateJavaScript("window.__render(json)")` 推数据。视觉参考 miHoYo Game UI 指南 + 星铁展示页复刻取色 + Uiverse 玻璃卡/按钮（MIT）。

**代价**：多一层 WebView（约 20MB 内存）；调试需 `takeSnapshot` 或浏览器预览；字体只能用系统字体（Songti/PingFang/DIN Alternate）。

---

## ADR-004 Live2D 不用上游 Tauri 壳，自绘 WKWebView 渲染

**日期**：2026-10-23　**状态**：已采纳

**背景**：`A8Chann/dsh-pet-live2d` 的 Tauri 桌面端有两个问题：① 窗口建在光标所在屏，扩展屏时整只跑到副屏；② 插件客户端在桌面页抛 React hooks 错误（`Rendered fewer hooks than expected` in `<Pet>`），canvas 从未创建——窗口只是空透明层。

**选项**：
1. 修上游 Tauri 壳的 React 问题 —— 需要深入其插件客户端，改动脆弱且随上游更新失效
2. 只用其引擎+模型，自写渲染页 —— 已验证可行（canvas 正常出画）
3. 放弃 Live2D —— 用户明确需要

**结论**：选 2。`desktop/live2d-web/` 用 `live2d-vendor.js` + DS 鲸鱼娘模型自绘，窗口 320×420、主屏右下、`statusBar` 层级。

**代价**：失去上游面板/动作选择/设置页等能力（只保留 idle 动作 + 视线跟随 + 点击摸头）；模型与 Cubism Core 不能入库（许可限制）。

---

## ADR-005 两种形态互斥，不是叠加

**日期**：2026-10-23　**状态**：已采纳

**背景**：接入 Live2D 后两只同时出现（用户截图确认），体验混乱。

**结论**：`prefs.form`（`png` / `live2d`）持久化，切换时另一只 `orderOut`，Live2D 切走时停掉本地 HTTP 服务。

**代价**：不能“双形态同时在场”；切换有 1–2 秒加载。

---

## ADR-006 宿主记忆/进度落 `~/.dsh/pet-one/`，不建数据库

**日期**：2026-10-23　**状态**：已采纳

**结论**：`state.json`（宠物状态、成就、记忆）、`live.json`（每秒快照）、`desktop.json`（窗口偏好）、`commands.json`（Swift→宿主命令）。全部 JSON 文件 + 原子写。

**理由**：桌宠状态量小（<100KB），SQLite 引入依赖且难调试；文件可以直接 `cat` 排障、可以直接备份。

**代价**：并发写靠原子替换，多实例不保证一致（目前靠 `desktop.json` 里的 pid 单实例保护）。

---

## ADR-007 nanobot 作为“渠道桥”，DSH 仍是主脑

**日期**：2026-10-23　**状态**：已采纳（第三批）

**背景**：nanobot 是 14 渠道、MCP、cron、记忆的常驻 gateway；DSH 拥有用户的项目上下文与会话历史。两者都能当 Agent。

**选项**：
1. nanobot 当主脑 —— 宠物会“不认识项目”，上下文断裂
2. DSH 当主脑，nanobot 只做 IM 渠道与定时 —— 保留上下文，最快拿到“手机也能触达”的收益
3. 双脑并用 —— 记忆互不通，必然打架

**结论**：选 2。DSH 负责回答与工具调用；nanobot 负责渠道收发、cron、Dream 记忆整理。宠物通过 `agent.followup()` 发消息，nanobot 通过渠道把外部消息转成 DSH 用户消息。

**代价**：需要维护 DSH 会话 ↔ nanobot session 的映射；nanobot 的 provider 失败会把错误写进 assistant 内容（实测），客户端必须识别。

---

## ADR-008 双机（本机 + 服务器）双活，靠健康检查切换

**日期**：2026-10-23　**状态**：已采纳（设计）

**背景**：用户本机常驻一台，另有服务器，要求“一台掉线另一个接着做”。

**结论**：
- 两端跑同一份 nanobot（同配置、同 session 目录不同步也接受）
- 渠道 webhook 只指向“当前主端”，主端由健康检查 + 心跳决定
- **不做双向会话同步**（成本高、冲突多）；接受“切过去看不到上一台的最后几句”

**代价**：切换瞬间可能丢 1–2 条消息；两边记忆各长各的。

---

## ADR-009 敏感资产不入库，提供重建脚本

**日期**：2026-10-23　**状态**：已采纳

**背景**：Live2D 模型（CC BY-NC-SA）、Cubism Core（专有）、deep-chan 素材（Personal-Use-Only）都不能再分发；`refs/` 有 800MB。

**结论**：全部写进 `.gitignore`，仓库只保留 `scripts/fetch-live2d-assets.sh` 说明从何处获取。

**代价**：clone 后不能直接构建安装器；需要先跑一次 fetch 脚本（或手动拷入）。
