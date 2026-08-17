"use strict";
// API-surface check: every module must load and export what app.js calls.
var path = require("path");
var root = path.resolve(__dirname, "..");

var names = ["util", "logger", "settings", "history", "cookie-jar", "binary-manager", "quality", "downloader", "csbridge"];
var mods = {};
var failed = false;
names.forEach(function (name) {
  try {
    mods[name] = require(path.join(root, "extension", "js", name + ".js"));
    console.log("OK   " + name);
  } catch (error) {
    failed = true;
    console.log("FAIL " + name + " -> " + String(error.message).split("\n")[0]);
  }
});

var checks = {
  downloader: ["fetchSuggestions", "searchYouTube", "loadMoreResults", "classifyUrl", "fetchPlaylistEntries", "resolveMetadata", "enqueueDownload", "cancelDownload", "on"],
  quality: ["estimateAudioSize", "planVideoCandidates", "getAudioSelector", "getFormatSortArgs"],
  "binary-manager": ["checkForUpdates", "autoCheckForUpdates", "getRuntimeStatus", "getYtDlpCommand"],
  "cookie-jar": ["probeBrowser"],
  settings: ["read", "write"],
  history: ["read", "add", "remove", "clear"],
  util: ["getStateDir", "httpGet"]
};
Object.keys(checks).forEach(function (moduleName) {
  var obj = mods[moduleName];
  checks[moduleName].forEach(function (fn) {
    var ok = obj && typeof obj[fn] === "function";
    if (!ok) { failed = true; }
    console.log((ok ? "  OK " : "  MISSING ") + moduleName + "." + fn);
  });
});

var runtime = mods["binary-manager"] ? mods["binary-manager"].getRuntimeStatus() : null;
console.log("runtime:", runtime ? JSON.stringify(runtime) : "n/a");
process.exit(failed ? 1 : 0);
