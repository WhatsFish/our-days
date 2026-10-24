import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { pool } from "./db";
import { AppError, uuid } from "./domain";
import { checkCapacity, mediaRoot, uploadLimit } from "./media";

export type SpecialMaterial = {
  id: string; title: string; original_ext: "jpg" | "png" | "webp";
  original_bytes: string; width: number; height: number; created_at: string;
};

export function specialMediaPath(id: string, suffix: string) {
  uuid.parse(id);
  z.enum(["original.jpg", "original.png", "original.webp", "preview.jpg"]).parse(suffix);
  return path.join(mediaRoot(), "special", `${id}.${suffix}`);
}

export async function uploadSpecialMaterial(buffer: Buffer, title: string) {
  const safeTitle = z.string().trim().min(1).max(160).parse(title);
  if (!buffer.length || buffer.length > uploadLimit) throw new AppError(413, "upload_size", "单张成品图上限 25MB");
  let preview: Buffer;
  let metadata;
  try {
    const image = sharp(buffer, { limitInputPixels: 40_000_000, failOn: "warning" });
    metadata = await image.metadata();
    if (!["jpeg", "png", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) > 1) {
      throw new AppError(400, "format", "特殊素材支持静态 JPEG、PNG、WebP；请勿上传 ZIP、HEIC 或动图");
    }
    preview = await image.rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, "decode", "无法读取图片，请导出为 JPEG 或 PNG 后重新上传");
  }
  const ext = metadata.format === "jpeg" ? "jpg" : metadata.format === "png" ? "png" : "webp";
  const sha = createHash("sha256").update(buffer).digest("hex");
  const id = randomUUID();
  const client = await pool.connect();
  const written: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(7316,2)");
    const [existing] = (await client.query<{ id: string }>("SELECT id FROM special_materials WHERE sha256=$1", [sha])).rows;
    if (existing) return { id: existing.id, duplicate: true };
    await checkCapacity(buffer.length + preview.length);
    await mkdir(path.join(mediaRoot(), "special"), { mode: 0o700, recursive: true });
    for (const [file, bytes] of [
      [specialMediaPath(id, `original.${ext}`), buffer],
      [specialMediaPath(id, "preview.jpg"), preview],
    ] as const) {
      await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
      written.push(file);
    }
    await client.query(`INSERT INTO special_materials(id,sha256,title,original_ext,original_bytes,preview_bytes,width,height)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, sha, safeTitle, ext, buffer.length, preview.length, metadata.width, metadata.height]);
    return { id, duplicate: false };
  } catch (error) {
    for (const file of written) await unlink(file);
    throw error;
  } finally {
    await client.query("SELECT pg_advisory_unlock(7316,2)");
    client.release();
  }
}
