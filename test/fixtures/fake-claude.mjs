#!/usr/bin/env node
const args = process.argv.slice(2);

if (args[0] === "--version") {
  process.stdout.write("2.1.218 (Claude Code fake)\n");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(
    `${JSON.stringify({
      loggedIn: true,
      authMethod: "test",
      apiProvider: "fake",
    })}\n`,
  );
  process.exit(0);
}

const sessionIndex = args.indexOf("--resume");
const sessionId =
  sessionIndex >= 0 ? args[sessionIndex + 1] : "11111111-1111-4111-8111-111111111111";
const promptIndex = args.indexOf("-p");
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : "";

process.stdout.write(
  `${JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: "fake-sonnet",
    tools: [],
    claude_code_version: "2.1.218",
  })}\n`,
);

if (prompt === "WAIT") {
  setTimeout(() => {}, 60_000);
} else if (prompt === "APPROVAL") {
  const settingsIndex = args.indexOf("--settings");
  const settings =
    settingsIndex >= 0 ? JSON.parse(args[settingsIndex + 1]) : undefined;
  const hook = settings?.hooks?.PreToolUse?.[0]?.hooks?.[0];
  if (!hook?.url) process.exit(3);
  const response = await fetch(hook.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.HIBRO_APPROVAL_TOKEN}`,
    },
    body: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "claude-approval-1",
      tool_input: { command: "printf approved" },
      cwd: process.cwd(),
    }),
  });
  const decision = await response.json();
  const permission =
    decision?.hookSpecificOutput?.permissionDecision ?? "deny";
  const result = `APPROVAL:${permission}`;
  process.stdout.write(
    `${JSON.stringify({
      type: "assistant",
      session_id: sessionId,
      message: {
        role: "assistant",
        content: [{ type: "text", text: result }],
      },
    })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result,
      session_id: sessionId,
      duration_ms: 10,
      total_cost_usd: 0,
    })}\n`,
  );
} else if (prompt === "FAIL") {
  process.stdout.write(
    `${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Synthetic failure",
      terminal_reason: "api_error",
      session_id: sessionId,
    })}\n`,
  );
  process.exit(1);
} else {
  const toolsIndex = args.indexOf("--tools");
  const result =
    prompt === "ARGS"
      ? JSON.stringify({ tools: toolsIndex >= 0 ? args[toolsIndex + 1] : null })
      : `ACK:${prompt}`;
  process.stdout.write(
    `${JSON.stringify({
      type: "assistant",
      session_id: sessionId,
      message: {
        role: "assistant",
        content: [{ type: "text", text: result }],
      },
    })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result,
      session_id: sessionId,
      duration_ms: 10,
      total_cost_usd: 0,
    })}\n`,
  );
}
