import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IncomingMessage } from "node:http";

export interface NodeControlCredential {
  token: string;
  generated: boolean;
  path?: string | undefined;
}

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

export function isNodeControlRequestAuthorized(
  request: IncomingMessage,
  expectedToken: string,
): boolean {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0 || decoded.slice(0, separator) !== "hibro") return false;
  const supplied = Buffer.from(decoded.slice(separator + 1));
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

