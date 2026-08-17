"use strict";

/**
 * MediaOtter — persistent settings.
 * Stored in <stateDir>/settings.json. No telemetry, ever.
 */

var fs = require("fs");
var path = require("path");
var util = require("./util.js");

var SETTINGS_PATH = "";
var settingsCache = null;

var DEFAULTS = {
  maxQualityHeight: 2160,       // 2160 | 1440 | 1080 | 720 | 480
  allowEncoding: false,         // allow ffmpeg transcode to H.264 when needed
  downloadLocation: "project",  // "project" | "custom"
  customPath: "",
  cookiesBrowser: "",           // chrome | edge | brave | firefox | ""
  theme: "dark",                // dark | light
  pausePreviewWhenHidden: false,
  autoCheckUpdates: true,
  historyLimit: 200
};

function getSettingsPath() {
  if (!SETTINGS_PATH) {
    SETTINGS_PATH = path.join(util.getStateDir(), "settings.json");
  }
  return SETTINGS_PATH;
}

function read() {
  if (settingsCache) {
    return Object.assign({}, DEFAULTS, settingsCache);
  }
  var loaded = {};
  try {
    loaded = JSON.parse(fs.readFileSync(getSettingsPath(), "utf8"));
  } catch (error) {
    loaded = {};
  }
  settingsCache = Object.assign({}, DEFAULTS, loaded);
  return Object.assign({}, DEFAULTS, settingsCache);
}

function write(patch) {
  var merged = read();
  Object.keys(patch || {}).forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
      merged[key] = patch[key];
    }
  });
  settingsCache = merged;
  try {
    fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
    fs.writeFileSync(getSettingsPath(), JSON.stringify(merged, null, 2) + "\n", { mode: 384 });
  } catch (error) {
    /* settings persistence must not crash the panel */
  }
  return read();
}

module.exports = {
  read: read,
  write: write,
  DEFAULTS: DEFAULTS
};
