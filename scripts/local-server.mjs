import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

await mkdir(".evidence", { recursive: true });
const config = {
  secret: randomBytes(32).toString("hex"),
  project: "crm-local",
  origin: "http://127.0.0.1:3410",
};
await writeFile(".evidence/runtime.json", JSON.stringify(config), { mode: 0o600 });
const child = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "start", "-p", "3410", "-H", "127.0.0.1"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PRAMAAN_FAKE: "1",
      DATABASE_URL: process.env.DATABASE_URL,
      SESSION_SECRET: config.secret,
      PRAMAAN_PROJECT_ID: config.project,
      APP_ORIGIN: config.origin,
      APP_COOKIE_SECURE: "false",
    },
  },
);
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 1));
