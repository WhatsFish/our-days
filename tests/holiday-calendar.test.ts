import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultHolidayRules, holidayOn, holidayPlan } from "../src/lib/holiday-calendar";
import { holidayPrompt } from "../src/lib/holiday-images";

test("holiday calendar computes lunar festivals, solar terms and US Thanksgiving instead of guessing", () => {
  assert.ok(holidayOn("2026-02-17", defaultHolidayRules)?.names.includes("春节"));
  assert.ok(holidayOn("2026-02-16", defaultHolidayRules)?.names.includes("除夕"));
  assert.ok(holidayOn("2026-11-22", defaultHolidayRules)?.names.includes("小雪"));
  assert.deepEqual(holidayOn("2026-11-26", defaultHolidayRules)?.names, ["感恩节"]);
  assert.equal(holidayOn("2026-11-19", defaultHolidayRules), null);
  assert.deepEqual(holidayOn("2027-11-25", { solar_terms: false, chinese: false, western: true })?.names, ["感恩节"]);
});
test("disabled categories do not produce events; same-day events merge; horizon uses Beijing date", () => {
  assert.equal(holidayOn("2026-12-25", { ...defaultHolidayRules, western: false }), null);
  const overlap = holidayOn("2026-04-05", defaultHolidayRules);
  assert.deepEqual(overlap?.names, ["清明节"]);
  assert.deepEqual(holidayOn("2026-04-05", { ...defaultHolidayRules, chinese: false })?.names, ["清明"]);
  const plan = holidayPlan(defaultHolidayRules, new Date("2026-12-24T16:01:00Z"), 1);
  assert.deepEqual(plan.map(event => event.day), ["2026-12-25"]);
  assert.equal(new Set(plan.map(event => event.day)).size, plan.length);
});
test("holiday prompts specify new scenes, not birthday layout edits", () => {
  const prompt = holidayPrompt({ day: "2026-12-25", names: ["圣诞节"], categories: ["western"] }, "改成夜晚");
  assert.match(prompt, /新环境、新动作、新镜头/);
  assert.match(prompt, /圣诞树/);
  assert.match(prompt, /改成夜晚/);
  assert.match(prompt, /禁止照搬/);
});
