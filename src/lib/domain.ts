import { z } from "zod";

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const uuid = z.string().uuid();
export const photoEdit = z.object({
  id: uuid,
  date_label: z.string().trim().max(80),
  place_label: z.string().trim().max(120),
  facts: z.string().trim().max(3000),
  caption: z.string().trim().max(3000),
  approved: z.boolean(),
}).refine(p => !p.approved || p.caption.length > 0, "请先填写并确认文案");
export const settingsInput = z.object({
  timezone: z.string().refine(v => {
    try { new Intl.DateTimeFormat("en", { timeZone: v }).format(); return true; }
    catch { return false; }
  }, "无效时区"),
  send_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  paused: z.boolean(),
  weather_lat: z.number().min(-90).max(90).nullable(),
  weather_lon: z.number().min(-180).max(180).nullable(),
  weather_city: z.string().trim().max(80),
  almanac: z.boolean(),
  star_note: z.string().trim().max(300),
}).refine(s => (s.weather_lat === null) === (s.weather_lon === null), "经纬度必须同时填写");

export const editionInput = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(validDay, "无效日期"),
  photo_id: uuid,
  title: z.string().trim().min(1).max(80),
  notify: z.boolean().default(false),
});

export function validDay(day: string): boolean {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === day;
}
export function localDay(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  return ["year", "month", "day"].map(type => parts.find(p => p.type === type)!.value).join("-");
}

export type Photo = z.infer<typeof photoEdit> & {
  metadata_place?: string;
  captured_raw: string | null;
  latitude: number | null;
  longitude: number | null;
  used: number;
  queued?: boolean;
  queue_pinned_at?: string | null;
  last_sent_day?: string | null;
};
export type Settings = z.infer<typeof settingsInput> & { queue_loop?: boolean };
export type Snapshot = {
  photo_id: string;
  date_label: string;
  place_label: string;
  caption: string;
  weather: string;
  almanac: string;
  star_note: string;
};
export type Edition = {
  id: string; day: string; photo_id: string; title: string; status: string;
  notify: boolean; send_at: string; snapshot: Snapshot | null; favorite?: boolean;
};

export function assertArchiveEntry(name: string, size: number, compressed: number) {
  if (name.startsWith("/") || name.includes("\\") || name.split("/").includes("..") ||
      size > 25 * 1024 * 1024 || size > Math.max(compressed, 1) * 200) {
    throw new AppError(400, "unsafe_archive", "压缩包包含不安全路径、过大文件或异常压缩比");
  }
}
export function publicError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof AppError) return { status: error.status, code: error.code, message: error.message };
  if (error instanceof z.ZodError) return { status: 400, code: "validation", message: error.issues.map(i => i.message).join("；") };
  // Do not include SQL, filenames, provider bodies, coordinates or captions in logs.
  console.error("[our-days] request failed", error instanceof Error ? error.name : "UnknownError");
  return { status: 500, code: "internal", message: "操作失败，请查看服务状态后重试" };
}
