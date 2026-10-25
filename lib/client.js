/**
 * dsh-pet-one browser half — a zero-dependency floating pet mounted straight
 * onto document.body. The DSH web loader imports this file and calls
 * `window.__ModuleLoader__.load({id, factory})`; the factory returns
 * `{apply, inject}`. Everything is drawn with DOM + inline SVG + CSS, so the
 * bundle needs no build step and no React.
 * @module dsh-pet-one/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-pet-one',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const API = '/api/pet-one'
    const MOUNT_FLAG = '__petOneMounted'

    const CSS = `
.po{--po-size:176px;--po-right:24px;--po-bottom:18px;--po-body:#4b7bec;--po-body-dark:#3867d6;--po-belly:#dbe7ff;--po-hair:#1f2d4d;--po-accent:#7fe3ff;--po-blush:#ff9aa2;
  position:fixed;right:var(--po-right);bottom:var(--po-bottom);width:var(--po-size);height:calc(var(--po-size) * 1.12);
  z-index:2147483600;user-select:none;-webkit-user-select:none;touch-action:none;cursor:grab;
  font-family:ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
.po[data-dragging="1"]{cursor:grabbing}
.po{transition:transform .22s ease}
@media (min-width:920px){.po[data-panel="1"]{transform:translateX(-322px)}}
.po[hidden]{display:none}
.po-svg{width:100%;height:100%;overflow:visible;filter:drop-shadow(0 10px 14px rgba(20,30,60,.22))}
.po-body{fill:var(--po-body)}
.po-belly{fill:var(--po-belly)}
.po-hair{fill:var(--po-hair)}
.po-accent{fill:var(--po-accent)}
.po-blush{fill:var(--po-blush);opacity:.55}
.po-stroke{fill:none;stroke:var(--po-hair);stroke-width:2.6;stroke-linecap:round}
.po-eye{fill:#1b2340}
.po-eye-hi{fill:#fff;opacity:.9}
.po-mouth{fill:none;stroke:#1b2340;stroke-width:2.4;stroke-linecap:round}

/* expressions: only one eyes/mouth group visible per phase */
.po-e-happy,.po-e-error,.po-e-sleep,.po-m-happy,.po-m-error,.po-think,.po-spout{display:none}
.po[data-phase="done"] .po-e-open,.po[data-phase="done"] .po-m-normal{display:none}
.po[data-phase="done"] .po-e-happy,.po[data-phase="done"] .po-m-happy{display:block}
.po[data-phase="failed"] .po-e-open,.po[data-phase="failed"] .po-m-normal{display:none}
.po[data-phase="failed"] .po-e-error,.po[data-phase="failed"] .po-m-error{display:block}
.po[data-phase="thinking"] .po-think,.po[data-phase="tool"] .po-think{display:block}
.po[data-phase="waiting"] .po-think{display:block;opacity:.5}
.po[data-phase="done"] .po-spout{display:block}

/* motion */
.po-inner{transform-origin:50% 82%;animation:po-bob 3.4s ease-in-out infinite}
.po[data-phase="thinking"] .po-inner{animation:po-tilt 2.2s ease-in-out infinite}
.po[data-phase="tool"] .po-inner{animation:po-wiggle .9s ease-in-out infinite}
.po[data-phase="review"] .po-inner{animation:po-sway 2.6s ease-in-out infinite}
.po[data-phase="waiting"] .po-inner{animation:po-breathe 1.8s ease-in-out infinite}
.po[data-phase="done"] .po-inner{animation:po-bounce .55s ease-out 3}
.po[data-phase="failed"] .po-inner{animation:po-shake .45s ease-in-out 2}
@keyframes po-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
@keyframes po-tilt{0%,100%{transform:rotate(-3deg) translateY(-2px)}50%{transform:rotate(3deg) translateY(-4px)}}
@keyframes po-wiggle{0%,100%{transform:rotate(-2deg)}50%{transform:rotate(2deg)}}
@keyframes po-sway{0%,100%{transform:rotate(-1.5deg)}50%{transform:rotate(1.5deg)}}
@keyframes po-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.03)}}
@keyframes po-bounce{0%{transform:translateY(0) scale(1,1)}35%{transform:translateY(-20px) scale(.96,1.05)}70%{transform:translateY(0) scale(1.04,.96)}100%{transform:translateY(0) scale(1,1)}}
@keyframes po-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px) rotate(-2deg)}75%{transform:translateX(6px) rotate(2deg)}}
@keyframes po-blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.1)}}
.po-e-open{transform-origin:70px 86px;animation:po-blink 5.2s infinite}
.po[data-phase="done"] .po-e-open,.po[data-phase="failed"] .po-e-open{animation:none}
@keyframes po-spout{0%{transform:translateY(4px);opacity:0}30%{opacity:1}100%{transform:translateY(-14px);opacity:0}}
.po-spout circle{animation:po-spout 1.1s ease-out infinite}
.po-spout circle:nth-child(2){animation-delay:.15s}
.po-spout circle:nth-child(3){animation-delay:.3s}

/* pose state machine: idle | working | celebrate | slack (override micro-phase motion) */
.po[data-pose="working"] .po-inner{animation:po-wiggle .9s ease-in-out infinite}
.po[data-pose="celebrate"] .po-inner{animation:po-bounce .55s ease-out 3}
.po[data-pose="celebrate"] .po-e-open,.po[data-pose="celebrate"] .po-m-normal{display:none}
.po[data-pose="celebrate"] .po-e-happy,.po[data-pose="celebrate"] .po-m-happy{display:block}
.po[data-pose="slack"] .po-inner{animation:po-breathe 3.4s ease-in-out infinite}
.po[data-pose="slack"] .po-e-open{animation:none;transform:scaleY(.16)}
.po[data-pose="slack"] .po-think{display:none}

/* transient input reactions: pet (click) / drag */
.po[data-react="pet"] .po-blush{opacity:.95;transform:scale(1.18);transform-origin:center}
.po[data-react="pet"] .po-e-open{display:none}
.po[data-react="pet"] .po-e-happy{display:block}
.po[data-react="drag"] .po-inner{animation:po-tilt 1.3s ease-in-out infinite}

/* speech bubble */
.po-bubble{position:absolute;left:50%;bottom:calc(100% - 10px);transform:translateX(-50%) translateY(6px) scale(.96);transform-origin:50% 100%;
  max-width:240px;min-width:64px;padding:8px 11px;border-radius:12px;background:rgba(20,26,44,.94);color:#f4f7ff;font-size:12.5px;line-height:1.45;
  box-shadow:0 8px 24px rgba(10,16,32,.28);opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease;z-index:2;word-break:break-word}
.po-bubble::after{content:"";position:absolute;left:50%;bottom:-6px;width:12px;height:12px;transform:translateX(-50%) rotate(45deg);background:inherit;border-radius:2px}
.po-bubble[data-show="1"]{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}
.po-bubble[data-tone="bad"]{background:rgba(74,26,36,.95)}
.po-bubble[data-tone="good"]{background:rgba(22,54,44,.95)}

/* atlas skins */
.po-atlas{position:absolute;inset:0;background-repeat:no-repeat;image-rendering:pixelated;border-radius:8px}
.po-shadow{position:absolute;left:50%;bottom:2%;width:58%;height:8%;transform:translateX(-50%);background:radial-gradient(ellipse at center,rgba(20,30,60,.28),rgba(20,30,60,0) 70%);z-index:-1}

/* summon button (when hidden) */
.po-summon{position:fixed;right:18px;bottom:16px;width:44px;height:44px;border-radius:50%;border:1px solid rgba(120,140,200,.35);
  background:rgba(20,26,44,.9);color:#fff;font-size:20px;line-height:1;display:none;place-items:center;cursor:pointer;z-index:2147483600;
  box-shadow:0 8px 22px rgba(10,16,32,.3)}
.po-summon[data-show="1"]{display:grid}

/* context menu */
.po-menu{position:fixed;z-index:2147482001;min-width:132px;padding:5px;border-radius:10px;background:rgba(20,26,44,.97);
  border:1px solid rgba(120,140,200,.28);box-shadow:0 14px 34px rgba(6,10,22,.4);display:none;font-size:12.5px;color:#eef2ff}
.po-menu[data-show="1"]{display:block}
.po-menu button{display:flex;width:100%;gap:8px;align-items:center;padding:7px 9px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}
.po-menu button:hover{background:rgba(120,150,255,.16)}

/* panel */
.po-panel{position:fixed;right:18px;bottom:18px;width:306px;max-height:calc(100vh - 36px);overflow:auto;z-index:2147482002;
  background:rgba(17,22,38,.97);color:#eef2ff;border:1px solid rgba(120,140,200,.26);border-radius:16px;
  box-shadow:0 24px 60px rgba(4,8,20,.45);font-size:12.5px;display:none;backdrop-filter:blur(10px);
  font-family:ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
.po-panel[data-show="1"]{display:block}
.po-panel-head{display:flex;align-items:center;gap:8px;padding:11px 14px 7px;position:sticky;top:0;background:linear-gradient(rgba(17,22,38,.99),rgba(17,22,38,.92));z-index:1}
.po-panel-head .po-name{font-size:14px;font-weight:600;flex:1;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.po-icon-btn{width:24px;height:24px;border-radius:7px;border:0;background:rgba(255,255,255,.08);color:#dfe6ff;cursor:pointer;font-size:14px;line-height:1}
.po-icon-btn:hover{background:rgba(255,255,255,.16)}
.po-sec{padding:5px 14px 10px;border-top:1px solid rgba(120,140,200,.12)}
.po-sec h4{margin:6px 0 8px;font-size:11px;font-weight:600;letter-spacing:.08em;color:#9fb0d8;text-transform:uppercase}
.po-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;background:rgba(120,150,255,.14);color:#c9d6ff;font-size:11.5px}
.po-dot{width:7px;height:7px;border-radius:50%;background:#7fe3ff;box-shadow:0 0 8px #7fe3ff}
.po-dot[data-phase="failed"]{background:#ff7b8a;box-shadow:0 0 8px #ff7b8a}
.po-dot[data-phase="done"]{background:#5CE1A4;box-shadow:0 0 8px #5CE1A4}
.po-dot[data-phase="idle"]{background:#8a94b8;box-shadow:none}
.po-line{margin:6px 0 0;color:#b9c6e8;line-height:1.5;min-height:18px}
.po-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.po-stat{padding:8px 9px;border-radius:10px;background:rgba(255,255,255,.05)}
.po-stat b{display:block;font-size:14px;font-weight:600;color:#fff;margin-top:2px}
.po-stat span{font-size:10.5px;color:#93a2c8}
.po-bar{height:6px;border-radius:999px;background:rgba(255,255,255,.1);overflow:hidden;margin-top:7px}
.po-bar i{display:block;height:100%;background:linear-gradient(90deg,#6ea8ff,#7fe3ff);border-radius:999px;transition:width .35s ease}
.po-row{display:flex;align-items:center;gap:8px;margin:8px 0}
.po-row label{flex:0 0 52px;color:#9fb0d8;font-size:11.5px}
.po-row input[type="range"]{flex:1;accent-color:#6ea8ff}
.po-actions{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:4px}
.po-btn{padding:8px 6px;border-radius:9px;border:1px solid rgba(120,140,200,.28);background:rgba(120,150,255,.14);color:#e7edff;font:inherit;cursor:pointer;font-size:12px}
.po-btn:hover{background:rgba(120,150,255,.26)}
.po-btn:disabled{opacity:.45;cursor:not-allowed}
.po-btn.primary{background:linear-gradient(135deg,#4b7bec,#6ea8ff);border-color:transparent;font-weight:600}
.po-say{display:flex;gap:6px;margin-top:8px}
.po-say input{flex:1;min-width:0;padding:7px 9px;border-radius:9px;border:1px solid rgba(120,140,200,.3);background:rgba(0,0,0,.25);color:#eef2ff;font:inherit;font-size:12px;outline:none}
.po-say input:focus{border-color:#6ea8ff}
.po-select{width:100%;padding:7px 8px;border-radius:9px;border:1px solid rgba(120,140,200,.3);background:rgba(0,0,0,.25);color:#eef2ff;font:inherit;font-size:12px}
.po-switch{display:flex;align-items:center;justify-content:space-between;margin:7px 0;color:#c9d6ff}
.po-switch input{accent-color:#6ea8ff}
.po-hint{margin:8px 0 0;color:#7f8db3;font-size:10.5px;line-height:1.5}
.po-import{display:none}
@media (prefers-reduced-motion: reduce){.po-inner,.po-e-open,.po-spout circle{animation:none !important}}
`

    /** Create an element with class/text. */
    function el(tag, cls, text) {
      const node = document.createElement(tag)
      if (cls) node.className = cls
      if (text !== undefined) node.textContent = text
      return node
    }

    /** Same-origin API helper. */
    async function api(path, body) {
      const response = await fetch(API + path, body === undefined
        ? { headers: { accept: 'application/json' } }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          })
      if (!response.ok) throw new Error(`${path} ${response.status}`)
      return response.json()
    }

    /** Inject the stylesheet once. */
    function injectStyle() {
      if (document.getElementById('pet-one-style')) return
      const style = document.createElement('style')
      style.id = 'pet-one-style'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    const PHASE_TEXT = {
      idle: '空闲',
      waiting: '等待中',
      thinking: '思考中',
      tool: '调用工具',
      review: '组织回复',
      done: '完成',
      failed: '出错',
    }

    const POSE_TEXT = {
      idle: 'idle · 待机',
      working: 'working · 工作中',
      celebrate: 'celebrate · 庆祝',
      slack: 'slack · 摸鱼',
      pet: 'pet · 互动',
      drag: 'drag · 拖拽',
    }

    /** Build the pet DOM (SVG rig + bubble) once. */
    function buildPet() {
      const root = el('div', 'po')
      root.dataset.phase = 'idle'

      const bubble = el('div', 'po-bubble')
      bubble.dataset.show = '0'

      const pet = el('div', 'po-pet')
      pet.setAttribute('role', 'button')
      pet.setAttribute('tabindex', '0')
      pet.setAttribute('aria-label', '桌宠')

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('class', 'po-svg')
      svg.setAttribute('viewBox', '0 0 140 164')
      svg.innerHTML = `
        <g class="po-inner">
          <g class="po-tail">
            <path class="po-body" d="M28 122 C10 126 4 116 2 104 C12 106 18 112 24 114 Z"/>
            <path class="po-body" d="M24 116 C8 112 4 100 6 90 C16 94 22 102 28 108 Z" opacity=".85"/>
          </g>
          <ellipse class="po-body" cx="70" cy="94" rx="46" ry="44"/>
          <ellipse class="po-belly" cx="70" cy="106" rx="30" ry="28"/>
          <ellipse class="po-body" cx="25" cy="104" rx="9" ry="15" transform="rotate(-28 25 104)"/>
          <ellipse class="po-body" cx="115" cy="104" rx="9" ry="15" transform="rotate(28 115 104)"/>
          <path class="po-hair" d="M24 70 C28 24 112 24 116 70 C110 50 94 40 70 40 C46 40 30 50 24 70 Z"/>
          <path class="po-stroke" d="M70 30 q7 -14 18 -16" fill="none"/>
          <g class="po-e-open">
            <ellipse class="po-eye" cx="56" cy="86" rx="4.2" ry="5.2"/>
            <ellipse class="po-eye" cx="84" cy="86" rx="4.2" ry="5.2"/>
            <circle class="po-eye-hi" cx="54.6" cy="83.8" r="1.3"/>
            <circle class="po-eye-hi" cx="82.6" cy="83.8" r="1.3"/>
          </g>
          <g class="po-e-happy">
            <path class="po-stroke" d="M51 86 q5 -6 10 0"/>
            <path class="po-stroke" d="M79 86 q5 -6 10 0"/>
          </g>
          <g class="po-e-error">
            <path class="po-stroke" d="M52 82 l8 8 M60 82 l-8 8"/>
            <path class="po-stroke" d="M80 82 l8 8 M88 82 l-8 8"/>
          </g>
          <g class="po-e-sleep">
            <path class="po-stroke" d="M51 86 q5 4 10 0"/>
            <path class="po-stroke" d="M79 86 q5 4 10 0"/>
          </g>
          <path class="po-mouth po-m-normal" d="M64 100 q6 5 12 0"/>
          <g class="po-m-happy"><ellipse cx="70" cy="101" rx="5.5" ry="4" fill="#1b2340"/><ellipse cx="70" cy="103" rx="3" ry="1.6" fill="#ff8fa3"/></g>
          <path class="po-mouth po-m-error" d="M63 103 q7 -4 14 0"/>
          <ellipse class="po-blush" cx="47" cy="96" rx="6" ry="3.2"/>
          <ellipse class="po-blush" cx="93" cy="96" rx="6" ry="3.2"/>
          <g class="po-spout">
            <circle class="po-accent" cx="70" cy="26" r="2.4"/>
            <circle class="po-accent" cx="64" cy="20" r="2.8"/>
            <circle class="po-accent" cx="77" cy="18" r="2.2"/>
          </g>
          <g class="po-think">
            <circle cx="108" cy="52" r="2.2" fill="#c9d6ff" opacity=".7"/>
            <circle cx="116" cy="43" r="3" fill="#c9d6ff" opacity=".8"/>
            <circle cx="126" cy="32" r="4" fill="#c9d6ff" opacity=".9"/>
          </g>
        </g>`
      pet.appendChild(svg)

      const atlas = el('div', 'po-atlas')
      atlas.hidden = true
      pet.appendChild(atlas)
      pet.appendChild(el('div', 'po-shadow'))

      root.appendChild(bubble)
      root.appendChild(pet)
      document.body.appendChild(root)
      return { root, bubble, pet, svg, atlas }
    }

    /** Build the summon button + context menu + settings panel. */
    function buildChrome() {
      const summon = el('button', 'po-summon', '🐋')
      summon.title = '唤醒桌宠'
      summon.setAttribute('aria-label', '唤醒桌宠')

      const menu = el('div', 'po-menu')
      const menuButtons = [
        ['👋 摸头', 'pat'],
        ['🐟 投喂', 'feed'],
        ['🎈 玩耍', 'play'],
        ['⚙️ 打开面板', 'panel'],
        ['🙈 隐藏', 'hide'],
      ].map(([label, key]) => {
        const button = el('button', '', label)
        button.dataset.key = key
        menu.appendChild(button)
        return button
      })

      const panel = el('div', 'po-panel')
      panel.innerHTML = `
        <div class="po-panel-head">
          <span class="po-name" title="点击改名">小鲸</span>
          <button class="po-icon-btn" data-act="refresh" title="刷新">⟳</button>
          <button class="po-icon-btn" data-act="close" title="关闭">✕</button>
        </div>
        <div class="po-sec">
          <div><span class="po-chip"><i class="po-dot" data-phase="idle"></i><span data-bind="phase">空闲</span></span>
            <span class="po-chip" style="margin-left:6px" data-bind="sessions">0 个会话</span></div>
          <p class="po-line" data-bind="line">等待你的第一条消息…</p>
          <p class="po-line" style="color:#9fb0d8" data-bind="poseline">姿态：自动</p>
        </div>
        <div class="po-sec">
          <h4>养成</h4>
          <div class="po-row" style="justify-content:space-between;margin:0">
            <span data-bind="rank">🌱 初次见面</span><span data-bind="affinity">0</span>
          </div>
          <div class="po-bar"><i data-bind="affinity-bar" style="width:0%"></i></div>
          <div class="po-grid" style="margin-top:9px">
            <div class="po-stat"><span>零食</span><b data-bind="treats">20</b></div>
            <div class="po-stat"><span>今日回合</span><b data-bind="turns">0</b></div>
            <div class="po-stat"><span>工具调用</span><b data-bind="tools">0</b></div>
            <div class="po-stat"><span>DeepSeek 余额</span><b data-bind="balance">—</b></div>
          </div>
        </div>
        <div class="po-sec">
          <h4>互动</h4>
          <div class="po-actions">
            <button class="po-btn" data-act="pat">👋 摸头</button>
            <button class="po-btn" data-act="feed">🐟 投喂</button>
            <button class="po-btn" data-act="play">🎈 玩耍</button>
          </div>
          <div class="po-say">
            <input data-bind="say-input" maxlength="120" placeholder="让它说点什么…">
            <button class="po-btn primary" data-act="say">说</button>
          </div>
        </div>
        <div class="po-sec">
          <h4>姿态</h4>
          <div class="po-row"><label>姿态</label>
            <select class="po-select" data-bind="poseSelect">
              <option value="auto">自动（跟随任务/宿主）</option>
              <option value="idle">待机 idle</option>
              <option value="working">工作 working</option>
              <option value="celebrate">庆祝 celebrate</option>
              <option value="slack">摸鱼 slack</option>
            </select>
          </div>
          <p class="po-hint">自动：有进行中任务→working；回合完成→celebrate 短暂后回 idle；空闲久了→slack。也可手动锁定（指令 API：POST <code>/api/pet-one/pose</code>）。</p>
        </div>
        <div class="po-sec">
          <h4>外观与声音</h4>
          <div class="po-row"><label>大小</label><input type="range" min="96" max="320" step="4" data-bind="size"><span data-bind="size-value" style="width:34px;text-align:right;color:#9fb0d8">176</span></div>
          <div class="po-row"><label>透明度</label><input type="range" min="25" max="100" step="1" data-bind="opacity"></div>
          <div class="po-switch"><span>音效</span><input type="checkbox" data-bind="sound"></div>
          <div class="po-switch"><span>安静模式（不弹气泡）</span><input type="checkbox" data-bind="quiet"></div>
          <select class="po-select" data-bind="skin"></select>
          <div class="po-actions" style="margin-top:8px">
            <button class="po-btn" data-act="import">导入精灵图</button>
            <button class="po-btn" data-act="reset">复位位置</button>
            <button class="po-btn" data-act="hide">隐藏桌宠</button>
          </div>
          <input class="po-import" type="file" accept="image/png,image/webp,image/gif,image/jpeg" data-bind="file">
          <p class="po-hint">精灵图按「列 × 行」切帧：默认 8 列 9 行、6fps。导入后自动切换。右键宠物打开快捷菜单，双击打开面板。</p>
        </div>`
      document.body.appendChild(summon)
      document.body.appendChild(menu)
      document.body.appendChild(panel)
      return { summon, menu, menuButtons, panel }
    }

    /** Main apply: honour the host's pageHidden flag before mounting. */
    function apply() {
      const unmount = () => {
        for (const node of document.querySelectorAll('.po, .po-panel, .po-summon, .po-menu')) node.remove()
        document.getElementById('pet-one-style')?.remove()
        window[MOUNT_FLAG] = false
      }
      fetch(API + '/state', { headers: { accept: 'application/json' } })
        .then((response) => (response.ok ? response.json() : null))
        .then((snapshot) => {
          if (snapshot && snapshot.pageHidden) {
            unmount()
            return
          }
          mount()
        })
        .catch(() => mount())
    }

    /** Build the floating pet. */
    function mount() {
      if (window[MOUNT_FLAG]) return
      window[MOUNT_FLAG] = true
      injectStyle()

      const ui = buildPet()
      const chrome = buildChrome()
      const { root, bubble, pet, svg, atlas } = ui
      const { summon, menu, panel } = chrome

      const state = {
        data: null,
        display: { size: 176, right: 24, bottom: 18, opacity: 1, visible: true },
        sound: true,
        quiet: false,
        skin: 'whale',
        sayAt: 0,
        phase: 'idle',
        pose: 'idle',
        reactTimer: null,
        online: true,
        atlasTimer: null,
        audio: null,
        drag: null,
        bubbleTimer: null,
        lastLine: '',
        lastSay: '',
      }

      const bind = (name) => panel.querySelector(`[data-bind="${name}"]`)
      const refs = {
        name: panel.querySelector('.po-name'),
        phase: bind('phase'),
        sessions: bind('sessions'),
        line: bind('line'),
        rank: bind('rank'),
        affinity: bind('affinity'),
        affinityBar: bind('affinity-bar'),
        treats: bind('treats'),
        turns: bind('turns'),
        tools: bind('tools'),
        balance: bind('balance'),
        sayInput: bind('say-input'),
        size: bind('size'),
        sizeValue: bind('size-value'),
        opacity: bind('opacity'),
        sound: bind('sound'),
        quiet: bind('quiet'),
        skin: bind('skin'),
        file: bind('file'),
        poseSelect: bind('poseSelect'),
        poseLine: bind('poseline'),
      }

      /** Show a bubble line for a while. */
      function showBubble(text, tone = '') {
        if (!text || state.quiet) return
        bubble.textContent = text
        bubble.dataset.tone = tone
        bubble.dataset.show = '1'
        if (state.bubbleTimer) clearTimeout(state.bubbleTimer)
        state.bubbleTimer = setTimeout(() => { bubble.dataset.show = '0' }, 4200)
      }

      /** Show a transient pose reaction (pet on click, drag while grabbing). */
      function flashReact(kind) {
        root.dataset.react = kind
        if (state.reactTimer) clearTimeout(state.reactTimer)
        state.reactTimer = setTimeout(() => { root.dataset.react = '' }, kind === 'drag' ? 1200 : 600)
      }

      /** Apply palette / geometry. */
      function applyLook() {
        const display = state.display
        root.style.setProperty('--po-size', `${display.size}px`)
        root.style.setProperty('--po-right', `${display.right}px`)
        root.style.setProperty('--po-bottom', `${display.bottom}px`)
        root.style.setProperty('--po-opacity', String(display.opacity))
        root.style.opacity = String(display.opacity)
        root.hidden = display.visible === false
        summon.dataset.show = display.visible === false ? '1' : '0'

        const skin = (state.data?.skins ?? []).find((item) => item.id === state.skin)
        if (skin && skin.kind === 'palette') {
          svg.style.display = ''
          atlas.hidden = true
          const palette = skin.palette
          root.style.setProperty('--po-body', palette.body)
          root.style.setProperty('--po-body-dark', palette.bodyDark)
          root.style.setProperty('--po-belly', palette.belly)
          root.style.setProperty('--po-hair', palette.hair)
          root.style.setProperty('--po-accent', palette.accent)
          root.style.setProperty('--po-blush', palette.blush)
          if (state.atlasTimer) { clearInterval(state.atlasTimer); state.atlasTimer = null }
        } else if (skin && skin.kind === 'atlas') {
          svg.style.display = 'none'
          atlas.hidden = false
          atlas.style.backgroundImage = `url("${skin.image}")`
          const cols = Math.max(1, Number(skin.cols) || 8)
          const rows = Math.max(1, Number(skin.rows) || 9)
          atlas.style.backgroundSize = `${cols * 100}% ${rows * 100}%`
          startAtlas(skin, cols, rows)
        }
      }

      /** Cycle atlas columns; the row follows the current phase. */
      function startAtlas(skin, cols, rows) {
        if (state.atlasTimer) clearInterval(state.atlasTimer)
        const rowFor = { idle: 0, waiting: 0, thinking: 1, tool: 2, review: 3, done: 4, failed: 5 }
        let col = 0
        const step = () => {
          const row = Math.min(rows - 1, rowFor[state.phase] ?? 0)
          atlas.style.backgroundPosition = `${(col / Math.max(1, cols - 1)) * 100}% ${(row / Math.max(1, rows - 1)) * 100}%`
          col = (col + 1) % cols
        }
        step()
        state.atlasTimer = setInterval(step, Math.max(80, 1000 / (Number(skin.fps) || 6)))
      }

      /** Tiny synthesized feedback tones (no audio assets). */
      function beep(kind) {
        if (!state.sound || state.quiet) return
        try {
          state.audio = state.audio ?? new (window.AudioContext || window.webkitAudioContext)()
          const audio = state.audio
          if (audio.state === 'suspended') audio.resume()
          const now = audio.currentTime
          const notes = kind === 'done' ? [660, 880, 1320] : kind === 'bad' ? [330, 240] : [880]
          notes.forEach((freq, index) => {
            const osc = audio.createOscillator()
            const gain = audio.createGain()
            osc.type = 'sine'
            osc.frequency.value = freq
            gain.gain.setValueAtTime(0.0001, now + index * 0.09)
            gain.gain.exponentialRampToValueAtTime(0.05, now + index * 0.09 + 0.02)
            gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.09 + 0.18)
            osc.connect(gain).connect(audio.destination)
            osc.start(now + index * 0.09)
            osc.stop(now + index * 0.09 + 0.2)
          })
        } catch { /* audio is optional */ }
      }

      /** Fetch and render one snapshot. */
      async function refresh() {
        try {
          const data = await api('/state')
          state.online = true
          const previousPhase = state.phase
          state.data = data
          state.display = data.display
          state.sound = data.sound
          state.quiet = data.quiet
          state.skin = data.skin
          state.phase = data.phase
          root.dataset.phase = data.phase
          refs.phase.textContent = PHASE_TEXT[data.phase] ?? data.phase

          // Pose state machine: reflect the resolved pose + manual/auto mode.
          state.pose = data.pose ?? 'idle'
          root.dataset.pose = state.pose
          refs.poseLine.textContent = `姿态：${POSE_TEXT[state.pose] ?? state.pose}${data.poseMode === 'manual' ? '（手动）' : '（自动）'}`
          if (document.activeElement !== refs.poseSelect) {
            refs.poseSelect.value = data.poseMode === 'manual' ? data.pose : 'auto'
          }
          panel.querySelector('.po-dot').dataset.phase = data.phase
          refs.sessions.textContent = `${data.activeCount} 个会话`
          const line = data.activeCount > 0 ? (data.line || '处理中…') : '等你派活…'
          refs.line.textContent = line

          refs.name.textContent = data.pet.name
          refs.rank.textContent = `${data.pet.rank.icon} ${data.pet.rank.name}`
          refs.affinity.textContent = String(data.pet.affinity)
          refs.affinityBar.style.width = `${Math.round(data.pet.rank.progress * 100)}%`
          refs.treats.textContent = String(data.pet.treats)
          refs.turns.textContent = String(data.ledger.turns)
          refs.tools.textContent = String(data.ledger.tools)
          if (data.balance?.ok) {
            refs.balance.textContent = `${data.balance.total?.toFixed(2) ?? '?'} ${data.balance.currency}`
          } else if (data.balance?.reason === 'no-key') {
            refs.balance.textContent = '未配 Key'
          } else if (data.balance) {
            refs.balance.textContent = '—'
          }
          refs.size.value = String(data.display.size)
          refs.sizeValue.textContent = String(data.display.size)
          refs.opacity.value = String(Math.round(data.display.opacity * 100))
          refs.sound.checked = data.sound
          refs.quiet.checked = data.quiet

          const skins = data.skins ?? []
          if (refs.skin.options.length !== skins.length) {
            refs.skin.innerHTML = ''
            for (const skin of skins) {
              const option = document.createElement('option')
              option.value = skin.id
              option.textContent = `${skin.name}${skin.kind === 'atlas' ? '（导入）' : ''}`
              refs.skin.appendChild(option)
            }
          }
          refs.skin.value = data.skin
          applyLook()

          if (data.say && data.say.text !== state.lastSay) {
            state.lastSay = data.say.text
            showBubble(data.say.text, data.phase === 'failed' ? 'bad' : 'good')
          } else if (!data.say && data.line && data.line !== state.lastLine && data.activeCount > 0) {
            state.lastLine = data.line
            showBubble(data.line)
          }

          if (previousPhase !== data.phase) {
            if (data.phase === 'done') { beep('done'); showBubble('完成啦！', 'good') }
            if (data.phase === 'failed') { beep('bad') }
          }
        } catch {
          state.online = false
          refs.phase.textContent = '与宿主断开'
          panel.querySelector('.po-dot').dataset.phase = 'failed'
        }
        schedule()
      }

      let pollTimer = null
      function schedule() {
        if (pollTimer) clearTimeout(pollTimer)
        if (document.visibilityState === 'hidden') {
          pollTimer = null
          return
        }
        pollTimer = setTimeout(refresh, state.online ? 1600 : 4000)
      }

      /** Persist one config patch then refresh. */
      async function configure(patch) {
        try {
          const result = await api('/config', { patch })
          if (result.display) state.display = result.display
          applyLook()
        } catch { /* ignore transient failures */ }
        refresh()
      }

      /** Persist the dragged position. */
      async function persistPosition() {
        const right = Math.round(state.display.right)
        const bottom = Math.round(state.display.bottom)
        try { await api('/config', { patch: { right, bottom } }) } catch { /* ignore */ }
      }

      /** Run an interaction and show the reaction immediately. */
      async function interact(kind) {
        try {
          const result = await api('/interact', { kind })
          if (result.reaction) showBubble(result.reaction, result.ok ? '' : 'bad')
          refresh()
        } catch { /* ignore */ }
      }

      /** Toggle the settings panel. */
      function togglePanel(force) {
        const open = force ?? panel.dataset.show !== '1'
        panel.dataset.show = open ? '1' : '0'
        root.dataset.panel = open ? '1' : '0'
        if (open) refresh()
      }

      /** Open / close the context menu. */
      function openMenu(event) {
        menu.dataset.show = '1'
        const width = 148
        const height = 190
        menu.style.left = `${Math.min(event.clientX, window.innerWidth - width - 8)}px`
        menu.style.top = `${Math.min(event.clientY, window.innerHeight - height - 8)}px`
      }
      function closeMenu() { menu.dataset.show = '0' }
      document.addEventListener('pointerdown', (event) => {
        if (!menu.contains(event.target)) closeMenu()
      }, true)

      chrome.menuButtons.forEach((button) => {
        button.addEventListener('click', () => {
          closeMenu()
          const key = button.dataset.key
          if (key === 'pat' || key === 'feed' || key === 'play') interact(key)
          if (key === 'panel') togglePanel(true)
          if (key === 'hide') hidePet()
        })
      })

      /** Hide the pet, leaving only the summon bubble button. */
      async function hidePet() {
        try { await api('/visible', { visible: false }) } catch { /* ignore */ }
        state.display.visible = false
        applyLook()
      }

      /** Drag + click handling on the pet itself. */
      pet.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return
        pet.setPointerCapture?.(event.pointerId)
        state.drag = {
          x: event.clientX,
          y: event.clientY,
          right: state.display.right,
          bottom: state.display.bottom,
          moved: false,
        }
        root.dataset.dragging = '1'
        flashReact('drag')
      })
      pet.addEventListener('pointermove', (event) => {
        const drag = state.drag
        if (!drag) return
        const dx = event.clientX - drag.x
        const dy = event.clientY - drag.y
        if (!drag.moved && Math.hypot(dx, dy) < 5) return
        drag.moved = true
        const bounds = state.data?.bounds ?? {}
        const [minR, maxR] = bounds.right ?? [-200, 4000]
        const [minB, maxB] = bounds.bottom ?? [-200, 4000]
        state.display.right = Math.min(maxR, Math.max(minR, drag.right - dx))
        state.display.bottom = Math.min(maxB, Math.max(minB, drag.bottom - dy))
        applyLook()
      })
      pet.addEventListener('pointerup', (event) => {
        const drag = state.drag
        state.drag = null
        root.dataset.dragging = '0'
        if (!drag) return
        if (drag.moved) persistPosition()
        else { interact('pat'); flashReact('pet') }
        event.preventDefault()
      })
      pet.addEventListener('pointercancel', () => {
        state.drag = null
        root.dataset.dragging = '0'
      })
      pet.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        openMenu(event)
      })
      pet.addEventListener('dblclick', () => togglePanel())
      pet.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          interact('pat')
        }
      })

      summon.addEventListener('click', async () => {
        try { await api('/visible', { visible: true }) } catch { /* ignore */ }
        state.display.visible = true
        applyLook()
        refresh()
      })

      // ------- panel wiring -------
      panel.addEventListener('click', async (event) => {
        const target = event.target.closest('[data-act]')
        if (!target) return
        const act = target.dataset.act
        if (act === 'pat' || act === 'feed' || act === 'play') interact(act)
        if (act === 'close') panel.dataset.show = '0'
        if (act === 'refresh') refresh()
        if (act === 'say') {
          const text = refs.sayInput.value.trim()
          if (text === '') return
          refs.sayInput.value = ''
          try {
            const result = await api('/say', { text })
            if (result.say) showBubble(result.say.text, 'good')
          } catch { /* ignore */ }
        }
        if (act === 'reset') configure({ right: 24, bottom: 18 })
        if (act === 'hide') hidePet()
        if (act === 'import') refs.file.click()
      })

      refs.name.addEventListener('click', async () => {
        const next = window.prompt('给桌宠起个名字', state.data?.pet?.name ?? '小鲸')
        if (next === null || next.trim() === '') return
        await configure({ name: next.trim() })
        refresh()
      })

      refs.size.addEventListener('input', () => {
        state.display.size = Number(refs.size.value)
        refs.sizeValue.textContent = refs.size.value
        applyLook()
      })
      refs.size.addEventListener('change', () => configure({ size: Number(refs.size.value) }))
      refs.opacity.addEventListener('input', () => {
        state.display.opacity = Number(refs.opacity.value) / 100
        applyLook()
      })
      refs.opacity.addEventListener('change', () => configure({ opacity: Number(refs.opacity.value) / 100 }))
      refs.sound.addEventListener('change', () => configure({ sound: refs.sound.checked }))
      refs.quiet.addEventListener('change', () => configure({ quiet: refs.quiet.checked }))
      refs.skin.addEventListener('change', () => {
        state.skin = refs.skin.value
        applyLook()
        configure({ skin: state.skin })
      })
      refs.poseSelect.addEventListener('change', () => {
        api('/pose', { pose: refs.poseSelect.value }).catch(() => {})
        refresh()
      })
      refs.sayInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          panel.querySelector('[data-act="say"]').click()
        }
      })

      // Import a spritesheet: data URL -> host, then select it.
      refs.file.addEventListener('change', () => {
        const file = refs.file.files?.[0]
        if (!file) return
        const reader = new FileReader()
        reader.onload = async () => {
          try {
            const dataUrl = String(reader.result ?? '')
            const name = window.prompt('给这张精灵图起个名字', file.name.replace(/\.[^.]+$/, '')) ?? '导入精灵图'
            const result = await api('/skins/import', { dataUrl, name, cols: 8, rows: 9, fps: 6 })
            if (result.skin) {
              state.skin = result.skin.id
              showBubble('新皮肤装好啦！')
            }
            refresh()
          } catch (error) {
            showBubble('导入失败：' + (error?.message ?? '未知错误'), 'bad')
          } finally {
            refs.file.value = ''
          }
        }
        reader.readAsDataURL(file)
      })

      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && panel.dataset.show === '1') togglePanel(false)
      })
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refresh()
      })

      applyLook()
      refresh()
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
