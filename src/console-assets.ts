export const CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <meta name="theme-color" content="#0b0d10" />
    <title>Hibro Node Console</title>
    <link rel="icon" type="image/png" href="/console/favicon.png" />
    <link rel="stylesheet" href="/console/styles.css" />
  </head>
  <body>
    <div class="app-shell">
      <aside class="sidebar">
        <a class="brand" href="/console" aria-label="Hibro Node Console">
          <img class="brand-mark" src="/console/hibro-mark.png" alt="" />
          <span><b>HIBRO</b><small>NODE CONTROL</small></span>
        </a>
        <div class="node-chip">
          <i></i>
          <span><b id="sidebar-node-name">LOCAL NODE</b><small id="sidebar-host">连接中…</small></span>
        </div>
        <nav aria-label="控制台导航">
          <button type="button" class="nav-button active" data-view="dashboard" aria-label="总览"><span>⌂</span><b>总览</b></button>
          <button type="button" class="nav-button" data-view="agents" aria-label="Agents"><span>◎</span><b>Agents</b><em id="nav-agent-count">0</em></button>
          <button type="button" class="nav-button" data-view="conversations" aria-label="Agent 对话"><span>◌</span><b>Agent 对话</b><em id="nav-conversation-count">0</em></button>
          <button type="button" class="nav-button" data-view="runs" aria-label="运行"><span>▶</span><b>运行</b><em id="nav-run-count">0</em></button>
          <button type="button" class="nav-button" data-view="artifacts" aria-label="产出"><span>◇</span><b>产出</b><em id="nav-artifact-count">0</em></button>
          <button type="button" class="nav-button" data-view="workspaces" aria-label="Agent 空间"><span>▣</span><b>Agent 空间</b></button>
          <div class="nav-separator">SYSTEM</div>
          <button type="button" class="nav-button" data-view="engines" aria-label="引擎"><span>⌘</span><b>引擎</b><em id="nav-engine-count">0</em></button>
          <button type="button" class="nav-button" data-view="system" aria-label="系统配置"><span>⚙</span><b>系统配置</b></button>
        </nav>
        <div class="sidebar-foot">
          <span id="core-mode">STANDALONE</span>
          <small id="hibro-version">Hibro Node</small>
        </div>
      </aside>

      <main class="main">
        <header class="topbar">
          <div>
            <p class="eyebrow" id="view-eyebrow">NODE OVERVIEW</p>
            <h1 id="view-title">运行总览</h1>
            <p id="view-subtitle">本地 Agent、引擎和运行状态的实时视图</p>
          </div>
          <div class="top-actions">
            <span class="last-refresh" id="last-refresh">尚未刷新</span>
            <button type="button" class="icon-button" id="refresh-button" aria-label="刷新全部数据" title="刷新">↻</button>
            <button type="button" class="primary-button" id="global-new-run">＋ 发起运行</button>
          </div>
        </header>

        <div class="banner warning" id="system-banner" hidden>
          <span>!</span><p id="system-banner-copy"></p>
          <button type="button" id="banner-action">查看引擎</button>
        </div>

        <section class="view active" id="view-dashboard" data-view-panel="dashboard">
          <div class="metric-grid">
            <article class="metric-card"><span>AGENTS</span><strong id="metric-agents">0</strong><small id="metric-agent-sub">0 个可用</small></article>
            <article class="metric-card"><span>ACTIVE RUNS</span><strong id="metric-active">0</strong><small>当前节点</small></article>
            <article class="metric-card"><span>SUCCESS RATE</span><strong id="metric-success">—</strong><small id="metric-run-sub">暂无运行</small></article>
            <article class="metric-card"><span>ENGINE HEALTH</span><strong id="metric-engines">0/0</strong><small id="metric-engine-sub">检测中</small></article>
          </div>

          <div class="dashboard-grid">
            <article class="panel span-2">
              <div class="panel-head">
                <div><p class="eyebrow">LOCAL AGENTS</p><h2>Agent 运行状态</h2></div>
                <button type="button" class="text-button" data-go-view="agents">管理 Agents →</button>
              </div>
              <div class="compact-agent-list" id="dashboard-agents"></div>
            </article>
            <article class="panel">
              <div class="panel-head">
                <div><p class="eyebrow">ENGINE STATUS</p><h2>引擎连通性</h2></div>
                <button type="button" class="text-button" data-go-view="engines">诊断 →</button>
              </div>
              <div class="engine-health-list" id="dashboard-engines"></div>
            </article>
            <article class="panel span-2">
              <div class="panel-head">
                <div><p class="eyebrow">RECENT RUNS</p><h2>最近运行</h2></div>
                <button type="button" class="text-button" data-go-view="runs">全部运行 →</button>
              </div>
              <div class="table-scroller">
                <table>
                  <thead><tr><th>Agent / 指令</th><th>状态</th><th>引擎</th><th>耗时</th><th>更新时间</th></tr></thead>
                  <tbody id="dashboard-runs"></tbody>
                </table>
              </div>
              <div class="empty-state" id="dashboard-runs-empty" hidden><b>还没有运行</b><p>从一个 Agent 发起首个任务。</p></div>
            </article>
            <article class="panel quick-panel">
              <div class="panel-head"><div><p class="eyebrow">QUICK START</p><h2>快速操作</h2></div></div>
              <button type="button" class="quick-action" id="quick-new-run"><span>▶</span><div><b>发起 Agent 运行</b><small>选择 Agent 和会话策略</small></div><em>→</em></button>
              <button type="button" class="quick-action" id="quick-new-agent"><span>＋</span><div><b>配置新 Agent</b><small>设置引擎、目录和权限</small></div><em>→</em></button>
              <button type="button" class="quick-action" data-go-view="system"><span>⚙</span><div><b>系统配置</b><small>并发、超时和 Core</small></div><em>→</em></button>
            </article>
          </div>
        </section>

        <section class="view" id="view-agents" data-view-panel="agents">
          <div class="section-toolbar">
            <div class="search-box"><span>⌕</span><input id="agent-search" type="search" placeholder="搜索 Agent 名称、引擎或目录" /></div>
            <div class="toolbar-actions">
              <select id="agent-engine-filter" aria-label="按引擎筛选">
                <option value="">全部引擎</option><option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="openclaw">OpenClaw</option>
              </select>
              <button type="button" class="primary-button" id="new-agent-button">＋ 新建 Agent</button>
            </div>
          </div>
          <div class="agent-grid" id="agent-grid"></div>
          <div class="empty-state large" id="agents-empty" hidden><b>没有符合条件的 Agent</b><p>调整筛选条件，或创建一个新的本地 Agent。</p></div>
        </section>

        <section class="view" id="view-conversations" data-view-panel="conversations">
          <div class="conversation-shell">
            <aside class="conversation-list-panel">
              <div class="conversation-list-head"><div><p class="eyebrow">CONVERSATIONS</p><h2>本地 Agent 对话</h2></div><button type="button" class="primary-button compact" id="new-conversation">＋ 新建</button></div>
              <div id="conversation-list" class="conversation-list"></div>
            </aside>
            <article class="conversation-main">
              <div class="conversation-empty" id="conversation-empty"><b>选择一个 Agent 开始对话</b><p>消息、Agent 输出、思考摘要、工具调用和审批项会按时间呈现。</p></div>
              <div id="conversation-detail" hidden>
                <div class="conversation-head"><div><p class="eyebrow" id="conversation-engine">AGENT</p><h2 id="conversation-title">对话</h2><small id="conversation-status">空闲</small></div><button type="button" class="danger-button" id="cancel-conversation" hidden>停止响应</button></div>
                <div class="conversation-feed" id="conversation-feed"></div>
                <form class="conversation-composer" id="conversation-form">
                  <textarea id="conversation-input" rows="3" placeholder="给这个 Agent 发送消息…"></textarea>
                  <div><small>Enter 发送，Shift + Enter 换行</small><button type="submit" class="primary-button" id="send-conversation">发送 →</button></div>
                </form>
              </div>
            </article>
          </div>
        </section>

        <section class="view" id="view-runs" data-view-panel="runs">
          <div class="section-toolbar">
            <div class="search-box"><span>⌕</span><input id="run-search" type="search" placeholder="搜索运行指令、ID 或会话" /></div>
            <div class="toolbar-actions">
              <select id="run-agent-filter" aria-label="按 Agent 筛选"><option value="">全部 Agent</option></select>
              <select id="run-status-filter" aria-label="按状态筛选">
                <option value="">全部状态</option><option value="running">运行中</option><option value="completed">已完成</option><option value="failed">失败</option><option value="cancelled">已取消</option><option value="timed_out">超时</option>
              </select>
              <button type="button" class="primary-button" id="runs-new-run">＋ 发起运行</button>
            </div>
          </div>
          <article class="panel">
            <div class="table-scroller">
              <table class="runs-table">
                <thead><tr><th>运行</th><th>Agent</th><th>状态</th><th>实际工作位置</th><th>耗时</th><th>创建时间</th><th></th></tr></thead>
                <tbody id="runs-body"></tbody>
              </table>
            </div>
            <div class="empty-state large" id="runs-empty" hidden><b>没有运行记录</b><p>发起运行后，状态、事件和结果会出现在这里。</p></div>
          </article>
        </section>

        <section class="view" id="view-artifacts" data-view-panel="artifacts">
          <div class="section-toolbar">
            <div class="search-box"><span>⌕</span><input id="artifact-search" type="search" placeholder="搜索产出标题、内容或 Agent" /></div>
            <span class="toolbar-note">已完成运行的最终输出</span>
          </div>
          <div class="artifact-grid" id="artifact-grid"></div>
          <div class="empty-state large" id="artifacts-empty" hidden><b>暂无产出</b><p>Agent 成功完成运行后，最终结果会自动归档到这里。</p></div>
        </section>

        <section class="view" id="view-workspaces" data-view-panel="workspaces">
          <div class="info-callout">
            <span>i</span><div><b>每个 Agent 都在自己的专属空间中工作</b><p>Agent 可以从空白空间启动，也可以配置默认项目；还可以只为某次 Run 临时挂载项目。</p></div>
          </div>
          <article class="panel">
            <div class="table-scroller">
              <table>
                <thead><tr><th>Agent</th><th>默认项目</th><th>空间类型</th><th>Agent 专属空间</th><th>权限</th><th>运行状态</th><th>最近使用</th></tr></thead>
                <tbody id="workspaces-body"></tbody>
              </table>
            </div>
          </article>
        </section>

        <section class="view" id="view-engines" data-view-panel="engines">
          <div class="section-toolbar">
            <div><p class="toolbar-title">CLI 引擎检测</p><span class="toolbar-note">显示安装、认证和版本状态</span></div>
            <button type="button" class="secondary-button" id="recheck-engines">↻ 重新检测</button>
          </div>
          <div class="engine-grid" id="engine-grid"></div>
          <div class="info-callout compact">
            <span>i</span><div><b>引擎路径来自启动环境</b><p>容器中通过镜像内 CLI 和挂载的认证配置运行；宿主机模式可用 HIBRO_CLAUDE_BIN、HIBRO_CODEX_BIN、HIBRO_OPENCLAW_BIN 覆盖。</p></div>
          </div>
        </section>

        <section class="view" id="view-system" data-view-panel="system">
          <div class="settings-layout">
            <form class="panel settings-form" id="settings-form">
              <div class="panel-head"><div><p class="eyebrow">NODE SETTINGS</p><h2>运行时配置</h2></div><span class="save-state" id="settings-save-state">已同步</span></div>
              <div class="form-body">
                <div class="field-grid two">
                  <label><span>节点名称</span><input id="setting-node-name" required /></label>
                  <label><span>全局最大并发</span><input id="setting-max-concurrency" type="number" min="1" max="64" required /></label>
                  <label><span>默认超时（秒）</span><input id="setting-timeout" type="number" min="1" required /></label>
                  <label><span>运行历史保留天数</span><input id="setting-retention" type="number" min="1" required /></label>
                </div>
                <label class="toggle-row"><input id="setting-auto-resume" type="checkbox" /><span><b>自动续接会话</b><small>同一 Agent、项目与 sessionKey 默认复用最近会话</small></span></label>
                <label class="toggle-row danger-toggle"><input id="setting-dangerous" type="checkbox" /><span><b>允许 danger-full-access</b><small>关闭时所有请求都无法绕过引擎沙箱</small></span></label>
                <div class="subsection">
                  <div class="subsection-head"><div><b>Hibro Core</b><small>启用后自动注册 Node、同步 Agent，并接收远程运行</small></div><label class="switch"><input id="setting-core-enabled" type="checkbox" /><i></i></label></div>
                  <label><span>Core URL</span><input id="setting-core-url" type="url" placeholder="ws://host.docker.internal:17400" /></label>
                  <label><span>Core 一次性注册码</span><input id="setting-core-token" type="password" autocomplete="off" placeholder="粘贴 Core 生成的一次性注册码" /><small id="core-token-status">尚未注册。请先在 Core 中生成一次性注册码。</small></label>
                  <p class="field-hint" id="core-connection-hint">Core 未启用。</p>
                </div>
              </div>
              <div class="form-footer"><button type="submit" class="primary-button" id="save-settings">保存配置</button></div>
            </form>

            <div class="system-side">
              <article class="panel">
                <div class="panel-head"><div><p class="eyebrow">RUNTIME PROFILE</p><h2>系统诊断</h2></div></div>
                <dl class="diagnostic-list" id="diagnostic-list"></dl>
              </article>
              <article class="panel">
                <div class="panel-head"><div><p class="eyebrow">STORAGE</p><h2>资源使用</h2></div></div>
                <div class="resource-body">
                  <div class="resource-row"><div><span>内存可用</span><b id="memory-label">—</b></div><div class="progress"><i id="memory-progress"></i></div></div>
                  <div class="resource-row"><div><span>磁盘可用</span><b id="disk-label">—</b></div><div class="progress"><i id="disk-progress"></i></div></div>
                  <code id="data-directory">—</code>
                </div>
              </article>
            </div>
          </div>
        </section>
      </main>
    </div>

    <dialog id="run-dialog" class="modal">
      <form id="run-form">
        <div class="modal-head"><div><p class="eyebrow">NEW RUN</p><h2>发起 Agent 运行</h2></div><button type="button" class="modal-close" data-close-dialog="run-dialog" aria-label="关闭运行窗口">×</button></div>
        <div class="modal-body">
          <label><span>Agent</span><select id="run-agent" required></select></label>
          <div class="selection-preview" id="run-agent-preview"></div>
          <label><span>任务指令</span><textarea id="run-prompt" required rows="6" placeholder="说明目标、约束和期望产出。"></textarea></label>
          <label><span>本次项目目录（可选）</span><input id="run-source-path" placeholder="/workspace/project" /><small>仅为这次 Run 创建独立工作副本，不会改变 Agent 的默认空间。</small></label>
          <div class="field-grid two">
            <label><span>会话键</span><input id="run-session-key" placeholder="default" /></label>
            <label><span>超时</span><select id="run-timeout"><option value="">使用系统默认</option><option value="60000">1 分钟</option><option value="300000">5 分钟</option><option value="900000">15 分钟</option></select></label>
          </div>
          <div class="field-grid two">
            <label><span>文件权限</span><select id="run-sandbox"><option value="">跟随 Agent 空间设置</option><option value="read-only">只读</option><option value="workspace-write">允许修改专属空间</option><option value="danger-full-access">完全访问</option></select></label>
            <label class="toggle-card"><input id="run-fresh-session" type="checkbox" /><span><b>新建会话</b><small>不续接历史上下文</small></span></label>
          </div>
        </div>
        <div class="modal-actions"><button type="button" class="secondary-button" data-close-dialog="run-dialog">取消</button><button type="submit" class="primary-button" id="submit-run">开始运行 →</button></div>
      </form>
    </dialog>

    <dialog id="conversation-dialog" class="modal">
      <form id="conversation-create-form">
        <div class="modal-head"><div><p class="eyebrow">NEW CONVERSATION</p><h2>新建 Agent 对话</h2></div><button type="button" class="modal-close" data-close-dialog="conversation-dialog" aria-label="关闭">×</button></div>
        <div class="modal-body">
          <label><span>Agent</span><select id="conversation-agent" required></select></label>
          <label><span>对话标题（可选）</span><input id="conversation-new-title" placeholder="例如：重构后端服务" /></label>
          <div class="info-callout compact"><span>i</span><div><b>对话会续接上下文</b><p>每个对话绑定一个 Agent 和它自己的工作空间；底层 Run 只作为执行记录。</p></div></div>
        </div>
        <div class="modal-actions"><button type="button" class="secondary-button" data-close-dialog="conversation-dialog">取消</button><button type="submit" class="primary-button">创建对话</button></div>
      </form>
    </dialog>

    <dialog id="agent-dialog" class="modal wide">
      <form id="agent-form">
        <div class="modal-head"><div><p class="eyebrow">AGENT CONFIGURATION</p><h2 id="agent-dialog-title">新建 Agent</h2></div><button type="button" class="modal-close" data-close-dialog="agent-dialog" aria-label="关闭 Agent 配置">×</button></div>
        <div class="modal-body">
          <div class="generated-id" id="agent-generated-id" hidden><span>系统 ID</span><code id="agent-id-value"></code></div>
          <label><span>显示名称</span><input id="agent-name" required placeholder="代码审查助手" /></label>
          <label><span>描述</span><input id="agent-description" placeholder="这个 Agent 适合处理什么任务" /></label>
          <div class="field-grid two">
            <label><span>引擎</span><select id="agent-engine" required><option value="claude-code">Claude Code</option><option value="codex">Codex CLI</option><option value="openclaw">OpenClaw</option></select></label>
            <label><span>模型（可选）</span><input id="agent-model" placeholder="使用引擎默认模型" /></label>
          </div>
          <label><span>默认项目目录（可选）</span><input id="agent-source-path" placeholder="/workspace/project" /><small>留空时 Agent 从空白专属空间启动；填写后会创建工作副本，不会直接修改此目录。</small></label>
          <div class="field-grid two">
            <label><span>专属空间保留方式</span><select id="agent-workspace-strategy" required><option value="persistent">持续保留，后续继续使用</option><option value="per-run">每次运行创建新空间</option><option value="scratch">每次使用空白临时空间</option></select></label>
            <label><span>专属空间权限</span><select id="agent-workspace-access" required><option value="read-only">只读</option><option value="workspace-write">允许修改</option></select></label>
          </div>
          <div class="workspace-preview" id="agent-workspace-preview"></div>
          <label><span>最大并发</span><input id="agent-concurrency" type="number" min="1" max="16" value="1" required /></label>
          <label><span>Agent 指令</span><textarea id="agent-instructions" rows="4" placeholder="每次运行都会附加到系统提示词。"></textarea></label>
          <label><span>Claude 工具白名单</span><input id="agent-tools" placeholder="Read, Grep, Glob" /><small>仅 Claude Code 使用，逗号分隔。</small></label>
          <label class="toggle-row danger-toggle"><input id="agent-dangerous" type="checkbox" /><span><b>允许申请完全访问</b><small>只有系统总开关也开启时，本 Agent 才能申请 danger-full-access</small></span></label>
          <label class="toggle-row"><input id="agent-enabled" type="checkbox" checked /><span><b>启用 Agent</b><small>停用后保留配置和历史，但不能发起新运行</small></span></label>
        </div>
        <div class="modal-actions split"><button type="button" class="danger-button" id="delete-agent" hidden>删除 Agent</button><div><button type="button" class="secondary-button" data-close-dialog="agent-dialog">取消</button><button type="submit" class="primary-button" id="save-agent">保存 Agent</button></div></div>
      </form>
    </dialog>

    <dialog id="run-detail-dialog" class="modal wide detail-modal">
      <div class="modal-head"><div><p class="eyebrow">RUN DETAIL</p><h2 id="detail-title">运行详情</h2></div><button type="button" class="modal-close" data-close-dialog="run-detail-dialog" aria-label="关闭运行详情">×</button></div>
      <div class="detail-summary" id="detail-summary"></div>
      <div class="detail-tabs"><button type="button" class="active" data-detail-tab="result">结果</button><button type="button" data-detail-tab="events">事件</button><button type="button" data-detail-tab="request">请求</button></div>
      <div class="detail-content active" id="detail-result"></div>
      <div class="detail-content" id="detail-events"></div>
      <div class="detail-content" id="detail-request"></div>
      <div class="modal-actions split"><button type="button" class="danger-button" id="detail-cancel" hidden>停止运行</button><div><a class="secondary-button link-button" id="detail-download" href="#" hidden>下载产出</a><button type="button" class="secondary-button" id="detail-rerun">再次运行</button></div></div>
    </dialog>

    <dialog id="artifact-dialog" class="modal wide">
      <div class="modal-head"><div><p class="eyebrow">AGENT OUTPUT</p><h2 id="artifact-title">产出详情</h2></div><button type="button" class="modal-close" data-close-dialog="artifact-dialog" aria-label="关闭产出详情">×</button></div>
      <div class="artifact-meta" id="artifact-meta"></div>
      <div class="result-view artifact-content" id="artifact-content"></div>
      <div class="modal-actions"><button type="button" class="secondary-button" id="copy-artifact">复制内容</button><a class="primary-button link-button" id="download-artifact" href="#">下载 Markdown</a></div>
    </dialog>

    <dialog id="confirm-dialog" class="modal compact-modal">
      <div class="modal-head"><div><p class="eyebrow">CONFIRM ACTION</p><h2 id="confirm-title">确认操作</h2></div><button type="button" class="modal-close" data-close-dialog="confirm-dialog" aria-label="关闭确认窗口">×</button></div>
      <p class="confirm-copy" id="confirm-copy"></p>
      <div class="modal-actions"><button type="button" class="secondary-button" data-close-dialog="confirm-dialog">取消</button><button type="button" class="danger-button solid" id="confirm-action">确认</button></div>
    </dialog>

    <div class="toast" id="toast" role="status" aria-live="polite"></div>
    <script type="module" src="/console/app.js"></script>
  </body>
</html>`;

export const CONSOLE_CSS = `:root {
  --bg: #0b0d10;
  --sidebar: #0f1115;
  --panel: #14171c;
  --panel-2: #181c22;
  --input: #0d1014;
  --border: #2a3039;
  --soft-border: rgba(255,255,255,.065);
  --text: #f0efe9;
  --muted: #9ba3af;
  --quiet: #656d79;
  --lime: #b8ef61;
  --lime-dim: rgba(184,239,97,.11);
  --blue: #75a9ff;
  --blue-dim: rgba(117,169,255,.1);
  --red: #ff7078;
  --red-dim: rgba(255,112,120,.1);
  --amber: #f3bd62;
  --amber-dim: rgba(243,189,98,.1);
  --sans: Inter, "SF Pro Text", "PingFang SC", system-ui, sans-serif;
  --mono: "SFMono-Regular", "Cascadia Code", monospace;
}
* { box-sizing: border-box; }
*[hidden] { display: none !important; }
html { background: var(--bg); color: var(--text); }
body { margin: 0; min-width: 320px; font-family: var(--sans); -webkit-font-smoothing: antialiased; }
button, input, textarea, select { font: inherit; }
button, a { -webkit-tap-highlight-color: transparent; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .45; }
a { color: inherit; }
.app-shell { min-height: 100vh; display: grid; grid-template-columns: 236px minmax(0, 1fr); }
.sidebar { position: sticky; top: 0; height: 100vh; padding: 26px 18px 20px; background: var(--sidebar); border-right: 1px solid var(--soft-border); display: flex; flex-direction: column; }
.brand { display: flex; align-items: center; gap: 12px; padding: 0 8px; text-decoration: none; }
.brand-mark { width: 38px; height: 38px; display: block; object-fit: cover; border: 1px solid #333b45; background: #090b0e; }
.brand b { display: block; letter-spacing: .15em; font-size: 15px; }
.brand small { display: block; margin-top: 5px; color: var(--quiet); font: 8px/1 var(--mono); letter-spacing: .13em; }
.node-chip { margin: 28px 4px 20px; padding: 12px; display: flex; align-items: center; gap: 10px; border: 1px solid var(--border); background: rgba(255,255,255,.018); }
.node-chip i { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: var(--lime); box-shadow: 0 0 0 4px var(--lime-dim), 0 0 12px var(--lime); }
.node-chip b, .node-chip small { display: block; max-width: 160px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.node-chip b { font: 9px/1.2 var(--mono); letter-spacing: .08em; }
.node-chip small { margin-top: 5px; color: var(--quiet); font: 8px/1 var(--mono); }
.sidebar nav { display: grid; gap: 4px; }
.nav-button { width: 100%; height: 42px; padding: 0 11px; border: 0; border-left: 2px solid transparent; background: transparent; color: var(--quiet); display: grid; grid-template-columns: 24px 1fr auto; align-items: center; text-align: left; }
.nav-button > span { font: 14px/1 var(--mono); }
.nav-button b { font-size: 12px; font-weight: 520; }
.nav-button em { min-width: 21px; padding: 3px 5px; border-radius: 10px; background: rgba(255,255,255,.05); color: #7f8793; text-align: center; font: normal 8px/1 var(--mono); }
.nav-button:hover { color: #cfd2d7; background: rgba(255,255,255,.025); }
.nav-button.active { border-left-color: var(--lime); background: var(--lime-dim); color: var(--text); }
.nav-button.active > span { color: var(--lime); }
.nav-separator { margin: 23px 12px 8px; color: #464d58; font: 8px/1 var(--mono); letter-spacing: .18em; }
.sidebar-foot { margin-top: auto; padding: 14px 10px 0; border-top: 1px solid var(--soft-border); display: flex; justify-content: space-between; color: #515964; font: 8px/1 var(--mono); }
.sidebar-foot span { color: var(--amber); }
.main { min-width: 0; min-height: 100vh; padding: 26px 34px 50px; }
.topbar { min-height: 82px; display: flex; align-items: center; justify-content: space-between; gap: 24px; border-bottom: 1px solid var(--border); }
.eyebrow { margin: 0 0 7px; color: var(--quiet); font: 8px/1.2 var(--mono); letter-spacing: .18em; }
.topbar h1 { margin: 0; font-size: 22px; font-weight: 620; letter-spacing: -.02em; }
.topbar > div > p:last-child { margin: 7px 0 0; color: var(--muted); font-size: 11px; }
.top-actions { display: flex; align-items: center; gap: 9px; }
.last-refresh { margin-right: 5px; color: var(--quiet); font: 8px/1 var(--mono); }
.icon-button, .primary-button, .secondary-button, .danger-button, .text-button { border: 0; }
.icon-button { width: 40px; height: 40px; border: 1px solid var(--border); background: var(--panel); color: var(--muted); font-size: 19px; }
.icon-button:hover { border-color: #52603e; color: var(--lime); }
.icon-button.spinning { animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.primary-button, .secondary-button, .danger-button { min-height: 40px; padding: 0 16px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; font-size: 11px; text-decoration: none; }
.primary-button { background: var(--lime); color: #12160c; font-weight: 720; }
.primary-button:hover { background: #c8ff77; }
.secondary-button { border: 1px solid var(--border); background: transparent; color: #c4c8ce; }
.secondary-button:hover { border-color: #555e6b; color: var(--text); }
.danger-button { border: 1px solid #61343a; background: var(--red-dim); color: var(--red); }
.danger-button.solid { background: var(--red); color: #21070a; font-weight: 700; }
.text-button { background: transparent; color: var(--muted); font: 9px/1 var(--mono); }
.text-button:hover { color: var(--lime); }
.view { display: none; padding-top: 24px; }
.view.active { display: block; min-height: calc(100vh - 132px); }
.banner { margin-top: 18px; min-height: 48px; padding: 10px 14px; border: 1px solid; display: flex; align-items: center; gap: 11px; }
.banner[hidden] { display: none; }
.banner.warning { border-color: #54452f; background: var(--amber-dim); color: var(--amber); }
.banner > span { width: 22px; height: 22px; display: grid; place-items: center; border: 1px solid currentColor; border-radius: 50%; font: 10px/1 var(--mono); }
.banner p { margin: 0; flex: 1; color: #c6ad83; font-size: 10px; }
.banner button { border: 0; background: transparent; color: var(--amber); font: 9px/1 var(--mono); }
.metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); border: 1px solid var(--border); background: var(--panel); }
.metric-card { min-height: 128px; padding: 22px; border-right: 1px solid var(--border); }
.metric-card:last-child { border-right: 0; }
.metric-card span { color: var(--quiet); font: 8px/1 var(--mono); letter-spacing: .13em; }
.metric-card strong { display: block; margin-top: 18px; font: 500 30px/1 var(--mono); letter-spacing: -.07em; }
.metric-card small { display: block; margin-top: 13px; color: var(--quiet); font-size: 9px; }
.dashboard-grid { margin-top: 16px; display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(280px, .65fr); gap: 16px; }
.panel { min-width: 0; border: 1px solid var(--border); background: var(--panel); }
.span-2 { grid-column: 1; }
.panel-head { min-height: 70px; padding: 17px 19px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 15px; }
.panel-head h2 { margin: 0; font-size: 14px; font-weight: 590; }
.compact-agent-list, .engine-health-list { min-height: 135px; }
.compact-agent { min-height: 68px; padding: 12px 17px; display: grid; grid-template-columns: 34px minmax(0,1fr) auto auto; align-items: center; gap: 12px; border-bottom: 1px solid var(--soft-border); }
.compact-agent:last-child { border-bottom: 0; }
.mini-avatar { width: 34px; height: 34px; display: grid; place-items: center; border: 1px solid #414853; color: var(--lime); font: 700 12px/1 var(--mono); }
.compact-agent b { display: block; font-size: 11px; font-weight: 550; }
.compact-agent small { display: block; margin-top: 5px; color: var(--quiet); font: 8px/1 var(--mono); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.state { display: inline-flex; align-items: center; gap: 7px; font: 8px/1 var(--mono); text-transform: uppercase; }
.state::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.state.idle, .state.completed { color: var(--lime); }
.state.running, .state.queued, .state.cancelling { color: var(--amber); }
.state.unavailable, .state.disabled, .state.failed, .state.cancelled, .state.timed_out { color: var(--red); }
.core-registration { display: inline-flex; align-items: center; gap: 6px; padding: 5px 7px; border: 1px solid var(--border); color: var(--quiet); font: 8px/1 var(--mono); }
.core-registration::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.core-registration.registered { border-color: #4f6138; color: var(--lime); }
.core-registration.pending, .core-registration.syncing { border-color: #5c4a2f; color: var(--amber); }
.core-registration.error, .core-registration.rejected { border-color: #61343a; color: var(--red); }
.engine-health-row { min-height: 54px; padding: 11px 16px; display: grid; grid-template-columns: 1fr auto; align-items: center; border-bottom: 1px solid var(--soft-border); }
.engine-health-row:last-child { border-bottom: 0; }
.engine-health-row b { display: block; font-size: 10px; }
.engine-health-row small { display: block; margin-top: 4px; color: var(--quiet); font: 8px/1 var(--mono); }
.table-scroller { overflow: auto; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th { height: 40px; padding: 0 13px; text-align: left; color: var(--quiet); border-bottom: 1px solid var(--soft-border); font: 8px/1 var(--mono); letter-spacing: .08em; }
td { height: 60px; padding: 9px 13px; color: #b7bdc6; border-bottom: 1px solid var(--soft-border); font-size: 10px; vertical-align: middle; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr[data-run-id] { cursor: pointer; }
tbody tr[data-run-id]:hover { background: rgba(255,255,255,.025); }
.cell-title { display: block; color: var(--text); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cell-sub { display: block; margin-top: 5px; color: var(--quiet); font: 8px/1 var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.quick-panel { grid-column: 2; grid-row: 1 / span 2; align-self: start; }
.quick-action { width: 100%; min-height: 78px; padding: 13px 16px; border: 0; border-bottom: 1px solid var(--soft-border); background: transparent; color: var(--text); display: grid; grid-template-columns: 34px 1fr auto; gap: 12px; align-items: center; text-align: left; }
.quick-action:last-child { border-bottom: 0; }
.quick-action:hover { background: rgba(255,255,255,.025); }
.quick-action > span { width: 34px; height: 34px; display: grid; place-items: center; background: var(--lime-dim); color: var(--lime); font: 12px/1 var(--mono); }
.quick-action b { display: block; font-size: 10px; font-weight: 560; }
.quick-action small { display: block; margin-top: 5px; color: var(--quiet); font-size: 8px; }
.quick-action em { color: var(--quiet); font-style: normal; }
.section-toolbar { min-height: 54px; margin-bottom: 15px; display: flex; align-items: center; justify-content: space-between; gap: 15px; }
.toolbar-actions { display: flex; align-items: center; gap: 8px; }
.toolbar-note { color: var(--quiet); font: 8px/1.4 var(--mono); }
.toolbar-title { margin: 0 0 5px; font-size: 12px; font-weight: 560; }
.search-box { width: min(420px, 100%); height: 40px; padding: 0 11px; display: flex; align-items: center; gap: 9px; border: 1px solid var(--border); background: var(--input); }
.search-box span { color: var(--quiet); font: 16px/1 var(--mono); }
.search-box input { border: 0; padding: 0; background: transparent; }
input, textarea, select { width: 100%; min-height: 40px; border: 1px solid #343b46; border-radius: 0; background: var(--input); color: var(--text); padding: 10px 11px; outline: 0; font-size: 11px; }
textarea { resize: vertical; line-height: 1.55; }
select { width: auto; min-width: 130px; }
input:focus, textarea:focus, select:focus { border-color: #66764b; box-shadow: 0 0 0 3px rgba(184,239,97,.055); }
.agent-grid { display: grid; grid-template-columns: repeat(3, minmax(250px, 1fr)); gap: 13px; }
.agent-card { min-width: 0; padding: 18px; border: 1px solid var(--border); background: var(--panel); }
.agent-card:hover { border-color: #48515d; }
.agent-card-head { display: grid; grid-template-columns: 40px minmax(0,1fr) auto; gap: 11px; align-items: center; }
.agent-card-head .mini-avatar { width: 40px; height: 40px; }
.agent-card-head h3 { margin: 0; font-size: 12px; font-weight: 590; }
.agent-card-head p { margin: 5px 0 0; color: var(--quiet); font: 8px/1 var(--mono); }
.agent-description { min-height: 34px; margin: 16px 0; color: var(--muted); font-size: 9px; line-height: 1.6; }
.tag-list { display: flex; flex-wrap: wrap; gap: 6px; }
.tag { padding: 5px 7px; background: rgba(255,255,255,.035); color: #818a97; font: 8px/1 var(--mono); }
.agent-path { display: block; margin-top: 13px; color: #626b77; font: 8px/1.4 var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agent-card-foot { margin-top: 17px; padding-top: 13px; border-top: 1px solid var(--soft-border); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.agent-card-foot > div { display: flex; gap: 6px; }
.agent-core-row { margin-top: 12px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.agent-core-row small { color: var(--quiet); font: 8px/1.4 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.small-button { min-height: 30px; padding: 0 9px; border: 1px solid var(--border); background: transparent; color: var(--muted); font-size: 8px; }
.small-button:hover { border-color: #56606d; color: var(--text); }
.small-button.accent { border-color: #4f6138; color: var(--lime); }
.runs-table th:first-child { width: 28%; }
.runs-table th:nth-child(2) { width: 14%; }
.runs-table th:nth-child(3) { width: 11%; }
.runs-table th:nth-child(4) { width: 20%; }
.runs-table th:nth-child(5), .runs-table th:nth-child(6) { width: 11%; }
.runs-table th:last-child { width: 5%; }
.row-menu { border: 0; background: transparent; color: var(--quiet); font-size: 16px; }
.artifact-grid { display: grid; grid-template-columns: repeat(3, minmax(250px,1fr)); gap: 13px; }
.artifact-card { min-width: 0; padding: 18px; border: 1px solid var(--border); background: var(--panel); cursor: pointer; }
.artifact-card:hover { border-color: #4a5461; transform: translateY(-1px); }
.artifact-card-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.artifact-card-top span { color: var(--lime); font: 8px/1 var(--mono); }
.artifact-card-top time { color: var(--quiet); font: 8px/1 var(--mono); }
.artifact-card-top .artifact-sync { margin-left: auto; padding: 4px 6px; border: 1px solid var(--border); color: var(--quiet); }
.artifact-card-top .artifact-sync.synced { border-color: #405f42; color: var(--lime); }
.artifact-card-top .artifact-sync.pending, .artifact-card-top .artifact-sync.uploading { border-color: #5c4a2f; color: var(--amber); }
.artifact-card-top .artifact-sync.failed { border-color: #61343a; color: var(--red); }
.artifact-card h3 { margin: 16px 0 9px; font-size: 12px; line-height: 1.4; }
.artifact-preview { height: 66px; overflow: hidden; color: var(--muted); font-size: 9px; line-height: 1.65; white-space: pre-wrap; }
.artifact-card-foot { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--soft-border); display: flex; justify-content: space-between; color: var(--quiet); font: 8px/1 var(--mono); }
.info-callout { margin-bottom: 15px; padding: 14px 16px; border: 1px solid #35445b; background: var(--blue-dim); display: flex; gap: 12px; align-items: center; }
.info-callout.compact { margin: 16px 0 0; }
.info-callout > span { width: 22px; height: 22px; flex: 0 0 auto; display: grid; place-items: center; border: 1px solid var(--blue); border-radius: 50%; color: var(--blue); font: 9px/1 var(--mono); }
.info-callout b { display: block; font-size: 10px; }
.info-callout p { margin: 5px 0 0; color: #899bb6; font-size: 9px; line-height: 1.5; }
#view-workspaces table { min-width: 1040px; }
.engine-grid { display: grid; grid-template-columns: repeat(3, minmax(240px,1fr)); gap: 13px; }
.engine-card { min-width: 0; padding: 19px; border: 1px solid var(--border); background: var(--panel); }
.engine-card-head { display: flex; align-items: center; gap: 12px; }
.engine-logo { width: 42px; height: 42px; display: grid; place-items: center; border: 1px solid #414955; color: var(--lime); font: 700 15px/1 var(--mono); }
.engine-card-head h3 { margin: 0; font-size: 12px; }
.engine-card dl { margin: 20px 0 0; }
.engine-card dl div { min-height: 36px; padding: 9px 0; display: grid; grid-template-columns: 75px minmax(0,1fr); gap: 10px; border-bottom: 1px solid var(--soft-border); }
.engine-card dt { color: var(--quiet); font-size: 9px; }
.engine-card dd { margin: 0; color: #aeb5bf; font: 8px/1.5 var(--mono); overflow-wrap: anywhere; }
.engine-error { margin: 13px 0 0; padding: 9px; color: #d99398; background: var(--red-dim); font-size: 8px; line-height: 1.5; }
.settings-layout { display: grid; grid-template-columns: minmax(0,1.3fr) minmax(300px,.7fr); gap: 15px; align-items: start; }
.settings-form .form-body { padding: 20px; }
.field-grid { display: grid; gap: 12px; }
.field-grid.two { grid-template-columns: 1fr 1fr; }
label > span:first-child { display: block; margin-bottom: 7px; color: var(--muted); font-size: 9px; }
label > small { display: block; margin-top: 6px; color: var(--quiet); font-size: 8px; }
.toggle-row, .toggle-card { min-height: 56px; padding: 10px 12px; border: 1px solid var(--border); display: flex; align-items: center; gap: 11px; }
.toggle-row { margin-top: 12px; }
.toggle-row input, .toggle-card input { width: 15px; min-height: 15px; height: 15px; accent-color: var(--lime); }
.toggle-row b, .toggle-card b { display: block; font-size: 9px; }
.toggle-row small, .toggle-card small { display: block; margin-top: 5px; color: var(--quiet); font-size: 8px; }
.danger-toggle { border-color: #4d3438; }
.subsection { margin-top: 18px; padding: 16px; border: 1px solid var(--border); background: rgba(255,255,255,.012); }
.subsection-head { margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.subsection-head b, .subsection-head small { display: block; }
.subsection-head b { font-size: 10px; }
.subsection-head small { margin-top: 5px; color: var(--quiet); font-size: 8px; }
.switch { position: relative; width: 34px; height: 18px; flex: 0 0 auto; }
.switch input { position: absolute; inset: 0; width: 34px; min-height: 18px; height: 18px; margin: 0; padding: 0; opacity: 0; pointer-events: none; }
.switch i { width: 34px; height: 18px; display: block; border: 1px solid #414955; background: var(--input); position: relative; }
.switch i::after { content: ""; position: absolute; width: 12px; height: 12px; left: 2px; top: 2px; background: #6d7580; transition: .2s; }
.switch input:checked + i { border-color: #627b3e; background: var(--lime-dim); }
.switch input:checked + i::after { left: 18px; background: var(--lime); }
.field-hint { margin: 8px 0 0; color: var(--quiet); font-size: 8px; line-height: 1.5; }
.generated-id { margin-bottom: 14px; padding: 10px 12px; border: 1px solid var(--border); background: var(--input); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.generated-id span { color: var(--quiet); font-size: 8px; }
.generated-id code { color: var(--lime); font: 8px/1.4 var(--mono); overflow-wrap: anywhere; }
.workspace-preview { margin-top: 12px; padding: 11px 12px; border-left: 2px solid var(--blue); background: var(--blue-dim); color: #91a4c1; font: 8px/1.55 var(--mono); overflow-wrap: anywhere; }
.form-footer { padding: 15px 20px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; }
.save-state { color: var(--quiet); font: 8px/1 var(--mono); }
.save-state.dirty { color: var(--amber); }
.system-side { display: grid; gap: 15px; }
.diagnostic-list { margin: 0; padding: 9px 18px 15px; }
.diagnostic-list div { min-height: 38px; display: grid; grid-template-columns: 95px minmax(0,1fr); align-items: center; border-bottom: 1px solid var(--soft-border); }
.diagnostic-list div:last-child { border-bottom: 0; }
.diagnostic-list dt { color: var(--quiet); font-size: 8px; }
.diagnostic-list dd { margin: 0; color: #aeb5bf; font: 8px/1.4 var(--mono); overflow-wrap: anywhere; }
.resource-body { padding: 18px; }
.resource-row { margin-bottom: 18px; }
.resource-row > div:first-child { display: flex; justify-content: space-between; color: var(--muted); font-size: 9px; }
.resource-row b { color: #b9bfc8; font: 8px/1 var(--mono); }
.progress { height: 4px; margin-top: 9px; background: #282e36; overflow: hidden; }
.progress i { display: block; width: 0; height: 100%; background: var(--lime); }
.resource-body code { display: block; padding: 10px; background: var(--input); color: var(--quiet); font: 8px/1.5 var(--mono); overflow-wrap: anywhere; }
.empty-state { padding: 35px 20px; text-align: center; color: var(--quiet); }
.empty-state.large { min-height: 260px; display: grid; place-content: center; border: 1px dashed var(--border); }
.empty-state[hidden] { display: none; }
.empty-state b { color: #b6bbc3; font-size: 11px; }
.empty-state p { margin: 7px 0 0; font-size: 9px; }
.modal { width: min(610px, calc(100% - 28px)); max-height: calc(100vh - 32px); padding: 0; border: 1px solid #3a424d; background: var(--panel); color: var(--text); box-shadow: 0 30px 100px rgba(0,0,0,.7); overflow: auto; }
.modal.wide { width: min(790px, calc(100% - 28px)); }
.compact-modal { width: min(430px, calc(100% - 28px)); }
.modal::backdrop { background: rgba(3,4,6,.76); backdrop-filter: blur(7px); }
.modal-head { min-height: 78px; padding: 20px 22px; border-bottom: 1px solid var(--border); display: flex; align-items: flex-start; justify-content: space-between; gap: 15px; }
.modal-head h2 { margin: 0; font-size: 18px; font-weight: 600; }
.modal-close { border: 0; background: transparent; color: var(--muted); font-size: 24px; line-height: 1; }
.modal-close:hover { color: var(--text); }
.modal-body { padding: 19px 22px; }
.modal-body > label { display: block; margin-top: 13px; }
.modal-body > label:first-child { margin-top: 0; }
.modal-body .field-grid { margin-top: 13px; }
.selection-preview { margin-top: 9px; padding: 10px 12px; border-left: 2px solid var(--lime); background: var(--lime-dim); color: #9dac88; font: 8px/1.5 var(--mono); }
.modal-actions { min-height: 68px; padding: 13px 22px; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: flex-end; gap: 9px; }
.modal-actions.split { justify-content: space-between; }
.modal-actions.split > div { display: flex; gap: 9px; }
.link-button { box-sizing: border-box; }
.confirm-copy { margin: 0; padding: 23px; color: var(--muted); font-size: 10px; line-height: 1.7; }
.detail-summary { padding: 14px 22px; border-bottom: 1px solid var(--border); display: flex; flex-wrap: wrap; gap: 8px 18px; }
.detail-summary span { color: var(--quiet); font: 8px/1.5 var(--mono); }
.detail-summary b { color: #bac0c9; font-weight: 500; }
.detail-tabs { padding: 0 22px; border-bottom: 1px solid var(--border); display: flex; gap: 20px; }
.detail-tabs button { height: 42px; padding: 0; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--quiet); font-size: 9px; }
.detail-tabs button.active { border-bottom-color: var(--lime); color: var(--text); }
.detail-content { display: none; min-height: 280px; max-height: 420px; overflow: auto; padding: 18px 22px; }
.detail-content.active { display: block; }
.result-view { min-height: 240px; margin: 0; padding: 15px; background: var(--input); color: #c6cad0; white-space: pre-wrap; overflow-wrap: anywhere; font: 9px/1.7 var(--mono); }
.event-line { padding: 8px 0; display: grid; grid-template-columns: 42px 125px minmax(0,1fr); gap: 10px; border-bottom: 1px solid var(--soft-border); font: 8px/1.5 var(--mono); }
.event-line span:first-child { color: #555e69; }
.event-line b { color: var(--blue); font-weight: 500; }
.event-line p { margin: 0; color: #9aa2ad; overflow-wrap: anywhere; }
.run-approval { margin: 10px 0; padding: 12px; border: 1px solid #6d5729; background: #21190c; }
.run-approval b,.run-approval small { display: block; }
.run-approval small { margin-top: 6px; color: #c8b17f; font: 9px/1.6 var(--mono); overflow-wrap: anywhere; }
.run-approval-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.run-approval-actions button { border: 1px solid #59643b; background: #16200e; color: #c9eb8c; padding: 7px 10px; }
.run-approval-actions button.deny { border-color: #6d2e38; background: #281318; color: #f491a0; }
.request-grid { margin: 0; }
.request-grid div { padding: 10px 0; display: grid; grid-template-columns: 110px minmax(0,1fr); border-bottom: 1px solid var(--soft-border); }
.request-grid dt { color: var(--quiet); font-size: 8px; }
.request-grid dd { margin: 0; color: #abb2bc; white-space: pre-wrap; overflow-wrap: anywhere; font: 8px/1.6 var(--mono); }
.artifact-meta { padding: 13px 22px; border-bottom: 1px solid var(--border); color: var(--quiet); font: 8px/1.5 var(--mono); }
#artifact-dialog .result-view { margin: 18px 22px; max-height: 430px; overflow: auto; }
.artifact-content pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.artifact-content img { display: block; max-width: 100%; max-height: 410px; margin: auto; }
.artifact-content video { display: block; width: 100%; max-height: 520px; margin: auto; background: #000; }
.artifact-content audio { display: block; width: 100%; margin: 28px auto; }
.artifact-content iframe { width: 100%; min-height: 410px; border: 0; background: white; }
.toast { position: fixed; z-index: 50; right: 24px; bottom: 24px; max-width: 360px; padding: 12px 15px; background: #eeece5; color: #171a1e; box-shadow: 0 10px 35px rgba(0,0,0,.35); font-size: 10px; opacity: 0; transform: translateY(10px); pointer-events: none; transition: .2s; }
.toast.show { opacity: 1; transform: translateY(0); }
.toast.error { background: #ffc4c7; color: #3b1114; }
.conversation-shell { min-height: 650px; display: grid; grid-template-columns: 310px minmax(0,1fr); border: 1px solid var(--border); background: var(--panel); }
.conversation-list-panel { border-right: 1px solid var(--border); background: #101318; }
.conversation-list-head, .conversation-head { min-height: 82px; padding: 18px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.conversation-list-head h2, .conversation-head h2 { margin: 4px 0 0; font-size: 16px; }
.primary-button.compact { padding: 8px 10px; font-size: 9px; }
.conversation-list { max-height: 566px; overflow: auto; }
.conversation-list-item { width: 100%; padding: 15px 18px; border: 0; border-bottom: 1px solid var(--soft-border); background: transparent; color: var(--text); text-align: left; }
.conversation-list-item:hover, .conversation-list-item.active { background: var(--lime-dim); }
.conversation-list-item.active { box-shadow: inset 2px 0 var(--lime); }
.conversation-list-item b, .conversation-list-item small { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.conversation-list-item b { font-size: 11px; }
.conversation-list-item small { margin-top: 7px; color: var(--quiet); font: 8px/1.3 var(--mono); }
.conversation-main { min-width: 0; display: flex; flex-direction: column; }
.conversation-empty { min-height: 650px; display: grid; place-content: center; text-align: center; color: var(--quiet); }
.conversation-empty b { color: var(--muted); font-size: 15px; }
.conversation-empty p { max-width: 420px; line-height: 1.8; }
#conversation-detail { min-height: 650px; display: flex; flex-direction: column; }
.conversation-head small { display: block; margin-top: 6px; color: var(--quiet); font: 8px/1 var(--mono); }
.conversation-feed { flex: 1; min-height: 420px; max-height: 500px; overflow: auto; padding: 22px; display: flex; flex-direction: column; gap: 13px; }
.message-card { max-width: 82%; padding: 13px 15px; border: 1px solid var(--border); background: #111419; }
.message-card.user { align-self: flex-end; border-color: rgba(184,239,97,.25); background: var(--lime-dim); }
.message-card.assistant { align-self: flex-start; }
.message-card .message-meta { margin-bottom: 8px; color: var(--quiet); font: 8px/1 var(--mono); text-transform: uppercase; }
.message-card pre { margin: 0; color: #d4d7da; white-space: pre-wrap; overflow-wrap: anywhere; font: 10px/1.7 var(--sans); }
.activity-card { margin-right: 9%; padding: 11px 13px; border-left: 2px solid var(--blue); background: rgba(117,169,255,.055); }
.activity-card.thinking { border-left-color: #a58bff; background: rgba(165,139,255,.06); }
.activity-card.approval { border-left-color: var(--amber); background: var(--amber-dim); }
.activity-card.error { border-left-color: var(--red); background: var(--red-dim); }
.activity-card b { display: flex; justify-content: space-between; gap: 12px; font-size: 10px; }
.activity-card b span { color: var(--quiet); font: 8px/1 var(--mono); }
.activity-card pre { max-height: 180px; margin: 8px 0 0; overflow: auto; color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; font: 8px/1.65 var(--mono); }
.approval-note { margin-top: 9px; color: var(--amber); font-size: 9px; }
.approval-actions { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 8px; }
.approval-actions button { min-height: 31px; padding: 7px 10px; }
.conversation-composer { padding: 16px 18px; border-top: 1px solid var(--border); background: #101318; }
.conversation-composer textarea { width: 100%; resize: vertical; }
.conversation-composer > div { margin-top: 10px; display: flex; align-items: center; justify-content: space-between; }
.conversation-composer small { color: var(--quiet); font-size: 8px; }
@media (max-width: 1180px) {
  .agent-grid, .artifact-grid, .engine-grid { grid-template-columns: repeat(2, minmax(240px,1fr)); }
  .settings-layout { grid-template-columns: 1fr; }
  .conversation-shell { grid-template-columns: 260px minmax(0,1fr); }
}
@media (max-width: 1080px) {
  .app-shell { grid-template-columns: 76px minmax(0,1fr); }
  .sidebar { padding: 22px 10px; align-items: center; }
  .brand > span:last-child, .node-chip span, .nav-button b, .nav-button em, .nav-separator, .sidebar-foot { display: none; }
  .brand { padding: 0; }
  .node-chip { padding: 10px; margin: 24px 0 16px; }
  .node-chip i { margin: 0; }
  .sidebar nav { width: 100%; }
  .nav-button { grid-template-columns: 1fr; justify-items: center; padding: 0; }
  .main { padding: 24px 24px 45px; }
  .metric-grid { grid-template-columns: 1fr 1fr; }
  .metric-card:nth-child(2) { border-right: 0; }
  .metric-card:nth-child(-n+2) { border-bottom: 1px solid var(--border); }
  .dashboard-grid { grid-template-columns: 1fr; }
  .span-2, .quick-panel { grid-column: 1; grid-row: auto; }
}
@media (max-width: 680px) {
  .app-shell { display: block; }
  .sidebar { position: sticky; z-index: 20; width: 100%; height: 60px; padding: 9px 12px; flex-direction: row; justify-content: space-between; border-right: 0; border-bottom: 1px solid var(--border); overflow-x: auto; }
  .brand-mark { width: 34px; height: 34px; }
  .node-chip { display: none; }
  .sidebar nav { width: auto; display: flex; }
  .nav-button { width: 42px; height: 40px; flex: 0 0 auto; }
  .main { padding: 18px 14px 40px; }
  .topbar { align-items: flex-start; }
  .topbar > div:first-child > p:last-child, .last-refresh, #global-new-run { display: none; }
  .metric-grid { grid-template-columns: 1fr 1fr; }
  .metric-card { padding: 17px; min-height: 112px; }
  .agent-grid, .artifact-grid, .engine-grid { grid-template-columns: 1fr; }
  .section-toolbar { align-items: stretch; flex-direction: column; }
  .search-box { width: 100%; }
  .toolbar-actions { overflow-x: auto; }
  .field-grid.two { grid-template-columns: 1fr; }
  .modal-actions.split { align-items: stretch; flex-direction: column-reverse; }
  .modal-actions.split > div { display: grid; grid-template-columns: 1fr 1fr; }
  .event-line { grid-template-columns: 36px 95px minmax(0,1fr); }
  .conversation-shell { display: block; }
  .conversation-list-panel { border-right: 0; border-bottom: 1px solid var(--border); }
  .conversation-list { max-height: 210px; }
  .conversation-empty, #conversation-detail { min-height: 560px; }
}`;

export const CONSOLE_JS = `const state = {
  view: "dashboard",
  agents: [],
  conversations: [],
  conversationDetail: null,
  selectedConversationId: null,
  conversationEvents: null,
  runs: [],
  artifacts: [],
  workspaces: [],
  capabilities: { engines: [], core: {} },
  settings: null,
  system: null,
  health: null,
  editingAgentId: null,
  selectedRunId: null,
  selectedArtifactId: null,
  confirmCallback: null,
  settingsDirty: false,
};

const byId = (id) => document.getElementById(id);
const terminalStatuses = new Set(["completed", "failed", "cancelled", "timed_out"]);
const statusLabels = {
  idle: "空闲", running: "运行中", queued: "排队中", cancelling: "停止中",
  responding: "响应中", streaming: "生成中", pending: "待处理", archived: "已归档",
  completed: "已完成", failed: "失败", cancelled: "已取消", timed_out: "超时",
  unavailable: "不可用", disabled: "已停用",
};
const viewMeta = {
  dashboard: ["NODE OVERVIEW", "运行总览", "本地 Agent、引擎和运行状态的实时视图"],
  agents: ["AGENT REGISTRY", "Agents", "配置本机运行的 Agent 身份、引擎、目录与权限"],
  conversations: ["AGENT CONVERSATIONS", "Agent 对话", "直接与本机 Agent 对话，并查看思考、工具调用和审批事件"],
  runs: ["EXECUTION HISTORY", "运行记录", "跟踪任务状态、事件、会话和最终结果"],
  artifacts: ["OUTPUT ARCHIVE", "产出归档", "查看、复制和下载 Agent 的最终输出"],
  workspaces: ["AGENT SPACES", "Agent 专属空间", "查看每个 Agent 真正工作的目录、权限和运行状态"],
  engines: ["ENGINE DIAGNOSTICS", "引擎管理", "检测 Claude Code、Codex 与 OpenClaw 的安装和认证"],
  system: ["SYSTEM SETTINGS", "系统配置", "管理节点并发、安全策略、存储与 Core 目标"],
};

function el(tag, className, textValue) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textValue !== undefined) node.textContent = textValue;
  return node;
}

function clear(node) {
  while (node.firstChild) node.firstChild.remove();
}

function notify(message, kind) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.className = "toast show" + (kind === "error" ? " error" : "");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => {
    toast.className = "toast";
    toast.textContent = "";
  }, 2600);
}

async function json(url, options) {
  const response = await fetch(url, options);
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof body === "object" ? body.message || body.error : body;
    throw new Error(message || "请求失败");
  }
  return body;
}

function formatAge(value) {
  if (!value) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return seconds + " 秒前";
  if (seconds < 3600) return Math.floor(seconds / 60) + " 分钟前";
  if (seconds < 86400) return Math.floor(seconds / 3600) + " 小时前";
  return Math.floor(seconds / 86400) + " 天前";
}

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
}

function formatDuration(run) {
  if (!run.startedAt) return "—";
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(run.startedAt).getTime()) / 1000));
  if (seconds < 60) return seconds + "s";
  return Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return value.toFixed(unit < 2 ? 0 : 1) + " " + units[unit];
}

function shortId(value, length) {
  return value ? value.slice(0, length || 8) : "—";
}

function engineLabel(value) {
  if (value === "claude-code") return "Claude Code";
  if (value === "codex") return "Codex";
  return "OpenClaw";
}

function workspaceLabel(value) {
  return {
    persistent: "持续保留",
    "per-run": "每次运行新建",
    "shared-readonly": "共享只读",
    "exclusive-local": "本地独占",
    "persistent-worktree": "持久 Worktree",
    "ephemeral-worktree": "临时 Worktree",
    scratch: "空白临时空间",
  }[value] || value;
}

function accessLabel(value) {
  return value === "read-only" ? "只读" : "允许写入";
}

function coreLabel(value) {
  return {
    standalone: "Core 未启用",
    pending: "等待注册",
    registered: "已注册",
    syncing: "同步中",
    rejected: "注册被拒绝",
    error: "注册异常",
  }[value] || value;
}

function coreRegistrationNode(registration) {
  const status = registration?.status || "standalone";
  return el("span", "core-registration " + status, coreLabel(status));
}

function coreRegistrationDetail(registration) {
  const status = registration?.status || "standalone";
  if (registration?.coreAgentId) return registration.coreAgentId;
  if (registration?.error) return registration.error;
  if (status === "standalone") return "仅在本机运行";
  if (status === "registered") return "已同步到 Hibro Core";
  if (status === "syncing") return "正在同步 Agent 配置";
  return "尚无 Core 注册信息";
}

function agentRuntime(agentId) {
  return state.agents.find((item) => item.agent.id === agentId);
}

function statusNode(status) {
  return el("span", "state " + status, statusLabels[status] || status);
}

function setView(view) {
  if (!viewMeta[view]) return;
  state.view = view;
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.viewPanel === view);
  });
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  const meta = viewMeta[view];
  byId("view-eyebrow").textContent = meta[0];
  byId("view-title").textContent = meta[1];
  byId("view-subtitle").textContent = meta[2];
  history.replaceState(null, "", "#/" + view);
  byId("global-new-run").textContent = view === "conversations" ? "＋ 新建对话" : "＋ 发起运行";
  window.scrollTo({ top: 0, behavior: "auto" });
}

function openDialog(id) {
  const dialog = byId(id);
  if (!dialog.open) dialog.showModal();
}

function closeDialog(id) {
  const dialog = byId(id);
  if (dialog.open) dialog.close();
}

function renderNavigation() {
  byId("nav-agent-count").textContent = String(state.agents.length);
  byId("nav-conversation-count").textContent = String(state.conversations.length);
  byId("nav-run-count").textContent = String(state.runs.length);
  byId("nav-artifact-count").textContent = String(state.artifacts.length);
  const managed = state.capabilities.engines;
  const ready = managed.filter((engine) => engine.available).length;
  byId("nav-engine-count").textContent = ready + "/" + managed.length;
  byId("core-mode").textContent = state.capabilities.core?.mode?.toUpperCase() || "STANDALONE";
}

function renderBanner() {
  const unavailable = state.capabilities.engines.filter((engine) => !engine.available);
  const banner = byId("system-banner");
  if (unavailable.length) {
    banner.hidden = false;
    byId("system-banner-copy").textContent = unavailable.map((engine) => engineLabel(engine.id)).join("、") + " 当前不可用，相关 Agent 无法运行。";
  } else {
    banner.hidden = true;
  }
}

function renderMetrics() {
  const availableAgents = state.agents.filter((item) => item.engineAvailable && item.agent.enabled).length;
  const active = state.runs.filter((run) => !terminalStatuses.has(run.status)).length;
  const terminal = state.runs.filter((run) => terminalStatuses.has(run.status));
  const completed = terminal.filter((run) => run.status === "completed").length;
  const managedEngines = state.capabilities.engines;
  const readyEngines = managedEngines.filter((engine) => engine.available).length;
  byId("metric-agents").textContent = String(state.agents.length).padStart(2, "0");
  byId("metric-agent-sub").textContent = availableAgents + " 个可用";
  byId("metric-active").textContent = String(active).padStart(2, "0");
  byId("metric-success").textContent = terminal.length ? Math.round(completed / terminal.length * 100) + "%" : "—";
  byId("metric-run-sub").textContent = terminal.length ? terminal.length + " 次已结束" : "暂无运行";
  byId("metric-engines").textContent = readyEngines + "/" + managedEngines.length;
  byId("metric-engine-sub").textContent = readyEngines === managedEngines.length ? "全部可用" : "需要检查";
}

function renderDashboardAgents() {
  const container = byId("dashboard-agents");
  clear(container);
  for (const runtime of state.agents.slice(0, 4)) {
    const row = el("div", "compact-agent");
    row.append(el("span", "mini-avatar", runtime.agent.engine === "claude-code" ? "C" : runtime.agent.engine === "codex" ? "X" : "O"));
    const copy = el("div");
    copy.append(
      el("b", "", runtime.agent.name),
      el("small", "", engineLabel(runtime.agent.engine) + " · " + workspaceLabel(runtime.agent.workspace.strategy) + " · " + coreLabel(runtime.coreRegistration?.status)),
    );
    const runCount = state.runs.filter((run) => run.agentId === runtime.agent.id).length;
    row.append(copy, el("small", "", runCount + " RUNS"), statusNode(runtime.status));
    container.append(row);
  }
  if (!state.agents.length) container.append(el("div", "empty-state", "尚未配置 Agent"));
}

function renderDashboardEngines() {
  const container = byId("dashboard-engines");
  clear(container);
  for (const engine of state.capabilities.engines) {
    const row = el("div", "engine-health-row");
    const copy = el("div");
    copy.append(el("b", "", engineLabel(engine.id)), el("small", "", engine.version || engine.error || "未检测"));
    row.append(copy, statusNode(engine.available ? "idle" : "unavailable"));
    container.append(row);
  }
}

function appendRunRow(container, run, compact) {
  const runtime = agentRuntime(run.agentId);
  const row = document.createElement("tr");
  row.dataset.runId = run.id;
  const prompt = document.createElement("td");
  prompt.append(el("span", "cell-title", run.request?.prompt || "未命名运行"), el("span", "cell-sub", shortId(run.id) + (run.sessionId ? " · session " + shortId(run.sessionId) : "")));
  if (compact) {
    const agent = document.createElement("td");
    agent.textContent = runtime?.agent.name || run.agentId || "历史运行";
    const status = document.createElement("td");
    status.append(statusNode(run.status));
    const engine = document.createElement("td");
    engine.textContent = engineLabel(run.engine);
    const duration = document.createElement("td");
    duration.textContent = formatDuration(run);
    const updated = document.createElement("td");
    updated.textContent = formatAge(run.updatedAt);
    row.append(prompt, status, engine, duration, updated);
  } else {
    const agent = document.createElement("td");
    agent.append(el("span", "cell-title", runtime?.agent.name || run.agentId || "历史运行"), el("span", "cell-sub", engineLabel(run.engine)));
    const status = document.createElement("td");
    status.append(statusNode(run.status));
    const workspace = document.createElement("td");
    workspace.append(
      el("span", "cell-title", workspaceLabel(run.workspace?.strategy || run.workspace?.mode || "—")),
      el("span", "cell-sub", run.workspace?.path || run.request?.workspace || "—"),
    );
    const duration = document.createElement("td");
    duration.textContent = formatDuration(run);
    const created = document.createElement("td");
    created.textContent = formatDate(run.createdAt);
    const action = document.createElement("td");
    const menu = el("button", "row-menu", "···");
    menu.type = "button";
    menu.setAttribute("aria-label", "查看运行 " + shortId(run.id));
    menu.addEventListener("click", (event) => { event.stopPropagation(); openRunDetail(run.id); });
    action.append(menu);
    row.append(prompt, agent, status, workspace, duration, created, action);
  }
  row.addEventListener("click", () => openRunDetail(run.id));
  container.append(row);
}

function renderDashboardRuns() {
  const body = byId("dashboard-runs");
  clear(body);
  state.runs.slice(0, 6).forEach((run) => appendRunRow(body, run, true));
  byId("dashboard-runs-empty").hidden = state.runs.length > 0;
}

function filteredAgents() {
  const query = byId("agent-search").value.trim().toLowerCase();
  const engine = byId("agent-engine-filter").value;
  return state.agents.filter((runtime) => {
    const agent = runtime.agent;
    const haystack = [agent.name, agent.id, agent.engine, agent.source?.path || "", runtime.paths?.workspace || "", agent.description || ""].join(" ").toLowerCase();
    return (!query || haystack.includes(query)) && (!engine || agent.engine === engine);
  });
}

function renderAgents() {
  const grid = byId("agent-grid");
  clear(grid);
  const agents = filteredAgents();
  for (const runtime of agents) {
    const agent = runtime.agent;
    const card = el("article", "agent-card");
    card.dataset.agentId = agent.id;
    const head = el("div", "agent-card-head");
    head.append(el("span", "mini-avatar", agent.engine === "claude-code" ? "C" : agent.engine === "codex" ? "X" : "O"));
    const name = el("div");
    name.append(el("h3", "", agent.name), el("p", "", agent.id));
    head.append(name, statusNode(runtime.status));
    card.append(head, el("p", "agent-description", agent.description || "未填写 Agent 描述"));
    const tags = el("div", "tag-list");
    [engineLabel(agent.engine), workspaceLabel(agent.workspace.strategy), accessLabel(agent.workspace.access), "并发 " + agent.maxConcurrency, agent.model || "默认模型"].forEach((value) => tags.append(el("span", "tag", value)));
    card.append(
      tags,
      el("code", "agent-path", agent.source?.path
        ? "默认项目（只用于创建工作副本）  " + agent.source.path
        : "默认项目  未配置 · 使用空白专属空间"),
      el("code", "agent-path", "Agent 专属空间（实际工作位置）  " + runtime.paths.workspace),
    );
    const coreRow = el("div", "agent-core-row");
    coreRow.append(coreRegistrationNode(runtime.coreRegistration), el("small", "", coreRegistrationDetail(runtime.coreRegistration)));
    card.append(coreRow);
    const foot = el("div", "agent-card-foot");
    foot.append(el("small", "", runtime.lastRunAt ? "最近 " + formatAge(runtime.lastRunAt) : "尚未运行"));
    const actions = el("div");
    const edit = el("button", "small-button", "配置");
    edit.type = "button";
    edit.addEventListener("click", () => openAgentDialog(agent.id));
    const run = el("button", "small-button accent", "运行 →");
    run.type = "button";
    run.disabled = runtime.status === "unavailable" || runtime.status === "disabled";
    run.addEventListener("click", () => openRunDialog(agent.id));
    actions.append(edit, run);
    foot.append(actions);
    card.append(foot);
    grid.append(card);
  }
  byId("agents-empty").hidden = agents.length > 0;
}

function renderConversations() {
  const list = byId("conversation-list");
  clear(list);
  for (const conversation of state.conversations) {
    const runtime = agentRuntime(conversation.agentId);
    const button = el("button", "conversation-list-item" + (conversation.id === state.selectedConversationId ? " active" : ""));
    button.type = "button";
    button.append(
      el("b", "", conversation.title),
      el("small", "", (runtime?.agent.name || conversation.agentId) + " · " + engineLabel(conversation.engine) + " · " + (statusLabels[conversation.status] || conversation.status)),
      el("small", "", conversation.lastMessageAt ? formatAge(conversation.lastMessageAt) : "尚无消息"),
    );
    button.addEventListener("click", () => openConversation(conversation.id));
    list.append(button);
  }
  if (!state.conversations.length) {
    const empty = el("div", "empty-state");
    empty.append(el("b", "", "还没有对话"), el("p", "", "创建后即可直接向本地 Agent 发送消息。"));
    list.append(empty);
  }
  const detail = state.conversationDetail;
  byId("conversation-empty").hidden = Boolean(detail);
  byId("conversation-detail").hidden = !detail;
  if (!detail) return;
  const conversation = detail.conversation;
  const runtime = agentRuntime(conversation.agentId);
  byId("conversation-engine").textContent = engineLabel(conversation.engine) + " · " + (runtime?.agent.name || conversation.agentId);
  byId("conversation-title").textContent = conversation.title;
  byId("conversation-status").textContent = (statusLabels[conversation.status] || conversation.status) + (conversation.engineSessionId ? " · session " + shortId(conversation.engineSessionId) : "");
  byId("cancel-conversation").hidden = !conversation.activeRunId;
  byId("conversation-input").disabled = Boolean(conversation.activeRunId) || conversation.status === "archived";
  byId("send-conversation").disabled = Boolean(conversation.activeRunId) || conversation.status === "archived";
  const feed = byId("conversation-feed");
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90;
  clear(feed);
  const timeline = [
    ...(detail.messages || []).map((value) => ({kind:"message", at:value.createdAt, value})),
    ...(detail.activities || []).map((value) => ({kind:"activity", at:value.createdAt, value})),
  ].sort((a,b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  for (const item of timeline) {
    if (item.kind === "message") {
      const message = item.value;
      const card = el("article", "message-card " + message.role);
      card.append(el("div", "message-meta", (message.role === "user" ? "你" : message.role === "assistant" ? "Agent" : message.role) + " · " + (statusLabels[message.status] || message.status)));
      card.append(el("pre", "", message.content || (message.status === "queued" ? "等待 Agent…" : "正在生成…")));
      if (message.error) card.append(el("div", "approval-note", message.error));
      feed.append(card);
    } else {
      const activity = item.value;
      const card = el("article", "activity-card " + activity.type);
      const title = el("b");
      title.append(document.createTextNode(activity.title), el("span", "", activity.type + " · " + activity.status));
      card.append(title);
      if (activity.detail) card.append(el("pre", "", activity.detail));
      if (activity.type === "approval") {
        if (activity.status === "pending" && activity.approval?.resolvable) {
          card.append(el("div", "approval-note", "等待你的决定"));
          const actions = el("div", "approval-actions");
          for (const [decision, label, className] of [
            ["allow_once", "仅本次允许", "small-button accent"],
            ["allow_always", "本会话允许", "small-button"],
            ["deny", "拒绝", "small-button danger-button"],
          ]) {
            if (!activity.approval.decisions.includes(decision)) continue;
            const button = el("button", className, label);
            button.type = "button";
            button.addEventListener("click", () => decideConversationApproval(activity.id, decision));
            actions.append(button);
          }
          card.append(actions);
        } else if (activity.approval?.decision) {
          card.append(el("div", "approval-note", "已决定：" + activity.approval.decision));
        } else {
          card.append(el("div", "approval-note", activity.approval?.reason || "该审批项当前为只读"));
        }
      }
      feed.append(card);
    }
  }
  if (!timeline.length) {
    feed.append(el("div", "empty-state", "发送第一条消息开始对话"));
  }
  if (nearBottom || !feed.dataset.rendered) {
    feed.scrollTop = feed.scrollHeight;
  }
  feed.dataset.rendered = "true";
}

async function openConversation(id) {
  state.selectedConversationId = id;
  await loadConversation();
  connectConversationEvents(id);
  setView("conversations");
}

async function loadConversation(showError = true) {
  if (!state.selectedConversationId) return;
  try {
    state.conversationDetail = await json("/v1/conversations/" + encodeURIComponent(state.selectedConversationId));
    renderConversations();
  } catch (error) {
    if (showError) notify(error.message, "error");
  }
}

function connectConversationEvents(id) {
  state.conversationEvents?.close();
  const source = new EventSource("/v1/conversations/" + encodeURIComponent(id) + "/events");
  state.conversationEvents = source;
  source.addEventListener("conversation-event", () => {
    if (state.selectedConversationId === id) void loadConversation(false);
  });
}

function openConversationDialog() {
  const select = byId("conversation-agent");
  clear(select);
  state.agents.filter((runtime) => runtime.agent.enabled && runtime.engineAvailable).forEach((runtime) => {
    const option = document.createElement("option");
    option.value = runtime.agent.id;
    option.textContent = runtime.agent.name + " · " + engineLabel(runtime.agent.engine);
    select.append(option);
  });
  byId("conversation-new-title").value = "";
  openDialog("conversation-dialog");
}

async function createConversation(event) {
  event.preventDefault();
  try {
    const detail = await json("/v1/conversations", {
      method: "POST",
      headers: {"content-type":"application/json"},
      body: JSON.stringify({
        agentId: byId("conversation-agent").value,
        title: byId("conversation-new-title").value.trim() || undefined,
      }),
    });
    closeDialog("conversation-dialog");
    state.selectedConversationId = detail.conversation.id;
    state.conversationDetail = detail;
    notify("对话已创建");
    await refresh({quiet:true});
    connectConversationEvents(detail.conversation.id);
    setView("conversations");
  } catch (error) {
    notify(error.message, "error");
  }
}

async function sendConversation(event) {
  event.preventDefault();
  const content = byId("conversation-input").value.trim();
  if (!content || !state.selectedConversationId) return;
  const button = byId("send-conversation");
  button.disabled = true;
  try {
    state.conversationDetail = await json("/v1/conversations/" + encodeURIComponent(state.selectedConversationId) + "/messages", {
      method: "POST",
      headers: {"content-type":"application/json"},
      body: JSON.stringify({content}),
    });
    byId("conversation-input").value = "";
    renderConversations();
    await refresh({quiet:true});
  } catch (error) {
    notify(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function decideConversationApproval(activityId, decision) {
  if (!state.selectedConversationId) return;
  try {
    state.conversationDetail = await json(
      "/v1/conversations/" + encodeURIComponent(state.selectedConversationId) +
        "/approval/" + encodeURIComponent(activityId),
      {
        method: "POST",
        headers: {"content-type":"application/json"},
        body: JSON.stringify({decision}),
      },
    );
    renderConversations();
    notify(decision === "deny" ? "已拒绝操作" : "审批已通过");
  } catch (error) {
    notify(error.message, "error");
  }
}

function syncRunAgentFilter() {
  const filter = byId("run-agent-filter");
  const previous = filter.value;
  clear(filter);
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "全部 Agent";
  filter.append(all);
  for (const runtime of state.agents) {
    const option = document.createElement("option");
    option.value = runtime.agent.id;
    option.textContent = runtime.agent.name;
    filter.append(option);
  }
  if ([...filter.options].some((option) => option.value === previous)) filter.value = previous;
}

function filteredRuns() {
  const query = byId("run-search").value.trim().toLowerCase();
  const agentId = byId("run-agent-filter").value;
  const status = byId("run-status-filter").value;
  return state.runs.filter((run) => {
    const haystack = [run.id, run.sessionId || "", run.request?.prompt || "", run.agentId || ""].join(" ").toLowerCase();
    return (!query || haystack.includes(query)) && (!agentId || run.agentId === agentId) && (!status || run.status === status);
  });
}

function renderRuns() {
  syncRunAgentFilter();
  const body = byId("runs-body");
  clear(body);
  const runs = filteredRuns();
  runs.forEach((run) => appendRunRow(body, run, false));
  byId("runs-empty").hidden = runs.length > 0;
}

function filteredArtifacts() {
  const query = byId("artifact-search").value.trim().toLowerCase();
  return state.artifacts.filter((artifact) => {
    const runtime = agentRuntime(artifact.agentId);
    return !query || [artifact.title, artifact.content, runtime?.agent.name || "", artifact.engine].join(" ").toLowerCase().includes(query);
  });
}

function artifactSyncLabel(artifact) {
  return {
    local_only: "仅本地",
    pending: "待同步",
    uploading: "同步中",
    synced: "已同步",
    failed: "同步失败",
  }[artifact.sync?.status] || "仅本地";
}

function renderArtifacts() {
  const grid = byId("artifact-grid");
  clear(grid);
  const artifacts = filteredArtifacts();
  for (const artifact of artifacts) {
    const card = el("article", "artifact-card");
    card.dataset.artifactId = artifact.id;
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", "查看产出 " + artifact.title);
    const top = el("div", "artifact-card-top");
    const sync = el(
      "span",
      "artifact-sync " + (artifact.sync?.status || "local_only"),
      artifactSyncLabel(artifact),
    );
    if (artifact.sync?.error) sync.title = artifact.sync.error;
    top.append(
      el("span", "", engineLabel(artifact.engine).toUpperCase()),
      sync,
      el("time", "", formatDate(artifact.createdAt)),
    );
    const runtime = agentRuntime(artifact.agentId);
    const foot = el("div", "artifact-card-foot");
    foot.append(el("span", "", runtime?.agent.name || artifact.agentId || "历史运行"), el("span", "", shortId(artifact.runId)));
    card.append(
      top,
      el("h3", "", artifact.title),
      el(
        "div",
        "artifact-preview",
        artifact.content ??
          ((artifact.previewKind || "文件") + " · " + formatBytes(artifact.sizeBytes)),
      ),
      foot,
    );
    card.addEventListener("click", () => openArtifact(artifact.id));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openArtifact(artifact.id);
      }
    });
    grid.append(card);
  }
  byId("artifacts-empty").hidden = artifacts.length > 0;
}

function renderWorkspaces() {
  const body = byId("workspaces-body");
  clear(body);
  for (const workspace of state.workspaces) {
    const row = document.createElement("tr");
    const agent = document.createElement("td");
    agent.append(el("span", "cell-title", workspace.agentName), el("span", "cell-sub", workspace.agentId));
    const source = document.createElement("td");
    source.append(
      el("span", "cell-title", workspace.sourcePath || "未配置"),
      el("span", "cell-sub", workspace.sourcePath ? "只用于创建工作副本" : "默认使用空白专属空间"),
    );
    const mode = document.createElement("td");
    mode.textContent = workspaceLabel(workspace.strategy);
    const path = document.createElement("td");
    path.append(
      el("span", "cell-title", workspace.path),
      el("span", "cell-sub", "实际工作位置 · Agent Home " + workspace.metadataPath),
    );
    const permission = document.createElement("td");
    permission.textContent = accessLabel(workspace.access);
    const leases = document.createElement("td");
    leases.append(statusNode(workspace.activeRunIds.length ? "running" : "idle"), el("span", "cell-sub", workspace.activeRunIds.length + " 个活动 Run"));
    const last = document.createElement("td");
    last.textContent = workspace.lastRunAt ? formatAge(workspace.lastRunAt) : "从未";
    row.append(agent, source, mode, path, permission, leases, last);
    body.append(row);
  }
}

function renderEngines() {
  const grid = byId("engine-grid");
  clear(grid);
  for (const engine of state.capabilities.engines) {
    const card = el("article", "engine-card");
    card.dataset.engineId = engine.id;
    const head = el("div", "engine-card-head");
    head.append(el("span", "engine-logo", engine.id === "claude-code" ? "C" : engine.id === "codex" ? "X" : "O"));
    const title = el("div");
    title.append(el("h3", "", engineLabel(engine.id)), statusNode(engine.available ? "idle" : "unavailable"));
    head.append(title);
    const list = document.createElement("dl");
    [["版本", engine.version || "—"], ["可执行文件", engine.executable || "—"], ["安装", engine.installed ? "已安装" : "未安装"], ["认证", engine.loggedIn === undefined ? "不适用" : engine.loggedIn ? "已认证" : "未认证"], ["认证方式", engine.authMethod || engine.credentialSource || "—"]].forEach((pair) => {
      const row = document.createElement("div");
      row.append(el("dt", "", pair[0]), el("dd", "", pair[1]));
      list.append(row);
    });
    card.append(head, list);
    if (engine.error) card.append(el("p", "engine-error", engine.error));
    grid.append(card);
  }
}

function renderSystem() {
  if (state.settings && !state.settingsDirty) {
    byId("setting-node-name").value = state.settings.nodeName;
    byId("setting-max-concurrency").value = String(state.settings.maxConcurrentRuns);
    byId("setting-timeout").value = String(Math.round(state.settings.defaultTimeoutMs / 1000));
    byId("setting-retention").value = String(state.settings.eventRetentionDays);
    byId("setting-auto-resume").checked = state.settings.autoResumeSessions;
    byId("setting-dangerous").checked = state.settings.allowDangerousSandbox;
    byId("setting-core-enabled").checked = state.settings.coreEnabled;
    byId("setting-core-url").value = state.settings.coreUrl || "";
    byId("setting-core-token").value = state.settings.coreToken || "";
    byId("core-token-status").textContent = state.settings.coreTokenConfigured
      ? "已完成 Core 注册，Node 专用凭据已自动保存；无需再次输入。"
      : "尚未注册。请先在 Core 中生成一次性注册码。";
    byId("settings-save-state").textContent = "已同步";
    byId("settings-save-state").className = "save-state";
  }
  const core = state.capabilities?.core;
  byId("core-connection-hint").textContent = !core?.enabled
    ? "Core 未启用。"
    : core.connected
      ? "已连接 Hibro Core，Agent 注册与远程运行通道正常。"
      : "正在连接 Hibro Core" + (core.error ? "：" + core.error : "…");
  if (!state.system) return;
  const system = state.system;
  const diagnostics = [
    ["运行环境", system.container ? "Docker Container" : "Host Process"],
    ["主机", system.hostname],
    ["平台", system.platform + " " + system.arch + " · " + system.release],
    ["Node.js", system.nodeVersion],
    ["进程", "PID " + system.pid + " · uptime " + Math.floor(system.uptimeSeconds) + "s"],
    ["运行数据", system.storage?.engine === "sqlite" ? "SQLite · " + system.storage.databasePath : "Filesystem JSON"],
    ["工作目录", system.cwd],
    ["活动运行", String(system.activeRuns)],
  ];
  const list = byId("diagnostic-list");
  clear(list);
  diagnostics.forEach((pair) => {
    const row = document.createElement("div");
    row.append(el("dt", "", pair[0]), el("dd", "", pair[1]));
    list.append(row);
  });
  const memoryUsed = system.memory.totalBytes - system.memory.freeBytes;
  const diskUsed = system.disk.totalBytes - system.disk.freeBytes;
  byId("memory-label").textContent = formatBytes(system.memory.freeBytes) + " / " + formatBytes(system.memory.totalBytes);
  byId("memory-progress").style.width = Math.min(100, memoryUsed / system.memory.totalBytes * 100) + "%";
  byId("disk-label").textContent = formatBytes(system.disk.freeBytes) + " / " + formatBytes(system.disk.totalBytes);
  byId("disk-progress").style.width = Math.min(100, diskUsed / system.disk.totalBytes * 100) + "%";
  byId("data-directory").textContent = system.dataDir;
  byId("hibro-version").textContent =
    "Hibro Node " + (system.hibroVersion || "");
}

function renderAll() {
  byId("sidebar-node-name").textContent = state.health?.nodeName || "LOCAL NODE";
  byId("sidebar-host").textContent = state.health?.hostname || "连接中…";
  renderNavigation();
  renderBanner();
  renderMetrics();
  renderDashboardAgents();
  renderDashboardEngines();
  renderDashboardRuns();
  renderAgents();
  renderConversations();
  renderRuns();
  renderArtifacts();
  renderWorkspaces();
  renderEngines();
  renderSystem();
}

async function refresh(options) {
  const quiet = options?.quiet === true;
  if (!quiet) byId("refresh-button").classList.add("spinning");
  try {
    const [health, capabilities, agents, conversations, runs, artifacts, workspaces, settings, system] = await Promise.all([
      json("/health"), json("/v1/capabilities"), json("/v1/agents"), json("/v1/conversations"),
      json("/v1/runs"), json("/v1/artifacts"), json("/v1/workspaces"), json("/v1/settings"), json("/v1/system"),
    ]);
    state.health = health;
    state.capabilities = capabilities;
    state.agents = agents.agents || [];
    state.conversations = conversations.conversations || [];
    state.runs = runs.runs || [];
    state.artifacts = artifacts.artifacts || [];
    state.workspaces = workspaces.workspaces || [];
    state.settings = settings;
    state.system = system;
    renderAll();
    byId("last-refresh").textContent = "更新于 " + new Intl.DateTimeFormat("zh-CN", {hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(new Date());
  } catch (error) {
    notify(error.message, "error");
  } finally {
    byId("refresh-button").classList.remove("spinning");
  }
}

function syncRunAgentSelect(selectedId) {
  const select = byId("run-agent");
  clear(select);
  for (const runtime of state.agents) {
    const option = document.createElement("option");
    option.value = runtime.agent.id;
    option.textContent = runtime.agent.name + " · " + engineLabel(runtime.agent.engine);
    option.disabled = !runtime.agent.enabled || !runtime.engineAvailable;
    select.append(option);
  }
  if (selectedId && [...select.options].some((option) => option.value === selectedId && !option.disabled)) {
    select.value = selectedId;
  }
  updateRunPreview();
}

function updateRunPreview() {
  const runtime = agentRuntime(byId("run-agent").value);
  if (!runtime) {
    byId("run-agent-preview").textContent = "没有可用 Agent，请先完成 Agent 与引擎配置。";
    return;
  }
  const sandboxSelect = byId("run-sandbox");
  const writable = runtime.agent.workspace.access === "workspace-write";
  const dangerous =
    writable &&
    runtime.agent.allowDangerousSandbox === true &&
    state.settings?.allowDangerousSandbox === true;
  [...sandboxSelect.options].forEach((option) => {
    option.disabled =
      (option.value === "workspace-write" && !writable) ||
      (option.value === "danger-full-access" && !dangerous);
  });
  if (sandboxSelect.selectedOptions[0]?.disabled) sandboxSelect.value = "";
  byId("run-agent-preview").textContent =
    engineLabel(runtime.agent.engine) + " · " +
    workspaceLabel(runtime.agent.workspace.strategy) + " · " +
    accessLabel(runtime.agent.workspace.access) + " · " +
    runtime.paths.workspace;
}

function openRunDialog(agentId, prompt) {
  byId("run-form").reset();
  syncRunAgentSelect(agentId);
  if (prompt) byId("run-prompt").value = prompt;
  openDialog("run-dialog");
  setTimeout(() => byId("run-prompt").focus(), 30);
}

function openAgentDialog(agentId) {
  state.editingAgentId = agentId || null;
  byId("agent-form").reset();
  byId("agent-enabled").checked = true;
  byId("agent-dangerous").checked = false;
  byId("agent-concurrency").value = "1";
  const runtime = agentRuntime(agentId);
  const agent = runtime?.agent;
  byId("agent-dialog-title").textContent = agent ? "编辑 " + agent.name : "新建 Agent";
  byId("agent-generated-id").hidden = !agent;
  byId("agent-id-value").textContent = agent?.id || "";
  byId("delete-agent").hidden = !agent;
  if (agent) {
    byId("agent-name").value = agent.name;
    byId("agent-description").value = agent.description || "";
    byId("agent-engine").value = agent.engine;
    byId("agent-model").value = agent.model || "";
    byId("agent-source-path").value = agent.source?.path || "";
    byId("agent-workspace-strategy").value = agent.workspace.strategy;
    byId("agent-workspace-access").value = agent.workspace.access;
    byId("agent-concurrency").value = String(agent.maxConcurrency);
    byId("agent-instructions").value = agent.instructions || "";
    byId("agent-tools").value = (agent.allowedTools || []).join(", ");
    byId("agent-enabled").checked = agent.enabled;
    byId("agent-dangerous").checked = agent.allowDangerousSandbox === true;
  } else {
    byId("agent-source-path").value = "";
    byId("agent-workspace-strategy").value = "persistent";
    byId("agent-workspace-access").value =
      byId("agent-engine").value === "claude-code" ? "read-only" : "workspace-write";
  }
  updateAgentWorkspacePreview();
  openDialog("agent-dialog");
}

function updateAgentWorkspacePreview() {
  const runtime = agentRuntime(state.editingAgentId);
  const strategy = byId("agent-workspace-strategy").value;
  const workspacePath = runtime?.paths.workspace;
  const root = workspacePath?.endsWith("/workspace")
    ? workspacePath.slice(0, -10)
    : (state.system?.dataDir || "~/.hibro") + "/agents/<系统生成 ID>";
  const path = strategy === "persistent"
    ? root + "/workspace"
    : strategy === "per-run"
      ? root + "/runs/<run-id>/workspace"
      : root + "/runs/<run-id>/scratch";
  byId("agent-workspace-preview").textContent =
    "Agent 实际工作位置：" + path + " · " + accessLabel(byId("agent-workspace-access").value) +
    (byId("agent-source-path").value.trim()
      ? "。默认项目只用于创建这个工作副本。"
      : "。未配置默认项目，将使用空白空间。");
}

function eventDescription(event) {
  const payload = event.payload || {};
  if (typeof payload.result === "string") return payload.result;
  if (payload.error?.message) return payload.error.message;
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.status === "string") return payload.status;
  if (payload.sessionId) return "session " + payload.sessionId;
  if (payload.event?.type) return payload.event.type;
  return JSON.stringify(payload).slice(0, 400);
}

async function openRunDetail(runId) {
  const run = state.runs.find((item) => item.id === runId);
  if (!run) return;
  state.selectedRunId = runId;
  const runtime = agentRuntime(run.agentId);
  byId("detail-title").textContent = shortId(run.id) + " · " + (runtime?.agent.name || engineLabel(run.engine));
  const summary = byId("detail-summary");
  clear(summary);
  [["状态", statusLabels[run.status] || run.status], ["引擎", engineLabel(run.engine)], ["耗时", formatDuration(run)], ["会话", run.sessionId || "—"], ["实际工作位置", run.workspace?.path || run.request?.workspace || "—"]].forEach((pair) => {
    const item = el("span");
    item.append(el("b", "", pair[0] + " "), document.createTextNode(pair[1]));
    summary.append(item);
  });
  const result = byId("detail-result");
  clear(result);
  result.append(el("pre", "result-view", run.result || run.error?.message || (terminalStatuses.has(run.status) ? "没有最终输出" : "Agent 正在运行，完成后会显示结果。")));
  const request = byId("detail-request");
  clear(request);
  const requestList = el("dl", "request-grid");
  [["Prompt", run.request?.prompt || ""], ["Agent ID", run.agentId || "—"], ["Run ID", run.id], ["Session Key", run.request?.sessionKey || "default"], ["Options", JSON.stringify(run.request?.options || {}, null, 2)], ["Metadata", JSON.stringify(run.request?.metadata || {}, null, 2)]].forEach((pair) => {
    const row = document.createElement("div");
    row.append(el("dt", "", pair[0]), el("dd", "", pair[1]));
    requestList.append(row);
  });
  request.append(requestList);
  const eventContainer = byId("detail-events");
  clear(eventContainer);
  eventContainer.append(el("p", "toolbar-note", "正在加载事件…"));
  byId("detail-cancel").hidden = terminalStatuses.has(run.status);
  byId("detail-download").hidden = !(run.status === "completed" && run.result);
  byId("detail-download").href = "/v1/artifacts/" + run.id + "/download";
  document.querySelectorAll("[data-detail-tab]").forEach((button) => button.classList.toggle("active", button.dataset.detailTab === "result"));
  document.querySelectorAll(".detail-content").forEach((panel) => panel.classList.toggle("active", panel.id === "detail-result"));
  openDialog("run-detail-dialog");
  try {
    const history = await json("/v1/runs/" + runId + "/events?format=json");
    clear(eventContainer);
    const resolvedApprovals = new Set(
      (history.events || [])
        .filter((event) => event.type === "engine.approval.resolved")
        .map((event) => event.payload?.externalId),
    );
    for (const event of history.events || []) {
      if (event.type !== "engine.approval.requested") continue;
      const approval = event.payload?.request || event.payload || {};
      if (!approval.externalId || resolvedApprovals.has(approval.externalId)) continue;
      const card = el("div", "run-approval");
      card.append(
        el("b", "", approval.title || "Agent 等待审批"),
        el("small", "", approval.detail || approval.command || "受控操作"),
      );
      const actions = el("div", "run-approval-actions");
      [["allow_once", "仅本次允许"], ["allow_always", "本会话允许"], ["deny", "拒绝"]].forEach(([decision, label]) => {
        const button = el("button", decision === "deny" ? "deny" : "", label);
        button.type = "button";
        button.addEventListener("click", () =>
          decideRunApproval(runId, approval.externalId, decision),
        );
        actions.append(button);
      });
      card.append(actions);
      eventContainer.append(card);
    }
    for (const event of history.events || []) {
      const row = el("div", "event-line");
      row.append(el("span", "", "#" + String(event.sequence).padStart(3, "0")), el("b", "", event.type), el("p", "", eventDescription(event)));
      eventContainer.append(row);
    }
    if (!history.events?.length) eventContainer.append(el("p", "toolbar-note", "没有事件记录"));
  } catch (error) {
    clear(eventContainer);
    eventContainer.append(el("p", "engine-error", error.message));
  }
}

async function decideRunApproval(runId, externalId, decision) {
  try {
    await json(
      "/v1/runs/" + runId + "/approval/" + encodeURIComponent(externalId),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      },
    );
    notify(decision === "deny" ? "已拒绝操作" : "审批已通过，Agent 将继续");
    await refresh();
    await openRunDetail(runId);
  } catch (error) {
    notify(error.message, "error");
  }
}

async function openArtifact(artifactId) {
  const artifact = state.artifacts.find((item) => item.id === artifactId);
  if (!artifact) return;
  state.selectedArtifactId = artifactId;
  const runtime = agentRuntime(artifact.agentId);
  byId("artifact-title").textContent = artifact.title;
  byId("artifact-meta").textContent =
    (runtime?.agent.name || artifact.agentId || "历史运行") +
    " · " +
    engineLabel(artifact.engine) +
    " · " +
    artifactSyncLabel(artifact) +
    (artifact.sync?.error ? "（" + artifact.sync.error + "）" : "") +
    " · " +
    formatDate(artifact.createdAt) +
    " · " +
    shortId(artifact.runId);
  const content = byId("artifact-content");
  clear(content);
  if (artifact.previewKind === "image") {
    const image = document.createElement("img");
    image.alt = artifact.title;
    image.src = "/v1/artifacts/" + encodeURIComponent(artifact.id) + "/content";
    content.append(image);
  } else if (artifact.previewKind === "video" || artifact.previewKind === "audio") {
    const media = document.createElement(artifact.previewKind);
    media.controls = true;
    media.preload = "metadata";
    media.src = "/v1/artifacts/" + encodeURIComponent(artifact.id) + "/content";
    content.append(media);
  } else if (artifact.previewKind === "pdf" || artifact.previewKind === "html") {
    const frame = document.createElement("iframe");
    frame.title = artifact.title;
    frame.sandbox = artifact.previewKind === "html" ? "" : "allow-same-origin";
    frame.src = "/v1/artifacts/" + encodeURIComponent(artifact.id) + "/content";
    content.append(frame);
  } else {
    const pre = document.createElement("pre");
    pre.textContent = artifact.encoding === "base64"
      ? "该文件类型暂不支持在线预览，请下载原文件。"
      : artifact.content ?? await fetch("/v1/artifacts/" + encodeURIComponent(artifact.id) + "/content").then((response) => {
          if (!response.ok) throw new Error("读取产物失败");
          return response.text();
        });
    content.append(pre);
  }
  byId("download-artifact").href = "/v1/artifacts/" + artifact.id + "/download";
  openDialog("artifact-dialog");
}

function confirmAction(title, copy, callback) {
  state.confirmCallback = callback;
  byId("confirm-title").textContent = title;
  byId("confirm-copy").textContent = copy;
  openDialog("confirm-dialog");
}

async function saveAgent(event) {
  event.preventDefault();
  const sourcePath = byId("agent-source-path").value.trim();
  const body = {
    name: byId("agent-name").value.trim(),
    description: byId("agent-description").value.trim() || undefined,
    engine: byId("agent-engine").value,
    source: sourcePath ? { type: "local", path: sourcePath } : null,
    workspace: {
      strategy: byId("agent-workspace-strategy").value,
      access: byId("agent-workspace-access").value,
    },
    maxConcurrency: Number(byId("agent-concurrency").value),
    model: byId("agent-model").value.trim() || undefined,
    instructions: byId("agent-instructions").value.trim() || undefined,
    allowedTools: byId("agent-tools").value.split(",").map((value) => value.trim()).filter(Boolean),
    allowDangerousSandbox: byId("agent-dangerous").checked,
    enabled: byId("agent-enabled").checked,
  };
  const button = byId("save-agent");
  button.disabled = true;
  try {
    const editing = Boolean(state.editingAgentId);
    await json(editing ? "/v1/agents/" + encodeURIComponent(state.editingAgentId) : "/v1/agents", {
      method: editing ? "PUT" : "POST",
      headers: {"content-type":"application/json"},
      body: JSON.stringify(body),
    });
    closeDialog("agent-dialog");
    notify(editing ? "Agent 配置已更新" : "Agent 已创建，系统已分配 ID 和专属空间");
    await refresh();
    setView("agents");
  } catch (error) {
    notify(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function submitRun(event) {
  event.preventDefault();
  const button = byId("submit-run");
  button.disabled = true;
  button.textContent = "正在创建…";
  const timeout = byId("run-timeout").value;
  const sandbox = byId("run-sandbox").value;
  const options = {};
  const sourcePath = byId("run-source-path").value.trim();
  if (timeout) options.timeoutMs = Number(timeout);
  if (sandbox) options.sandbox = sandbox;
  try {
    const run = await json("/v1/runs", {
      method: "POST",
      headers: {"content-type":"application/json"},
      body: JSON.stringify({
        agentId: byId("run-agent").value,
        prompt: byId("run-prompt").value.trim(),
        source: sourcePath ? { type: "local", path: sourcePath } : undefined,
        sessionKey: byId("run-session-key").value.trim() || undefined,
        freshSession: byId("run-fresh-session").checked,
        options,
      }),
    });
    closeDialog("run-dialog");
    notify("运行已创建");
    await refresh();
    setView("runs");
    await openRunDetail(run.id);
  } catch (error) {
    notify(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "开始运行 →";
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const button = byId("save-settings");
  button.disabled = true;
  try {
    state.settings = await json("/v1/settings", {
      method: "PUT",
      headers: {"content-type":"application/json"},
      body: JSON.stringify({
        nodeName: byId("setting-node-name").value.trim(),
        maxConcurrentRuns: Number(byId("setting-max-concurrency").value),
        defaultTimeoutMs: Number(byId("setting-timeout").value) * 1000,
        eventRetentionDays: Number(byId("setting-retention").value),
        autoResumeSessions: byId("setting-auto-resume").checked,
        allowDangerousSandbox: byId("setting-dangerous").checked,
        coreEnabled: byId("setting-core-enabled").checked,
        coreUrl: byId("setting-core-url").value.trim() || undefined,
        coreToken: byId("setting-core-token").value.trim() || undefined,
      }),
    });
    state.settingsDirty = false;
    notify("系统配置已保存");
    await refresh();
  } catch (error) {
    notify(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

document.querySelectorAll(".nav-button").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
document.querySelectorAll("[data-go-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.goView)));
document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => closeDialog(button.dataset.closeDialog)));
document.querySelectorAll(".modal").forEach((dialog) => {
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); dialog.close(); } });
});
document.querySelectorAll("[data-detail-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-detail-tab]").forEach((item) => item.classList.toggle("active", item === button));
    document.querySelectorAll(".detail-content").forEach((panel) => panel.classList.toggle("active", panel.id === "detail-" + button.dataset.detailTab));
  });
});

byId("global-new-run").addEventListener("click", () => state.view === "conversations" ? openConversationDialog() : openRunDialog());
byId("new-conversation").addEventListener("click", openConversationDialog);
byId("conversation-create-form").addEventListener("submit", createConversation);
byId("conversation-form").addEventListener("submit", sendConversation);
byId("conversation-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    byId("conversation-form").requestSubmit();
  }
});
byId("cancel-conversation").addEventListener("click", async () => {
  if (!state.selectedConversationId) return;
  try {
    await json("/v1/conversations/" + encodeURIComponent(state.selectedConversationId) + "/cancel", {method:"POST"});
    notify("已请求停止 Agent");
    await loadConversation();
  } catch (error) { notify(error.message, "error"); }
});
byId("quick-new-run").addEventListener("click", () => openRunDialog());
byId("runs-new-run").addEventListener("click", () => openRunDialog());
byId("quick-new-agent").addEventListener("click", () => openAgentDialog());
byId("new-agent-button").addEventListener("click", () => openAgentDialog());
byId("refresh-button").addEventListener("click", () => refresh());
byId("banner-action").addEventListener("click", () => setView("engines"));
byId("run-agent").addEventListener("change", updateRunPreview);
byId("agent-workspace-strategy").addEventListener("change", updateAgentWorkspacePreview);
byId("agent-workspace-access").addEventListener("change", updateAgentWorkspacePreview);
byId("agent-source-path").addEventListener("input", updateAgentWorkspacePreview);
byId("agent-engine").addEventListener("change", () => {
  if (!state.editingAgentId) {
    byId("agent-workspace-access").value =
      byId("agent-engine").value === "claude-code" ? "read-only" : "workspace-write";
  }
  updateAgentWorkspacePreview();
});
byId("agent-search").addEventListener("input", renderAgents);
byId("agent-engine-filter").addEventListener("change", renderAgents);
byId("run-search").addEventListener("input", renderRuns);
byId("run-agent-filter").addEventListener("change", renderRuns);
byId("run-status-filter").addEventListener("change", renderRuns);
byId("artifact-search").addEventListener("input", renderArtifacts);
byId("agent-form").addEventListener("submit", saveAgent);
byId("run-form").addEventListener("submit", submitRun);
byId("settings-form").addEventListener("submit", saveSettings);
byId("settings-form").addEventListener("input", () => {
  state.settingsDirty = true;
  byId("settings-save-state").textContent = "有未保存修改";
  byId("settings-save-state").className = "save-state dirty";
});
byId("recheck-engines").addEventListener("click", async () => {
  const button = byId("recheck-engines");
  button.disabled = true;
  try {
    await json("/v1/capabilities/refresh", {method:"POST"});
    await refresh();
    notify("引擎状态已重新检测");
  } catch (error) {
    notify(error.message, "error");
  } finally {
    button.disabled = false;
  }
});
byId("delete-agent").addEventListener("click", () => {
  const runtime = agentRuntime(state.editingAgentId);
  if (!runtime) return;
  confirmAction("删除 " + runtime.agent.name, "将删除 Agent 配置，但不会删除历史运行和产出。该操作无法从控制台撤销。", async () => {
    await json("/v1/agents/" + encodeURIComponent(runtime.agent.id), {method:"DELETE"});
    closeDialog("confirm-dialog");
    closeDialog("agent-dialog");
    notify("Agent 已删除");
    await refresh();
  });
});
byId("confirm-action").addEventListener("click", async () => {
  if (!state.confirmCallback) return;
  const callback = state.confirmCallback;
  state.confirmCallback = null;
  try { await callback(); } catch (error) { notify(error.message, "error"); }
});
byId("detail-cancel").addEventListener("click", async () => {
  if (!state.selectedRunId) return;
  try {
    await json("/v1/runs/" + state.selectedRunId + "/cancel", {method:"POST"});
    notify("已发送停止请求");
    closeDialog("run-detail-dialog");
    await refresh();
  } catch (error) { notify(error.message, "error"); }
});
byId("detail-rerun").addEventListener("click", () => {
  const run = state.runs.find((item) => item.id === state.selectedRunId);
  if (!run) return;
  closeDialog("run-detail-dialog");
  openRunDialog(run.agentId, run.request?.prompt);
});
byId("copy-artifact").addEventListener("click", async () => {
  const artifact = state.artifacts.find((item) => item.id === state.selectedArtifactId);
  if (!artifact) return;
  await navigator.clipboard.writeText(artifact.content);
  notify("产出内容已复制");
});

const initialView = location.hash.startsWith("#/") ? location.hash.slice(2) : "dashboard";
setView(viewMeta[initialView] ? initialView : "dashboard");
refresh();
setInterval(() => refresh({quiet:true}), 10000);
`;
