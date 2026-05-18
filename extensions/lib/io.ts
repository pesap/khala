import { promises as fs } from "node:fs";
import path from "node:path";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorCode(error: unknown): string | null {
  if (!isRecord(error)) return null;
  const code = error.code;
  return typeof code === "string" ? code : null;
}

function hasErrorCode(error: unknown, codes: readonly string[]): boolean {
  const code = getErrorCode(error);
  return code !== null && codes.includes(code);
}

export function isMissingPathError(error: unknown): boolean {
  return hasErrorCode(error, ["ENOENT", "ENOTDIR"]);
}

export function isRecoverableLearningStoreError(error: unknown): boolean {
  return hasErrorCode(error, ["EACCES", "EPERM", "EROFS", "ENOENT", "ENOTDIR"]);
}

export function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

export async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readText(filePath);
  } catch (error) {
    if (isMissingPathError(error)) return "";
    throw new Error(`Failed to read ${filePath}: ${formatErrorMessage(error)}`);
  }
}

export async function readTextTailIfExists(
  filePath: string,
  maxBytes: number,
): Promise<string> {
  const stats = await statIfExists(filePath);
  if (!stats?.isFile()) return "";

  const byteLimit = Math.max(1, Math.floor(maxBytes));
  if (stats.size <= byteLimit) return readText(filePath);

  const start = stats.size - byteLimit;
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(byteLimit);
    const { bytesRead } = await handle.read(buffer, 0, byteLimit, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const firstNewline = text.indexOf("\n");
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
  } finally {
    await handle.close();
  }
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw new Error(`Failed to check whether ${filePath} exists: ${formatErrorMessage(error)}`);
  }
}

export async function statIfExists(filePath: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw new Error(`Failed to stat ${filePath}: ${formatErrorMessage(error)}`);
  }
}

export async function ensureFile(filePath: string, initialContent: string): Promise<void> {
  const present = await exists(filePath);
  if (present) return;
  await fs.writeFile(filePath, initialContent, "utf8");
}

export async function appendLine(filePath: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${line}\n`, "utf8");
}
