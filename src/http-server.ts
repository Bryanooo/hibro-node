import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { SocketAddress } from "node:net";
import {
  isTerminalStatus,
  type AgentDefinition,
  type CreateRunInput,
  type SystemSettings,
} from "./domain.ts";
import type { RunManager } from "./run-manager.ts";
import { arch, freemem, hostname, platform, release, totalmem } from "node:os";
import { createReadStream } from "node:fs";
import { readFile, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { CONSOLE_CSS, CONSOLE_HTML, CONSOLE_JS } from "./console-assets.ts";
import { CORE_MESSAGE_TYPES, HIBRO_CORE_PROTOCOL } from "./core-protocol.ts";
import type { ConversationService } from "./conversation-service.ts";
import { isNodeControlRequestAuthorized } from "./node-access.ts";

export interface HttpServerOptions {
  host: string;
  port: number;
  manager: RunManager;
  conversations?: ConversationService | undefined;
  controlToken: string;
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function publicErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(
      /\b(token|password|secret|authorization|access[_-]?key(?:id|secret)?)\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    )
    .replace(/(?:\/(?:Users|home|app|var|opt|etc|private|tmp)\/)[^\s"'`]+/g, "[path]")
    .replace(/[A-Za-z]:\\[^\s"'`]+/g, "[path]")
    .slice(0, 500);
}

function sendAsset(
  response: ServerResponse,
  contentType: string,
  body: string,
): void {
  response.writeHead(200, {
    "content-type": `${contentType}; charset=utf-8`,
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}

async function sendImage(response: ServerResponse, filename: string): Promise<void> {
  const body = await readFile(join(import.meta.dirname, "..", "assets", "brand", filename));
  response.writeHead(200, {
    "content-type": "image/png",
    "cache-control": "public, max-age=3600",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendDownload(
  response: ServerResponse,
  filename: string,
  body: string,
): void {
  response.writeHead(200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": `attachment; filename="${filename.replace(/[^a-z0-9._-]/gi, "-")}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new Error("content-type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) {
      throw new Error("Request body exceeds 1 MiB");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function runRoute(
  pathname: string,
): { runId: string; action?: string | undefined } | undefined {
  const match = pathname.match(
    /^\/v1\/runs\/([a-f0-9-]{36})(?:\/(events|cancel))?$/i,
  );
  return match
    ? { runId: match[1] as string, action: match[2] as string | undefined }
    : undefined;
}

export function createHibroHttpServer(options: HttpServerOptions): Server {
  const { manager, conversations } = options;
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://hibro-node.local");
      const isPublic =
        request.method === "GET" &&
        (url.pathname === "/health" ||
          url.pathname === "/console/favicon.png" ||
          url.pathname === "/console/hibro-mark.png");
      if (
        !isPublic &&
        !isNodeControlRequestAuthorized(request, options.controlToken)
      ) {
        response.writeHead(401, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "www-authenticate": 'Basic realm="Hibro Node", charset="UTF-8"',
        });
        response.end('{"error":"authentication_required"}\n');
        return;
      }
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method ?? "")) {
        const origin = request.headers.origin;
        if (origin) {
          const expectedOrigin = `${request.headers["x-forwarded-proto"] ?? "http"}://${request.headers.host}`;
          if (origin !== expectedOrigin) {
            sendJson(response, 403, { error: "origin_not_allowed" });
            return;
          }
        }
      }
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(302, { location: "/console" });
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/console") {
        sendAsset(response, "text/html", CONSOLE_HTML);
        return;
      }
      if (request.method === "GET" && url.pathname === "/console/styles.css") {
        sendAsset(response, "text/css", CONSOLE_CSS);
        return;
      }
      if (request.method === "GET" && url.pathname === "/console/app.js") {
        sendAsset(response, "text/javascript", CONSOLE_JS);
        return;
      }
      if (request.method === "GET" && url.pathname === "/console/hibro-mark.png") {
        await sendImage(response, "hibro-app-icon.png");
        return;
      }
      if (request.method === "GET" && url.pathname === "/console/favicon.png") {
        await sendImage(response, "hibro-favicon.png");
        return;
      }
      if (request.method === "GET" && url.pathname === "/health") {
        const settings = manager.getSettings();
        sendJson(response, 200, {
          status: "ok",
          service: "hibro-node",
          nodeName: settings.nodeName,
          hostname: hostname(),
          uptimeSeconds: process.uptime(),
          nodeVersion: process.version,
          cwd: process.cwd(),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/capabilities") {
        const engines = await manager.doctorEngines();
        const settings = manager.getSettings();
        sendJson(response, 200, {
          engines: engines.map(({ id, doctor }) => ({
            id,
            available: doctor.ready,
            ...doctor,
          })),
          transports: ["http", "sse"],
          conversations: conversations?.capabilities(),
          core: {
            ...manager.getCoreConnection(),
            enabled: settings.coreEnabled,
            url: settings.coreUrl,
            mode: settings.coreEnabled
              ? manager.getCoreConnection().connected
                ? "connected"
                : "configured"
              : "standalone",
            transportImplemented: true,
          },
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/protocol") {
        sendJson(response, 200, {
          protocol: HIBRO_CORE_PROTOCOL,
          status: "specified",
          canonicalTransport: "wss",
          edgeAuthentication: "node-token",
          messageTypes: CORE_MESSAGE_TYPES,
          delivery: {
            semantics: "at-least-once",
            ordering: "per-connection sequence",
            acknowledgement: "explicit message.ack",
            idempotency: "messageId and idempotencyKey",
          },
          artifacts: {
            metadata: "websocket",
            largeContent: "signed-https-upload",
          },
          runtimeTransportImplemented: true,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/capabilities/refresh") {
        manager.clearDoctorCache();
        const engines = await manager.doctorEngines();
        sendJson(response, 200, {
          engines: engines.map(({ id, doctor }) => ({ id, ...doctor })),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/settings") {
        const settings = manager.getSettings();
        sendJson(response, 200, {
          ...settings,
          coreToken: "",
          coreTokenConfigured: Boolean(settings.coreToken),
        });
        return;
      }
      if (request.method === "PUT" && url.pathname === "/v1/settings") {
        const body = (await readJsonBody(request)) as Partial<SystemSettings>;
        if (body.coreToken === "") delete body.coreToken;
        const settings = await manager.updateSettings(body);
        sendJson(response, 200, {
          ...settings,
          coreToken: "",
          coreTokenConfigured: Boolean(settings.coreToken),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/system") {
        const disk = await statfs(manager.store.rootDir);
        sendJson(response, 200, {
          hostname: hostname(),
          platform: platform(),
          arch: arch(),
          release: release(),
          nodeVersion: process.version,
          pid: process.pid,
          uptimeSeconds: process.uptime(),
          memory: { totalBytes: totalmem(), freeBytes: freemem() },
          disk: {
            totalBytes: disk.blocks * disk.bsize,
            freeBytes: disk.bavail * disk.bsize,
          },
          dataDir: manager.store.rootDir,
          cwd: process.cwd(),
          activeRuns: manager.activeRunCount(),
          container: process.env.HIBRO_CONTAINER === "docker",
          storage: {
            engine: manager.store.databasePath ? "sqlite" : "filesystem",
            databasePath: manager.store.databasePath,
          },
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/workspaces") {
        sendJson(response, 200, { workspaces: await manager.listWorkspaces() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/artifacts") {
        sendJson(response, 200, { artifacts: await manager.listArtifacts() });
        return;
      }
      const artifactMatch = url.pathname.match(
        /^\/v1\/artifacts\/([a-z0-9_-]+)(?:\/(download|content))?$/i,
      );
      if (request.method === "GET" && artifactMatch) {
        const artifact = (await manager.listArtifacts()).find(
          (item) => item.id === artifactMatch[1],
        );
        if (!artifact) {
          sendJson(response, 404, { error: "artifact_not_found" });
          return;
        }
        if (!artifactMatch[2]) {
          sendJson(response, 200, { artifact });
          return;
        }
        const fileName =
          artifact.fileName ??
          `hibro-${artifact.engine}-${artifact.runId.slice(0, 8)}.md`;
        if (artifact.localPath) {
          const info = await stat(artifact.localPath);
          const range = parseByteRange(request.headers.range, info.size);
          response.writeHead(range ? 206 : 200, {
            "content-type": artifact.contentType ?? "application/octet-stream",
            "content-disposition": `${artifactMatch[2] === "download" ? "attachment" : "inline"}; filename="${fileName.replace(/[^a-z0-9._-]/gi, "-")}"`,
            "content-length": String(range ? range.end - range.start + 1 : info.size),
            "accept-ranges": "bytes",
            ...(range
              ? { "content-range": `bytes ${range.start}-${range.end}/${info.size}` }
              : {}),
            "cache-control": "no-store",
            "content-security-policy":
              artifact.previewKind === "html"
                ? "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline';"
                : "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self';",
            "x-content-type-options": "nosniff",
          });
          createReadStream(artifact.localPath, range ?? {}).pipe(response);
          return;
        }
        if (artifact.content === undefined) {
          sendJson(response, 409, { error: "artifact_content_unavailable" });
          return;
        }
        const binary =
          artifact.encoding === "base64"
            ? Buffer.from(artifact.content, "base64")
            : Buffer.from(artifact.content, "utf8");
        response.writeHead(200, {
          "content-type":
            artifact.contentType ??
            (artifact.encoding === "utf8"
              ? "text/plain; charset=utf-8"
              : "application/octet-stream"),
          "content-disposition": `${artifactMatch[2] === "download" ? "attachment" : "inline"}; filename="${fileName.replace(/[^a-z0-9._-]/gi, "-")}"`,
          "cache-control": "no-store",
          "content-security-policy":
            artifact.previewKind === "html"
              ? "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline';"
              : "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:;",
          "x-content-type-options": "nosniff",
        });
        response.end(binary);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/agents") {
        sendJson(response, 200, { agents: await manager.listAgents() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/agents") {
        if (!manager.agents) {
          sendJson(response, 409, { error: "agent_registry_unavailable" });
          return;
        }
        const body = (await readJsonBody(request)) as Partial<AgentDefinition>;
        if (!body.name || !body.engine || !body.source || !body.workspace) {
          throw new Error("name, engine, source and workspace are required");
        }
        const agent = await manager.agents.create({
          name: body.name,
          description: body.description,
          engine: body.engine,
          enabled: body.enabled ?? true,
          source: body.source,
          workspace: body.workspace,
          maxConcurrency: body.maxConcurrency ?? 1,
          model: body.model,
          instructions: body.instructions,
          allowedTools: body.allowedTools,
          allowDangerousSandbox: body.allowDangerousSandbox ?? false,
        });
        sendJson(response, 201, agent);
        return;
      }
      const agentMatch = url.pathname.match(/^\/v1\/agents\/([a-z0-9._-]{2,64})$/i);
      if (request.method === "GET" && agentMatch) {
        const agent = manager.getAgent(agentMatch[1] as string);
        sendJson(response, agent ? 200 : 404, agent ?? { error: "agent_not_found" });
        return;
      }
      if (request.method === "PUT" && agentMatch) {
        if (!manager.agents) {
          sendJson(response, 409, { error: "agent_registry_unavailable" });
          return;
        }
        const body = (await readJsonBody(request)) as Partial<AgentDefinition>;
        const existing = manager.getAgent(agentMatch[1] as string);
        const name = body.name ?? existing?.name;
        const engine = body.engine ?? existing?.engine;
        const source = body.source ?? existing?.source;
        const workspace = body.workspace ?? existing?.workspace;
        if (!name || !engine || !source || !workspace) {
          throw new Error("name, engine, source and workspace are required");
        }
        const agent = await manager.agents.upsert({
          ...existing,
          ...body,
          id: agentMatch[1] as string,
          name,
          engine,
          source,
          workspace,
        });
        sendJson(response, 200, agent);
        return;
      }
      if (request.method === "DELETE" && agentMatch) {
        const deleted = await manager.deleteAgent(agentMatch[1] as string);
        sendJson(
          response,
          deleted ? 200 : 404,
          deleted ? { deleted: true } : { error: "agent_not_found" },
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/conversations") {
        if (!conversations) {
          sendJson(response, 503, { error: "conversations_unavailable" });
          return;
        }
        sendJson(response, 200, {
          conversations: conversations.list(),
          capabilities: conversations.capabilities(),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/conversations") {
        if (!conversations) {
          sendJson(response, 503, { error: "conversations_unavailable" });
          return;
        }
        const body = (await readJsonBody(request)) as {
          id?: string;
          title?: string;
          agentId?: string;
          source?: "node" | "core";
          createdBy?: string;
        };
        if (!body.agentId) throw new Error("agentId is required");
        sendJson(
          response,
          201,
          conversations.create({
            agentId: body.agentId,
            ...(body.id ? { id: body.id } : {}),
            ...(body.title ? { title: body.title } : {}),
            ...(body.source ? { source: body.source } : {}),
            ...(body.createdBy ? { createdBy: body.createdBy } : {}),
          }),
        );
        return;
      }
      const conversationMatch = url.pathname.match(
        /^\/v1\/conversations\/(conv_[a-f0-9-]+)(?:\/(messages|events|cancel|archive|approval))?(?:\/([a-z0-9_-]+))?$/i,
      );
      if (conversationMatch && !conversations) {
        sendJson(response, 503, { error: "conversations_unavailable" });
        return;
      }
      const conversationId = conversationMatch?.[1] as string | undefined;
      const conversationAction = conversationMatch?.[2] as string | undefined;
      const conversationChildId = conversationMatch?.[3] as string | undefined;
      if (
        request.method === "GET" &&
        conversationId &&
        !conversationAction
      ) {
        const detail = conversations?.detail(conversationId);
        sendJson(
          response,
          detail ? 200 : 404,
          detail ?? { error: "conversation_not_found" },
        );
        return;
      }
      if (
        request.method === "PATCH" &&
        conversationId &&
        !conversationAction
      ) {
        const body = (await readJsonBody(request)) as { title?: string };
        if (!body.title) throw new Error("title is required");
        sendJson(response, 200, conversations?.rename(conversationId, body.title));
        return;
      }
      if (
        request.method === "POST" &&
        conversationId &&
        conversationAction === "messages"
      ) {
        const body = (await readJsonBody(request)) as {
          content?: string;
          userMessageId?: string;
          assistantMessageId?: string;
          createdBy?: string;
        };
        if (!body.content) throw new Error("content is required");
        sendJson(
          response,
          202,
          await conversations?.sendMessage(conversationId, {
            content: body.content,
            ...(body.userMessageId ? { userMessageId: body.userMessageId } : {}),
            ...(body.assistantMessageId
              ? { assistantMessageId: body.assistantMessageId }
              : {}),
            ...(body.createdBy ? { createdBy: body.createdBy } : {}),
          }),
        );
        return;
      }
      if (
        request.method === "POST" &&
        conversationId &&
        conversationAction === "cancel"
      ) {
        sendJson(response, 202, await conversations?.cancel(conversationId));
        return;
      }
      if (
        request.method === "POST" &&
        conversationId &&
        conversationAction === "archive"
      ) {
        sendJson(response, 200, conversations?.archive(conversationId));
        return;
      }
      if (
        request.method === "POST" &&
        conversationId &&
        conversationAction === "approval" &&
        conversationChildId
      ) {
        const body = (await readJsonBody(request)) as {
          decision?: "allow_once" | "allow_always" | "deny";
        };
        if (!body.decision) throw new Error("decision is required");
        sendJson(
          response,
          202,
          await conversations?.decideApproval(
            conversationId,
            conversationChildId,
            body.decision,
          ),
        );
        return;
      }
      if (
        request.method === "GET" &&
        conversationId &&
        conversationAction === "events"
      ) {
        const after = Number(url.searchParams.get("after") ?? "0");
        if (!Number.isInteger(after) || after < 0) {
          throw new Error("after must be a non-negative integer");
        }
        const existing = conversations?.detail(conversationId);
        if (!existing) {
          sendJson(response, 404, { error: "conversation_not_found" });
          return;
        }
        const replay = conversations?.eventsAfter(conversationId, after) ?? [];
        if (url.searchParams.get("format") === "json") {
          sendJson(response, 200, { events: replay });
          return;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        const writeEvent = (event: unknown): void => {
          response.write(
            `event: conversation-event\ndata: ${JSON.stringify(event)}\n\n`,
          );
        };
        replay.forEach(writeEvent);
        const unsubscribe = conversations?.subscribe(conversationId, writeEvent);
        const heartbeat = setInterval(
          () => response.write(": heartbeat\n\n"),
          15_000,
        );
        heartbeat.unref();
        request.once("close", () => {
          clearInterval(heartbeat);
          unsubscribe?.();
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/runs") {
        const body = (await readJsonBody(request)) as CreateRunInput;
        const run = await manager.create(body);
        sendJson(response, 202, run);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/runs") {
        sendJson(response, 200, { runs: await manager.list() });
        return;
      }
      const approvalRoute = url.pathname.match(
        /^\/v1\/runs\/([a-f0-9-]{36})\/approval\/([^/]+)$/i,
      );
      if (approvalRoute && request.method === "POST") {
        const body = (await readJsonBody(request)) as {
          decision?: "allow_once" | "allow_always" | "deny";
        };
        if (!["allow_once", "allow_always", "deny"].includes(body.decision ?? "")) {
          throw new Error("invalid approval decision");
        }
        await manager.decideApproval(
          approvalRoute[1] as string,
          decodeURIComponent(approvalRoute[2] as string),
          body.decision as "allow_once" | "allow_always" | "deny",
        );
        sendJson(response, 202, { accepted: true });
        return;
      }

      const route = runRoute(url.pathname);
      if (route && request.method === "GET" && !route.action) {
        const run = await manager.get(route.runId);
        sendJson(response, run ? 200 : 404, run ?? { error: "run_not_found" });
        return;
      }
      if (route?.action === "cancel" && request.method === "POST") {
        const run = await manager.cancel(route.runId);
        sendJson(response, run ? 202 : 404, run ?? { error: "run_not_found" });
        return;
      }
      if (route?.action === "events" && request.method === "GET") {
        const run = await manager.get(route.runId);
        if (!run) {
          sendJson(response, 404, { error: "run_not_found" });
          return;
        }
        const after = Number(url.searchParams.get("after") ?? "0");
        if (!Number.isInteger(after) || after < 0) {
          sendJson(response, 400, {
            error: "bad_request",
            message: "after must be a non-negative integer",
          });
          return;
        }
        if (url.searchParams.get("format") === "json") {
          sendJson(response, 200, {
            events: await manager.eventsAfter(route.runId, after),
          });
          return;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        const writeEvent = (event: unknown): void => {
          response.write(`event: run-event\ndata: ${JSON.stringify(event)}\n\n`);
        };
        for (const event of await manager.eventsAfter(route.runId, after)) {
          writeEvent(event);
        }
        if (isTerminalStatus(run.status)) {
          response.end();
          return;
        }
        const unsubscribe = manager.subscribe(route.runId, writeEvent);
        const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
        heartbeat.unref();
        request.once("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 400, {
        error: "bad_request",
        message: publicErrorMessage(error),
      });
    }
  });
}

function parseByteRange(
  value: string | undefined,
  sizeBytes: number,
): { start: number; end: number } | undefined {
  if (!value) return undefined;
  const match = value.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) throw new Error("invalid range");
  const left = match[1] ? Number(match[1]) : undefined;
  const right = match[2] ? Number(match[2]) : undefined;
  let start: number;
  let end: number;
  if (left === undefined) {
    if (!right || right < 1) throw new Error("invalid range");
    start = Math.max(0, sizeBytes - right);
    end = sizeBytes - 1;
  } else {
    start = left;
    end = right === undefined ? sizeBytes - 1 : Math.min(right, sizeBytes - 1);
  }
  if (start < 0 || start >= sizeBytes || end < start) {
    throw new Error("range not satisfiable");
  }
  return { start, end };
}

export async function listen(
  server: Server,
  host: string,
  port: number,
): Promise<SocketAddress> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server.address() as SocketAddress;
}
