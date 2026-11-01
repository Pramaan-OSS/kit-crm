import { createHmac, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { Pool } from "pg";

const config = JSON.parse(await readFile(".evidence/runtime.json", "utf8"));
if (new URL(config.origin).port !== "3307") throw Error("Walk must use port 3307");
function pass(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({
      v: 1,
      role: "owner",
      project: config.project,
      iat: now,
      exp: now + 60,
      nonce: randomBytes(18).toString("base64url"),
      ...overrides,
    }),
  ).toString("base64url");
  return `${body}.${createHmac("sha256", config.secret).update(`pramaan-owner-pass.v1.${body}`).digest("base64url")}`;
}
if (!process.env.DATABASE_URL) throw Error("Walk needs its disposable Postgres database");
const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const browser = await chromium.launch({ headless: true });
const results = [];
const errors = [];
try {
  const manifest = JSON.parse(await readFile("pramaan.kit.json", "utf8"));
  for (const journey of manifest.journeys.filter((j) => j.status === "ships-working")) {
    if (!["owner-settings", "password-reset-off"].includes(journey.id))
      await db.query("TRUNCATE app_users CASCADE");
    const list = JSON.parse(await readFile(journey.checklist, "utf8"));
    for (const item of list.items) {
      const context = await browser.newContext({
        baseURL: config.origin,
        viewport: { width: 1280, height: 900 },
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        for (const step of item.steps) {
          if (step.enterAs === "owner") await page.goto(`/api/account/owner-pass?token=${pass()}`);
          else if (step.enterAs === "visitor") await context.clearCookies();
          else if (step.goto) await page.goto(step.goto);
          else if (step.fill) await page.getByLabel(step.fill, { exact: true }).fill(step.value);
          else if (step.select)
            await page
              .getByLabel(step.select, { exact: true })
              .selectOption({ label: step.option });
          else if (step.click)
            await page
              .getByRole("button", { name: step.click, exact: true })
              .or(page.getByRole("link", { name: step.click, exact: true }))
              .click();
          else if (step.expectText)
            await expect(page.getByText(step.expectText, { exact: false }).first()).toBeVisible();
          else if (step.expectAbsent)
            await expect(
              page.getByText(step.expectAbsent, { exact: false }).first(),
            ).not.toBeVisible();
          else if (step.expectHeading)
            await expect(
              page.getByRole("heading", { name: step.expectHeading, exact: true }),
            ).toBeVisible();
          else throw Error(`Unsupported checklist step ${Object.keys(step)}`);
        }
        await page.screenshot({ path: `.evidence/${item.id}.png`, fullPage: true });
        results.push({ id: item.id, ok: true });
        console.log(`Passed ${item.id}`);
      } catch (e) {
        await page.screenshot({ path: `.evidence/failed-${item.id}.png`, fullPage: true });
        throw Error(`${item.id}: ${e.message}`);
      } finally {
        await context.close();
      }
    }
  }
  const owner = await browser.newContext({ baseURL: config.origin });
  const used = pass();
  expect(
    (
      await owner.request.get(`/api/account/owner-pass?token=${used}`, { maxRedirects: 0 })
    ).status(),
  ).toBe(303);
  for (const token of [
    used,
    pass({ exp: Math.floor(Date.now() / 1000) - 1 }),
    pass({ project: "foreign" }),
    `${pass().slice(0, -1)}!`,
  ])
    expect(
      (
        await owner.request.get(`/api/account/owner-pass?token=${token}`, { maxRedirects: 0 })
      ).status(),
    ).toBeGreaterThanOrEqual(400);
  const viewer = await browser.newContext({ baseURL: config.origin });
  expect(
    (
      await viewer.request.post("/api/account/signin", {
        headers: { origin: config.origin },
        data: { email: "teammate@example.test", password: "Workspace check 2026" },
      })
    ).ok(),
  ).toBe(true);
  // Give the first team data, so the isolation check below has something to leak.
  expect(
    (
      await owner.request.post("/api/pramaan/contacts", {
        headers: { origin: config.origin },
        data: { action: "save", kind: "company", name: "First team client", email: "" },
      })
    ).ok(),
  ).toBe(true);
  const contacts = await (await viewer.request.get("/api/pramaan/contacts")).json();
  expect(contacts.contacts.map((c) => c.name)).toContain("First team client");
  expect(
    (
      await viewer.request.post("/api/pramaan/contacts", {
        headers: { origin: config.origin },
        data: { action: "save", kind: "person", name: "Forbidden" },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await viewer.request.post("/api/workspace", {
        headers: { origin: config.origin },
        data: { action: "rename", name: "Forbidden" },
      })
    ).status(),
  ).toBe(403);
  await owner.request.post("/api/records/note", {
    headers: { origin: config.origin },
    data: { action: "save", title: "Team plan", notes: "Shared export" },
  });
  const exported = await viewer.request.get("/api/records/note/export");
  expect(exported.ok()).toBe(true);
  expect(await exported.text()).toContain("Team plan");
  const stranger = await browser.newContext({ baseURL: config.origin });
  for (const url of [
    "/api/pramaan/contacts",
    "/api/pramaan/pipeline",
    "/api/workspace",
    "/api/records/note",
    "/api/records/note/export",
  ])
    expect((await stranger.request.get(url)).status()).toBe(401);
  // A second organisation sees none of the first team's data.
  const foreign = await browser.newContext({ baseURL: config.origin });
  expect(
    (
      await foreign.request.post("/api/account/signup", {
        headers: { origin: config.origin },
        data: { email: "another-team@example.test", password: "Workspace check 2026" },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await foreign.request.post("/api/workspace", {
        headers: { origin: config.origin },
        data: { action: "create", name: "Separate team" },
      })
    ).ok(),
  ).toBe(true);
  const foreignData = await (
    await foreign.request.get("/api/pramaan/contacts?scope=ignored")
  ).json();
  expect(foreignData.contacts).toEqual([]);
  expect((await (await foreign.request.get("/api/records/note")).json()).records).toEqual([]);
  expect(await (await foreign.request.get("/api/records/note/export")).text()).not.toContain(
    "Team plan",
  );
  expect((await (await foreign.request.get("/api/pramaan/pipeline")).json()).deals).toEqual([]);
  // Narrow screen: navigation and forms remain usable without horizontal overflow.
  const mobile = await viewer.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto("/contacts");
  await expect(
    mobile.getByRole("heading", { name: "People and companies", exact: true }).first(),
  ).toBeVisible();
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await mobile.screenshot({ path: ".evidence/mobile-contacts.png", fullPage: true });
  for (const c of [owner, viewer, stranger, foreign]) await c.close();
  expect(errors).toEqual([]);
  await writeFile(
    ".evidence/walk.json",
    JSON.stringify(
      {
        port: 3307,
        headless: true,
        browser: "chromium",
        results,
        ownerPass: true,
        readOnlyDenied: true,
        crossOrganisation: true,
        export: true,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    `Passed ${results.length} journeys, owner-pass, permission, export, isolation and mobile checks.`,
  );
} finally {
  await browser.close();
  await db.end();
}
