import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import path from "path";

// All sub-packages / plugins that MIGHT need a TypeScript build step.
// Folders without a package.json, or without a "build" script, are skipped safely.
const dirs = [
  "src/packages/scraper-core",
  "src/packages/worker-ai-enrichment",
  "src/plugins/amazon",
  "src/plugins/ebay",
  "src/plugins/facebook",
  "src/plugins/google-maps",
  "src/plugins/instagram",
  "src/plugins/linkedin",
  "src/plugins/tripadvisor",
  "src/plugins/website",
  "src/plugins/youtube",
  "src/packages/worker-registry",
  "src/packages/worker-scheduler",
];

let builtCount = 0;
let skippedCount = 0;

for (const dir of dirs) {
  const pkgPath = path.join(dir, "package.json");

  if (!existsSync(pkgPath)) {
    console.log(`[build-all] Skipping ${dir} (no package.json)`);
    skippedCount++;
    continue;
  }

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (err) {
    console.warn(`[build-all] Could not parse ${pkgPath}: ${err.message}`);
    skippedCount++;
    continue;
  }

  if (!pkg.scripts || !pkg.scripts.build) {
    console.log(`[build-all] Skipping ${dir} (no build script)`);
    skippedCount++;
    continue;
  }

  console.log(`[build-all] Building ${dir}...`);
  try {
    execSync("npm run build", { cwd: dir, stdio: "inherit" });
    builtCount++;
  } catch (err) {
    console.error(`[build-all] Build FAILED for ${dir}`);
    // Re-throw so the overall Render build fails loudly instead of silently
    // shipping a broken dist/ folder.
    throw err;
  }
}

console.log(`[build-all] Done. Built: ${builtCount}, Skipped: ${skippedCount}`);
