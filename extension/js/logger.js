"use strict";

/**
 * MediaOtter — local logger. No telemetry: everything stays on the user's machine.
 * Writes to <stateDir>/logs/mediaotter.log with 1MB rotation.
 */

var fs = require("fs");
var path = require("path");
var util = require(path.join(__dirname, "util.js"));

var LOG_FILE_NAME = "mediaotter.log";
var MAX_LOG_BYTES = 1024 * 1024;
var logFilePath = "";
var logWriteQueue = Promise.resolve();

function getLogFilePath() {
  if (!logFilePath) {
    logFilePath = path.join(util.getLogsDir(), LOG_FILE_NAME);
  }
  return logFilePath;
}

function rotateIfNeeded() {
  try {
    var stats = fs.statSync(getLogFilePath());
    if (stats.size > MAX_LOG_BYTES) {
      fs.renameSync(getLogFilePath(), getLogFilePath() + ".old");
    }
  } catch (error) {
    /* no file yet — fine */
  }
}

function writeLine(level, component, message, details) {
  var entry = {
    ts: new Date().toISOString(),
    level: level,
    component: component,
    message: message,
    details: details || {}
  };
  var line;
  try {
    line = JSON.stringify(entry);
  } catch (error) {
    line = JSON.stringify({ ts: entry.ts, level: level, component: component, message: message });
  }

  if (typeof console !== "undefined") {
    if (level === "error") {
      console.error("[MediaOtter:" + component + "] " + message);
    } else if (level === "warn") {
      console.warn("[MediaOtter:" + component + "] " + message);
    } else {
      console.log("[MediaOtter:" + component + "] " + message);
    }
  }

  logWriteQueue = logWriteQueue.then(function () {
    return new Promise(function (resolve) {
      try {
        rotateIfNeeded();
        fs.appendFileSync(getLogFilePath(), line + "\n", "utf8");
      } catch (error) {
        /* logging must never crash the panel */
      }
      resolve();
    });
  });
}

function info(component, message, details) {
  writeLine("info", component, message, details);
}

function warn(component, message, details) {
  writeLine("warn", component, message, details);
}

function error(component, message, details) {
  writeLine("error", component, message, details);
}

module.exports = {
  info: info,
  warn: warn,
  error: error,
  getLogFilePath: getLogFilePath
};
