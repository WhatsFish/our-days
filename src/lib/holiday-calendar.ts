import { Solar } from "lunar-typescript";
import { localDay, validDay } from "./domain";

export type HolidayRules = { solar_terms: boolean; chinese: boolean; western: boolean };
export type HolidayEvent = { day: string; names: string[]; categories: (keyof HolidayRules)[] };
export const HOLIDAY_HORIZON = 14;
export const defaultHolidayRules: HolidayRules = { solar_terms: true, chinese: true, western: true };

export function holidayOn(day: string, rules: HolidayRules): HolidayEvent | null {
  if (!validDay(day)) throw new Error("Invalid holiday date");
  const [year, month, date] = day.split("-").map(Number);
  const solar = Solar.fromYmd(year, month, date);
  const lunar = solar.getLunar();
  const names: string[] = [];
  const categories: (keyof HolidayRules)[] = [];
  const add = (category: keyof HolidayRules, name: string | undefined) => {
    if (rules[category] && name && !names.includes(name)) { names.push(name); if (!categories.includes(category)) categories.push(category); }
  };
  if (lunar.getMonth() > 0) {
    add("chinese", ({ "1-1": "春节", "1-15": "元宵节", "5-5": "端午节", "7-7": "七夕",
      "8-15": "中秋节", "9-9": "重阳节", "12-8": "腊八节", "12-23": "小年" } as Record<string, string>)[`${lunar.getMonth()}-${lunar.getDay()}`]);
    if (lunar.getMonth() === 12 && lunar.next(1).getMonth() === 1) add("chinese", "除夕");
  }
  const term = lunar.getJieQi();
  if (term === "清明") add("chinese", "清明节");
  add("chinese", ({ "1-1": "元旦", "5-1": "劳动节", "10-1": "国庆节" } as Record<string, string>)[`${month}-${date}`]);
  add("western", ({ "2-14": "情人节", "10-31": "万圣节", "12-24": "平安夜", "12-25": "圣诞节" } as Record<string, string>)[`${month}-${date}`]);
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  if (month === 11 && weekday === 4 && date >= 22 && date <= 28) add("western", "感恩节");
  add("solar_terms", term && !(term === "清明" && names.includes("清明节")) ? term : undefined);
  return names.length ? { day, names, categories } : null;
}

export function holidayPlan(rules: HolidayRules, now = new Date(), days = HOLIDAY_HORIZON): HolidayEvent[] {
  const today = localDay(now, "Asia/Shanghai");
  const date = new Date(`${today}T12:00:00Z`);
  const events: HolidayEvent[] = [];
  for (let index = 0; index < days; index++) {
    const event = holidayOn(date.toISOString().slice(0, 10), rules);
    if (event) events.push(event);
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return events;
}
