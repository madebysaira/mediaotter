"use strict";

/**
 * MediaOtter — binary manager.
 * Locates and manages the bundled runtimes:
 *   - yt-dlp        (python script on darwin/linux, .exe on win32)
 *   - python        (bundled standalone CPython on darwin; system python fallback elsewhere)
 *   - ffmpeg/ffprobe(eugeneware/ffmpeg-static per platform)
 *   - deno          (JS runtime required by yt-dlp for YouTube PO-token/bot-check challenges)
 * Auto-updates the active yt-dlp from GitHub releases (SHA256-verified, circuit breaker).
 */

var fs = require("fs");
var path = require("path");
var util = require(path.join(__dirname, "util.js"));
var logger = require(path.join(__dirname, "logger.js"));

var BUNDLED_BINARY_DIR = path.join(__dirname, "..", "binaries");
var BUNDLED_RELEASE_METADATA_PATH = path.join(BUNDLED_BINARY_DIR, "release.json");
var RELEASE_API_URL = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
var CHECKSUM_ASSET_NAME = "SHA2-256SUMS";
var UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
var SPAWN_FAILURE_DISABLE_THRESHOLD = 2;
var MANAGED_STATE_FILE_NAME = "ytdlp-runtime.json";
var PYTHON_ENV_VARS_TO_CLEAR = ["PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONEXECUTABLE", "VIRTUAL_ENV"];

var managedStateCache = null;
var updateCheckPromise = null;
var runtimeEpoch = 0;

function getBinaryName() {
  return util.getPlatform() === "win32" ? "yt-dlp.exe" : "yt-dlp";
}

function getBundledBinaryPath() {
  return path.join(BUNDLED_BINARY_DIR, getBinaryName());
}

/** True when the bundled yt-dlp is a self-contained native binary (not a python script/zipapp). */
function isStandaloneYtDlp(filePath) {
  try {
    return fs.statSync(filePath).size > 20 * 1024 * 1024;
  } catch (error) {
    return false;
  }
}

/** GitHub asset name to fetch for the managed auto-update on this platform. */
function getManagedAssetName() {
  if (util.getPlatform() === "win32") {
    return "yt-dlp.exe";
  }
  if (util.getPlatform() === "darwin") {
    return "yt-dlp_macos";
  }
  return util.getArch() === "x64" ? "yt-dlp_linux" : "yt-dlp_linux_aarch64";
}

function getManagedBinDir() {
  return path.join(util.getStateDir(), "bin");
}

function getManagedBinaryPath() {
  return path.join(getManagedBinDir(), getBinaryName());
}

function getManagedStatePath() {
  return path.join(util.getStateDir(), MANAGED_STATE_FILE_NAME);
}

function readBundledReleaseMetadata() {
  try {
    return JSON.parse(fs.readFileSync(BUNDLED_RELEASE_METADATA_PATH, "utf8"));
  } catch (error) {
    return {};
  }
}

function getBundledVersion() {
  var metadata = readBundledReleaseMetadata();
  var ytDlp = metadata && metadata.releases && metadata.releases.ytDlp;
  return String((ytDlp && ytDlp.tagName) || "");
}

function getBundledPythonLayoutKey() {
  return util.getPlatform() === "darwin" ? (util.getArch() === "x64" ? "darwin-x64" : "darwin-arm64") : "";
}

function getBundledPythonRoot() {
  var key = getBundledPythonLayoutKey();
  return key ? path.join(BUNDLED_BINARY_DIR, "python", key) : "";
}

function getRecordedPythonEntryPoint() {
  var metadata = readBundledReleaseMetadata();
  var release = metadata && metadata.releases ? metadata.releases.pythonStandalone : null;
  var python = release && release.python ? release.python : {};
  var layout = python[getBundledPythonLayoutKey()] || {};
  return String(layout.entryPoint || "");
}

function findPythonExecutable(rootDir) {
  var binDir = path.join(rootDir, "bin");
  var candidates;
  try {
    candidates = fs.readdirSync(binDir).filter(function (name) {
      return /^python3(\.\d+)?$/.test(name);
    });
  } catch (error) {
    return "";
  }
  candidates.sort(function (left, right) {
    if (left === "python3") {
      return 1;
    }
    if (right === "python3") {
      return -1;
    }
    return right.localeCompare(left);
  });
  for (var index = 0; index < candidates.length; index += 1) {
    var candidate = path.join(binDir, candidates[index]);
    if (util.isExecutable(candidate)) {
      return candidate;
    }
  }
  return "";
}

/** Returns the python interpreter used to run the yt-dlp script. */
function getPythonRuntime() {
  if (util.getPlatform() === "win32") {
    return { path: "", kind: "not_required" };
  }
  if (util.getPlatform() === "darwin") {
    var rootDir = getBundledPythonRoot();
    var entryPoint = getRecordedPythonEntryPoint();
    var runtimePath = entryPoint ? path.join(rootDir, entryPoint) : "";
    if (!runtimePath || !util.isExecutable(runtimePath)) {
      runtimePath = findPythonExecutable(rootDir);
    }
    return {
      path: runtimePath,
      kind: runtimePath ? "bundled" : "missing",
      ready: Boolean(runtimePath && util.isExecutable(runtimePath))
    };
  }
  // Linux/dev: prefer system python3, else bundled if present.
  try {
    var probe = require("child_process").spawnSync("python3", ["--version"], { timeout: 5000 });
    if (probe.status === 0) {
      return { path: "python3", kind: "system", ready: true };
    }
  } catch (error) {
    /* fall through */
  }
  return { path: "", kind: "missing", ready: false };
}

function getBundledFfmpegDir() {
  return path.join(BUNDLED_BINARY_DIR, "ffmpeg", util.getLayoutKey());
}

function getFfmpegPath() {
  var dir = getBundledFfmpegDir();
  var name = util.getPlatform() === "win32" ? "ffmpeg.exe" : "ffmpeg";
  return path.join(dir, name);
}

function getFfprobePath() {
  var dir = getBundledFfmpegDir();
  var name = util.getPlatform() === "win32" ? "ffprobe.exe" : "ffprobe";
  return path.join(dir, name);
}

function getDenoPath() {
  var dir = path.join(BUNDLED_BINARY_DIR, "deno", util.getLayoutKey());
  var name = util.getPlatform() === "win32" ? "deno.exe" : "deno";
  return path.join(dir, name);
}

function getJsRuntimeArgs() {
  var args = [];
  var candidates = [];

  var denoPath = getDenoPath();
  if (util.isExecutable(denoPath)) {
    candidates.push("deno:" + denoPath);
  }
  var nodePath = process.execPath; // CEP embeds Node; modern Node on dev machines
  if (nodePath && nodePath.indexOf("node") !== -1 && util.isExecutable(nodePath)) {
    candidates.push("node:" + nodePath);
  }
  if (candidates.length) {
    args.push("--js-runtimes");
    args.push(candidates.join(","));
  }
  return args;
}

/** Returns the active yt-dlp invocation: { executable, argsPrefix, path, version, source }. */
function getYtDlpCommand() {
  var state = readManagedState();
  var bundledVersion = getBundledVersion();

  if (util.getPlatform() === "win32") {
    var managedPath = getManagedBinaryPath();
    if (isManagedUsable(state) && util.compareVersions(state.managedVersion, bundledVersion) > 0) {
      return { executable: managedPath, argsPrefix: [], path: managedPath, version: state.managedVersion, source: "managed" };
    }
    return { executable: getBundledBinaryPath(), argsPrefix: [], path: getBundledBinaryPath(), version: bundledVersion, source: "bundled" };
  }

  // darwin / linux: standalone binary preferred; python + script fallback
  var bundledPath = getBundledBinaryPath();
  if (isStandaloneYtDlp(bundledPath)) {
    if (isManagedUsable(state) && util.compareVersions(state.managedVersion, bundledVersion) > 0) {
      return { executable: getManagedBinaryPath(), argsPrefix: [], path: getManagedBinaryPath(), version: state.managedVersion, source: "managed" };
    }
    return { executable: bundledPath, argsPrefix: [], path: bundledPath, version: bundledVersion, source: "bundled" };
  }
  var python = getPythonRuntime();
  if (!python.ready) {
    return { executable: "", argsPrefix: [], path: "", version: "", source: "missing_python", error: "Bundled Python runtime is not available." };
  }
  if (isManagedUsable(state) && util.compareVersions(state.managedVersion, bundledVersion) > 0) {
    return { executable: python.path, argsPrefix: [getManagedBinaryPath()], path: getManagedBinaryPath(), version: state.managedVersion, source: "managed", pythonKind: python.kind };
  }
  return { executable: python.path, argsPrefix: [bundledPath], path: bundledPath, version: bundledVersion, source: "bundled", pythonKind: python.kind };
}

function getRuntimeStatus() {
  var ytDlp = getYtDlpCommand();
  var ffmpegPath = getFfmpegPath();
  var ffprobePath = getFfprobePath();
  var denoPath = getDenoPath();
  var python = getPythonRuntime();

  return {
    ytDlpPath: ytDlp.path,
    ytDlpVersion: ytDlp.version,
    ytDlpSource: ytDlp.source,
    ytDlpReady: Boolean(ytDlp.executable && (ytDlp.path || ytDlp.argsPrefix.length)),
    ytDlpError: ytDlp.error || "",
    pythonPath: python.path,
    pythonKind: python.kind,
    pythonReady: python.ready,
    ffmpegPath: ffmpegPath,
    ffmpegReady: util.isExecutable(ffmpegPath),
    ffprobePath: ffprobePath,
    ffprobeReady: util.isExecutable(ffprobePath),
    ffmpegDir: path.dirname(ffmpegPath),
    denoPath: denoPath,
    denoReady: util.isExecutable(denoPath),
    jsRuntimeArgs: getJsRuntimeArgs()
  };
}

// ─── Managed yt-dlp auto-update (SHA256-verified, circuit breaker) ──────────

function createDefaultManagedState() {
  return {
    managedVersion: "",
    managedSha256: "",
    installedAt: "",
    lastCheckedAt: "",
    consecutiveSpawnFailures: 0,
    disabledReason: "",
    disabledAt: ""
  };
}

function readManagedState() {
  if (managedStateCache) {
    return Object.assign({}, managedStateCache);
  }
  var state = null;
  try {
    state = JSON.parse(fs.readFileSync(getManagedStatePath(), "utf8"));
  } catch (error) {
    state = null;
  }
  managedStateCache = Object.assign(createDefaultManagedState(), state && typeof state === "object" ? state : {});
  return Object.assign({}, managedStateCache);
}

function persistManagedState(state) {
  managedStateCache = Object.assign(createDefaultManagedState(), state);
  try {
    fs.mkdirSync(path.dirname(getManagedStatePath()), { recursive: true });
    fs.writeFileSync(getManagedStatePath(), JSON.stringify(managedStateCache, null, 2) + "\n", { mode: 384 });
  } catch (error) {
    logger.warn("binary", "managed_state_persist_failed", { message: error.message });
  }
  return Object.assign({}, managedStateCache);
}

function isManagedUsable(state) {
  var managedPath = getManagedBinaryPath();
  if (!managedPath || !state.managedVersion || state.disabledReason) {
    return false;
  }
  if (!util.isExecutable(managedPath)) {
    return false;
  }
  if (util.getPlatform() === "darwin") {
    return getPythonRuntime().ready;
  }
  return true;
}

function getRuntimeEpoch() {
  return runtimeEpoch;
}

function bumpRuntimeEpoch() {
  runtimeEpoch += 1;
}

function reportSpawnFailure(binaryPath) {
  var state = readManagedState();
  if (!binaryPath || binaryPath !== getManagedBinaryPath() || state.disabledReason) {
    return false;
  }
  state.consecutiveSpawnFailures = (parseInt(state.consecutiveSpawnFailures, 10) || 0) + 1;
  if (state.consecutiveSpawnFailures >= SPAWN_FAILURE_DISABLE_THRESHOLD) {
    state.disabledReason = "spawn_failures";
    state.disabledAt = new Date().toISOString();
    logger.warn("binary", "managed_binary_disabled", { reason: state.disabledReason });
    bumpRuntimeEpoch();
  }
  persistManagedState(state);
  return Boolean(state.disabledReason);
}

function reportSpawnSuccess(binaryPath) {
  var state = readManagedState();
  if (!binaryPath || binaryPath !== getManagedBinaryPath() || !state.consecutiveSpawnFailures) {
    return;
  }
  state.consecutiveSpawnFailures = 0;
  persistManagedState(state);
}

function downloadFile(url, destPath) {
  return util.httpGet(url, { timeoutMs: 120000 }).then(function (result) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, result.buffer, { mode: 493 }); // 0755
    return destPath;
  });
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fetchLatestYtDlpRelease() {
  return util.httpGet(RELEASE_API_URL, {
    json: true,
    timeoutMs: 20000,
    headers: { "Accept": "application/vnd.github+json" }
  }).then(function (result) {
    var release = result.data;
    if (!release || !release.tag_name) {
      throw new Error("Unexpected GitHub response for yt-dlp releases.");
    }
    var assetName = getManagedAssetName();
    var checksumAsset = (release.assets || []).filter(function (asset) {
      return asset.name === CHECKSUM_ASSET_NAME;
    })[0];
    var binaryAsset = (release.assets || []).filter(function (asset) {
      return asset.name === assetName;
    })[0];
    if (!binaryAsset || !checksumAsset) {
      throw new Error("yt-dlp release " + release.tag_name + " is missing expected assets (" + assetName + ").");
    }
    return { tagName: release.tag_name, assetName: assetName, binaryUrl: binaryAsset.browser_download_url, checksumUrl: checksumAsset.browser_download_url };
  });
}

function installManagedYtDlp(releaseInfo) {
  var state = readManagedState();
  var binDir = getManagedBinDir();
  var destPath = getManagedBinaryPath();
  var tmpPath = destPath + ".part";

  fs.mkdirSync(binDir, { recursive: true });
  state.lastCheckedAt = new Date().toISOString();
  state.installing = true;
  persistManagedState(state);

  return util.httpGet(releaseInfo.checksumUrl, { timeoutMs: 30000 }).then(function (checksumResult) {
    var expectedHash = "";
    var lines = checksumResult.buffer.toString("utf8").split(/\r?\n/);
    var checksumPattern = new RegExp("^([0-9a-f]{64})\\s+\\*?" + escapeRegExp(releaseInfo.assetName) + "\\s*$", "i");
    for (var index = 0; index < lines.length; index += 1) {
      var match = lines[index].match(checksumPattern);
      if (match) {
        expectedHash = match[1].toLowerCase();
        break;
      }
    }
    if (!expectedHash) {
      throw new Error("Could not find yt-dlp checksum in release checksums.");
    }
    return downloadFile(releaseInfo.binaryUrl, tmpPath).then(function () {
      var actualHash = util.sha256OfFile(tmpPath);
      if (actualHash !== expectedHash) {
        try {
          fs.unlinkSync(tmpPath);
        } catch (error) {
          /* ignore */
        }
        throw new Error("yt-dlp checksum mismatch (expected " + expectedHash + ", got " + actualHash + ").");
      }
      fs.renameSync(tmpPath, destPath);
      state.managedVersion = releaseInfo.tagName;
      state.managedSha256 = actualHash;
      state.installedAt = new Date().toISOString();
      state.disabledReason = "";
      state.consecutiveSpawnFailures = 0;
      delete state.installing;
      persistManagedState(state);
      bumpRuntimeEpoch();
      logger.info("binary", "ytdlp_updated", { version: releaseInfo.tagName, source: "managed" });
      return Object.assign({}, state);
    });
  });
}

function maybeAutoUpdateYtDlp(force) {
  var state = readManagedState();
  var now = Date.now();
  var lastChecked = state.lastCheckedAt ? new Date(state.lastCheckedAt).getTime() : 0;

  if (!force && (now - lastChecked) < UPDATE_CHECK_INTERVAL_MS) {
    return Promise.resolve(Object.assign({}, state));
  }
  if (updateCheckPromise) {
    return updateCheckPromise;
  }

  updateCheckPromise = fetchLatestYtDlpRelease().then(function (releaseInfo) {
    if (util.compareVersions(releaseInfo.tagName, getBundledVersion()) <= 0 && util.compareVersions(releaseInfo.tagName, state.managedVersion) <= 0) {
      state.lastCheckedAt = new Date().toISOString();
      persistManagedState(state);
      return Object.assign({}, state);
    }
    return installManagedYtDlp(releaseInfo);
  }).catch(function (error) {
    state.lastCheckedAt = new Date().toISOString();
    persistManagedState(state);
    logger.warn("binary", "ytdlp_update_failed", { message: error.message });
    return Object.assign({}, state);
  }).then(function (result) {
    updateCheckPromise = null;
    return result;
  });

  return updateCheckPromise;
}

function getActiveVersion() {
  var state = readManagedState();
  var bundled = getBundledVersion();
  if (state.managedVersion && state.updateSource === "managed" &&
      util.compareVersions(state.managedVersion, bundled) > 0 && isManagedUsable(state)) {
    return state.managedVersion;
  }
  return bundled;
}

/** Force an immediate update check. @returns Promise<{updated, version}> */
function checkForUpdates() {
  var before = getActiveVersion();
  return maybeAutoUpdateYtDlp(true).then(function () {
    var after = getActiveVersion();
    return {
      updated: after !== before,
      version: after
    };
  });
}

/** Respect the check throttle (used at panel boot). @returns Promise<{updated, version}> */
function autoCheckForUpdates() {
  return checkForUpdates();
}

module.exports = {
  getYtDlpCommand: getYtDlpCommand,
  getRuntimeStatus: getRuntimeStatus,
  getJsRuntimeArgs: getJsRuntimeArgs,
  getFfmpegPath: getFfmpegPath,
  getFfprobePath: getFfprobePath,
  getDenoPath: getDenoPath,
  getPythonRuntime: getPythonRuntime,
  getBundledVersion: getBundledVersion,
  maybeAutoUpdateYtDlp: maybeAutoUpdateYtDlp,
  checkForUpdates: checkForUpdates,
  autoCheckForUpdates: autoCheckForUpdates,
  reportSpawnFailure: reportSpawnFailure,
  reportSpawnSuccess: reportSpawnSuccess,
  getRuntimeEpoch: getRuntimeEpoch,
  BUNDLED_BINARY_DIR: BUNDLED_BINARY_DIR
};
