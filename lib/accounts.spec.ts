import { randomUUID } from "node:crypto";
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
// Precomputed from `password` and `salt`, so loading this file runs no 128 MiB derive.
const legacy = `scrypt:${salt}:c5f558f051d181ac7544bb888adf83ac786723a6c3433eb473287f59be86d80aa45bc518a4c2cbcce88e166325b8309d90bef7b4e7949655449d7fc020d5191f`;
const strong = `scrypt$N=131072,r=8,p=1$${salt}$3454bc748e5b5296e43ee4cdf54d623d5e3baea0c020e5a838c79e515148eed0e8ac4fe712b6a4d11d125db7299c705a8e3d31f446acc726c6e3e9c8a1e402a6`;
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
    // Held stand-in derives prove the cap without four real 128 MiB derives in flight.
    const held: (() => void)[] = [];
    for (let i = 0; i < 4; i++)
      vi.mocked(scrypt).mockImplementationOnce(((...args: unknown[]) => {
        const done = args.at(-1) as (error: Error | null, key: Buffer) => void;
        held.push(() => done(null, Buffer.alloc(64)));
      }) as typeof scrypt);
    const settled = Promise.allSettled(Array.from({ length: 5 }, () => hashPassword(password)));
    await vi.waitFor(() => expect(held).toHaveLength(4));
    for (const release of held) release();
    const outcomes = await settled;
    expect(scrypt).toHaveBeenCalledTimes(4);
    expect(vi.mocked(scrypt).mock.calls[0]?.[3]).toMatchObject({ N: 131072, r: 8, p: 1 });
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(4);
    expect(outcomes[4]).toMatchObject({
      status: "rejected",
      reason: { status: 429, message: "Please wait a moment and try again." },
    });
    for (const outcome of outcomes)
      if (outcome.status === "fulfilled")
        expect(outcome.value).toMatch(/^scrypt\$N=131072,r=8,p=1\$/);
  });
});
