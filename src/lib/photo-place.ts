import { z } from "zod";
import { pool } from "./db";
import { AppError } from "./domain";

export async function lookupPhotoPlace(id: string) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(7316,5)");
    const [photo] = (await client.query<{
      latitude: number | null; longitude: number | null; metadata_place: string; gps_place_guess: string;
    }>("SELECT latitude,longitude,metadata_place,gps_place_guess FROM photos WHERE id=$1", [id])).rows;
    if (!photo) throw new AppError(404, "not_found", "照片不存在");
    if (photo.metadata_place) return { place: photo.metadata_place, source: "照片内嵌地点" };
    if (photo.gps_place_guess) return { place: photo.gps_place_guess, source: "已缓存的地图城市候选" };
    if (photo.latitude === null || photo.longitude === null ||
        Math.abs(photo.latitude) > 90 || Math.abs(photo.longitude) > 180) {
      throw new AppError(400, "no_gps", "照片没有有效 GPS，无法自动解析地点");
    }
    const [rate] = (await client.query<{ allowed: boolean }>(
      "SELECT coalesce(max(geocoded_at)<now()-interval '2 seconds',true) AS allowed FROM photos")).rows;
    if (!rate.allowed) throw new AppError(429, "map_rate", "地图查询过于频繁，请稍后再试");
    // Persist the attempt before the request so failed requests also respect the shared rate limit.
    await client.query("UPDATE photos SET geocoded_at=now() WHERE id=$1", [id]);
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.search = new URLSearchParams({
      format: "jsonv2", lat: photo.latitude.toFixed(3), lon: photo.longitude.toFixed(3),
      zoom: "10", addressdetails: "1", "accept-language": "zh-CN,en",
    }).toString();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "User-Agent": "OurDaysPhotoLetters/0.1", Accept: "application/json" },
        redirect: "error", signal: AbortSignal.timeout(10000), cache: "no-store",
      });
    } catch { throw new AppError(502, "map_unavailable", "地图服务暂不可用，地点未修改"); }
    if (!response.ok) throw new AppError(502, "map_unavailable", `地图服务返回 HTTP ${response.status}，地点未修改`);
    const result = z.object({
      address: z.object({
        city: z.string().optional(), town: z.string().optional(), village: z.string().optional(),
        municipality: z.string().optional(), county: z.string().optional(),
        state: z.string().optional(), country: z.string().optional(),
      }),
    }).safeParse(await response.json());
    if (!result.success) throw new AppError(502, "map_result", "地图没有返回可用城市，请手动填写");
    const a = result.data.address;
    const city = a.city || a.town || a.village || a.municipality || a.county;
    if (!city) throw new AppError(404, "map_result", "地图未识别到城市，请手动填写");
    const place = [...new Set([a.country, a.state, city].filter(Boolean))].join(" · ").slice(0, 120);
    await client.query("UPDATE photos SET gps_place_guess=$2 WHERE id=$1", [id, place]);
    return { place, source: "OpenStreetMap / Nominatim 城市候选（请核对）" };
  } finally {
    try { await client.query("SELECT pg_advisory_unlock(7316,5)"); }
    finally { client.release(); }
  }
}
