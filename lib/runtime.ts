import { Pool } from "pg";
import { createAccounts } from "./accounts";
import { emailDoor } from "./email";

let pool: Pool | undefined;
let accounts: ReturnType<typeof createAccounts> | undefined;
const integer = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
};
/** The app's one connection pool: accounts and workspace records share it (the live database allows few connections). */
export function database() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Account storage has not been configured");
  pool = new Pool({
    connectionString: url,
    statement_timeout: 10_000,
    max: Math.min(integer("APP_DB_POOL_SIZE", 3), 6),
    connectionTimeoutMillis: integer("APP_DB_CONNECT_TIMEOUT_MS", 5000),
  });
  // pg emits errors for idle sockets outside a request. Keep the process alive;
  // later requests still receive the ordinary storage-unavailable response.
  pool.on("error", () => console.error("Account database connection unavailable"));
  return pool;
}
/** SESSION_SECRET: signs sessions (lib/accounts.ts). */
export function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw new Error("SESSION_SECRET must be configured by the runtime");
  return secret;
}
export function accountRuntime() {
  if (accounts) return accounts;
  const secret = process.env.SESSION_SECRET;
  if (!process.env.DATABASE_URL || !secret)
    throw new Error("Account storage has not been configured");
  accounts = createAccounts(database(), {
    secret,
    origin: process.env.APP_ORIGIN,
    projectId: process.env.PRAMAAN_PROJECT_ID,
    // Sign-up makes an unassigned member. An owner adds workspace access separately.
    publicSignUp: true,
    mailer: emailDoor,
    secureCookies: process.env.APP_COOKIE_SECURE !== "false",
    sessionSeconds: integer("APP_SESSION_SECONDS", 604800),
    passwordMinLength: integer("APP_PASSWORD_MIN_LENGTH", 12),
    maxBodyBytes: integer("APP_MAX_BODY_BYTES", 16384),
    taskTitleLength: integer("APP_TASK_TITLE_LENGTH", 240),
    authAttempts: integer("APP_AUTH_ATTEMPTS", 10),
    authClientAttempts: integer("APP_AUTH_CLIENT_ATTEMPTS", 30),
    authWindowSeconds: integer("APP_AUTH_WINDOW_SECONDS", 60),
  });
  return accounts;
}
