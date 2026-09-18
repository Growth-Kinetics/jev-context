// Ratchet: every dependency and devDependency must be exact-pinned (no ^, ~, or ranges).
// Mirrors pi-mono scripts/check-pinned-deps.mjs intent, reduced for a single-package repo.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const offenders: string[] = [];
for (const section of ["dependencies", "devDependencies"] as const) {
  for (const [name, range] of Object.entries(pkg[section] ?? {})) {
    if (typeof range !== "string" || !/^\d+\.\d+\.\d+/.test(range)) {
      offenders.push(`${section}.${name} = ${range}`);
    }
  }
}
if (offenders.length > 0) {
  console.error(
    `PINNED_DEPS_VIOLATION:\n${offenders.map((o) => `  ${o}`).join("\n")}`,
  );
  process.exit(1);
}
console.log("PINNED_DEPS_OK: all dependency ranges exact-pinned");
