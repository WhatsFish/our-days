import { Solar } from "lunar-typescript";
import { z } from "zod";
import type { Photo, Settings, Snapshot } from "./domain";

const forecast = z.object({
  daily: z.object({
    time: z.array(z.string()),
    temperature_2m_max: z.array(z.number().nullable()),
    temperature_2m_min: z.array(z.number().nullable()),
    precipitation_probability_max: z.array(z.number().nullable()),
  }),
});
export async function buildSnapshot(photo: Photo, settings: Settings, day: string): Promise<Snapshot> {
  let weather = "未配置天气城市";
  if (settings.weather_lat !== null && settings.weather_lon !== null) {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.search = new URLSearchParams({
      latitude: String(settings.weather_lat), longitude: String(settings.weather_lon),
      timezone: settings.timezone,
      daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      forecast_days: "2",
    }).toString();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
      if (!response.ok) throw new Error("WeatherHttp");
      const data = forecast.parse(await response.json()).daily;
      const i = data.time.indexOf(day);
      if (i < 0 || data.temperature_2m_max[i] == null || data.temperature_2m_min[i] == null) throw new Error("WeatherDate");
      weather = `${settings.weather_city} ${data.temperature_2m_min[i]}—${data.temperature_2m_max[i]}°C` +
        (data.precipitation_probability_max[i] == null ? "" : `，降水概率 ${data.precipitation_probability_max[i]}%`) +
        ` · Open-Meteo · 更新于 ${new Intl.DateTimeFormat("zh-CN", { timeZone: settings.timezone, hour: "2-digit", minute: "2-digit" }).format()}`;
    } catch {
      console.warn("[our-days] weather_unavailable");
      weather = "天气暂未更新";
    }
  }
  let almanac = "";
  if (settings.almanac) {
    const [year, month, date] = day.split("-").map(Number);
    const lunar = Solar.fromYmd(year, month, date).getLunar();
    almanac = `农历${lunar.getMonthInChinese()}月${lunar.getDayInChinese()} · 宜：${lunar.getDayYi().slice(0, 3).join("、")} · 忌：${lunar.getDayJi().slice(0, 3).join("、")}`;
  }
  return {
    photo_id: photo.id, date_label: photo.date_label, place_label: photo.place_label,
    caption: photo.caption, weather, almanac, star_note: settings.star_note,
  };
}
