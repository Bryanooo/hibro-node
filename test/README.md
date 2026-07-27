# Hibro Node 测试

所有 Node 测试由 `test/catalog.ts` 统一登记。新增 `*.test.ts` 却未登记时，
`catalog.test.ts` 会直接失败，避免测试散落后无人知道该从哪里执行。

## 分层

- `unit`：纯逻辑、配置、协议和脚本契约，执行快，不启动服务。
- `integration`：文件系统、SQLite、HTTP 服务、引擎子进程和运行时协作。
- `e2e`：位于 `e2e/`，使用真实浏览器操作临时启动的 Hibro Node。
- `docker`：构建镜像并在临时容器、临时数据卷中验证启动和数据布局。

## 常用命令

```text
npm test
npm run test:unit
npm run test:integration
npm run test:list
npm run test:report
npm run test:e2e
npm run test:docker
npm run validate
```

`validate` 是提交前的默认入口；CI 会额外执行浏览器和 Docker 测试。测试报告
统一写入 `test-results/` 和 `playwright-report/`，这些目录不会提交到 Git。

## 新增测试检查清单

1. 将 Node 测试放到 `test/<area>.test.ts`。
2. 在 `test/catalog.ts` 登记唯一 ID、层级、领域和用途。
3. 浏览器流程放到 `e2e/`，不要依赖本机已有账号、Agent 或端口。
4. 测试只能写入临时目录、临时容器或临时数据卷。
5. 本地至少执行 `npm run validate`；涉及页面或镜像时再执行对应测试。
