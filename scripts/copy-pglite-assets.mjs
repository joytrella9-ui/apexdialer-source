import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules/@electric-sql/pglite/dist");
const target = join(root, ".vercel/output/functions/__server.func/_libs");
const files = ["pglite.data", "pglite.wasm", "initdb.wasm"];

if (!existsSync(target)) {
  console.log("[pglite] nitro output not present, skipping asset copy");
  process.exit(0);
}

for (const file of files) {
  copyFileSync(join(source, file), join(target, file));
}
console.log("[pglite] copied wasm assets into the server bundle");
