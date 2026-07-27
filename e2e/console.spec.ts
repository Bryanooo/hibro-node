import { expect, test } from "@playwright/test";

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

test("creates an Agent without a project and runs it in its private workspace", async ({
  page,
}) => {
  const agentName = `E2E Codex ${Date.now()}`;
  await page.locator("#new-agent-button").click();
  await page.locator("#agent-name").fill(agentName);
  await page.locator("#agent-engine").selectOption("codex");
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
  const created = (await createResponse.json()) as { id: string };
  expect(created.id).toMatch(/^agt_[0-9a-f-]{36}$/);

  const card = page.locator(`.agent-card[data-agent-id="${created.id}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText(agentName);
  await expect(card).toContainText("默认项目 未配置 · 使用空白专属空间");
  await expect(card).toContainText("/.hibro/agents/");

  await card.getByRole("button", { name: "运行 →" }).click();
  await expect(page.locator("#run-source-path")).toHaveValue("");
  await page.locator("#run-prompt").fill("browser e2e");
  const runResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/v1/runs") &&
      response.request().method() === "POST",
  );
  await page.locator("#submit-run").click();
  const runResponse = await runResponsePromise;
  expect(runResponse.status()).toBe(202);
  const run = (await runResponse.json()) as { id: string };

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
