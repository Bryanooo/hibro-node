# Agent as Code v1 验收规范

本文是 Hibro Node 与 Hibro Core 第一阶段的共同交付门槛。它描述可自动验证的行为，不以“接口已存在”作为完成标准。

## 1. 源码契约

- Agent 包由 `agent.yaml`、指令文件和零个或多个 Skill 目录组成。
- `apiVersion` 必须是 `hibro.ai/v1alpha1`，`kind` 必须是 `Agent`。
- `metadata.name`、`metadata.slug`、`spec.engine`、`spec.instructions` 必填。
- Engine 支持 `codex`、`claude-code`、`openclaw`；工作空间、并发数、审批策略和模型都由清单声明。
- 文件路径必须是规范化的相对 POSIX 路径。拒绝绝对路径、`..`、空路径、NUL、符号链接和越界读取。
- v1 包最多 256 个文本文件、单文件 256 KiB、总计 768 KiB。二进制产物不属于 Agent 源码包。
- 文件排序、换行和清单规范化后计算 SHA-256；相同语义源码必须得到相同内容哈希。

## 2. Node 编译与隔离

- 每个 Agent 的源码、编译结果、激活状态、工作空间、状态、临时文件和产物都位于自己的 `.hibro/agents/<agent-id>/` 下。
- Codex 投影生成 `AGENTS.md` 与 `.agents/skills/<skill>/...`。
- Claude Code 投影生成 `CLAUDE.md` 与 `.claude/skills/<skill>/...`。
- OpenClaw 投影生成 `AGENTS.md` 与 `.openclaw/skills/<skill>/...`，并保留可替换编译器边界。
- 编译发生在 Hibro 管理目录，不修改源码目录。运行前只把当前激活版本投影到该 Agent 的私有工作空间。
- Revision 目录不可变；重复部署相同 revision 是幂等操作。
- 校验或编译失败时，当前激活版本和可运行 Agent 不受影响。
- Node 可独立导入、激活和回滚 Agent 包；没有 Core 时运行、对话和产物预览不退化。

## 3. Core 发布与部署

- Core 分离 Definition、Revision、Deployment：Definition 是稳定身份，Revision 是不可变源码，Deployment 是某版本在某 Node 的期望/实际状态。
- 新源码发布为递增 Revision；同一 Definition 下重复发布相同哈希返回已有版本。
- Core 记录创建者、内容哈希、目标 Node、目标本地 Agent、部署状态、错误和激活时间。
- 部署命令通过现有可靠 outbox、ack 和幂等键发送；Node 回传 `installing/active/failed` 状态。
- Node 离线时部署保持 `pending`，重连后重放；失败可重试，不产生重复 Agent。
- 回滚是把历史 Revision 创建为新的 Deployment，不修改历史记录。
- 已有 Node 本地 Agent 继续通过 snapshot 注册，现有 Run/Conversation/Team 协议保持兼容。

## 4. 安全与权限

- Core 的读操作要求 `agent:read`，发布、部署、回滚要求 `agent:manage`。
- 普通用户只能操作自己可见的 Node/Agent；Owner/Admin 可管理全局。
- Node 只接受已认证 Core 连接上的部署命令；本地管理 API 默认仅监听回环地址。
- 日志与错误不得包含 Node credential、密码、OSS 密钥或完整 Authorization 值。

## 5. 必须通过的验证

1. Core 与 Node 全量 typecheck、unit、integration 测试通过。
2. 恶意路径、超限包、无效 YAML、哈希不符、未知 Engine 的负向用例通过。
3. 三种 Engine 的编译快照和两次相同部署幂等测试通过。
4. 激活 A、部署 B 失败仍运行 A、再次部署 B 成功、回滚 A 的生命周期测试通过。
5. 进程重启后 Agent、激活 Revision、Deployment 状态和独立工作空间不丢失。
6. Docker 中启动 Core 与 Node，完成注册、发布、部署、snapshot 回传，并使用测试 Engine 完成至少一个真实 Run。
7. Core 与 Node 控制台的创建、发布、部署、回滚、错误提示、弹窗关闭和刷新恢复由 Playwright 覆盖。

## 6. 完成定义

以上自动化全部通过、Docker 容器健康、无未处理异常与重复 outbox 后，Agent as Code v1 才视为完成。真实云端凭证（Claude/Codex/OSS）不作为本地 CI 前置条件，但对应 doctor 必须准确显示“不可用”而不能假成功。
