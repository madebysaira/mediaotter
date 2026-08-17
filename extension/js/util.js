"use strict";

/**
 * MediaOtter — shared platform utilities.
 * Must run inside CEP 10 (Chromium 88 / Node 12.14) AND modern Node (testing).
 * Rules: ES2017 only — no optional chaining, no nullish coalescing, no fetch().
 */

var fs = require("fs");
var path = require("path");
var os = require("os");
var crypto = require("crypto");
var http = require("http");
var https = require("https");
var childProcess = require("child_process");

var MAX_REDIRECTS = 5;
var MAX_RESPONSE_BYTES = 40 * 1024 * 1024;

function getPlatform() {
  return process.platform; // darwin | win32 | linux
}

function getArch() {
  return process.arch === "x64" ? "x64" : "arm64";
}

/** Layout key used by binaries/release.json: darwin-arm64, darwin-x64, win32-x64, linux-x64, linux-arm64 */
function getLayoutKey() {
  var platform = getPlatform();
  var arch = getArch();
  return platform + "-" + arch;
}

function getStateDir() {
  var base;
  if (getPlatform() === "darwin") {
    base = path.join(os.homedir(), "Library", "Application Support", "MediaOtter");
  } else if (getPlatform() === "win32") {
    base = process.env.APPDATA ? path.join(process.env.APPDATA, "MediaOtter") : path.join(os.homedir(), ".mediaotter");
  } else {
    base = path.join(os.homedir(), ".mediaotter");
  }
  try {
    fs.mkdirSync(base, { recursive: true });
  } catch (error) {
    /* best effort */
  }
  return base;
}

function getLogsDir() {
  var dir = path.join(getStateDir(), "logs");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    /* best effort */
  }
  return dir;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function clampInteger(value, fallback, min, max) {
  var parsed = parseInt(value, 10);
  if (!isFinite(parsed)) {
    parsed = fallback;
  }
  if (typeof min === "number" && parsed < min) {
    parsed = min;
  }
  if (typeof max === "number" && parsed > max) {
    parsed = max;
  }
  return parsed;
}

function parseFloatValue(value) {
  var parsed = parseFloat(value);
  return isFinite(parsed) ? parsed : null;
}

function cleanString(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function parseInteger(value) {
  var parsed = parseInt(value, 10);
  return isFinite(parsed) ? parsed : 0;
}

function compareVersions(left, right) {
  var leftParts = String(left || "").split(".");
  var rightParts = String(right || "").split(".");
  var length = Math.max(leftParts.length, rightParts.length);
  var index;
  for (index = 0; index < length; index += 1) {
    var leftValue = parseInt(leftParts[index], 10) || 0;
    var rightValue = parseInt(rightParts[index], 10) || 0;
    if (leftValue !== rightValue) {
      return leftValue < rightValue ? -1 : 1;
    }
  }
  return 0;
}

function sha256OfFile(filePath) {
  var hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function sha256OfBuffer(buffer) {
  var hash = crypto.createHash("sha256");
  hash.update(buffer);
  return hash.digest("hex");
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * HTTP GET with redirects, timeout and size cap.
 * Resolves with { buffer, statusCode, headers } (binary), or parsed JSON when opts.json.
 */
function httpGet(url, options) {
  var settings = Object.assign({}, options || {});
  var redirectsLeft = settings.redirectsLeft === undefined ? MAX_REDIRECTS : settings.redirectsLeft;

  return new Promise(function (resolve, reject) {
    var transport = String(url).indexOf("http://") === 0 ? http : https;
    var request;

    function cleanup() {
      request.removeAllListeners();
    }

    request = transport.get(url, {
      headers: Object.assign({
        "User-Agent": "MediaOtter/" + (settings.userAgentSuffix || "CEP"),
        "Accept": settings.json ? "application/json" : "*/*"
      }, settings.headers || {})
    }, function (response) {
      var chunks = [];
      var receivedBytes = 0;

      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        cleanup();
        if (redirectsLeft <= 0) {
          reject(new Error("Too many redirects fetching " + url));
          return;
        }
        resolve(httpGet(new URL(response.headers.location, url).toString(), Object.assign({}, settings, {
          redirectsLeft: redirectsLeft - 1
        })));
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        cleanup();
        reject(new Error("Request failed with HTTP " + response.statusCode + " (" + url + ")"));
        return;
      }

      response.on("data", function (chunk) {
        receivedBytes += chunk.length;
        if (receivedBytes > (settings.maxBytes || MAX_RESPONSE_BYTES)) {
          request.destroy(new Error("Response exceeded size cap (" + url + ")"));
          return;
        }
        chunks.push(chunk);
      });

      response.on("end", function () {
        var body = Buffer.concat(chunks);
        cleanup();
        if (!settings.json) {
          resolve({ buffer: body, statusCode: response.statusCode, headers: response.headers });
          return;
        }
        try {
          resolve({ data: JSON.parse(body.toString("utf8")), statusCode: response.statusCode, headers: response.headers });
        } catch (error) {
          reject(new Error("Unable to parse JSON from " + url + ": " + error.message));
        }
      });

      response.on("error", function (error) {
        cleanup();
        reject(error);
      });
    });

    request.setTimeout(settings.timeoutMs || 60000, function () {
      request.destroy(new Error("Request timed out (" + url + ")"));
    });

    request.on("error", function (error) {
      reject(error);
    });
  });
}

/**
 * Spawn a process with promise semantics + cancel.
 * Resolves { code, stdout, stderr } or rejects on spawn error.
 */
function spawnProcess(executable, args, options) {
  var settings = Object.assign({}, options || {});
  var child = null;
  var settled = false;
  var stdoutChunks = [];
  var stderrChunks = [];

  function settle(result) {
    if (settled) {
      return;
    }
    settled = true;
    try {
      child && child.removeAllListeners();
    } catch (error) {
      /* ignore */
    }
    if (result.error) {
      settings.onError && settings.onError(result.error);
    } else if (settings.onExit) {
      settings.onExit(result);
    }
  }

  var promise = new Promise(function (resolve, reject) {
    child = childProcess.spawn(executable, args || [], {
      cwd: settings.cwd,
      env: settings.env || process.env
    });

    child.stdout.on("data", function (chunk) {
      stdoutChunks.push(chunk);
      settings.onStdout && settings.onStdout(chunk.toString("utf8"));
    });

    child.stderr.on("data", function (chunk) {
      stderrChunks.push(chunk);
      settings.onStderr && settings.onStderr(chunk.toString("utf8"));
    });

    child.on("error", function (error) {
      if (settled) {
        return;
      }
      settled = true;
      reject({ error: error, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: Buffer.concat(stderrChunks).toString("utf8"), code: null });
      settings.onError && settings.onError(error);
    });

    child.on("close", function (code) {
      if (settled) {
        return;
      }
      settled = true;
      var result = { code: code, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: Buffer.concat(stderrChunks).toString("utf8") };
      settings.onExit && settings.onExit(result);
      resolve(result);
    });
  });

  promise.cancel = function (signal) {
    if (!child || settled) {
      return;
    }
    try {
      child.kill(signal || "SIGKILL");
    } catch (error) {
      /* ignore */
    }
  };

  return promise;
}

function parseJsonTolerant(text) {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function decodeCompressedBody(buffer, encoding) {
  var zlib = require("zlib");
  var encodingName = String(encoding || "").toLowerCase();
  if (encodingName === "gzip") {
    return zlib.gunzipSync(buffer).toString("utf8");
  }
  if (encodingName === "deflate") {
    return zlib.inflateSync(buffer).toString("utf8");
  }
  if (encodingName === "br") {
    return zlib.brotliDecompressSync(buffer).toString("utf8");
  }
  return buffer.toString("utf8");
}

function formatBytes(bytes) {
  var value = parseFloatValue(bytes);
  if (value === null) {
    return "Unknown";
  }
  if (value >= 1073741824) {
    return (value / 1073741824).toFixed(2) + " GB";
  }
  if (value >= 1048576) {
    return (value / 1048576).toFixed(1) + " MB";
  }
  if (value >= 1024) {
    return (value / 1024).toFixed(1) + " KB";
  }
  return value.toFixed(0) + " B";
}

function formatDuration(seconds) {
  var total = parseInteger(seconds);
  if (!total) {
    return "";
  }
  var hours = Math.floor(total / 3600);
  var minutes = Math.floor((total % 3600) / 60);
  var secs = total % 60;
  var parts = [];
  if (hours) {
    parts.push(hours);
  }
  parts.push(hours ? String(minutes).padStart(2, "0") : String(minutes));
  parts.push(String(secs).padStart(2, "0"));
  return parts.join(":");
}

function formatCount(value) {
  var parsed = parseFloatValue(value);
  if (parsed === null) {
    return "";
  }
  if (parsed >= 1000000000) {
    return (parsed / 1000000000).toFixed(1) + "B";
  }
  if (parsed >= 1000000) {
    return (parsed / 1000000).toFixed(1) + "M";
  }
  if (parsed >= 1000) {
    return (parsed / 1000).toFixed(1) + "K";
  }
  return String(Math.round(parsed));
}

function formatSpeed(bytesPerSecond) {
  var value = parseFloatValue(bytesPerSecond);
  if (value === null) {
    return "";
  }
  return formatBytes(value) + "/s";
}

module.exports = {
  getPlatform: getPlatform,
  getArch: getArch,
  getLayoutKey: getLayoutKey,
  getStateDir: getStateDir,
  getLogsDir: getLogsDir,
  ensureDir: ensureDir,
  clampInteger: clampInteger,
  parseFloatValue: parseFloatValue,
  cleanString: cleanString,
  parseInteger: parseInteger,
  compareVersions: compareVersions,
  sha256OfFile: sha256OfFile,
  sha256OfBuffer: sha256OfBuffer,
  isExecutable: isExecutable,
  httpGet: httpGet,
  spawnProcess: spawnProcess,
  parseJsonTolerant: parseJsonTolerant,
  decodeCompressedBody: decodeCompressedBody,
  formatBytes: formatBytes,
  formatDuration: formatDuration,
  formatCount: formatCount,
  formatSpeed: formatSpeed
};
