"use strict";

/**
 * MediaOtter — download & search engine (yt-dlp powered).
 *  - YouTube search: web scrape (ytInitialData + continuation) with yt-dlp ytsearchN fallback
 *  - Search suggestions: Google suggestqueries (YouTube client)
 *  - Any yt-dlp-supported URL: Vimeo, SoundCloud, Twitch, TikTok, X, etc.
 *  - Download pipeline: quality selector → spawn yt-dlp → progress → final path
 */

var fs = require("fs");
var path = require("path");
var util = require("./util.js");
var logger = require("./logger.js");
var binaryManager = require("./binary-manager.js");
var quality = require("./quality.js");

var YT_SEARCH_URL = "https://www.youtube.com/results?search_query=";
var YT_SUGGEST_URL = "https://suggestqueries.google.com/complete/search";
var YT_INNERTUBE_URL = "https://www.youtube.com/youtubei/v1/search";
var YT_INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
var YT_WEB_CLIENT_VERSION = "2.20240814.04.00";

var CONCURRENT_DOWNLOAD_LIMIT = 2;
var PRE_RESOLVE_TTL_MS = 10 * 60 * 1000;

var activeDownloads = {};
var preResolveCache = {};
var pendingQueue = [];
var activeCount = 0;
var listeners = {};

// ─── events ─────────────────────────────────────────────────────

function on(eventName, handler) {
  listeners[eventName] = listeners[eventName] || [];
  listeners[eventName].push(handler);
}

function emit(eventName, payload) {
  var handlers = listeners[eventName] || [];
  for (var index = 0; index < handlers.length; index += 1) {
    try {
      handlers[index](payload);
    } catch (error) {
      logger.error("downloader", "listener_error", { event: eventName, message: error.message });
    }
  }
}

function getYtDlpBaseArgs(extra) {
  var args = [
    "--no-warnings",
    "--no-playlist",
    "--continue",
    "--no-overwrites",
    "--retries", "10",
    "--extractor-retries", "3",
    "--socket-timeout", "15",
    "--newline"
  ];
  var runtime = binaryManager.getRuntimeStatus();
  if (runtime.ffmpegReady) {
    args.push("--ffmpeg-location", runtime.ffmpegDir);
  }
  var jsRuntimeArgs = runtime.jsRuntimeArgs;
  for (var index = 0; index < jsRuntimeArgs.length; index += 1) {
    args.push(jsRuntimeArgs[index]);
  }
  var session = extra && extra.cookiesBrowser;
  if (session) {
    args.push("--cookies-from-browser", session);
  }
  return args;
}

function getSpawnEnv(pythonKind) {
  var env = Object.assign({}, process.env);
  if (pythonKind === "bundled") {
    delete env.PYTHONHOME;
    delete env.PYTHONPATH;
    delete env.PYTHONSTARTUP;
    delete env.VIRTUAL_ENV;
  }
  return env;
}

// ─── search (YouTube web scrape) ────────────────────────────────

function extractYtInitialData(html) {
  var match = html.match(/var\s+ytInitialData\s*=\s*(\{.*?\});\s*<\/script>/);
  if (!match) {
    match = html.match(/ytInitialData\s*=\s*(\{.*?\});/);
  }
  if (!match) {
    return null;
  }
  return util.parseJsonTolerant(match[1]);
}

function findVideoRenderers(node, output) {
  if (!node || typeof node !== "object") {
    return;
  }
  if (node.videoRenderer) {
    output.push(node.videoRenderer);
  }
  if (node.compactVideoRenderer) {
    output.push(node.compactVideoRenderer);
  }
  if (node.richItemRenderer && node.richItemRenderer.content) {
    findVideoRenderers(node.richItemRenderer.content, output);
  }
  var keys = Object.keys(node);
  for (var index = 0; index < keys.length; index += 1) {
    var key = keys[index];
    if (key === "videoRenderer" || key === "compactVideoRenderer" || key === "richItemRenderer") {
      continue;
    }
    var value = node[key];
    if (value && typeof value === "object") {
      findVideoRenderers(value, output);
    }
  }
}

function extractContinuationToken(data) {
  try {
    var continuations = data.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents;
    for (var index = 0; index < continuations.length; index += 1) {
      var item = continuations[index];
      if (item.continuationItemRenderer && item.continuationItemRenderer.continuationEndpoint && item.continuationItemRenderer.continuationEndpoint.continuationCommand) {
        return item.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
      }
    }
  } catch (error) {
    /* structure varies */
  }
  return "";
}

function mapVideoRenderer(renderer) {
  var id = renderer.videoId || "";
  var title = "";
  try {
    title = renderer.title.runs.map(function (run) { return run.text; }).join("");
  } catch (error) {
    title = renderer.title && renderer.title.simpleText ? renderer.title.simpleText : "";
  }
  var channel = "";
  try {
    channel = renderer.ownerText.runs.map(function (run) { return run.text; }).join("");
  } catch (error) {
    channel = "";
  }
  var views = "";
  try {
    views = renderer.viewCountText.simpleText || "";
  } catch (error) {
    views = "";
  }
  var duration = "";
  try {
    duration = renderer.lengthText.simpleText || "";
  } catch (error) {
    duration = "";
  }
  var thumbnail = "";
  try {
    thumbnail = renderer.thumbnail.thumbnails[renderer.thumbnail.thumbnails.length - 1].url || "";
  } catch (error) {
    thumbnail = "";
  }
  if (thumbnail && thumbnail.indexOf("http") === -1) {
    thumbnail = "https:" + thumbnail;
  }
  var published = "";
  try {
    published = renderer.publishedTimeText.simpleText || "";
  } catch (error) {
    published = "";
  }
  return { id: id, title: title, channel: channel, views: views, duration: duration, published: published, thumbnail: thumbnail, url: id ? "https://www.youtube.com/watch?v=" + id : "" };
}

function parseSearchHtml(html) {
  var data = extractYtInitialData(html);
  if (!data) {
    return { items: [], continuationToken: "" };
  }
  var renderers = [];
  try {
    var sectionList = data.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents;
    for (var index = 0; index < sectionList.length; index += 1) {
      if (sectionList[index].itemSectionRenderer) {
        findVideoRenderers(sectionList[index].itemSectionRenderer, renderers);
      }
    }
  } catch (error) {
    logger.warn("downloader", "search_parse_partial", { message: error.message });
  }
  var items = renderers.map(mapVideoRenderer).filter(function (item) {
    return item.id && item.title;
  });
  return { items: items, continuationToken: extractContinuationToken(data) };
}

function fetchSearchPage(query, filter) {
  var params = [];
  if (filter && filter !== "all") {
    params.push("sp=" + encodeURIComponent(filter));
  }
  var url = YT_SEARCH_URL + encodeURIComponent(query) + (params.length ? "&" + params.join("&") : "");
  return util.httpGet(url, {
    timeoutMs: 25000,
    headers: {
      "Accept-Language": "en-US,en;q=0.9",
      "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+417; SOCS=CAI"
    }
  }).then(function (result) {
    return parseSearchHtml(util.decodeCompressedBody(result.buffer, result.headers["content-encoding"]));
  });
}

function fetchSearchContinuation(token) {
  var body = JSON.stringify({
    continuation: token,
    context: {
      client: {
        clientName: "WEB",
        clientVersion: YT_WEB_CLIENT_VERSION,
        hl: "en",
        gl: "US"
      }
    }
  });
  var url = YT_INNERTUBE_URL + "?key=" + YT_INNERTUBE_API_KEY + "&prettyPrint=false";
  return new Promise(function (resolve, reject) {
    var transport = require("https");
    var payload = Buffer.from(body, "utf8");
    var req = transport.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": payload.length,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+417"
      }
    }, function (res) {
      var chunks = [];
      res.on("data", function (chunk) { chunks.push(chunk); });
      res.on("end", function () {
        try {
          var data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          var renderers = [];
          try {
            var sectionList = data.onResponseReceivedCommands[0].appendContinuationItemsAction.continuationItems;
            for (var index = 0; index < sectionList.length; index += 1) {
              if (sectionList[index].itemSectionRenderer) {
                findVideoRenderers(sectionList[index].itemSectionRenderer, renderers);
              }
            }
          } catch (error) {
            /* empty page */
          }
          resolve({ items: renderers.map(mapVideoRenderer).filter(function (item) { return item.id && item.title; }), continuationToken: extractContinuationToken({ contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: data.onResponseReceivedCommands ? data.onResponseReceivedCommands[0].appendContinuationItemsAction.continuationItems : [] } } } } }) });
        } catch (error) {
          reject(error);
        }
      });
      res.on("error", reject);
    });
    req.setTimeout(25000, function () { req.destroy(new Error("continuation timeout")); });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** Primary search path. Returns { items, continuationToken, source }. */
function searchYouTube(query, filter) {
  return fetchSearchPage(query, filter).then(function (page) {
    if (page.items.length === 0 && !page.continuationToken) {
      return searchYouTubeWithYtDlp(query);
    }
    return Object.assign(page, { source: "web" });
  }).catch(function (error) {
    logger.warn("downloader", "search_fallback", { message: error.message });
    return searchYouTubeWithYtDlp(query);
  });
}

function searchYouTubeWithYtDlp(query, extra) {
  var runtime = binaryManager.getRuntimeStatus();
  if (!runtime.ytDlpReady) {
    return Promise.reject(new Error(runtime.ytDlpError || "yt-dlp runtime is not ready."));
  }
  var command = binaryManager.getYtDlpCommand();
  var args = getYtDlpBaseArgs(extra).concat([
    "--flat-playlist",
    "--dump-single-json",
    "--skip-download",
    "--playlist-end", "20",
    "ytsearch20:" + query
  ]);
  return util.spawnProcess(command.executable, command.argsPrefix.concat(args), {
    env: getSpawnEnv(command.pythonKind),
    timeoutMs: 90000,
    onError: function (error) { binaryManager.reportSpawnFailure(command.path); }
  }).then(function (result) {
    binaryManager.reportSpawnSuccess(command.path);
    if (result.code !== 0) {
      throw new Error("yt-dlp search failed (exit " + result.code + "): " + result.stderr.slice(-400));
    }
    var data = util.parseJsonTolerant(result.stdout);
    if (!data || !data.entries) {
      throw new Error("yt-dlp search returned no results.");
    }
    var items = data.entries.filter(function (entry) { return entry && entry.id && entry.title; }).map(function (entry) {
      return {
        id: entry.id,
        title: entry.title,
        channel: entry.channel || entry.uploader || "",
        views: entry.view_count ? util.formatCount(entry.view_count) : "",
        duration: entry.duration ? util.formatDuration(entry.duration) : "",
        published: "",
        thumbnail: (entry.thumbnails && entry.thumbnails.length ? entry.thumbnails[entry.thumbnails.length - 1].url : "") || "",
        url: entry.url || "https://www.youtube.com/watch?v=" + entry.id,
        source: "ytdlp"
      };
    });
    return { items: items, continuationToken: "", source: "ytdlp" };
  });
}

function loadMoreResults(token, extra) {
  return fetchSearchContinuation(token);
}

// ─── suggestions ───────────────────────────────────────────────

function fetchSuggestions(query) {
  // client=firefox returns pure JSON (client=youtube wraps it in JSONP).
  var url = YT_SUGGEST_URL + "?client=firefox&ds=yt&hl=en&q=" + encodeURIComponent(query);
  return util.httpGet(url, { timeoutMs: 10000, json: true }).then(function (result) {
    var data = result.data;
    if (!Array.isArray(data) || data.length < 2 || !Array.isArray(data[1])) {
      return [];
    }
    return data[1].filter(function (entry) { return typeof entry === "string"; }).slice(0, 8);
  }).catch(function () {
    return [];
  });
}

// ─── metadata (pre-resolve) ────────────────────────────────────

function getCacheKey(url, extra) {
  return url + "|" + (extra && extra.cookiesBrowser ? extra.cookiesBrowser : "");
}

function getPreResolved(url, extra) {
  var key = getCacheKey(url, extra);
  var entry = preResolveCache[key];
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.ts > PRE_RESOLVE_TTL_MS) {
    delete preResolveCache[key];
    return null;
  }
  return entry.meta;
}

function putPreResolved(url, meta, extra) {
  preResolveCache[getCacheKey(url, extra)] = { meta: meta, ts: Date.now() };
}

function classifyUrl(url) {
  var lower = String(url || "").toLowerCase();
  if (lower.indexOf("youtube.com") !== -1 || lower.indexOf("youtu.be") !== -1 || lower.indexOf("music.youtube.com") !== -1) {
    if (lower.indexOf("playlist?list=") !== -1 || lower.indexOf("&list=") !== -1) {
      return "youtube_playlist";
    }
    if (lower.indexOf("/playlist/") !== -1) {
      return "youtube_playlist";
    }
    return "youtube_video";
  }
  return "generic";
}

function resolveMetadata(url, extra) {
  var cached = getPreResolved(url, extra);
  if (cached) {
    return Promise.resolve(cached);
  }
  var command = binaryManager.getYtDlpCommand();
  if (!command.executable && !command.argsPrefix.length) {
    return Promise.reject(new Error(command.error || "yt-dlp runtime is not ready."));
  }
  var args = getYtDlpBaseArgs(extra).concat([
    "--dump-single-json",
    "--skip-download",
    url
  ]);
  return util.spawnProcess(command.executable, command.argsPrefix.concat(args), {
    env: getSpawnEnv(command.pythonKind),
    onError: function () { binaryManager.reportSpawnFailure(command.path); }
  }).then(function (result) {
    binaryManager.reportSpawnSuccess(command.path);
    if (result.code !== 0) {
      throw new Error(mapYtDlpError(result.stderr, url));
    }
    var meta = util.parseJsonTolerant(result.stdout);
    if (!meta) {
      throw new Error("Unable to parse media metadata.");
    }
    putPreResolved(url, meta, extra);
    return meta;
  });
}

/**
 * Fetch a playlist's entries (flat, no downloads). Works for YouTube playlists
 * (private ones with a browser session) and generic site playlists.
 * @returns Promise<{id, title, url, entries:[{id,title,url,thumbnail,channel,duration}]}>
 */
function fetchPlaylistEntries(url, extra) {
  var command = binaryManager.getYtDlpCommand();
  if (!command.executable && !command.argsPrefix.length) {
    return Promise.reject(new Error(command.error || "yt-dlp runtime is not ready."));
  }
  var playlistExtra = Object.assign({}, extra || {}, { noPlaylist: false });
  var args = getYtDlpBaseArgs(playlistExtra).concat([
    "--flat-playlist",
    "--dump-single-json",
    "--playlist-end", "150",
    url
  ]);
  return util.spawnProcess(command.executable, command.argsPrefix.concat(args), {
    env: getSpawnEnv(command.pythonKind),
    onError: function () { binaryManager.reportSpawnFailure(command.path); }
  }).then(function (result) {
    binaryManager.reportSpawnSuccess(command.path);
    if (result.code !== 0) {
      throw new Error(mapYtDlpError(result.stderr, url));
    }
    var data = util.parseJsonTolerant(result.stdout);
    if (!data) {
      throw new Error("Unable to parse playlist metadata.");
    }
    var entries = (data.entries || []).filter(function (entry) {
      return entry && (entry.id || entry.url);
    }).map(function (entry) {
      var thumb = "";
      if (entry.thumbnails && entry.thumbnails.length) {
        var best = entry.thumbnails[entry.thumbnails.length - 1];
        thumb = best.url || "";
      }
      return {
        id: entry.id || "",
        title: entry.title || "",
        url: entry.url || entry.webpage_url || "",
        thumbnail: thumb,
        channel: entry.channel || entry.uploader || "",
        duration: entry.duration ? formatSeconds(entry.duration) : ""
      };
    });
    return {
      id: data.id || "",
      title: data.title || "",
      url: url,
      entries: entries
    };
  });
}

function formatSeconds(seconds) {
  var total = Math.round(Number(seconds) || 0);
  var hours = Math.floor(total / 3600);
  var minutes = Math.floor((total % 3600) / 60);
  var secs = total % 60;
  if (hours > 0) {
    return hours + ":" + String(minutes).padStart(2, "0") + ":" + String(secs).padStart(2, "0");
  }
  return minutes + ":" + String(secs).padStart(2, "0");
}

/** Format a seconds value as H:MM:SS for --download-sections (yt-dlp rejects bare seconds). */
function formatSecondsSpec(seconds) {
  var total = Math.max(0, Math.round(Number(seconds) || 0));
  var hours = Math.floor(total / 3600);
  var minutes = Math.floor((total % 3600) / 60);
  var secs = total % 60;
  if (hours > 0) {
    return hours + ":" + String(minutes).padStart(2, "0") + ":" + String(secs).padStart(2, "0");
  }
  return String(minutes).padStart(2, "0") + ":" + String(secs).padStart(2, "0");
}

// ─── error mapping ─────────────────────────────────────────────

function mapYtDlpError(stderr, url) {
  var text = String(stderr || "");
  if (/sign in to confirm you're not a bot/i.test(text)) {
    return "YouTube flagged this request as a bot. Enable a browser session (Settings → YouTube Session) and retry.";
  }
  if (/private video/i.test(text)) {
    return "This video is private. Enable the YouTube browser session and retry.";
  }
  if (/age[- ]restricted/i.test(text)) {
    return "This video is age-restricted. Enable the YouTube browser session and retry.";
  }
  if (/HTTP Error 429/i.test(text)) {
    return "Rate-limited by YouTube. Wait a minute and retry.";
  }
  if (/unsupported url/i.test(text)) {
    return "This URL is not supported by yt-dlp.";
  }
  if (/requested format is not available/i.test(text)) {
    return "The requested quality is not available for this media.";
  }
  if (/unable to download webpage/i.test(text) || /temporarily unavailable/i.test(text)) {
    return "Network error reaching the site. Check your connection and retry.";
  }
  if (/video unavailable/i.test(text) || /removed/i.test(text)) {
    return "This video is unavailable or was removed.";
  }
  var tail = text.split(/\r?\n/).filter(function (line) { return line.trim(); }).slice(-2).join(" ");
  return "Download failed: " + tail;
}

// ─── download pipeline ─────────────────────────────────────────

function buildOutputTemplate(destDir, downloadRecord) {
  var suffix = "";
  if (downloadRecord && downloadRecord.range) {
    suffix = " " + formatSecondsSpec(downloadRecord.range.start) + "-" + formatSecondsSpec(downloadRecord.range.end);
  }
  return path.join(destDir, "%(title).80B [%(id)s]" + suffix + ".%(ext)s");
}

function parseProgressLine(line) {
  var parts = line.split("|");
  if (parts.length < 5) {
    return null;
  }
  var toNumber = function (value) {
    var parsed = parseFloat(value);
    return isFinite(parsed) ? parsed : null;
  };
  return {
    percent: toNumber(parts[0].replace("%", "")),
    downloadedBytes: toNumber(parts[1]),
    totalBytes: toNumber(parts[2]),
    speedText: parts[3] === "NA" ? "" : parts[3],
    etaText: parts[4] === "NA" ? "" : parts[4]
  };
}

function runDownload(downloadRecord) {
  var meta = downloadRecord.meta;
  var settings = downloadRecord.settings;
  var command = binaryManager.getYtDlpCommand();
  var args = getYtDlpBaseArgs(settings);

  if (downloadRecord.range) {
    // yt-dlp needs h:mm:ss specifiers — bare seconds are mis-parsed
    args.push("--download-sections", "*" + formatSecondsSpec(downloadRecord.range.start) + "-" + formatSecondsSpec(downloadRecord.range.end));
    args.push("--force-keyframes-at-cuts");
  }

  if (downloadRecord.kind === "audio") {
    args.push("-f", quality.getAudioSelector());
    args.push("-x");
    args.push("--audio-format", "wav");
    args.push("--postprocessor-args", "ExtractAudio:-vn -ar 48000 -ac 2 -c:a pcm_s16le");
  } else {
    args.push("-f", downloadRecord.selector);
    args.push("--merge-output-format", "mp4");
    args.push.apply(args, quality.getFormatSortArgs());
    if (!downloadRecord.transcode) {
      // remux is only safe when we keep the source codecs; transcode path goes through ffmpeg anyway
      args.push("--remux-video", "mp4");
    }
  }

  args.push("-o", buildOutputTemplate(downloadRecord.destDir, downloadRecord));
  args.push("--progress-template", "%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress._speed_str)s|%(progress._eta_str)s");
  args.push("--print", "after_move:MEDIAOTTER_PATH %(filepath)s");
  args.push(downloadRecord.url);

  downloadRecord.stage = "running";
  downloadRecord.startedAt = Date.now();
  emit("download:start", downloadRecord);

  var proc = util.spawnProcess(command.executable, command.argsPrefix.concat(args), {
    env: getSpawnEnv(command.pythonKind),
    onStdout: function (chunk) {
      var lines = chunk.split(/\r?\n/);
      for (var index = 0; index < lines.length; index += 1) {
        var line = lines[index].trim();
        if (line.indexOf("MEDIAOTTER_PATH ") === 0) {
          downloadRecord.finalPath = line.slice("MEDIAOTTER_PATH ".length);
          downloadRecord.stage = "finalizing";
        }
      }
    },
    onStderr: function (chunk) {
      var lines = chunk.split(/\r?\n/);
      for (var index = 0; index < lines.length; index += 1) {
        var line = lines[index].trim();
        if (!line || line.indexOf("%") === -1) {
          continue;
        }
        var progress = parseProgressLine(line);
        if (progress) {
          downloadRecord.progress = progress;
          emit("download:progress", downloadRecord);
        }
      }
    },
    onError: function () {
      binaryManager.reportSpawnFailure(command.path);
      failDownload(downloadRecord, "Unable to launch the download engine (yt-dlp). Check Settings → Engine.");
    }
  });

  downloadRecord.cancel = function () {
    if (downloadRecord.stage === "done" || downloadRecord.stage === "error") {
      return;
    }
    downloadRecord.stage = "cancelled";
    try {
      proc.cancel();
    } catch (error) {
      /* ignore */
    }
    cleanupPartialFiles(downloadRecord);
    emit("download:cancelled", downloadRecord);
    logger.info("downloader", "download_cancelled", { id: downloadRecord.id });
  };

  proc.then(function (result) {
    if (downloadRecord.stage === "cancelled") {
      return;
    }
    if (result.code !== 0) {
      // Range downloads can fail when yt-dlp streams the cut through ffmpeg
      // (DNS / network). Fall back to full download + local cut.
      if (downloadRecord.range && !downloadRecord._sectionFallback && isSectionCutFailure(result)) {
        runSectionCutFallback(downloadRecord);
        return;
      }
      failDownload(downloadRecord, mapYtDlpError(result.stderr, downloadRecord.url));
      return;
    }
    if (!downloadRecord.finalPath || !fs.existsSync(downloadRecord.finalPath)) {
      failDownload(downloadRecord, "The file was downloaded but its path could not be resolved.");
      return;
    }
    if (downloadRecord.transcode) {
      transcodeToH264(downloadRecord).then(function (finalPath) {
        downloadRecord.finalPath = finalPath;
        completeDownload(downloadRecord);
      }).catch(function (error) {
        failDownload(downloadRecord, "Transcode failed: " + error.message);
      });
      return;
    }
    completeDownload(downloadRecord);
  }).catch(function () {
    if (downloadRecord.stage !== "cancelled") {
      failDownload(downloadRecord, "Download process error.");
    }
  });
}

function transcodeToH264(downloadRecord) {
  var runtime = binaryManager.getRuntimeStatus();
  var sourcePath = downloadRecord.finalPath;
  var targetPath = sourcePath.replace(/\.[^.]+$/, ".h264.mp4");
  var ffmpegArgs = ["-y", "-i", sourcePath, "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", targetPath];
  downloadRecord.stage = "transcoding";
  emit("download:progress", downloadRecord);
  return util.spawnProcess(runtime.ffmpegPath, ffmpegArgs, {}).then(function (result) {
    if (result.code !== 0) {
      throw new Error("ffmpeg exited " + result.code + ": " + result.stderr.slice(-300));
    }
    try {
      fs.unlinkSync(sourcePath);
    } catch (error) {
      /* keep both */
    }
    return targetPath;
  });
}

// ─── section-cut fallback ────────────────────────────────────────

/** True when yt-dlp failed while streaming the cut through ffmpeg (network/DNS). */
function isSectionCutFailure(result) {
  var text = String(result.stderr || "") + " " + String(result.stdout || "");
  return /ffmpeg exited with code/i.test(text) ||
    /error opening input/i.test(text) ||
    /failed to resolve hostname/i.test(text) ||
    /input\/output error/i.test(text);
}

/**
 * Range downloads normally stream only the section via ffmpeg (fast). When that
 * path fails (e.g. DNS/network), download the full media with yt-dlp's native
 * downloader, then cut locally with ffmpeg -c copy.
 */
function runSectionCutFallback(downloadRecord) {
  downloadRecord._sectionFallback = true;
  cleanupPartialFiles(downloadRecord);
  var range = downloadRecord.range;
  var meta = downloadRecord.meta;
  var settings = downloadRecord.settings;
  var command = binaryManager.getYtDlpCommand();
  var args = getYtDlpBaseArgs(settings);

  if (downloadRecord.kind === "audio") {
    args.push("-f", quality.getAudioSelector());
    args.push("-x");
    args.push("--audio-format", "wav");
    args.push("--postprocessor-args", "ExtractAudio:-vn -ar 48000 -ac 2 -c:a pcm_s16le");
  } else {
    args.push("-f", downloadRecord.selector);
    args.push("--merge-output-format", "mp4");
    args.push.apply(args, quality.getFormatSortArgs());
    if (!downloadRecord.transcode) {
      args.push("--remux-video", "mp4");
    }
  }

  // temp name: " [full]" marks the untrimmed file
  args.push("-o", buildOutputTemplate(downloadRecord.destDir, null).replace(".%(ext)s", " [full].%(ext)s"));
  args.push("--progress-template", "%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress._speed_str)s|%(progress._eta_str)s");
  args.push("--print", "after_move:MEDIAOTTER_PATH %(filepath)s");
  args.push(downloadRecord.url);

  downloadRecord.stage = "running";
  logger.info("downloader", "section_fallback_full_download", { id: downloadRecord.id });

  var proc = util.spawnProcess(command.executable, command.argsPrefix.concat(args), {
    env: getSpawnEnv(command.pythonKind),
    onStdout: function (chunk) {
      var lines = chunk.split(/\r?\n/);
      for (var index = 0; index < lines.length; index += 1) {
        var line = lines[index].trim();
        if (line.indexOf("MEDIAOTTER_PATH ") === 0) {
          downloadRecord.finalPath = line.slice("MEDIAOTTER_PATH ".length);
          downloadRecord.stage = "finalizing";
        }
      }
    },
    onStderr: function (chunk) {
      var lines = chunk.split(/\r?\n/);
      for (var index = 0; index < lines.length; index += 1) {
        var line = lines[index].trim();
        if (!line || line.indexOf("%") === -1) {
          continue;
        }
        var progress = parseProgressLine(line);
        if (progress) {
          downloadRecord.progress = progress;
          emit("download:progress", downloadRecord);
        }
      }
    },
    onError: function () {
      binaryManager.reportSpawnFailure(command.path);
    }
  });

  downloadRecord.cancel = function () {
    if (downloadRecord.stage === "done" || downloadRecord.stage === "error") {
      return;
    }
    downloadRecord.stage = "cancelled";
    try {
      proc.cancel();
    } catch (error) {
      /* ignore */
    }
    cleanupPartialFiles(downloadRecord);
    emit("download:cancelled", downloadRecord);
  };

  proc.then(function (result) {
    if (downloadRecord.stage === "cancelled") {
      return;
    }
    if (result.code !== 0) {
      failDownload(downloadRecord, mapYtDlpError(result.stderr, downloadRecord.url));
      return;
    }
    if (!downloadRecord.finalPath || !fs.existsSync(downloadRecord.finalPath)) {
      failDownload(downloadRecord, "The file was downloaded but its path could not be resolved.");
      return;
    }
    var fullPath = downloadRecord.finalPath;
    var sectionName = path.basename(fullPath).replace(" [full]", " " + formatSecondsSpec(range.start) + "-" + formatSecondsSpec(range.end));
    var sectionPath = path.join(downloadRecord.destDir, sectionName);
    var ffmpeg = binaryManager.getFfmpegPath();
    var cutArgs = ["-y", "-ss", formatSecondsSpec(range.start), "-to", formatSecondsSpec(range.end), "-i", fullPath, "-c", "copy", "-map", "0", sectionPath];
    util.spawnProcess(ffmpeg, cutArgs, {}).then(function (cutResult) {
      if (cutResult.code !== 0) {
        throw new Error("ffmpeg exited " + cutResult.code + ": " + String(cutResult.stderr || "").slice(-300));
      }
      if (!fs.existsSync(sectionPath)) {
        throw new Error("ffmpeg produced no output.");
      }
      try {
        fs.unlinkSync(fullPath);
      } catch (error) {
        /* keep the full file as well */
      }
      cleanupPartialFiles(downloadRecord);
      downloadRecord.finalPath = sectionPath;
      completeDownload(downloadRecord);
    }).catch(function (error) {
      failDownload(downloadRecord, "Section cut failed: " + error.message);
    });
  }).catch(function () {
    if (downloadRecord.stage !== "cancelled") {
      failDownload(downloadRecord, "Download process error.");
    }
  });
}

function completeDownload(downloadRecord) {
  downloadRecord.stage = "done";
  downloadRecord.finishedAt = Date.now();
  downloadRecord.progress = downloadRecord.progress || {};
  downloadRecord.progress.percent = 100;
  logger.info("downloader", "download_complete", { id: downloadRecord.id, finalPath: downloadRecord.finalPath });
  emit("download:complete", downloadRecord);
  releaseSlot();
}

function failDownload(downloadRecord, message) {
  downloadRecord.stage = "error";
  downloadRecord.error = message;
  downloadRecord.finishedAt = Date.now();
  cleanupPartialFiles(downloadRecord);
  logger.warn("downloader", "download_failed", { id: downloadRecord.id, message: message });
  emit("download:error", downloadRecord);
  releaseSlot();
}

function cleanupPartialFiles(downloadRecord) {
  if (!downloadRecord.finalPath) {
    return;
  }
  [downloadRecord.finalPath + ".part", downloadRecord.finalPath + ".ytdl"].forEach(function (candidate) {
    try {
      if (fs.existsSync(candidate)) {
        fs.unlinkSync(candidate);
      }
    } catch (error) {
      /* ignore */
    }
  });
}

function releaseSlot() {
  activeCount = Math.max(0, activeCount - 1);
  while (activeCount < CONCURRENT_DOWNLOAD_LIMIT && pendingQueue.length) {
    var next = pendingQueue.shift();
    activeCount += 1;
    runDownload(next);
  }
}

/** Enqueue a download. settings: { destDir, cookiesBrowser, maxQualityHeight, allowEncoding } */
function enqueueDownload(record) {
  var downloadRecord = Object.assign({}, record, {
    id: record.id || String(Date.now()) + "_" + Math.floor(Math.random() * 10000),
    stage: "queued",
    progress: null,
    createdAt: Date.now()
  });
  activeDownloads[downloadRecord.id] = downloadRecord;
  if (activeCount < CONCURRENT_DOWNLOAD_LIMIT) {
    activeCount += 1;
    runDownload(downloadRecord);
  } else {
    pendingQueue.push(downloadRecord);
    emit("download:queued", downloadRecord);
  }
  return downloadRecord;
}

function cancelDownload(id) {
  var record = activeDownloads[id];
  if (!record) {
    return;
  }
  var queueIndex = pendingQueue.indexOf(record);
  if (queueIndex !== -1) {
    pendingQueue.splice(queueIndex, 1);
    record.stage = "cancelled";
    emit("download:cancelled", record);
    return;
  }
  record.cancel && record.cancel();
}

function getActiveDownloads() {
  return Object.keys(activeDownloads).map(function (key) {
    return activeDownloads[key];
  }).filter(function (record) {
    return record.stage === "queued" || record.stage === "running" || record.stage === "finalizing" || record.stage === "transcoding";
  });
}

module.exports = {
  on: on,
  searchYouTube: searchYouTube,
  loadMoreResults: loadMoreResults,
  fetchSuggestions: fetchSuggestions,
  resolveMetadata: resolveMetadata,
  classifyUrl: classifyUrl,
  fetchPlaylistEntries: fetchPlaylistEntries,
  enqueueDownload: enqueueDownload,
  cancelDownload: cancelDownload,
  getActiveDownloads: getActiveDownloads,
  mapYtDlpError: mapYtDlpError
};
