import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const draft = process.argv.includes("--draft");
const config = JSON.parse(await readFile(".evidence/runtime.json", "utf8"));
await mkdir(".evidence/results", { recursive: true });
const args = [
  "run",
  "--rm",
  "--name",
  draft ? "kit-crm-draft-measure" : "kit-crm-browser-measure",
  "--memory",
  draft ? "2560m" : "1g",
  "--memory-swap",
  draft ? "3584m" : "1g",
  "--cpus",
  "1",
  "--pids-limit",
  "256",
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges:true",
  "--user=1000:1000",
  "--tmpfs=/tmp:rw,size=134217728",
];
for (const [src, dst] of [
  [".evidence/linux", "/work"],
  [".evidence/results", "/results"],
])
  args.push("--mount", `type=bind,src=${path.resolve(src)},dst=${dst}`);
args.push("--workdir=/work");
for (const name of [
  "SESSION_SECRET",
  "PRAMAAN_PROJECT_ID",
  "DATABASE_URL",
  "APP_ORIGIN",
  "APP_COOKIE_SECURE",
  "NODE_OPTIONS",
  "NEXT_TELEMETRY_DISABLED",
])
  args.push("-e", name);
args.push(
  "kit-bookings-cell:test",
  "node",
  "scripts/measure-server.mjs",
  ...(draft ? ["--draft"] : []),
);
const child = spawn("docker", args, {
  stdio: "inherit",
  env: {
    ...process.env,
    SESSION_SECRET: config.secret,
    PRAMAAN_PROJECT_ID: config.project,
    DATABASE_URL: "postgresql://kit_crm@host.docker.internal:55439/crm",
    APP_ORIGIN: config.origin,
    APP_COOKIE_SECURE: "false",
    NODE_OPTIONS: `--max-old-space-size=${draft ? 819 : 409}`,
    NEXT_TELEMETRY_DISABLED: "1",
  },
});
child.on("exit", (code) => process.exit(code ?? 1));
