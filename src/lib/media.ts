import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { ExifTool } from "exiftool-vendored";
import * as yauzl from "yauzl";
import { pool, query } from "./db";
import { AppError, assertArchiveEntry, uuid } from "./domain";
import { captureLabel, embeddedPlace } from "./photo-metadata";

export const uploadLimit = 25 * 1024 * 1024;
export function mediaRoot() {
  if (!process.env.MEDIA_ROOT || !path.isAbsolute(process.env.MEDIA_ROOT)) {
    throw new AppError(503, "storage_config", "尚未配置私有照片存储");
  }
  return process.env.MEDIA_ROOT;
}
export function mediaPath(id: string, suffix: string) {
  uuid.parse(id);
  if (!/^(original|display|thumb|upload)\.[a-z]+$/.test(suffix)) throw new Error("Invalid suffix");
  return path.join(mediaRoot(), `${id}.${suffix}`);
}
export async function storageBytes() {
  await mkdir(mediaRoot(), { recursive: true, mode: 0o700 });
  let bytes = 0;
  for (const file of await readdir(mediaRoot(), { withFileTypes: true })) {
    if (file.isFile()) bytes += (await stat(path.join(mediaRoot(), file.name))).size;
    if (file.isDirectory() && file.name === "special") {
      for (const special of await readdir(path.join(mediaRoot(), "special"), { withFileTypes: true })) {
        if (special.isFile()) bytes += (await stat(path.join(mediaRoot(), "special", special.name))).size;
      }
    }
  }
  return bytes;
}
export async function checkCapacity(bytes: number) {
  const quota = Number(process.env.MEDIA_QUOTA_MB ?? 200) * 1024 * 1024;
  if (!Number.isFinite(quota) || quota <= 0) throw new AppError(503, "quota_config", "存储额度配置无效");
  if ((await storageBytes()) + bytes > quota) throw new AppError(507, "quota", "照片存储额度不足，请释放空间或扩容");
}
export async function enqueueUpload(buffer: Buffer, zip: boolean) {
  if (!buffer.length || buffer.length > uploadLimit) throw new AppError(413, "upload_size", "单文件上限 25MB");
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(7316,2)");
    await checkCapacity(buffer.length);
    const id = randomUUID();
    const ext = zip ? "zip" : "image";
    const file = mediaPath(id, `upload.${ext}`);
    await writeFile(file, buffer, { mode: 0o600, flag: "wx" });
    try { await client.query("INSERT INTO imports(id,ext) VALUES($1,$2)", [id, ext]); }
    catch (error) { await unlink(file); throw error; }
    return id;
  } finally {
    await client.query("SELECT pg_advisory_unlock(7316,2)");
    client.release();
  }
}

export async function importPhoto(buffer: Buffer, tool: ExifTool): Promise<"added" | "duplicate"> {
  const sha = createHash("sha256").update(buffer).digest("hex");
  if ((await query("SELECT id FROM photos WHERE sha256=$1", [sha])).length) return "duplicate";
  const image = sharp(buffer, { limitInputPixels: 40_000_000, failOn: "warning" });
  let metadata;
  try { metadata = await image.metadata(); }
  catch { throw new AppError(400, "decode", "无法解码图片；HEIC 请先导出为 JPEG 原图"); }
  if (!["jpeg", "png", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) > 1) {
    throw new AppError(400, "format", "首版支持静态 JPEG、PNG、WebP；HEIC/动图请先转换");
  }
  const id = randomUUID();
  const ext = metadata.format === "jpeg" ? "jpg" : metadata.format!;
  const original = mediaPath(id, `original.${ext}`);
  const display = await image.clone().rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  const thumb = await image.clone().rotate().resize(360, 360, { fit: "inside", withoutEnlargement: true }).webp({ quality: 70 }).toBuffer();
  const client = await pool.connect();
  const written: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(7316,2)");
    await checkCapacity(buffer.length + display.length + thumb.length);
    for (const [file, data] of [[original, buffer], [mediaPath(id, "display.webp"), display], [mediaPath(id, "thumb.webp"), thumb]] as const) {
      await writeFile(file, data, { mode: 0o600, flag: "wx" });
      written.push(file);
    }
    const tags = await tool.read(original);
    const rawDate = tags.DateTimeOriginal?.toString() ?? null;
    const lat = typeof tags.GPSLatitude === "number" ? tags.GPSLatitude : null;
    const lon = typeof tags.GPSLongitude === "number" ? tags.GPSLongitude : null;
    const place = embeddedPlace(Object.fromEntries(Object.entries(tags)));
    const result = await client.query(
      `INSERT INTO photos(id,sha256,original_ext,original_bytes,captured_raw,latitude,longitude,date_label,place_label,metadata_place)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) ON CONFLICT(sha256) DO NOTHING RETURNING id`,
      [id, sha, ext, buffer.length, rawDate, lat, lon, captureLabel(rawDate), place]);
    if (!result.rowCount) {
      for (const file of written) await unlink(file);
      return "duplicate";
    }
    return "added";
  } catch (error) {
    for (const file of written) await unlink(file);
    throw error;
  } finally {
    await client.query("SELECT pg_advisory_unlock(7316,2)");
    client.release();
  }
}

async function eachZip(file: string, consume: (buffer: Buffer, index: number) => Promise<void>) {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (err, value) => err
      ? reject(new AppError(400, "zip_invalid", "无法读取 ZIP，请重新打包")) : resolve(value!)));
  await new Promise<void>((resolve, reject) => {
    let count = 0, total = 0;
    let stopped = false;
    function fail(error: unknown) { stopped = true; zip.close(); reject(error); }
    zip.on("error", () => fail(new AppError(400, "zip_invalid", "ZIP 已损坏或包含不安全条目")));
    zip.on("end", resolve);
    zip.on("entry", (entry: yauzl.Entry) => {
      void (async () => {
        if (++count > 100) throw new AppError(400, "zip_count", "每个 ZIP 最多 100 个条目");
        assertArchiveEntry(entry.fileName, entry.uncompressedSize, entry.compressedSize);
        if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000 || (entry.generalPurposeBitFlag & 1)) {
          throw new AppError(400, "zip_type", "不支持符号链接或加密压缩包");
        }
        if (entry.fileName.endsWith("/") || entry.fileName.startsWith("__MACOSX/") || path.basename(entry.fileName).startsWith(".")) {
          if (!stopped) zip.readEntry();
          return;
        }
        total += entry.uncompressedSize;
        if (total > 100 * 1024 * 1024) throw new AppError(400, "zip_size", "ZIP 解压总量上限 100MB");
        const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
          zip.openReadStream(entry, (err, value) => err ? rej(err) : res(value!)));
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of stream) {
          const part = Buffer.from(chunk);
          bytes += part.length;
          if (bytes > uploadLimit || bytes > entry.uncompressedSize) throw new AppError(400, "zip_size", "ZIP 文件大小不符合声明");
          chunks.push(part);
        }
        await consume(Buffer.concat(chunks), count);
        if (!stopped) zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}

export async function processImport() {
  const jobs = await query<{ id: string; ext: string }>(
    "SELECT id,ext FROM imports WHERE status IN ('queued','processing') ORDER BY created_at LIMIT 1");
  if (!jobs[0]) return;
  const job = jobs[0];
  await query("UPDATE imports SET status='processing' WHERE id=$1", [job.id]);
  const file = mediaPath(job.id, `upload.${job.ext}`);
  const tool = new ExifTool({ maxProcs: 1, taskTimeoutMillis: 15000 });
  let added = 0, duplicates = 0;
  const errors: string[] = [];
  async function consume(buffer: Buffer, index: number) {
    try {
      const result = await importPhoto(buffer, tool);
      if (result === "added") added++; else duplicates++;
    } catch (error) {
      if (!(error instanceof AppError)) {
        // Infrastructure errors must leave the job retryable rather than discard its source.
        throw error;
      }
      errors.push(`第 ${index} 项：${error.message}`);
    }
  }
  let status = "done";
  try {
    if (job.ext === "zip") await eachZip(file, consume);
    else await consume(await readFile(file), 1);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    status = "failed";
    errors.push(error.message);
  } finally { await tool.end(); }
  if (!added && errors.length) status = "failed";
  await query("UPDATE imports SET status=$2,added=$3,duplicates=$4,errors=$5::jsonb,finished_at=now() WHERE id=$1",
    [job.id, status, added, duplicates, JSON.stringify(errors)]);
  await unlink(file);
}
