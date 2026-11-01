import { randomUUID, scryptSync } from "node:crypto";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, scrypt: vi.fn(actual.scrypt) };
});

import { scrypt } from "node:crypto";
import { createAccounts, hashPassword, verifyPassword } from "./accounts";

const password = "Correct password 42";
const salt = "a".repeat(32);
const legacy = `scrypt:${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
const strong = `scrypt$N=131072,r=8,p=1$${salt}$${scryptSync(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }).toString("hex")}`;
const config = {
  secret: "x".repeat(32),
  secureCookies: false,
  sessionSeconds: 3600,
  passwordMinLength: 12,
  maxBodyBytes: 16384,
  taskTitleLength: 240,
  authAttempts: 10,
  authClientAttempts: 30,
  authWindowSeconds: 60,
};
// lostRace: another request replaces the hash between this sign-in's read and its upgrade.
function fixture(hash?: string, lostRace = false) {
  const user = hash
    ? { id: randomUUID(), email: "sam@example.test", role: "member", password_hash: hash }
    : undefined;
  let upgrades = 0;
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("RETURNING attempts")) return { rows: [{ attempts: 1 }] };
    if (sql.startsWith("SELECT id,email,role,password_hash"))
      return { rows: user ? [{ ...user }] : [] };
    if (sql.includes("WITH changed AS")) {
      if (lostRace || !user || user.password_hash !== values?.[1]) return { rows: [] };
      user.password_hash = values[2] as string;
      upgrades++;
      return { rows: [{ id: user.id }] };
    }
    return { rows: [] };
  });
  const accounts = createAccounts({ query } as unknown as Pick<Pool, "query">, config);
  const signin = (value = password) =>
    accounts.handle(
      new Request("http://localhost/api/account/signin", {
        method: "POST",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body: JSON.stringify({ email: "sam@example.test", password: value }),
      }),
      "signin",
    );
  return { user, signin, upgrades: () => upgrades };
}
beforeEach(() => {
  vi.mocked(scrypt).mockClear();
});
describe("password format sign-in", () => {
  it("signs in with a reset-format password", async () => {
    const f = fixture(strong);
    expect((await f.signin()).status).toBe(200);
    expect(f.upgrades()).toBe(0);
    expect(scrypt).toHaveBeenCalledTimes(1);
  });
  it("upgrades an old password only after a correct sign-in", async () => {
    const f = fixture(legacy);
    expect((await f.signin()).status).toBe(200);
    expect(f.user?.password_hash).toMatch(/^scrypt\$N=131072,r=8,p=1\$/);
    expect(f.upgrades()).toBe(1);
    expect(await verifyPassword(password, f.user?.password_hash ?? "")).toBe(true);
  });
  it("keeps an old hash unchanged after a wrong password", async () => {
    const f = fixture(legacy);
    const response = await f.signin("wrong password");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Email or password is incorrect." });
    expect(f.user?.password_hash).toBe(legacy);
    expect(f.upgrades()).toBe(0);
    // The old-cost check plus one strong dummy derive: as slow as an unknown email, never cheaper.
    expect(scrypt).toHaveBeenCalledTimes(2);
    expect(vi.mocked(scrypt).mock.calls[1]?.[3]).toMatchObject({ N: 131072, r: 8, p: 1 });
    // The same account must subsequently upgrade on a valid attempt.
    expect((await f.signin()).status).toBe(200);
    expect(f.upgrades()).toBe(1);
  });
  it("asks for a retry, not a wrong password, when a concurrent change wins the upgrade", async () => {
    const f = fixture(legacy, true);
    const response = await f.signin();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Please wait a moment and try again." });
    expect(f.user?.password_hash).toBe(legacy);
  });
  it("runs exactly one strong derive for an unknown email", async () => {
    expect((await fixture().signin()).status).toBe(401);
    expect(scrypt).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scrypt).mock.calls[0]?.[3]).toMatchObject({ N: 131072, r: 8, p: 1 });
  });
  it("writes strong new passwords and caps concurrent derives at four", async () => {
    const work = Array.from({ length: 5 }, () => hashPassword(password));
    const outcomes = await Promise.allSettled(work);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(4);
    expect(outcomes[4]).toMatchObject({
      status: "rejected",
      reason: { status: 429, message: "Please wait a moment and try again." },
    });
    for (const outcome of outcomes)
      if (outcome.status === "fulfilled")
        expect(outcome.value).toMatch(/^scrypt\$N=131072,r=8,p=1\$/);
    console.log(`Password concurrency peak RSS: ${process.resourceUsage().maxRSS} KiB`);
  }, 30000);
});
