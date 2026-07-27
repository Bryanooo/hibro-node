export type TestLayer = "unit" | "integration";

export interface TestSuiteDefinition {
  id: string;
  file: string;
  layer: TestLayer;
  area: string;
  description: string;
}

export const TEST_SUITES: readonly TestSuiteDefinition[] = [
  {
    id: "quality.catalog",
    file: "catalog.test.ts",
    layer: "unit",
    area: "quality",
    description: "测试目录完整性与元数据约束",
  },
  {
    id: "runtime.agent",
    file: "agent-runtime.test.ts",
    layer: "integration",
    area: "runtime",
    description: "Agent 运行时、引擎状态和工作空间",
  },
  {
    id: "engine.claude",
    file: "claude-code-adapter.test.ts",
    layer: "integration",
    area: "engine",
    description: "Claude Code 适配器协议与审批",
  },
  {
    id: "engine.codex",
    file: "codex-adapter.test.ts",
    layer: "integration",
    area: "engine",
    description: "Codex App Server 协议与审批",
  },
  {
    id: "config.node",
    file: "config.test.ts",
    layer: "unit",
    area: "configuration",
    description: "Node 配置解析和默认值",
  },
  {
    id: "conversation.service",
    file: "conversation-service.test.ts",
    layer: "integration",
    area: "conversation",
    description: "连续对话、事件和会话恢复",
  },
  {
    id: "protocol.core",
    file: "core-protocol.test.ts",
    layer: "unit",
    area: "core",
    description: "Core/Node 协议消息定义",
  },
  {
    id: "storage.layout",
    file: "data-layout.test.ts",
    layer: "integration",
    area: "storage",
    description: "统一 Hibro Home 与旧数据迁移",
  },
  {
    id: "cli.management",
    file: "hibro-cli.test.ts",
    layer: "integration",
    area: "cli",
    description: "hibro 管理命令",
  },
  {
    id: "http.api",
    file: "http-server.test.ts",
    layer: "integration",
    area: "api",
    description: "HTTP API、控制台资源和安全边界",
  },
  {
    id: "installer.scripts",
    file: "install-script.test.ts",
    layer: "unit",
    area: "installation",
    description: "一键安装脚本的静态契约",
  },
  {
    id: "engine.openclaw",
    file: "openclaw-adapter.test.ts",
    layer: "integration",
    area: "engine",
    description: "OpenClaw 适配器协议",
  },
  {
    id: "runtime.manager",
    file: "run-manager.test.ts",
    layer: "integration",
    area: "runtime",
    description: "运行队列、超时、取消和审批",
  },
  {
    id: "settings.store",
    file: "settings-store.test.ts",
    layer: "integration",
    area: "configuration",
    description: "系统配置持久化和脱敏",
  },
  {
    id: "engine.shell-environment",
    file: "shell-environment.test.ts",
    layer: "integration",
    area: "engine",
    description: "本地 Shell 环境导入",
  },
  {
    id: "storage.sqlite",
    file: "sqlite-store.test.ts",
    layer: "integration",
    area: "storage",
    description: "SQLite 运行、事件和产物存储",
  },
] as const;
