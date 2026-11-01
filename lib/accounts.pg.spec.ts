import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createAccounts, verifyPassword } from "./accounts";

// An empty TEST_DATABASE_URL falls back too, so a blank variable never skips the suite silently.
const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const pool = new Pool({ connectionString: url, max: 2 });
const ids: string[] = [];
const password = "Correct password 42";
const salt = "b".repeat(32);
const legacy = `scrypt:${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
const strong = `scrypt$N=131072,r=8,p=1$${salt}$${scryptSync(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }).toString("hex")}`;
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
function post(action: string, input: object, cookie = "") {
  return accounts.handle(
    new Request(`http://localhost/api/account/${action}`, {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json", cookie },
      body: JSON.stringify(input),
    }),
    action,
  );
}
async function user(hash: string) {
  const id = randomUUID();
  ids.push(id);
  const email = `${id}@example.test`;
  await pool.query("INSERT INTO app_users(id,email,password_hash) VALUES($1,$2,$3)", [
    id,
    email,
    hash,
  ]);
  return { id, email };
}
afterAll(async () => {
  if (url) await pool.query("DELETE FROM app_users WHERE id=ANY($1::uuid[])", [ids]);
  await pool.end();
});
describe.skipIf(!url)("password sign-in on Postgres", () => {
  it("accepts a reset-format hash and creates a session", async () => {
    const u = await user(strong);
    expect((await post("signin", { email: u.email, password })).status).toBe(200);
    expect((await pool.query("SELECT * FROM app_sessions WHERE user_id=$1", [u.id])).rowCount).toBe(
      1,
    );
  });
  it("upgrades a legacy hash and replaces old sessions", async () => {
    const u = await user(legacy);
    const old = randomBytes(32).toString("hex");
    await pool.query(
      "INSERT INTO app_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
      [old, u.id],
    );
    expect((await post("signin", { email: u.email, password: "wrong" })).status).toBe(401);
    expect(
      (await pool.query("SELECT password_hash FROM app_users WHERE id=$1", [u.id])).rows[0]
        .password_hash,
    ).toBe(legacy);
    expect((await post("signin", { email: u.email, password })).status).toBe(200);
    const hash = (await pool.query("SELECT password_hash FROM app_users WHERE id=$1", [u.id]))
      .rows[0].password_hash;
    expect(hash).toMatch(/^scrypt\$N=131072,r=8,p=1\$/);
    expect(await verifyPassword(password, hash)).toBe(true);
    const sessions = await pool.query("SELECT token_hash FROM app_sessions WHERE user_id=$1", [
      u.id,
    ]);
    expect(sessions.rowCount).toBe(1);
    expect(sessions.rows[0].token_hash).not.toBe(old);
  });
  it("stores a strong hash at signup", async () => {
    const id = randomUUID();
    const email = `${id}@example.test`;
    const response = await post("signup", { email, password });
    expect(response.status).toBe(200);
    const row = (await pool.query("SELECT id,password_hash FROM app_users WHERE email=$1", [email]))
      .rows[0];
    ids.push(row.id);
    expect(row.password_hash).toMatch(/^scrypt\$N=131072,r=8,p=1\$/);
  });
});
