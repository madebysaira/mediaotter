"use strict";

/**
 * MediaOtter — package the extension into a .zxp (zip with CSXS manifest).
 * No npm deps: uses system zip / python3 / powershell as available.
 *
 * Usage: node scripts/build-zxp.js [version]
 */

var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");

var ROOT = path.resolve(__dirname, "..");
var EXT = path.join(ROOT, "extension");
var DIST = path.join(ROOT, "dist");

var version = process.argv[2] || "1.0.0";
var outName = "mediaotter-" + version + ".zxp";
var outPath = path.join(DIST, outName);

function fail(message) {
  console.error("✗ " + message);
  process.exit(1);
}

if (!fs.existsSync(path.join(EXT, "CSXS", "manifest.xml"))) {
  fail("extension/CSXS/manifest.xml missing — nothing to package.");
}

if (!fs.existsSync(path.join(EXT, "index.html"))) {
  fail("extension/index.html missing.");
}

fs.mkdirSync(DIST, { recursive: true });
try { fs.unlinkSync(outPath); } catch (error) { /* not present yet */ }

console.log("Packaging " + EXT + " → " + outPath);

function exec(cmd) {
  var result = childProcess.spawnSync(cmd, { shell: true, cwd: EXT, stdio: "inherit" });
  if (result.status !== 0) { fail("command failed: " + cmd); }
}

var platform = process.platform;
if (platform === "win32") {
  // PowerShell Compress-Archive produces zip-compatible archives (zxp is a zip).
  exec('powershell -NoProfile -Command "Compress-Archive -Path * -DestinationPath ' + outPath.replace(/'/g, "''") + ' -Force"');
} else {
  // Try system zip, fall back to python3 zipfile (works everywhere).
  var zip = childProcess.spawnSync("which zip", { shell: true });
  if (zip.status === 0) {
    exec("zip -r -X " + JSON.stringify(outPath) + " .");
  } else {
    exec('python3 - <<\'PY\'\nimport zipfile, os, sys\nout = sys.argv[1]\nwith zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:\n    for root, _, files in os.walk("."):\n        for name in files:\n            fp = os.path.join(root, name)\n            z.write(fp, fp)\nPY ' + JSON.stringify(outPath));
  }
}

var sizeMb = (fs.statSync(outPath).size / 1048576).toFixed(1);
console.log("✓ Built " + outPath + " (" + sizeMb + " MB)");
console.log("  Verify: unzip -l " + outName + " | head");
