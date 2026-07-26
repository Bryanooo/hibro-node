import { readFileSync } from "node:fs";

export function hibroNodeVersion(): string {
  try {
    return readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
  } catch {
    return "development";
  }
}
