#!/usr/bin/env node

import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-cli 0.145.0\n");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  process.stdout.write("Logged in using ChatGPT\n");
  process.exit(0);
}
if (args[0] !== "app-server") process.exit(2);

const defaultSessionId = "44444444-4444-4444-8444-444444444444";
let sessionId = defaultSessionId;
let pendingPrompt;
let pendingApprovalId;
let developerInstructions = "";

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (process.env.FAKE_CODEX_DEBUG) {
    process.stderr.write(`IN:${JSON.stringify(message)}\n`);
  }
  if (message.method === "initialize") {
    write({ id: message.id, result: { userAgent: "fake-codex" } });
    return;
  }
  if (message.method === "thread/start") {
    sessionId = defaultSessionId;
    developerInstructions = message.params.developerInstructions ?? "";
    write({ id: message.id, result: { thread: { id: sessionId } } });
    return;
  }
  if (message.method === "thread/resume") {
    sessionId = message.params.threadId;
    write({ id: message.id, result: { thread: { id: sessionId } } });
    return;
  }
  if (message.method === "turn/start") {
    pendingPrompt = message.params.input?.[0]?.text ?? "";
    write({ id: message.id, result: { turn: { id: "turn-fake" } } });
    if (pendingPrompt === "HANG") return;
    if (pendingPrompt === "APPROVAL") {
      pendingApprovalId = 9001;
      write({
        id: pendingApprovalId,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: sessionId,
          turnId: "turn-fake",
          itemId: "command-fake",
          command: "printf approved",
          cwd: process.cwd(),
          reason: "test approval",
        },
      });
      return;
    }
    finishTurn(pendingPrompt);
    return;
  }
  if (pendingApprovalId !== undefined && message.id === pendingApprovalId) {
    const decision = message.result?.decision ?? "decline";
    finishTurn(`APPROVAL:${decision}`);
  }
});

function finishTurn(prompt) {
  let text = `CODEX:${prompt}`;
  if (prompt.includes("VERIFY_PROJECT_PLATFORM")) {
    const artifactDirectory = developerInstructions.match(/Hibro 产物目录：([^\n]+)/)?.[1]?.trim();
    if (artifactDirectory) {
      mkdirSync(artifactDirectory, { recursive: true });
      writeFileSync(
        `${artifactDirectory}/stock-research-report.md`,
        "# 股票研究报告\n\nDocker Project 平台全链路验证通过。\n",
      );
    }
    text = [
      "CODEX:VERIFY_PROJECT_PLATFORM",
      `SECRET_PRESENT=${process.env.MARKET_API_TOKEN === "docker-project-secret"}`,
      `SOURCE_PRESENT=${prompt.includes("https://example.com/stock-feed")}`,
      `ARTIFACT_WRITTEN=${Boolean(artifactDirectory)}`,
    ].join(":");
  }
  write({
    method: "item/completed",
    params: {
      item: { id: "item-1", type: "agentMessage", text },
    },
  });
  write({
    method: "turn/completed",
    params: { turn: { id: "turn-fake", status: "completed" } },
  });
}
