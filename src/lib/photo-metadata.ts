export function captureLabel(raw: string | null | undefined): string {
  if (!raw) return "";
  const match = raw.match(/^(\d{4})[:-](\d{2})[:-](\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return "";
  const [, year, month, day, hour, minute] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) return "";
  return `${year}年${Number(month)}月${Number(day)}日` + (hour && minute && Number(hour) < 24 && Number(minute) < 60 ? ` ${hour}:${minute}` : "");
}

export function embeddedPlace(tags: Record<string, unknown>): string {
  const fields = ["Country", "Country-PrimaryLocationName", "State", "Province-State", "City", "Sub-location", "Location"];
  return [...new Set(fields.flatMap(field => {
    const value = tags[field];
    return typeof value === "string" && value.trim() ? [value.trim()] : [];
  }))].join(" · ").slice(0, 120);
}
