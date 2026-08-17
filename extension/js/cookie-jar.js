"use strict";

/**
 * MediaOtter — YouTube browser session (cookie jar).
 * Lets yt-dlp borrow cookies from the user's own browser for private,
 * age-restricted or bot-flagged content. yt-dlp does the cookie extraction
 * (incl. encrypted Chrome cookies) — we manage the preference + readiness probe.
 */

var path = require("path");
var util = require("./util.js");
var logger = require("./logger.js");
var binaryManager = require("./binary-manager.js");

var SUPPORTED_BROWSERS = [
  { key: "chrome", label: "Google Chrome" },
  { key: "edge", label: "Microsoft Edge" },
  { key: "brave", label: "Brave" },
  { key: "firefox", label: "Firefox" }
];

function getSupportedBrowsers() {
  return SUPPORTED_BROWSERS;
}

/** Probe: can yt-dlp read cookies for this browser? */
function probeBrowser(browserKey) {
  var command = binaryManager.getYtDlpCommand();
  if (!command.executable && !command.argsPrefix.length) {
    return Promise.resolve({ ok: false, error: "yt-dlp runtime is not ready." });
  }
  var args = [
    "--no-warnings",
    "--cookies-from-browser", browserKey,
    "--skip-download",
    "--dump-single-json",
    "--playlist-items", "1",
    "--flat-playlist",
    "https://www.youtube.com/feed/subscriptions"
  ];
  return util.spawnProcess(command.executable, command.argsPrefix.concat(args), {
    timeoutMs: 45000,
    onError: function () { binaryManager.reportSpawnFailure(command.path); }
  }).then(function (result) {
    if (result.code === 0) {
      binaryManager.reportSpawnSuccess(command.path);
      return { ok: true, browser: browserKey };
    }
    var text = String(result.stderr || "") + String(result.stdout || "");
    var error = "Unable to read cookies from " + browserKey + ".";
    if (/keyring/i.test(text) || /keychain/i.test(text) || /Could not decrypt|No decryptor/i.test(text)) {
      error += " macOS Keychain access was denied — allow it in System Settings → Privacy & Security, or unlock your keychain.";
    }
    if (/Could not find|No cookies/i.test(text)) {
      error += " No " + browserKey + " cookies found — are you logged in on " + browserKey + "?";
    }
    if (/did not find file/i.test(text)) {
      error += " Browser profile not found.";
    }
    return { ok: false, browser: browserKey, error: error, detail: text.slice(-200) };
  });
}

module.exports = {
  getSupportedBrowsers: getSupportedBrowsers,
  probeBrowser: probeBrowser
};
