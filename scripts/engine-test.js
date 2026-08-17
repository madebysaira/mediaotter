"use strict";

/**
 * MediaOtter — engine integration test (run on any machine with binaries fetched).
 * Exercises: suggestions, search scrape, yt-dlp fallback search, metadata pre-resolve,
 * quality planning, audio WAV download, video MP4 download, generic URL metadata.
 * Usage: node scripts/engine-test.js [--quick]
 */

var path = require("path");
var fs = require("fs");
var os = require("os");
var downloader = require(path.join(__dirname, "..", "extension", "js", "downloader.js"));
var quality = require(path.join(__dirname, "..", "extension", "js", "quality.js"));
var binaryManager = require(path.join(__dirname, "..", "extension", "js", "binary-manager.js"));
var util = require(path.join(__dirname, "..", "extension", "js", "util.js"));

var QUICK = process.argv.indexOf("--quick") !== -1;
var TEST_DEST = process.env.MEDIAOTTER_TEST_DIR || path.join(os.tmpdir(), "mediaotter-test");
var DOWNLOAD_TEST_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw"; // 19s clip — fast & tiny
var passed = 0;
var failed = 0;

function ok(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log("  ✓ " + name);
  } else {
    failed += 1;
    console.log("  ✗ " + name + (detail ? " — " + detail : ""));
  }
}

function section(title) {
  console.log("\n=== " + title + " ===");
}

async function main() {
  fs.mkdirSync(TEST_DEST, { recursive: true });

  var runtime = binaryManager.getRuntimeStatus();
  section("Runtime status");
  ok("yt-dlp ready (" + runtime.ytDlpVersion + ", source=" + runtime.ytDlpSource + ")", runtime.ytDlpReady);
  ok("ffmpeg ready", runtime.ffmpegReady, runtime.ffmpegPath);
  ok("ffprobe ready", runtime.ffprobeReady);
  ok("deno ready", runtime.denoReady);
  console.log("  js-runtime args: " + (runtime.jsRuntimeArgs.length ? runtime.jsRuntimeArgs.join(" ") : "(none)"));

  section("Search suggestions");
  var suggestions = await downloader.fetchSuggestions("premiere pro");
  ok("suggestions returned (" + suggestions.length + ")", suggestions.length > 0, JSON.stringify(suggestions.slice(0, 3)));

  section("YouTube search (web scrape)");
  var search = await downloader.searchYouTube("premiere pro tutorial", "all");
  ok("items returned (" + search.items.length + ")", search.items.length > 0);
  if (search.items.length) {
    var first = search.items[0];
    console.log("  first: " + first.title.slice(0, 60) + " [" + first.id + "] " + first.duration + " by " + first.channel.slice(0, 30));
    ok("item has thumbnail", Boolean(first.thumbnail));
  }
  ok("continuation token" + (search.continuationToken ? " present" : " absent (may be fine)"), true);

  if (search.continuationToken && !QUICK) {
    section("Search load-more (continuation)");
    try {
      var more = await downloader.loadMoreResults(search.continuationToken, {});
      ok("more items returned (" + more.items.length + ")", more.items.length > 0);
    } catch (error) {
      ok("load-more works", false, error.message);
    }
  }

  section("Metadata pre-resolve (YouTube)");
  var videoUrl = search.items.length ? search.items[0].url : "https://www.youtube.com/watch?v=jNQXAC9IVRw";
  var meta = await downloader.resolveMetadata(videoUrl, {});
  ok("title: " + String(meta.title || "").slice(0, 50), Boolean(meta.title && meta.id));
  ok("formats present (" + (meta.formats ? meta.formats.length : 0) + ")", Boolean(meta.formats && meta.formats.length));

  section("Quality planning (video candidates)");
  var candidates = quality.planVideoCandidates(meta, { maxQualityHeight: 2160, allowEncoding: true });
  ok("candidates generated (" + candidates.length + ")", candidates.length > 0);
  candidates.forEach(function (candidate) {
    console.log("  " + candidate.label + ": muxedH264=" + candidate.hasMuxedH264 + " merge=" + candidate.requiresMerge + " transcode=" + candidate.transcodeOffered + " codec=" + candidate.codec + (candidate.sizeBytes ? " ~" + Math.round(candidate.sizeBytes / 1048576) + "MB" : ""));
  });
  var audioSize = quality.estimateAudioSize(meta.formats);
  console.log("  audio estimate: " + (audioSize ? Math.round(audioSize / 1048576) + "MB" : "unknown"));

  if (QUICK) {
    return finish();
  }

  section("Real download: audio → WAV (Premiere-friendly PCM)");
  var audioMeta = await downloader.resolveMetadata(DOWNLOAD_TEST_URL, {});
  var audioRecord = await new Promise(function (resolve, reject) {
    var record = downloader.enqueueDownload({
      url: DOWNLOAD_TEST_URL,
      kind: "audio",
      destDir: TEST_DEST,
      settings: {},
      meta: audioMeta
    });
    downloader.on("download:complete", function (done) { resolve(done); });
    downloader.on("download:error", function (done) { reject(new Error(done.error)); });
  });
  ok("audio WAV exists", fs.existsSync(audioRecord.finalPath), audioRecord.finalPath);
  if (fs.existsSync(audioRecord.finalPath)) {
    var audioStat = fs.statSync(audioRecord.finalPath);
    console.log("  size: " + (audioStat.size / 1048576).toFixed(1) + " MB — " + path.basename(audioRecord.finalPath));
    ok("audio > 50KB", audioStat.size > 50000);
  }

  section("Real download: video → MP4");
  var videoMeta = await downloader.resolveMetadata(DOWNLOAD_TEST_URL, {});
  var videoCandidates = quality.planVideoCandidates(videoMeta, { maxQualityHeight: 720, allowEncoding: false });
  var videoRecord = await new Promise(function (resolve, reject) {
    var record = downloader.enqueueDownload({
      url: DOWNLOAD_TEST_URL,
      kind: "video",
      selector: videoCandidates[videoCandidates.length - 1].selector, // lowest cap = smallest
      destDir: TEST_DEST,
      settings: {},
      meta: videoMeta
    });
    downloader.on("download:complete", function (done) { resolve(done); });
    downloader.on("download:error", function (done) { reject(new Error(done.error)); });
  });
  ok("video mp4 exists", fs.existsSync(videoRecord.finalPath), videoRecord.finalPath);
  if (fs.existsSync(videoRecord.finalPath)) {
    var videoStat = fs.statSync(videoRecord.finalPath);
    console.log("  size: " + (videoStat.size / 1048576).toFixed(1) + " MB — " + path.basename(videoRecord.finalPath));
    ok("video > 50KB", videoStat.size > 50000);
  }

  if (!QUICK) {
    section("Generic URL metadata (Vimeo)");
    try {
      var vimeoMeta = await downloader.resolveMetadata("https://vimeo.com/76979871", {});
      ok("vimeo title: " + String(vimeoMeta.title || "").slice(0, 50), Boolean(vimeoMeta.title));
    } catch (error) {
      ok("vimeo metadata", false, error.message);
    }
  }

  section("Playlist entries (public YouTube playlist)");
  try {
    var playlist = await downloader.fetchPlaylistEntries("https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf", {});
    ok("playlist '" + String(playlist.title || "").slice(0, 30) + "' has entries", playlist.entries.length > 0, "entries=" + playlist.entries.length);
    ok("first entry has id+title", Boolean(playlist.entries[0] && playlist.entries[0].id && playlist.entries[0].title));
  } catch (error) {
    ok("playlist fetch", false, error.message);
  }

  section("Section-range audio download (first 8s)");
  try {
    var rangeRecord = await new Promise(function (resolve, reject) {
      var record = downloader.enqueueDownload({
        url: DOWNLOAD_TEST_URL,
        kind: "audio",
        destDir: TEST_DEST,
        settings: {},
        range: { start: 0, end: 8 },
        meta: audioMeta
      });
      downloader.on("download:complete", function (done) { resolve(done); });
      downloader.on("download:error", function (done) { reject(new Error(done.error)); });
    });
    var rangePath = rangeRecord.finalPath;
    ok("section wav exists", Boolean(rangePath) && fs.existsSync(rangePath), rangePath || "");
    if (rangePath && fs.existsSync(rangePath)) {
      var probeArgs = ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", rangePath];
      var probeResult = await util.spawnProcess(binaryManager.getRuntimeStatus().ffprobePath, probeArgs, {});
      var duration = parseFloat(String(probeResult.stdout || "").trim());
      ok("section duration ~8s (got " + duration + "s)", duration > 6 && duration < 12, "expected 6-12s");
      var leftovers = fs.readdirSync(TEST_DEST).filter(function (name) { return name.indexOf("[full]") !== -1; });
      ok("fallback [full] cleaned", leftovers.length === 0, "left: " + leftovers.join(", "));
    }
  } catch (error) {
    ok("section download", false, error.message);
  }

  finish();
}

function finish() {
  console.log("\n==================");
  console.log("PASSED: " + passed + "  FAILED: " + failed);
  process.exit(failed ? 1 : 0);
}

main().catch(function (error) {
  console.error("FATAL:", error.message);
  process.exit(2);
});
