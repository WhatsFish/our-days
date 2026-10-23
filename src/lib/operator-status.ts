import { freemem, totalmem } from "node:os";
import { readFile, statfs } from "node:fs/promises";
import { mediaRoot } from "./media";

export const OPERATOR_COUNTS_SQL = `SELECT
  (SELECT count(*)::int FROM photos) AS photos,
  (SELECT count(*)::int FROM photos WHERE NOT approved) AS unreviewed,
  (SELECT count(*)::int FROM photo_queue) AS ready,
  (SELECT count(*)::int FROM deliveries WHERE status IN ('accepted','delivered')) AS submitted,
  (SELECT count(*)::int FROM deliveries WHERE status='delivered') AS provider_delivered,
  (SELECT count(*)::int FROM deliveries WHERE status='failed') AS failed,
  (SELECT count(*)::int FROM deliveries WHERE status='unknown') AS unknown,
  (SELECT count(*)::int FROM deliveries WHERE status IN ('pending','sending')) AS pending_delivery,
  (SELECT count(*)::int FROM imports WHERE status IN ('queued','processing')) AS pending_import,
  (SELECT count(*)::int FROM editions WHERE status='scheduled') AS scheduled`;

export async function resourceStatus() {
  const disk = await statfs(mediaRoot());
  async function cgroup(file: string) {
    try {
      const value = (await readFile(`/sys/fs/cgroup/${file}`, "utf8")).trim();
      return /^\d+$/.test(value) ? Number(value) : null;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }
  const [containerLimit, containerUsage] = await Promise.all([cgroup("memory.max"), cgroup("memory.current")]);
  return {
    processRss: process.memoryUsage().rss, containerLimit, containerUsage,
    hostMemoryTotal: totalmem(), hostMemoryFree: freemem(),
    diskFree: disk.bavail * disk.bsize, diskTotal: disk.blocks * disk.bsize,
  };
}

export type OperatorCounts = {
  photos: number; unreviewed: number; ready: number; submitted: number;
  provider_delivered: number; failed: number; unknown: number; pending_delivery: number;
  pending_import: number; scheduled: number;
};
export type Resources = Awaited<ReturnType<typeof resourceStatus>>;
export function workerHealth(worker: { last_tick: string | Date | null; error_code: string | null } | null, now = Date.now()) {
  if (!worker?.last_tick) return { healthy: false, reason: "Worker 尚无成功记录" };
  if (worker.error_code) return { healthy: false, reason: worker.error_code };
  const timestamp = new Date(worker.last_tick).getTime();
  if (!Number.isFinite(timestamp) || now - timestamp > 5 * 60_000) return { healthy: false, reason: "Worker 超过 5 分钟未成功运行" };
  return { healthy: true, reason: "数据库可用，Worker 最近 5 分钟内成功运行" };
}
