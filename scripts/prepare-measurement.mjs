import { cp, mkdir, readdir, rm } from "node:fs/promises";

await mkdir(".evidence/linux", { recursive: true });
for (const name of await readdir(".evidence/linux")) {
  if (name === "node_modules") continue;
  await rm(`.evidence/linux/${name}`, { recursive: true, force: true });
}
for (const name of await readdir(".")) {
  if (name.startsWith(".") || name === "node_modules" || name === "next-env.d.ts") continue;
  await cp(name, `.evidence/linux/${name}`, { recursive: true });
}
for (const name of [".npmrc", ".gitignore"]) await cp(name, `.evidence/linux/${name}`);
