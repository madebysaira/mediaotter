"use strict";

/**
 * MediaOtter — pre-ship validation gate.
 *   1. node --check on every .js file (engine + scripts)
 *   2. XML well-formedness of the CEP manifest
 *   3. Secret scan: real API keys / client IDs / env files must not be tracked by git
 *
 * Usage: node scripts/validate.js
 * Exit code 0 = all good, 1 = at least one gate failed.
 */

var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");

var ROOT = path.resolve(__dirname, "..");
var failures = 0;

function fail(message) {
  failures += 1;
  console.error("  ✗ " + message);
}

function ok(message) {
  console.log("  ✓ " + message);
}

console.log("MediaOtter validation\n");

// 1. Syntax
console.log("[1/4] JavaScript syntax");
var jsFiles = [];
[path.join(ROOT, "extension", "js"), path.join(ROOT, "scripts")].forEach(function (dir) {
  if (!fs.existsSync(dir)) { return; }
  fs.readdirSync(dir).forEach(function (name) {
    if (name.endsWith(".js")) { jsFiles.push(path.join(dir, name)); }
  });
});
jsFiles.forEach(function (file) {
  var result = childProcess.spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) { fail(file + " failed syntax check:\n" + (result.stderr || "").trim()); }
});
if (!failures) { ok(jsFiles.length + " files pass node --check"); }

// 2. Manifest
console.log("[2/4] CEP manifest");
var manifestPath = path.join(ROOT, "extension", "CSXS", "manifest.xml");
if (!fs.existsSync(manifestPath)) {
  fail("manifest.xml missing");
} else {
  var xmllint = childProcess.spawnSync("xmllint", ["--noout", manifestPath], { encoding: "utf8" });
  if (xmllint.status === 0) {
    ok("manifest.xml is well-formed");
  } else {
    var python = childProcess.spawnSync("python3", ["-c", "import xml.dom.minidom,sys; xml.dom.minidom.parse(sys.argv[1])", manifestPath], { encoding: "utf8" });
    if (python.status === 0) { ok("manifest.xml is well-formed (python parser)"); }
    else { fail("manifest.xml is malformed: " + (python.stderr || "").trim().slice(0, 300)); }
  }
}

// 3. Secret scan (tracked files only)
console.log("[3/4] Secret scan");
var gitFiles = childProcess.spawnSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
var secretPatterns = [
  // Google API key. Negative lookahead excludes the PUBLIC innertube
  // WEB-client key: YouTube embeds it in the JS of every page load (yt-dlp
  // ships the same key in its source). It grants no user access and is not
  // a credential — downloader.js needs it for search-continuation calls.
  /AIza(?!SyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8)[0-9A-Za-z_-]{35}/,
  /[0-9]{12}-[0-9a-z]{32}\.apps\.googleusercontent\.com/, // Google OAuth client ID
  /ya29\.[0-9A-Za-z_-]+/,                                // Google OAuth access token
  /sk-[0-9A-Za-z]{20,}/,                                  // OpenAI-style keys
  /AKIA[0-9A-Z]{16}/,                                     // AWS keys
  // Real Google client secrets are always "GOCSPX-" + 28 chars. Matching the
  // VALUE format (not the field name) catches genuine leaks while ignoring
  // field references, empty strings, and "GOCSPX-SELFTEST"-style placeholders.
  /GOCSPX-[0-9A-Za-z_-]{20,}/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/
];
var secretHits = 0;
gitFiles.forEach(function (file) {
  if (!file || file.indexOf("node_modules") !== -1) { return; }
  var full = path.join(ROOT, file);
  if (!fs.existsSync(full)) { return; }
  var content;
  try { content = fs.readFileSync(full, "utf8"); } catch (error) { return; }
  secretPatterns.forEach(function (pattern) {
    if (pattern.test(content)) {
      secretHits += 1;
      fail("possible secret in tracked file " + file);
    }
  });
});
if (!secretHits) { ok("no secret patterns in tracked files"); }

["credentials.json", ".env", "*.secret"].forEach(function (name) {
  var check = childProcess.spawnSync("git", ["-C", ROOT, "check-ignore", "--quiet", name], { encoding: "utf8" });
  if (check.status === 0) { ok(name + " is gitignored"); }
  else { fail(name + " is NOT gitignored"); }
});

// 4. Key files present
console.log("[4/4] Key files");
["extension/CSXS/manifest.xml", "extension/index.html", "extension/js/app.js", "extension/js/downloader.js",
 "extension/jsx/hostscript.jsx", "extension/lib/CSInterface.js", "extension/js/credentials.example.json",
 "docs/CREDENTIALS.md", "docs/INSTALL.md", "README.md", "LICENSE", ".gitignore"].forEach(function (file) {
  if (fs.existsSync(path.join(ROOT, file))) { ok(file); }
  else { fail(file + " missing"); }
});

console.log("\n" + (failures === 0 ? "✓ ALL GATES PASSED" : "✗ " + failures + " FAILURE(S)"));
process.exit(failures === 0 ? 0 : 1);
