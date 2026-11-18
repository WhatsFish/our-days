import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = "http://127.0.0.1:3317";
const containerTest = process.env.OUR_DAYS_CONTAINER_TEST === "true";
const server = spawn(containerTest ? "docker" : process.execPath, containerTest
  ? ["run", "--rm", "--name", "our-days-ux-browser-web", "--memory", "512m", "-p", "127.0.0.1:3317:3000", "our-days-web:local"]
  : ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", "3317"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", data => { log += data; });
server.stderr.on("data", data => { log += data; });
let browser;
try {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(log);
    try { if ((await fetch(`${origin}/our-days`)).ok) break; }
    catch { /* Wait for the test server only. */ }
    if (attempt === 79) throw new Error(`Test server did not start: ${log}`);
    await delay(250);
  }
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const photos = Array.from({ length: 103 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    date_label: `Synthetic ${index + 1}`, place_label: "Test city", facts: "Synthetic saved facts",
    caption: index ? "" : "Original caption", approved: false, used: 0,
    captured_raw: null, latitude: null, longitude: null,
  }));
  photos[0].approved = true;
  photos[0].queued = true;
  photos[0].queue_pinned_at = null;
  const dashboard = {
    editions: [], imports: [], deliveries: [], settings: { paused: true, queue_loop: false, send_time: "08:00", timezone: "Asia/Shanghai", weather_city: "", weather_lat: null, weather_lon: null, star_note: "" },
    worker: { last_tick: new Date().toISOString(), error_code: null }, bytes: 100, quotaMb: 200,
    pushEnabled: true, pushReady: true, pushChannel: "wecom", aiEnabled: true, aiCost: "0.1", aiUnknownCost: 0,
    ai: { enabled: true, provider: "zhipu", model: "glm-5.3-flash", keyConfigured: true, source: "dashboard", currency: "CNY", inputRate: 0.8, outputRate: 2.8, monthlyLimit: 100 },
    stats: { photos: 103, ready: 28, unreviewed: 12, submitted: 64, provider_delivered: 0, failed: 0, unknown: 0, pending_delivery: 0, pending_import: 0 },
    resources: { processRss: 160000000, containerUsage: 210000000, containerLimit: 536870912, hostMemoryTotal: 8000000000, hostMemoryFree: 4500000000, diskFree: 7500000000, diskTotal: 30000000000 },
    queue: [photos[0]], health: { healthy: true, reason: "Test worker healthy" },
  };
  let generated = 0, saved = null, lastFacts = "", lastContext = null;
  const specialItems = [];
  let signedIn = false;
  let passwordSet = false;
  await page.route("**/our-days/api/**", async route => {
    const url = new URL(route.request().url());
    const endpoint = url.pathname.split("/api/")[1];
    let body;
    if (endpoint === "session") body = { role: signedIn ? "admin" : null };
    else if (endpoint === "login") {
      const input = route.request().postDataJSON();
      assert.equal(input.username, "admin");
      assert.equal(input.password, "SyntheticPassword123");
      signedIn = true;
      body = { role: "admin" };
    } else if (endpoint === "admin/password") {
      const input = route.request().postDataJSON();
      assert.equal(input.token, "a".repeat(64));
      assert.equal(input.password, "SyntheticPassword123");
      passwordSet = true;
      signedIn = false;
      body = { ok: true };
    }
    else if (endpoint === "editions") body = [];
    else if (endpoint === "admin") body = dashboard;
    else if (endpoint === "special") body = { items: specialItems, total: specialItems.length, page: 1 };
    else if (endpoint === "special/upload") {
      await delay(250);
      const item = { id: "00000000-0000-4000-8000-000000000999", title: "Synthetic birthday artwork",
        original_ext: "png", original_bytes: "100", width: 100, height: 150, created_at: new Date().toISOString() };
      specialItems.push(item);
      await route.fulfill({ status: 201, json: { id: item.id, duplicate: false } });
      return;
    }
    else if (endpoint === "queue/settings") {
      dashboard.settings.queue_loop = route.request().postDataJSON().loop;
      body = { ok: true };
    } else if (endpoint === "queue/pin") {
      const input = route.request().postDataJSON();
      const photo = photos.find(photo => photo.id === input.id);
      photo.queue_pinned_at = input.pinned ? new Date().toISOString() : null;
      body = { ok: true };
    } else if (endpoint === "photos") {
      const q = (url.searchParams.get("q") || "").toLowerCase();
      const matching = photos.filter(photo => `${photo.date_label} ${photo.place_label}`.toLowerCase().includes(q));
      const number = Number(url.searchParams.get("page") || 1);
      body = { photos: matching.slice((number - 1) * 20, number * 20), total: matching.length, page: number };
    } else if (endpoint.startsWith("photo/")) body = photos.find(photo => photo.id === endpoint.slice(6));
    else if (endpoint.startsWith("media/") || endpoint.startsWith("special/")) {
      await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#d6e7e1"/><circle cx="300" cy="280" r="130" fill="#fffefa"/><text x="300" y="550" text-anchor="middle" font-size="32">Synthetic photo</text></svg>' });
      return;
    } else if (endpoint === "ai") {
      generated++;
      lastFacts = route.request().postDataJSON().facts;
      lastContext = route.request().postDataJSON();
      await delay(650);
      if (generated === 2) { await route.fulfill({ status: 502, json: { error: "Synthetic provider failure" } }); return; }
      body = { draft: "AI generated caption" };
    } else if (endpoint === "photo") {
      saved = route.request().postDataJSON();
      Object.assign(photos.find(photo => photo.id === saved.id), saved);
      body = { ok: true };
    } else throw new Error(`Unexpected request: ${endpoint}`);
    await route.fulfill({ json: body });
  });
  await page.goto(`${origin}/our-days`);
  assert.equal(await page.getByLabel("用户名", { exact: true }).inputValue(), "admin");
  await page.getByLabel("密码", { exact: true }).fill("SyntheticPassword123");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("navigation", { name: "工作区" }).waitFor();
  const nav = page.getByRole("navigation", { name: "工作区" });
  assert.equal(await nav.getByRole("link").count(), 5, "All five modules share one navigation, including special artwork");
  assert.equal(await nav.getByRole("link", { name: "特殊素材", exact: true }).count(), 1);
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  const screenshot = async name => {
    if (process.env.BENTO_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.BENTO_SCREENSHOT_DIR}/${name}.png`, fullPage: true });
  };
  await screenshot("bento-overview-light");
  await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  assert.equal(await page.evaluate(() => localStorage.getItem("our-days-theme")), "dark");
  await screenshot("bento-overview-dark");
  await page.reload();
  await nav.waitFor();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark", "Theme must survive a full reload");
  await page.getByRole("button", { name: "切换到浅色模式", exact: true }).click();
  await page.getByRole("link", { name: "队列与素材", exact: true }).click();
  await page.getByText("103 张符合条件 · 每页 20 张").waitFor();
  const loop = page.getByRole("checkbox", { name: "循环队列：全部照片发送一轮后，从头继续" });
  assert.equal(await loop.count(), 0, "Cycling is a configuration control, not a library control");
  assert.equal(await page.locator("main > .card").first().getByRole("heading", { name: "上传素材", exact: true }).count(), 1,
    "Upload is the first material-page module");
  assert.equal(await page.locator('input[type="file"]').isVisible(), true, "Upload is expanded without any extra click");
  await page.getByRole("link", { name: "API 与系统配置", exact: true }).click();
  await loop.check();
  await page.getByText("循环队列已开启；自动发送开关保持不变", { exact: true }).waitFor();
  assert.equal(dashboard.settings.paused, true);
  await loop.uncheck();
  await page.getByText("循环队列已关闭；只发送未使用素材", { exact: true }).waitFor();
  await page.getByRole("link", { name: "队列与素材", exact: true }).click();
  await page.getByText("103 张符合条件 · 每页 20 张").waitFor();
  await page.locator(".material-table").getByRole("button", { name: "置顶", exact: true }).click();
  await page.getByText("已置顶，将优先安排下一次发送", { exact: true }).waitFor();
  await page.locator(".material-table").getByRole("button", { name: "取消置顶", exact: true }).click();
  await page.getByText("已取消置顶", { exact: true }).waitFor();
  assert.equal(await page.locator(".material-table tbody tr").count(), 20);
  await screenshot("bento-library-light");
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByRole("cell", { name: /^Synthetic 21 / }).waitFor();
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await page.getByRole("cell", { name: /^Synthetic 1 / }).waitFor();
  await page.getByLabel("搜索素材").fill("Synthetic 103");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await page.getByText("1 张符合条件 · 每页 20 张").waitFor();
  assert.equal(await page.locator(".material-table tbody tr").count(), 1);
  await page.getByLabel("搜索素材").fill("");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await page.getByText("103 张符合条件 · 每页 20 张").waitFor();
  await page.getByRole("button", { name: "编辑", exact: true }).first().click();
  const editor = page.getByRole("dialog");
  await editor.waitFor();
  assert.equal(await editor.getByRole("checkbox").count(), 1, "No per-call consent checkbox");
  await editor.getByText(/看图生成：发送去掉 EXIF\/GPS 的压缩照片/).waitFor();
  await editor.getByLabel("当时发生了什么").fill("");
  assert.equal(await editor.getByRole("button", { name: "AI 生成并填入文案" }).isEnabled(), true, "Photo-only generation needs no facts");
  await editor.getByLabel("当时发生了什么").fill("Unsaved current facts");
  page.once("dialog", dialog => dialog.accept());
  await editor.getByRole("button", { name: "AI 生成并填入文案" }).click();
  await editor.getByRole("status").filter({ hasText: "正在生成文案" }).waitFor();
  await editor.getByText("AI 文案已填入下方。核对或修改后，保存草稿或确认加入队列。").waitFor();
  assert.equal(lastFacts, "Unsaved current facts");
  assert.equal(lastContext.date_label, "Synthetic 1");
  assert.equal(lastContext.place_label, "Test city");
  assert.equal(await editor.getByLabel("推送文案", { exact: true }).inputValue(), "AI generated caption");
  assert.equal(saved, null, "Generation must not automatically persist or approve");
  await editor.getByRole("button", { name: "撤销 AI 填入" }).click();
  assert.equal(await editor.getByLabel("推送文案", { exact: true }).inputValue(), "Original caption");
  page.once("dialog", dialog => dialog.accept());
  await editor.getByRole("button", { name: "AI 生成并填入文案" }).click();
  await editor.getByRole("alert").filter({ hasText: "Synthetic provider failure" }).waitFor();
  assert.equal(await editor.getByLabel("推送文案", { exact: true }).inputValue(), "Original caption", "Failure preserves the draft");
  page.once("dialog", dialog => dialog.accept());
  await editor.getByRole("button", { name: "AI 生成并填入文案" }).click();
  await editor.getByText("AI 文案已填入下方。核对或修改后，保存草稿或确认加入队列。").waitFor();
  await editor.getByRole("button", { name: "预览当前草稿" }).click();
  assert.equal(await editor.locator(".draft-preview .caption").textContent(), "AI generated caption");
  await editor.getByRole("checkbox").check();
  await editor.getByRole("button", { name: "保存并确认素材" }).click();
  await editor.getByText("已保存，素材已确认。历史发送内容不会改变。").waitFor();
  assert.equal(saved.caption, "AI generated caption");
  assert.equal(saved.facts, "Unsaved current facts");
  assert.equal(saved.approved, true);
  await editor.getByLabel("推送文案", { exact: true }).fill("Dirty draft");
  page.once("dialog", dialog => dialog.dismiss());
  await editor.getByRole("button", { name: "关闭", exact: true }).click();
  assert.equal(await editor.isVisible(), true, "Rejecting discard keeps the editor");
  page.once("dialog", dialog => dialog.accept());
  await editor.getByRole("button", { name: "下一张", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("dialog .editor-fields input")?.value === "Synthetic 2");
  assert.equal(await editor.getByLabel("拍摄时间", { exact: true }).inputValue(), "Synthetic 2");
  await editor.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("link", { name: "API 与系统配置", exact: true }).click();
  await screenshot("bento-settings-light");
  assert.equal(new URL(page.url()).searchParams.get("view"), "settings");
  await page.reload();
  await page.getByRole("heading", { name: "定时任务配置", exact: true }).waitFor();
  assert.equal(await nav.getByRole("link", { name: "API 与系统配置", exact: true }).getAttribute("aria-current"), "page");
  await page.getByText("GLM-5.3-Flash · 已内置", { exact: true }).waitFor();
  assert.equal(await page.getByRole("checkbox", { name: /费用限额/ }).count(), 0);
  assert.equal(await page.getByLabel(/输入单价/).count(), 0);
  await page.getByLabel("天气城市名（显示用）", { exact: true }).fill("湖州");
  await page.getByRole("status").filter({ hasText: "只保存城市名不会启用天气" }).waitFor();
  await page.getByPlaceholder("湖州示例：30.8703", { exact: true }).fill("30.8703");
  await page.getByRole("status").filter({ hasText: "经纬度尚未填完整" }).waitFor();
  await page.getByPlaceholder("湖州示例：120.0933", { exact: true }).fill("120.0933");
  await page.getByRole("status").filter({ hasText: "经纬度已填写" }).waitFor();
  await page.getByPlaceholder("湖州示例：30.8703", { exact: true }).fill("");
  await page.getByPlaceholder("湖州示例：120.0933", { exact: true }).fill("");
  await page.getByRole("status").filter({ hasText: "只保存城市名不会启用天气" }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "队列与素材", exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).first().click();
  await editor.waitFor();
  const geometry = await editor.evaluate(node => ({ width: node.getBoundingClientRect().width, scroll: node.scrollWidth, client: node.clientWidth }));
  assert.ok(geometry.width <= 390 && geometry.scroll <= geometry.client + 1, "Mobile editor must not overflow horizontally");
  assert.equal(await editor.evaluate(node => Math.round(node.getBoundingClientRect().top)), 0, "Mobile editor starts at the top of the viewport");
  if (process.env.UX_SCREENSHOT_PATH) await page.screenshot({ path: process.env.UX_SCREENSHOT_PATH });
  if (process.env.BENTO_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.BENTO_SCREENSHOT_DIR}/bento-editor-mobile.png` });
  await editor.getByRole("button", { name: "关闭", exact: true }).click();
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ["运行状态", "API 与系统配置", "队列与素材"]) {
      await nav.getByRole("link", { name, exact: true }).click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        `Page ${name} must not overflow at ${width}px`);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await nav.getByRole("link", { name: "运行状态", exact: true }).click();
  await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
  await screenshot("bento-overview-mobile-dark");
  await nav.getByRole("link", { name: "特殊素材", exact: true }).click();
  await page.getByRole("heading", { name: "上传特殊素材", exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark", "Theme persists across special-material navigation");
  assert.equal(await nav.getByRole("link", { name: "特殊素材", exact: true }).getAttribute("aria-current"), "page");
  await screenshot("bento-special-mobile-dark");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await screenshot("bento-special-dark");
  await page.getByLabel("素材名称", { exact: true }).fill("Synthetic birthday artwork");
  await page.getByLabel("选择成品图片", { exact: true }).setInputFiles({
    name: "birthday.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHn0AAAAASUVORK5CYII=", "base64"),
  });
  await page.getByRole("button", { name: "保存到特殊素材库", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "上传成功，成品原图已保存到特殊素材库" }).waitFor();
  await page.getByText("Synthetic birthday artwork", { exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "下载原文件" }).count(), 1);
  assert.equal(dashboard.editions.length, 0, "Special upload must not create a daily edition");
  await page.goto(`${origin}/our-days/password#token=${"a".repeat(64)}`);
  await page.getByLabel("新密码", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, "", "Setup credential must be removed from visible URL history");
  await page.getByLabel("新密码", { exact: true }).fill("SyntheticPassword123");
  await page.getByLabel("再次输入新密码", { exact: true }).fill("DifferentPassword123");
  await page.getByRole("button", { name: "保存密码", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "两次输入的密码不一致" }).waitFor();
  assert.equal(passwordSet, false);
  await page.getByLabel("再次输入新密码", { exact: true }).fill("SyntheticPassword123");
  await page.getByRole("button", { name: "保存密码", exact: true }).click();
  await page.getByRole("link", { name: "前往登录并管理照片" }).waitFor();
  assert.equal(passwordSet, true);
  const systemContext = await browser.newContext({ colorScheme: "dark", viewport: { width: 390, height: 844 } });
  const systemPage = await systemContext.newPage();
  await systemPage.route("**/our-days/api/session", route => route.fulfill({ json: { role: null } }));
  await systemPage.goto(`${origin}/our-days`);
  await systemPage.getByRole("heading", { name: "管理员登录", exact: true }).waitFor();
  assert.equal(await systemPage.locator("html").getAttribute("data-theme"), "dark", "First visit follows dark OS setting");
  await systemPage.emulateMedia({ colorScheme: "light" });
  await systemPage.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await systemPage.getByRole("button", { name: "切换到深色模式" }).click();
  await systemPage.emulateMedia({ colorScheme: "dark" });
  await systemPage.emulateMedia({ colorScheme: "light" });
  assert.equal(await systemPage.locator("html").getAttribute("data-theme"), "dark", "Explicit user preference takes precedence over OS");
  await systemPage.getByRole("button", { name: "收信人入口", exact: true }).click();
  await systemPage.getByLabel("收信人配对码", { exact: true }).waitFor();
  await systemContext.close();
  assert.deepEqual(errors, []);
  console.log("Bento admin browser checks passed: five equal navigation items, persistent light/dark themes, settings deep links, responsive 390/768/1024/1440 layouts, 103-photo pagination/search, pin/cycle controls, AI draft flows, special uploads and password setup.");
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  if (server.exitCode === null) await new Promise(resolve => server.once("exit", resolve));
}
