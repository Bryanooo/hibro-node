# Hibro Node

Hibro Node 是 Hibro 的本地多 Agent 运行时。Agent 是一等实体，Run 是某个 Agent
的一次执行；Team 与跨节点编排由 Hibro Core 管理，不进入 Node。

当前版本已经打通 Claude Code、Codex CLI 与 OpenClaw 三种引擎，并在 Docker
中完成六个独立 Agent 的真实调用验证。

## 运行模型

```text
AgentDefinition
  ├─ engine: claude-code | codex | openclaw
  ├─ source.path
  ├─ workspace.strategy: persistent | per-run | scratch
  ├─ workspace.access: read-only | workspace-write
  ├─ model / instructions / allowedTools
  └─ maxConcurrency
           │
           ▼
Agent 私有目录 ──► WorkspaceLease ──► Run ──► Engine Adapter
```

Node 负责：

- 本地 Agent 注册、状态和并发控制
- Claude Code / Codex CLI / OpenClaw 进程生命周期
- 工作空间分配与写入互斥
- 会话续接、取消、超时和重启恢复
- 一等对话、消息、思考/工具/审批活动与实时事件
- Run 状态、事件与产出持久化
- HTTP API、SSE 与本地管理台

Core 负责 Team、跨节点路由、策略和全局产出索引。Node 可独立运行，也可以主动通过
`hibro.node.v1` WebSocket 连接 Hibro Core。

## Agent ID 与默认 Agent

Agent ID 完全由 Hibro Node 生成，格式为 `agt_<ULID>`。Web 控制台和
`POST /v1/agents` 都不接受用户指定 ID，避免命名冲突以及未来多个 Node 注册到 Core
时发生全局冲突。

首次启动会在 `HIBRO_NODE_DATA_DIR/agents.json` 创建六个 Agent；已有数据目录会按引擎
补足到每种两个，不删除已有 Agent，也不改变已有 ID：

| Agent | 引擎 | 生命周期 | 权限 |
|---|---|---|---|
| Claude 本地助手 | Claude Code | 持久工作区 | 只读 |
| Claude 实作助手 | Claude Code | 持久工作区 | 可写 |
| Codex 开发助手 | Codex CLI | 持久工作区 | 可写 |
| Codex 审查助手 | Codex CLI | 持久工作区 | 可写 |
| OpenClaw 研究助手 | OpenClaw | 持久工作区 | 只读 |
| OpenClaw 自动化助手 | OpenClaw | 持久工作区 | 可写 |

它们可以使用同一个源项目，但运行目录永远不同。默认源项目为启动服务时的当前目录，
也可以通过
`HIBRO_DEFAULT_PROJECT_ROOT` 或 `--project-root` 指定。

旧版 `projectRoot`、`workspaceMode` 会在启动时自动迁移到新结构；已经存在的 Agent ID
和历史 Run 不会改变。

## 初始项目与 Agent 专属空间

控制台中的“初始项目”表示 Agent 第一次创建工作副本时从哪里获得文件，对应 API
内部的 `source.path`。它不是 Agent 实际工作的目录。每个 Agent 都拥有自己的
“Agent 专属空间”：

```text
HIBRO_NODE_DATA_DIR/
  agents/
    <agent-id>/
      workspace/       # persistent 生命周期
      state/           # Agent 状态与后续会话数据
      tmp/             # 临时文件
      artifacts/       # Agent 产出目录
      runs/
        <run-id>/      # per-run 或 scratch 生命周期
```

| 生命周期 | 用途 |
|---|---|
| `persistent` | 为 Agent 创建一次并长期复用，适合持续开发和会话续接 |
| `per-run` | 每个 Run 创建独立工作区，Run 结束后清理 |
| `scratch` | 每个 Run 使用空白临时目录，Run 结束后清理 |

`read-only` 和 `workspace-write` 独立控制引擎权限。Git 项目使用 detached worktree
物化，未提交或非 Git 项目使用目录复制。源项目本身不会被 Agent 直接作为运行目录。

每次 Run 都会保存实际的 `WorkspaceLease`。默认并发为 1；同一个私有工作目录不会
同时分配给多个 Run。

## 快速开始

要求 Node.js 24 或更高版本，并至少安装一种引擎：

- Claude Code CLI
- Codex CLI
- OpenClaw CLI

```bash
npm install
npm run doctor
npm start
```

默认监听 `http://127.0.0.1:7331`。打开
`http://127.0.0.1:7331/console` 可以使用完整的本地管理台：

控制台和所有管理 API 使用独立的 Node 控制凭据。用户名固定为 `hibro`；密码优先从
`HIBRO_NODE_CONTROL_TOKEN` 读取。未配置时，Node 会首次生成强随机凭据，保存到
数据目录的 `control-token`（权限 `0600`）。启动日志永远不会输出口令；需要查看时运行
`npm run control-token`。Docker 部署可运行
`docker compose exec hibro-node npm run control-token`，用户名固定为 `hibro`。

- 总览：Agent、活动运行、成功率、引擎状态和快速操作
- Agents：搜索、新建、编辑、启停、删除和直接运行
- Agent 对话：直接聊天，并查看思考摘要、工具调用、工具结果和审批项
- 运行：按 Agent/状态筛选，查看结果、事件与原始请求，取消或再次运行
- 产出：搜索、复制和下载已完成运行的 Markdown 结果
- 工作空间：查看目录策略、权限、活动租约和最近使用时间
- 引擎：检测 CLI 安装、版本和认证状态
- 系统配置：并发、超时、会话续接、安全策略、历史保留与 Core 目标

控制台为响应式页面，弹窗支持关闭按钮、取消、`Escape` 和点击遮罩关闭。

## HTTP API

查看 Agent 与引擎状态：

```bash
curl http://127.0.0.1:7331/v1/agents
curl http://127.0.0.1:7331/v1/capabilities
curl http://127.0.0.1:7331/v1/protocol
```

创建 Agent（ID 由系统返回）：

```bash
curl -X POST http://127.0.0.1:7331/v1/agents \
  -H 'content-type: application/json' \
  -d '{
    "name": "代码审查",
    "engine": "codex",
    "source": {
      "type": "local",
      "path": "/workspace/project"
    },
    "workspace": {
      "strategy": "persistent",
      "access": "workspace-write"
    },
    "maxConcurrency": 1
  }'
```

让指定 Agent 执行：

```bash
curl -X POST http://127.0.0.1:7331/v1/runs \
  -H 'content-type: application/json' \
  -d '{
    "agentId": "agt_...",
    "prompt": "分析当前项目并给出三条改进建议",
    "sessionKey": "project-review",
    "options": {
      "timeoutMs": 300000
    }
  }'
```

相同 Agent、Workspace 与 `sessionKey` 会自动续接最近会话。传入
`"freshSession": true` 可强制新建会话。

对话 API：

```text
GET    /v1/conversations
POST   /v1/conversations
GET    /v1/conversations/:id
PATCH  /v1/conversations/:id
POST   /v1/conversations/:id/messages
GET    /v1/conversations/:id/events
POST   /v1/conversations/:id/cancel
POST   /v1/conversations/:id/archive
```

对话事件通过 SSE 实时输出，并持久化为对话内顺序事件。活动类型统一为
`thinking`、`tool_call`、`tool_result`、`approval`、`progress` 和 `error`。
只展示引擎实际输出的思考内容。审批项带 `resolvable` 能力标记；当前 CLI 没有可恢复
的审批桥时，控制台明确显示为只读。

```bash
curl http://127.0.0.1:7331/v1/runs/RUN_ID
curl -N http://127.0.0.1:7331/v1/runs/RUN_ID/events
curl 'http://127.0.0.1:7331/v1/runs/RUN_ID/events?format=json'
curl -X POST http://127.0.0.1:7331/v1/runs/RUN_ID/cancel
```

更新一个 Agent：

```bash
curl -X PUT http://127.0.0.1:7331/v1/agents/agt_... \
  -H 'content-type: application/json' \
  -d '{
    "workspace": {
      "strategy": "per-run",
      "access": "workspace-write"
    },
    "maxConcurrency": 1
  }'
```

其余管理接口：

```text
GET    /v1/settings
PUT    /v1/settings
GET    /v1/system
GET    /v1/workspaces
GET    /v1/artifacts
GET    /v1/artifacts/:runId/download
POST   /v1/agents
GET    /v1/agents/:id
PUT    /v1/agents/:id
DELETE /v1/agents/:id
POST   /v1/capabilities/refresh
```

系统配置和 Agent 定义都写入数据目录。运行历史保留天数会在服务启动和保存设置时清理
过期且已经结束的 Run；活动 Run 不会被清理。

## 数据存储

生产运行使用 Node.js 内置 SQLite，数据库为
`HIBRO_NODE_DATA_DIR/hibro.db`。Run、顺序事件与后续 Core Outbox 使用事务表，
数据库启用 WAL；Agent 定义和系统设置暂时保留为可读、易备份的 JSON。

旧版 `runs/*/state.json` 和 `events.jsonl` 会在首次启动时幂等导入 SQLite，源文件保留，
不会被删除。这个混合方案适合单机 Hibro Node；只有未来让多个 Node 实例共享同一运行
数据库时，才需要考虑 PostgreSQL 等外部数据库。设计决策见
[`docs/adr-0001-sqlite-storage.md`](docs/adr-0001-sqlite-storage.md)。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `HIBRO_NODE_HOST` | `127.0.0.1` | HTTP 监听地址 |
| `HIBRO_NODE_PORT` | `7331` | HTTP 监听端口 |
| `HIBRO_NODE_DATA_DIR` | `~/.hibro-node` | Agent、Run、事件和 Workspace 数据 |
| `HIBRO_DEFAULT_PROJECT_ROOT` | 当前目录 | 首次创建默认 Agent 使用的项目目录 |
| `HIBRO_CLAUDE_BIN` | 自动发现 | Claude Code CLI |
| `HIBRO_CODEX_BIN` | `codex` | Codex CLI |
| `HIBRO_OPENCLAW_BIN` | `openclaw` | OpenClaw CLI |
| `HIBRO_IMPORT_SHELL_ENV` | `true` | 从交互式 shell 导入 Claude 专用变量 |
| `HIBRO_NODE_ARTIFACT_MAX_BYTES` | `1073741824` | Node 收集的单个产物上限；Core 存储驱动还会再次限制 |

Shell 环境导入只接受 Claude/API Provider 所需的变量白名单；日志只记录变量名，
不会记录变量值。

## Docker

镜像构建时会在镜像内全新安装并固定 Claude Code `2.1.218`、Codex CLI `0.145.0`
和 OpenClaw `2026.7.1-2`，不会直接使用宿主机上的 CLI 安装。默认映射到宿主机
`17332` 端口，使用 `hibro-node-data` 保存配置、运行、事件和工作空间，并将当前项目
挂载到 `/workspace/project`。

Claude 可使用当前 shell 中的 Anthropic 环境变量；Codex 会从宿主机的
`~/.codex/auth.json` 和 `~/.codex/config.toml` 导入认证配置。OpenClaw 复用
`ANTHROPIC_API_KEY`（没有该变量时也接受 `ANTHROPIC_AUTH_TOKEN`）；配置了
`ANTHROPIC_BASE_URL` 时会为 OpenClaw 生成对应的 Anthropic-compatible Provider。
每个 OpenClaw Agent 使用自己的 `OPENCLAW_STATE_DIR`、配置文件和工作空间。

```bash
docker compose build
docker compose up -d
open http://127.0.0.1:17332/console
```

容器健康状态和日志：

```bash
docker ps --filter name=hibro-node-local
docker logs hibro-node-local
```

## 验证

```bash
npm run validate
npm run smoke:claude
```

`validate` 会执行严格 TypeScript 检查、语法检查和自动化测试。运行时使用 Node.js
原生 TypeScript type stripping，没有生产依赖。

每个 Agent 的 API 和控制台卡片都会显示 Core 注册状态。当前支持：

- `standalone`：Node 未启用 Core
- `pending` / `syncing`：已配置 Core，正在连接或同步
- `registered`：Core 已确认全局 Agent ID
- `rejected` / `error`：Core 拒绝注册或同步失败

Hibro Core ↔ Node 协议已经定义为 `hibro.node.v1`：使用 Node 主动发起的 WSS
连接，包含认证握手、断线续传、Agent 修订同步、Run 命令/事件、产出上传、显式 ACK、
幂等键、顺序号、心跳租约、重试与背压。大产出通过签名 HTTPS 上传，NATS 只作为
Core 内部总线候选，不暴露给 Node。

协议可以通过 `GET /v1/protocol` 查询，完整规范见
[`docs/hibro-core-node-protocol-v1.md`](docs/hibro-core-node-protocol-v1.md)。
WSS Transport 已实现 Node 注册、Agent 同步、心跳、远程 Run、取消、运行事件和
文本产出上传。需要 ACK 的 Node 消息会先写入本地 SQLite `core_outbox`，断线重连后
自动重发，Core 通过 `messageId` 幂等处理。

Docker 连接本机 Core 的典型配置为：

```text
Core URL: ws://host.docker.internal:17400
Node Token: 与 HIBRO_CORE_NODE_TOKEN 相同
```

## 品牌资产

品牌探索图和当前临时采用的连接节点标识位于 `assets/brand/`：

- `hibro-icon-concepts.png`：H 桥、连接节点、模块积木三种方向
- `hibro-mark.png`：当前控制台使用的连接节点标识
- `hibro-app-icon.png`：App 图标尺寸
- `hibro-favicon.png`：控制台 favicon
