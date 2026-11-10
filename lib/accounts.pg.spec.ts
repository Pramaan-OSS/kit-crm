import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createAccounts, hashPassword, verifyPassword } from "./accounts";

// The starter's own sign-up and sign-in (lib/accounts.ts is its exact bytes) against real Postgres.
// An empty TEST_DATABASE_URL falls back too, so a blank variable never skips the suite silently.
const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const pool = new Pool({ connectionString: url, max: 2 });
const ids: string[] = [];
const password = "Correct password 42";
const accounts = createAccounts(pool, {
  secret: "x".repeat(32),
  secureCookies: false,
  sessionSeconds: 3600,
  passwordMinLength: 12,
  maxBodyBytes: 16384,
  taskTitleLength: 240,
  authAttempts: 100,
  authClientAttempts: 1000,
  authWindowSeconds: 60,
});
function post(action: string, input: object) {
  return accounts.handle(
    new Request(`http://localhost/api/account/${action}`, {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
    action,
  );
}
afterAll(async () => {
  if (url) await pool.query("DELETE FROM app_users WHERE id=ANY($1::uuid[])", [ids]);
  await pool.end();
});
describe.skipIf(!url)("password sign-in on Postgres", () => {
  it("stores a hash at signup that signs in, and refuses a wrong password", async () => {
    const email = `${randomUUID()}@example.test`;
    expect((await post("signup", { email, password })).status).toBe(200);
    const row = (await pool.query("SELECT id,password_hash FROM app_users WHERE email=$1", [email]))
      .rows[0];
    ids.push(row.id);
    expect(row.password_hash).not.toContain(password);
    expect(await verifyPassword(password, row.password_hash)).toBe(true);
    expect((await post("signin", { email, password: "wrong password" })).status).toBe(401);
    expect((await post("signin", { email, password })).status).toBe(200);
    expect(
      (await pool.query("SELECT 1 FROM app_sessions WHERE user_id=$1", [row.id])).rowCount,
    ).toBeGreaterThan(0);
  });
  it("signs in an account whose hash was made by hashPassword", async () => {
    const id = randomUUID();
    ids.push(id);
    const email = `${id}@example.test`;
    await pool.query("INSERT INTO app_users(id,email,password_hash) VALUES($1,$2,$3)", [
      id,
      email,
      await hashPassword(password),
    ]);
    expect((await post("signin", { email, password })).status).toBe(200);
  });
});
