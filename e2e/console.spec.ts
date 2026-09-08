import { expect, test } from "@playwright/test";
import { join } from "node:path";

test.beforeEach(async ({ page }) => {
  await page.goto("/console#/agents");
  await expect
    .poll(async () => page.locator("#agent-grid .agent-card").count())
    .toBeGreaterThanOrEqual(6);
});

test("all creation and run dialogs can be closed", async ({ page }) => {
  await page.locator("#new-agent-button").click();
  await expect(page.locator("#agent-dialog")).toBeVisible();
  await page.getByRole("button", { name: "关闭 Agent 配置" }).click();
  await expect(page.locator("#agent-dialog")).toBeHidden();

  await page.locator("#global-new-run").click();
  await expect(page.locator("#run-dialog")).toBeVisible();
  await page
    .locator('#run-dialog [data-close-dialog="run-dialog"]')
    .filter({ hasText: "取消" })
    .click();
  await expect(page.locator("#run-dialog")).toBeHidden();
});

test("engine lifecycle can disable and re-enable an engine", async ({ page }) => {
  await page.getByRole("button", { name: "引擎" }).click();
  const card = page.locator('.engine-card[data-engine-id="codex"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText(/镜像内置|系统已有/);

  const disableResponse = page.waitForResponse((response) =>
    response.url().endsWith("/v1/engines/codex/disable") && response.request().method() === "POST",
  );
  await card.getByRole("button", { name: "停用" }).click();
  expect((await disableResponse).status()).toBe(200);
  await expect(card.getByRole("button", { name: "启用" })).toBeVisible();

  const enableResponse = page.waitForResponse((response) =>
    response.url().endsWith("/v1/engines/codex/enable") && response.request().method() === "POST",
  );
  await card.getByRole("button", { name: "启用" }).click();
  expect((await enableResponse).status()).toBe(200);
  await expect(card.getByRole("button", { name: "停用" })).toBeVisible();
});

test("observability lists a trace and opens its execution details", async ({ page }) => {
  const run = await page.evaluate(async () => {
    const response = await fetch("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "observability e2e", workspace: "." }),
    });
    return await response.json() as { id: string };
  });
  await expect.poll(async () => page.evaluate(async (runId) => {
    const response = await fetch(`/v1/runs/${runId}`);
    return ((await response.json()) as { status: string }).status;
  }, run.id)).toBe("completed");

  await page.reload();
  await page.getByRole("button", { name: "观测中心" }).click();
  await expect(page.locator("#view-observability")).toHaveClass(/active/);
  const row = page.locator("#obs-trace-body tr", { hasText: "observability e2e" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Claude Code");
  await row.click();
  await expect(page.locator("#run-detail-dialog")).toBeVisible();
  await expect(page.locator("#detail-events")).toContainText("run.completed");
  await page.getByRole("button", { name: "关闭运行详情" }).click();
  await expect(page.locator("#run-detail-dialog")).toBeHidden();
});

test("creates an Agent without a project and runs it in its private workspace", async ({
  page,
}) => {
  const agentName = `E2E Codex ${Date.now()}`;
  await page.locator("#new-agent-button").click();
  await page.locator("#agent-name").fill(agentName);
  await page.locator("#agent-engine").selectOption("codex");
  await page.locator('.agent-modality[value="image"]').check();
  await expect(page.locator("#agent-source-path")).toHaveValue("");
  await expect(page.locator("#agent-workspace-preview")).toContainText(
    "未配置默认项目，将使用空白空间",
  );

  const createResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/v1/agents") &&
      response.request().method() === "POST",
  );
  await page.locator("#save-agent").click();
  const createResponse = await createResponsePromise;
  expect(createResponse.status()).toBe(201);
  const created = (await createResponse.json()) as { id: string; modalities?: string[] };
  expect(created.id).toMatch(/^agt_[0-9a-f-]{36}$/);
  expect(created.modalities).toEqual(expect.arrayContaining(["text", "image"]));

  const card = page.locator(`.agent-card[data-agent-id="${created.id}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText(agentName);
  await expect(card).toContainText("默认项目 未配置 · 使用空白专属空间");
  await expect(card).toContainText("/.hibro/agents/");

  await card.getByRole("button", { name: "运行 →" }).click();
  await expect(page.locator("#run-source-path")).toHaveValue("");
  await page.locator("#run-prompt").fill("browser e2e");
  await page.locator("#run-execution").selectOption("media");
  await page.locator("#run-output-mb").fill("8");
  await page.locator("#run-timeout").fill("10");
  const runResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/v1/runs") &&
      response.request().method() === "POST",
  );
  await page.locator("#submit-run").click();
  const runResponse = await runResponsePromise;
  expect(runResponse.status()).toBe(202);
  const run = (await runResponse.json()) as { id: string; request: { execution?: { class: string; maxOutputBytes: number }; options?: { timeoutMs: number } } };
  expect(run.request.execution).toEqual({ class: "media", maxOutputBytes: 8 * 1_024 * 1_024 });
  expect(run.request.options?.timeoutMs).toBe(10 * 60 * 1_000);

  await expect
    .poll(async () => {
      return page.evaluate(async (runId) => {
        const response = await fetch(`/v1/runs/${runId}`);
        const body = (await response.json()) as { status: string };
        return body.status;
      }, run.id);
    })
    .toBe("completed");

  await page.getByRole("button", { name: "关闭运行详情" }).click();
  await page.reload();
  await page.getByRole("button", { name: "运行", exact: true }).click();
  await page.locator("#runs-body tr", { hasText: "browser e2e" }).click();
  await expect(page.locator("#detail-result")).toContainText("CODEX:browser e2e");
});

test("system and workspace pages expose one isolated Hibro Home", async ({ page }) => {
  const system = await page.evaluate(async () => {
    const response = await fetch("/v1/system");
    return (await response.json()) as {
      dataDir: string;
      storage: { engine: string; databasePath: string };
    };
  });
  expect(system.dataDir).toMatch(/hibro-node-e2e-[^/]+\/\.hibro$/);
  expect(system.storage.engine).toBe("sqlite");
  expect(system.storage.databasePath).toBe(`${system.dataDir}/hibro.db`);

  const workspacePayload = await page.evaluate(async () => {
    const response = await fetch("/v1/workspaces");
    return (await response.json()) as {
      workspaces: Array<{
        agentId: string;
        path: string;
        metadataPath: string;
        statePath: string;
      }>;
    };
  });
  expect(workspacePayload.workspaces.length).toBeGreaterThanOrEqual(6);
  expect(new Set(workspacePayload.workspaces.map((item) => item.path)).size).toBe(
    workspacePayload.workspaces.length,
  );
  for (const workspace of workspacePayload.workspaces) {
    expect(workspace.path).toContain(`${system.dataDir}/agents/${workspace.agentId}/`);
    expect(workspace.metadataPath).toBe(
      `${system.dataDir}/agents/${workspace.agentId}`,
    );
    expect(workspace.statePath).toBe(
      `${system.dataDir}/agents/${workspace.agentId}/state`,
    );
  }

  await page.getByRole("button", { name: "系统配置" }).click();
  await expect(page.locator("#data-directory")).toHaveText(system.dataDir);
  await page.getByRole("button", { name: "Agent 空间" }).click();
  await expect(page.locator("#workspaces-body tr")).toHaveCount(
    workspacePayload.workspaces.length,
  );
  await expect(page.locator("#workspaces-body")).toContainText("默认使用空白专属空间");
});

test("imports, revisions and rolls back an Agent as Code package", async ({ page }) => {
  await page.getByRole("button", { name: "Agent 源码" }).click();
  await expect(page.locator("#view-definitions")).toHaveClass(/active/);
  const firstPath = join(process.cwd(), "test/fixtures/agent-packages/e2e-codex-v1");
  await page.locator("#agent-package-path").fill(firstPath);
  const firstResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/v1/agent-packages/import") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "校验、编译并激活" }).click();
  const firstResponse = await firstResponsePromise;
  expect(firstResponse.status()).toBe(201);
  const first = (await firstResponse.json()) as { revision: { agentId: string } };
  await expect(page.locator("#agent-revisions-body")).toContainText("Revision 1");
  await expect(page.locator("#agent-revisions-body")).toContainText("已激活");

  const secondPath = join(process.cwd(), "test/fixtures/agent-packages/e2e-codex-v2");
  await page.locator("#agent-package-path").fill(secondPath);
  await page.locator("#agent-package-target").selectOption(first.revision.agentId);
  const secondResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/v1/agent-packages/import") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "校验、编译并激活" }).click();
  expect((await secondResponsePromise).status()).toBe(201);
  await expect(page.locator("#agent-revisions-body tr")).toHaveCount(2);
  await expect(page.locator("#agent-revisions-body")).toContainText("Revision 2");

  const firstRow = page.locator("#agent-revisions-body tr", { hasText: "Revision 1" });
  const activateResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/activate") && response.request().method() === "POST",
  );
  await firstRow.getByRole("button", { name: "回滚到此版本" }).click();
  expect((await activateResponsePromise).status()).toBe(200);
  await expect(firstRow).toContainText("已激活");
});
