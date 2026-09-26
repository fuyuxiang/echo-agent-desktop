import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it, expect } from "vitest";
function files(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (['experimental', '__tests__'].includes(e.name) ? [] : files(join(dir, e.name))) : /\.[jt]sx?$/.test(e.name) ? [join(dir, e.name)] : []); }
it("experimental adapters are not imported by production UI", () => {
  const imports = files("src").flatMap(file => [...readFileSync(file, "utf8").matchAll(/(?:from\s*|import\s*\()(["'])([^"']+)\1/g)].filter(m => /experimental\//.test(m[2])).map(() => file));
  expect(imports).toEqual([]);
});
