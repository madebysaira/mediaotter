"use strict";

/**
 * MediaOtter — inject credentials into the extension WITHOUT ever committing them.
 *
 * Reads MF_GOOGLE_CLIENT_ID / MF_GOOGLE_CLIENT_SECRET / MF_GOOGLE_API_KEY from the
 * environment, or a local credentials.json at the repo root (gitignored). Writes
 * extension/js/credentials.json (gitignored). Refuses placeholders/empty values.
 * Prints a REDACTED confirmation.
 *
 * Usage:  node scripts/inject-credentials.js
 */

var fs = require("fs");
var path = require("path");

var ROOT = path.resolve(__dirname, "..");
var DEST = path.join(ROOT, "extension", "js", "credentials.json");
var ROOT_CRED = path.join(ROOT, "credentials.json");

var clientId = process.env.MF_GOOGLE_CLIENT_ID || "";
var clientSecret = process.env.MF_GOOGLE_CLIENT_SECRET || "";
var apiKey = process.env.MF_GOOGLE_API_KEY || "";

if (!clientId || !clientSecret) {
  try {
    if (fs.existsSync(ROOT_CRED)) {
      var local = JSON.parse(fs.readFileSync(ROOT_CRED, "utf8"));
      clientId = clientId || local.clientId || "";
      clientSecret = clientSecret || local.clientSecret || "";
      apiKey = apiKey || local.apiKey || "";
    }
  } catch (error) {
    console.error("Could not read " + ROOT_CRED + ": " + error.message);
    process.exit(1);
  }
}

function isPlaceholder(value) {
  return !value ||
    value.indexOf("REPLACE_WITH") !== -1 ||
    value.indexOf("YOUR_") !== -1 ||
    value.indexOf("…") !== -1 ||
    value.indexOf("...") !== -1;
}

if (isPlaceholder(clientId) || isPlaceholder(clientSecret)) {
  console.error(
    "Refusing to write placeholder credentials. Set MF_GOOGLE_CLIENT_ID / MF_GOOGLE_CLIENT_SECRET" +
    " (API key MF_GOOGLE_API_KEY is optional — authenticated calls use a Bearer token only)."
  );
  process.exit(1);
}

function redact(value) {
  if (!value || value.length <= 12) { return "***"; }
  return value.slice(0, 5) + "…" + value.slice(-4);
}

var payload = JSON.stringify({
  clientId: clientId,
  clientSecret: clientSecret,
  apiKey: apiKey
}, null, 2) + "\n";
fs.writeFileSync(DEST, payload, { mode: 0o600 });
console.log("Wrote " + DEST);
console.log("  clientId:     " + redact(clientId));
console.log("  clientSecret: " + redact(clientSecret));
console.log("  apiKey:       " + (apiKey ? redact(apiKey) : "(none — optional)"));
console.log("This file is gitignored — verify with: git check-ignore extension/js/credentials.json");
