/**
 * build-all-plugins.js
 *
 * Scans worker/src/plugins/*, and for every plugin folder that has a
 * package.json with a "build" script, runs `npm install` (only if
 * node_modules is missing) and then the build script (tsc).
 *
 * Usage (from inside the `worker` folder):
 *   node build-all-plugins.js
 *
 * Works on Windows, Linux (Contabo), and Mac — no bash required.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const pluginsDir = path.join(__dirname, "src", "plugins");

if (!fs.existsSync(pluginsDir)) {
  console.error(`❌ Could not find plugins folder at: ${pluginsDir}`);
  console.error("   Run this script from inside the 'worker' folder.");
  process.exit(1);
}

const pluginFolders = fs
  .readdirSync(pluginsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

console.log(`Found ${pluginFolders.length} plugin folder(s): ${pluginFolders.join(", ")}\n`);

const results = {
  built: [],
  skipped: [],
  failed: [],
};

for (const pluginName of pluginFolders) {
  const pluginPath = path.join(pluginsDir, pluginName);
  const packageJsonPath = path.join(pluginPath, "package.json");

  if (!fs.existsSync(packageJsonPath)) {
    console.log(`⏭️  [${pluginName}] No package.json found, skipping.`);
    results.skipped.push(pluginName);
    continue;
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch (err) {
    console.log(`⚠️  [${pluginName}] Could not parse package.json, skipping. (${err.message})`);
    results.skipped.push(pluginName);
    continue;
  }

  if (!pkg.scripts || !pkg.scripts.build) {
    console.log(`⏭️  [${pluginName}] No "build" script defined, skipping.`);
    results.skipped.push(pluginName);
    continue;
  }

  console.log(`\n=== [${pluginName}] ===`);

  const nodeModulesPath = path.join(pluginPath, "node_modules");
  if (!fs.existsSync(nodeModulesPath)) {
    console.log(`[${pluginName}] node_modules missing, running npm install...`);
    try {
      execSync("npm install", { cwd: pluginPath, stdio: "inherit" });
    } catch (err) {
      console.log(`❌ [${pluginName}] npm install failed.`);
      results.failed.push(pluginName);
      continue;
    }
  }

  console.log(`[${pluginName}] Running build...`);
  try {
    execSync("npm run build", { cwd: pluginPath, stdio: "inherit" });
    console.log(`✅ [${pluginName}] Build succeeded.`);
    results.built.push(pluginName);
  } catch (err) {
    console.log(`❌ [${pluginName}] Build failed.`);
    results.failed.push(pluginName);
  }
}

console.log("\n\n================ SUMMARY ================");
console.log(`✅ Built (${results.built.length}): ${results.built.join(", ") || "none"}`);
console.log(`⏭️  Skipped (${results.skipped.length}): ${results.skipped.join(", ") || "none"}`);
console.log(`❌ Failed (${results.failed.length}): ${results.failed.join(", ") || "none"}`);

if (results.failed.length > 0) {
  process.exitCode = 1;
}
