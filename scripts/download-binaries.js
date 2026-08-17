"use strict";

/**
 * MediaOtter — download & pin bundled binaries.
 * Fetches per-platform runtimes into extension/binaries/ and writes release.json
 * (schema mirrors Sidestream's). Run: node scripts/download-binaries.js [--platform KEY] [--all] [--list]
 *
 * Platforms: darwin-arm64, darwin-x64, win32-x64, linux-x64, linux-arm64 (linux = dev/test).
 * Binaries are gitignored; this script is also how contributors bootstrap a dev env.
 */

var fs = require("fs");
var path = require("path");
var os = require("os");
var childProcess = require("child_process");

var ROOT = path.join(__dirname, "..");
var BIN_DIR = path.join(ROOT, "extension", "binaries");
var GITHUB_API = "https://api.github.com/repos";

function httpGet(url, opts) {
  var settings = opts || {};
  var mod = url.indexOf("https:") === 0 ? require("https") : require("http");
  return new Promise(function (resolve, reject) {
    var req = mod.get(url, { headers: Object.assign({ "User-Agent": "MediaOtter-Build" }, settings.headers || {}) }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(httpGet(res.headers.location, settings));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error("HTTP " + res.statusCode + " for " + url));
        return;
      }
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        resolve({ body: Buffer.concat(chunks), headers: res.headers });
      });
      res.on("error", reject);
    });
    req.setTimeout(settings.timeoutMs || 120000, function () { req.destroy(new Error("timeout " + url)); });
    req.on("error", reject);
  });
}

function sha256(buf) {
  return require("crypto").createHash("sha256").update(buf).digest("hex");
}

function run(cmd, args, opts) {
  return new Promise(function (resolve, reject) {
    var child = childProcess.spawn(cmd, args, Object.assign({ stdio: ["ignore", "pipe", "pipe"] }, opts || {}));
    var out = "";
    child.stdout.on("data", function (d) { out += d; });
    child.stderr.on("data", function (d) { out += d; });
    child.on("error", reject);
    child.on("close", function (code) {
      if (code === 0) { resolve(out); } else { reject(new Error(cmd + " exited " + code + ": " + out.slice(0, 500))); }
    });
  });
}

function extractArchive(archivePath, destDir, kind) {
  fs.mkdirSync(destDir, { recursive: true });
  if (kind === "tar.gz") {
    return run("tar", ["-xzf", archivePath, "-C", destDir]);
  }
  if (kind === "zip") {
    try {
      return run("unzip", ["-o", "-q", archivePath, "-d", destDir]);
    } catch (error) {
      // fallback: python zipfile (python3 commonly present on dev machines)
      return run("python3", ["-m", "zipfile", "-e", archivePath, destDir]);
    }
  }
  return Promise.reject(new Error("Unknown archive kind " + kind));
}

function log(msg) {
  console.log("[binaries] " + msg);
}

function latestRelease(ownerRepo) {
  return httpGet(GITHUB_API + "/" + ownerRepo + "/releases/latest", { headers: { Accept: "application/vnd.github+json" } }).then(function (res) {
    return JSON.parse(res.body.toString("utf8"));
  });
}

function findAsset(assets, name) {
  return (assets || []).filter(function (a) { return a.name === name; })[0] || null;
}

async function downloadTo(asset, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  log("  downloading " + asset.name + " (" + (asset.size / 1048576).toFixed(1) + " MB) → " + path.relative(ROOT, destPath));
  var res = await httpGet(asset.browser_download_url || asset.url);
  fs.writeFileSync(destPath, res.body);
  fs.chmodSync(destPath, 493); // 0755 — binaries must be executable
  return { sha256: sha256(res.body), size: res.body.length };
}

async function fetchYtDlp(metadata, platformKeys) {
  log("yt-dlp: resolving latest release...");
  var release = await latestRelease("yt-dlp/yt-dlp");
  var tagName = release.tag_name;
  var assets = release.assets;
  var out = { label: "yt-dlp", tagName: tagName, assets: [] };

  log("  release " + tagName + " assets: " + assets.map(function (a) { return a.name; }).join(", "));

  var exeAsset = findAsset(assets, "yt-dlp.exe");
  var macAsset = findAsset(assets, "yt-dlp_macos");
  var linuxArmAsset = findAsset(assets, "yt-dlp_linux_aarch64");
  var linuxX64Asset = findAsset(assets, "yt-dlp_linux");
  var scriptAsset = findAsset(assets, "yt-dlp"); // python zipapp — fallback only

  var macNeeded = platformKeys.indexOf("darwin-arm64") !== -1 || platformKeys.indexOf("darwin-x64") !== -1;
  var linuxNeeded = platformKeys.indexOf("linux-x64") !== -1 || platformKeys.indexOf("linux-arm64") !== -1;

  function add(asset, outputPath) {
    return downloadTo(asset, path.join(BIN_DIR, outputPath)).then(function (info) {
      out.assets.push({ assetName: asset.name, outputPath: outputPath, size: info.size, sha256: info.sha256, sourceUrl: asset.browser_download_url });
    });
  }

  if (platformKeys.indexOf("win32-x64") !== -1 && exeAsset) {
    await add(exeAsset, "yt-dlp.exe");
  }
  if (macNeeded && macAsset) {
    await add(macAsset, "yt-dlp"); // universal2 standalone — no python needed
  }
  if (linuxNeeded) {
    if (platformKeys.indexOf("linux-arm64") !== -1 && linuxArmAsset) {
      await add(linuxArmAsset, "yt-dlp");
    } else if (platformKeys.indexOf("linux-x64") !== -1 && linuxX64Asset) {
      await add(linuxX64Asset, "yt-dlp");
    } else if (scriptAsset) {
      await add(scriptAsset, "yt-dlp"); // zipapp fallback (needs python3)
    }
  }
  out.standalone = Boolean(macAsset || linuxArmAsset || linuxX64Asset || exeAsset);
  metadata.releases.ytDlp = out;
  return out;
}

async function fetchFfmpeg(metadata, platformKeys) {
  log("ffmpeg: resolving latest ffmpeg-static release...");
  var release = await latestRelease("eugeneware/ffmpeg-static");
  var tagName = release.tag_name;
  var assets = release.assets;
  var out = { label: "ffmpeg-static", tagName: tagName, assets: [] };

  var platformMap = {
    "darwin-arm64": ["ffmpeg-darwin-arm64", "ffprobe-darwin-arm64", "darwin-arm64.LICENSE", "darwin-arm64.README"],
    "darwin-x64": ["ffmpeg-darwin-x64", "ffprobe-darwin-x64", "darwin-x64.LICENSE", "darwin-x64.README"],
    "win32-x64": ["ffmpeg-win32-x64", "ffprobe-win32-x64", "win32-x64.LICENSE", "win32-x64.README"],
    "linux-x64": ["ffmpeg-linux-x64", "ffprobe-linux-x64", "linux-x64.LICENSE", "linux-x64.README"],
    "linux-arm64": ["ffmpeg-linux-arm64", "ffprobe-linux-arm64", "linux-arm64.LICENSE", "linux-arm64.README"]
  };

  for (var index = 0; index < platformKeys.length; index += 1) {
    var key = platformKeys[index];
    var names = platformMap[key];
    if (!names) {
      continue;
    }
    for (var j = 0; j < names.length; j += 1) {
      var assetName = names[j];
      var asset = findAsset(assets, assetName);
      if (!asset) {
        log("  ! missing asset " + assetName + " (skipping)");
        continue;
      }
      var destName = assetName;
      if (assetName === "ffmpeg-" + key) {
        destName = key === "win32-x64" ? "ffmpeg.exe" : "ffmpeg";
      } else if (assetName === "ffprobe-" + key) {
        destName = key === "win32-x64" ? "ffprobe.exe" : "ffprobe";
      } else if (assetName.indexOf(key + ".") === 0) {
        destName = assetName.slice(key.length + 1); // LICENSE / README
      }
      var destPath = path.join(BIN_DIR, "ffmpeg", key, destName);
      var info = await downloadTo(asset, destPath);
      out.assets.push({ assetName: asset.name, outputPath: "binaries/ffmpeg/" + key + "/" + destName, size: info.size, sha256: info.sha256, sourceUrl: asset.browser_download_url });
    }
  }
  metadata.releases.ffmpeg = out;
}

async function fetchDeno(metadata, platformKeys) {
  log("deno: resolving latest deno release...");
  var release = await latestRelease("denoland/deno");
  var tagName = release.tag_name;
  var assets = release.assets;
  var out = { label: "deno", tagName: tagName, assets: [] };

  var platformMap = {
    "darwin-arm64": "deno-aarch64-apple-darwin.zip",
    "darwin-x64": "deno-x86_64-apple-darwin.zip",
    "win32-x64": "deno-x86_64-pc-windows-msvc.zip",
    "linux-x64": "deno-x86_64-unknown-linux-gnu.zip",
    "linux-arm64": "deno-aarch64-unknown-linux-gnu.zip"
  };

  for (var index = 0; index < platformKeys.length; index += 1) {
    var key = platformKeys[index];
    var assetName = platformMap[key];
    var asset = findAsset(assets, assetName);
    if (!asset) {
      log("  ! missing asset " + assetName + " (skipping)");
      continue;
    }
    var zipPath = path.join(os.tmpdir(), "mediaotter-" + assetName);
    await downloadTo(asset, zipPath);
    var destDir = path.join(BIN_DIR, "deno", key);
    await extractArchive(zipPath, destDir, "zip");
    fs.unlinkSync(zipPath);
    var binaryName = key === "win32-x64" ? "deno.exe" : "deno";
    var binaryPath = path.join(destDir, binaryName);
    if (!fs.existsSync(binaryPath)) {
      // deno zip contains a versioned folder
      var found = fs.readdirSync(destDir).filter(function (f) {
        return f === binaryName || f.indexOf(binaryName) === 0;
      });
      if (found.length) {
        fs.renameSync(path.join(destDir, found[0]), binaryPath);
      }
    }
    fs.chmodSync(binaryPath, 493);
    var size = fs.statSync(binaryPath).size;
    out.assets.push({ assetName: assetName, outputPath: "binaries/deno/" + key + "/" + binaryName, size: size, sha256: sha256(fs.readFileSync(binaryPath)), sourceUrl: asset.browser_download_url });
    log("  deno " + key + " ready (" + (size / 1048576).toFixed(1) + " MB)");
  }
  metadata.releases.deno = out;
}

async function fetchPython(metadata, platformKeys) {
  var needMac = platformKeys.indexOf("darwin-arm64") !== -1 || platformKeys.indexOf("darwin-x64") !== -1;
  if (!needMac) {
    return; // only macOS needs a bundled python (system python3 used elsewhere)
  }
  log("python: resolving latest python-build-standalone release...");
  var release = await latestRelease("astral-sh/python-build-standalone");
  var tagName = release.tag_name;
  var assets = release.assets;
  var out = { label: "python-build-standalone", tagName: tagName, assets: [], python: {} };

  var platformMap = {
    "darwin-arm64": "cpython-3.13.+aarch64-apple-darwin-install_only_stripped.tar.gz",
    "darwin-x64": "cpython-3.13.+x86_64-apple-darwin-install_only_stripped.tar.gz"
  };

  for (var index = 0; index < platformKeys.length; index += 1) {
    var key = platformKeys[index];
    if (!platformMap[key]) {
      continue;
    }
    // Match by prefix (version may differ, e.g. cpython-3.13.14+20260623-...)
    var pattern = platformMap[key].replace("3.13.+", "3.13.");
    var asset = (assets || []).filter(function (a) { return a.name.indexOf(pattern.slice(0, "cpython-3.13.".length)) === 0 && a.name.indexOf("aarch64-apple-darwin") !== -1; }).sort(function (a, b) { return b.name.localeCompare(a.name); })[0];
    if (!asset) {
      log("  ! missing python asset for " + key + " (skipping)");
      continue;
    }
    var tarballPath = path.join(os.tmpdir(), "mediaotter-" + asset.name);
    await downloadTo(asset, tarballPath);
    var destDir = path.join(BIN_DIR, "python", key);
    await extractArchive(tarballPath, destDir, "tar.gz");
    fs.unlinkSync(tarballPath);
    var entryPoint = "";
    var pythonDir = fs.readdirSync(destDir).filter(function (f) { return f.indexOf("python") === 0; })[0];
    if (pythonDir) {
      var base = path.join(destDir, pythonDir);
      var binDir = path.join(base, "bin");
      var candidates = fs.readdirSync(binDir).filter(function (f) { return /^python3(\.\d+)?$/.test(f); });
      if (candidates.length) {
        entryPoint = path.join(pythonDir, "bin", candidates[0]).split(path.sep).join("/");
        fs.chmodSync(path.join(binDir, candidates[0]), 493);
      }
    }
    out.python[key] = { entryPoint: entryPoint, outputPath: "binaries/python/" + key };
    log("  python " + key + " ready (entryPoint " + entryPoint + ")");
  }
  metadata.releases.pythonStandalone = out;
}

function parseArgs() {
  var args = process.argv.slice(2);
  var result = { platforms: [], all: false, list: false };
  args.forEach(function (arg) {
    if (arg === "--all") {
      result.all = true;
    } else if (arg === "--list") {
      result.list = true;
    } else if (arg.indexOf("--platform=") === 0) {
      result.platforms.push(arg.split("=")[1]);
    }
  });
  return result;
}

async function main() {
  var options = parseArgs();
  var known = ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64", "linux-arm64"];
  var platformKeys = options.all ? known.slice() : options.platforms.length ? options.platforms : [process.platform + "-" + process.arch];

  var metadata = { downloadedAt: new Date().toISOString(), releases: {} };
  fs.mkdirSync(BIN_DIR, { recursive: true });
  log("target platforms: " + platformKeys.join(", "));

  if (options.list) {
    var release = await latestRelease("yt-dlp/yt-dlp");
    log("yt-dlp latest: " + release.tag_name + " → " + release.assets.map(function (a) { return a.name; }).join(", "));
    return;
  }

  await fetchYtDlp(metadata, platformKeys);
  await fetchFfmpeg(metadata, platformKeys);
  await fetchDeno(metadata, platformKeys);
  var macNeeded = platformKeys.indexOf("darwin-arm64") !== -1 || platformKeys.indexOf("darwin-x64") !== -1;
  var ytDlpStandalone = metadata.releases.ytDlp && metadata.releases.ytDlp.standalone;
  if (macNeeded && !ytDlpStandalone) {
    // Fallback: standalone mac binary missing → bundle a Python runtime for the yt-dlp script.
    await fetchPython(metadata, platformKeys);
  } else if (macNeeded) {
    log("python: not needed (standalone yt-dlp_macos present).");
  }

  fs.writeFileSync(path.join(BIN_DIR, "release.json"), JSON.stringify(metadata, null, 2) + "\n");
  log("release.json written. Done.");
}

main().catch(function (error) {
  console.error("[binaries] FAILED:", error.message);
  process.exit(1);
});
