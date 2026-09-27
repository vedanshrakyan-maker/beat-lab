import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomToken } from "@/lib/crypto";

/**
 * File storage for manual-verification screen recordings. v0.1 writes to local disk
 * (./uploads, git-ignored). Swap for S3/GCS with signed URLs in production.
 */
const ROOT = path.join(process.cwd(), "uploads");

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const ALLOWED_UPLOAD_TYPES = ["video/mp4", "video/quicktime", "video/webm", "image/png", "image/jpeg"];

export async function saveUpload(buffer: Buffer, originalName: string): Promise<string> {
  await mkdir(ROOT, { recursive: true });
  const ext = path
    .extname(originalName)
    .toLowerCase()
    .replace(/[^.a-z0-9]/g, "")
    .slice(0, 8);
  const key = `${Date.now()}_${randomToken(8)}${ext}`;
  await writeFile(path.join(ROOT, key), buffer);
  return key;
}

export async function readUpload(key: string): Promise<Buffer> {
  if (!/^[\w.]+$/.test(key)) throw new Error("Invalid storage key");
  return readFile(path.join(ROOT, key));
}
