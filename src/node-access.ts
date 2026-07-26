import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IncomingMessage } from "node:http";

export interface NodeControlCredential {
  token: string;
  generated: boolean;
  path?: string | undefined;
}

export const NODE_CONTROL_SESSION_COOKIE = "hibro_node_session";
export const NODE_CONTROL_SESSION_TTL_SECONDS = 12 * 60 * 60;

export async function loadNodeControlCredential(
  dataDir: string,
  configuredToken = process.env.HIBRO_NODE_CONTROL_TOKEN,
): Promise<NodeControlCredential> {
  const fromEnvironment = configuredToken?.trim();
  if (fromEnvironment) {
    if (fromEnvironment.length < 24) {
      throw new Error("HIBRO_NODE_CONTROL_TOKEN must contain at least 24 characters");
    }
    return { token: fromEnvironment, generated: false };
  }

  const path = join(dataDir, "control-token");
  try {
    const token = (await readFile(path, "utf8")).trim();
    if (token.length < 24) throw new Error("Stored Node control token is invalid");
    await chmod(path, 0o600);
    return { token, generated: false, path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const token = randomBytes(32).toString("base64url");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
  return { token, generated: true, path };
}

function tokensEqual(suppliedToken: string, expectedToken: string): boolean {
  const supplied = Buffer.from(suppliedToken);
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function basicToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Basic ")) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
  } catch {
    return undefined;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0 || decoded.slice(0, separator) !== "hibro") return undefined;
  return decoded.slice(separator + 1);
}

function sessionSignature(expectedToken: string, expiresAt: number): string {
  return createHmac("sha256", expectedToken)
    .update(`hibro-node-console-v1:${expiresAt}`)
    .digest("base64url");
}

export function createNodeControlSession(
  expectedToken: string,
  now = Date.now(),
): string {
  const expiresAt = Math.floor(now / 1_000) + NODE_CONTROL_SESSION_TTL_SECONDS;
  return `${expiresAt}.${sessionSignature(expectedToken, expiresAt)}`;
}

export function isNodeControlSessionValid(
  value: string,
  expectedToken: string,
  now = Date.now(),
): boolean {
  const [expiresRaw, suppliedSignature, extra] = value.split(".");
  if (!expiresRaw || !suppliedSignature || extra !== undefined) return false;
  if (!/^\d+$/.test(expiresRaw)) return false;
  const expiresAt = Number(expiresRaw);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Math.floor(now / 1_000) ||
    expiresAt > Math.floor(now / 1_000) + NODE_CONTROL_SESSION_TTL_SECONDS + 60
  ) {
    return false;
  }
  return tokensEqual(
    suppliedSignature,
    sessionSignature(expectedToken, expiresAt),
  );
}

function sessionCookie(request: IncomingMessage): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== NODE_CONTROL_SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function isNodeControlRequestAuthorized(
  request: IncomingMessage,
  expectedToken: string,
): boolean {
  const suppliedBasicToken = basicToken(request);
  if (
    suppliedBasicToken !== undefined &&
    tokensEqual(suppliedBasicToken, expectedToken)
  ) {
    return true;
  }
  const suppliedSession = sessionCookie(request);
  return suppliedSession
    ? isNodeControlSessionValid(suppliedSession, expectedToken)
    : false;
}
