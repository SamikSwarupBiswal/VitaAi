import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localPython = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const result = spawnSync(existsSync(localPython) ? localPython : "python", ["-m", "vita_api.export_openapi"], {
  cwd: path.join(root, "services/api"), encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
});
if (result.error || result.status !== 0) {
  throw new Error("OpenAPI export failed. Install API requirements first. " + (result.stderr || result.error));
}
const source = astToString(await openapiTS(JSON.parse(result.stdout)));
writeFileSync(path.join(root, "apps/web/lib/api.generated.ts"), source);
console.log("Generated TypeScript contracts from the FastAPI OpenAPI schema.");
