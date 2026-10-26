// Generation only: python -m pip install -r scripts/requirements-guide.txt
// node scripts/generate-tester-guide.mjs [python-executable]
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const filename = fileURLToPath(new URL("apps/web/lib/tester-guide.ts", root));
const require = createRequire(import.meta.url), compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
  fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
new Function("module", "exports", "require", compiled)(module, module.exports, require);
const guide = module.exports;
const contentHash = createHash("sha256").update(guide.guideText).digest("hex");
const output = new URL(`apps/web/public/guides/${guide.guideVersion}.pdf`, root);
mkdirSync(new URL("./", output), { recursive: true });
const result = spawnSync(process.argv[2] || "python", [fileURLToPath(new URL("generate-tester-guide.py", import.meta.url)), fileURLToPath(output)], {
  input: JSON.stringify({ ...guide, contentHash }), encoding: "utf8", maxBuffer: 1024 * 1024,
});
if (result.error || result.status !== 0) throw new Error("Guide generation failed. Check Python and scripts/requirements-guide.txt. " + (result.stderr || result.error?.message || ""));
writeFileSync(new URL("apps/web/lib/guide-pdf.generated.json", root), JSON.stringify({
  guide_version: guide.guideVersion, content_sha256: contentHash,
  pdf_sha256: createHash("sha256").update(readFileSync(output)).digest("hex"),
}, null, 2) + "\n");
console.log(`Generated ${guide.guideVersion}.pdf from the public guide.`);
