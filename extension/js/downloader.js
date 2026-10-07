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
  return function () { listeners[eventName] = listeners[eventName].filter(function (fn) { return fn !== handler; }); };
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
    "--ignore-config",
    "--no-playlist",
    "--continue",
    "--no-overwrites",
    "--retries", "3",
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
  if (node.lockupViewModel && /PLAYLIST|VIDEO/.test(node.lockupViewModel.contentType || "")) { output.push(node.lockupViewModel); }
  if (node.playlistRenderer) { output.push(node.playlistRenderer); }
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
    if (key === "lockupViewModel" || key === "playlistRenderer" || key === "videoRenderer" || key === "compactVideoRenderer" || key === "richItemRenderer") {
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

function mapLockup(renderer) {
  var playlist = /PLAYLIST/.test(renderer.contentType || "");
  var metadata = renderer.metadata && renderer.metadata.lockupMetadataViewModel || {};
  var image = renderer.contentImage || {};
  var thumbnail = image.thumbnailViewModel || (image.collectionThumbnailViewModel && image.collectionThumbnailViewModel.primaryThumbnail && image.collectionThumbnailViewModel.primaryThumbnail.thumbnailViewModel) || {};
  var sources = thumbnail.image && thumbnail.image.sources || [];
  var rows = metadata.metadata && metadata.metadata.contentMetadataViewModel && metadata.metadata.contentMetadataViewModel.metadataRows || [];
  var parts = rows[0] && rows[0].metadataParts || [];
  var id = renderer.contentId;
  return {id:id,kind:playlist?"playlist":"video",title:metadata.title && metadata.title.content || "",channel:parts[0] && parts[0].text && parts[0].text.content || "",thumbnail:sources.length?sources[sources.length-1].url:"",duration:"",views:"",published:"",url:(playlist?"https://www.youtube.com/playlist?list=":"https://www.youtube.com/watch?v=")+id};
}
function mapVideoRenderer(renderer) {
  if (renderer.contentId) { return mapLockup(renderer); }
  var isPlaylist = Boolean(renderer.playlistId);
  var id = renderer.videoId || renderer.playlistId || "";
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
  return { kind: isPlaylist ? "playlist" : "video", id: id, title: title, channel: channel, views: views, duration: duration, published: published, thumbnail: thumbnail, url: id ? (isPlaylist ? "https://www.youtube.com/playlist?list=" : "https://www.youtube.com/watch?v=") + id : "" };
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
  var seen = {};
  items = items.filter(function (item) { if (seen[item.id]) { return false; } seen[item.id] = true; return true; });
  return { items: items, continuationToken: extractContinuationToken(data) };
}

function fetchSearchPage(query, filter) {
  var params = [];
  if (filter && filter !== "all") {
    var filters = {video:"EgIQAQ==",playlist:"EgIQAw=="};
    if (filters[filter]) { params.push("sp=" + encodeURIComponent(filters[filter])); }
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
      return filter === "playlist" ? {items:[],continuationToken:"",source:"web"} : searchYouTubeWithYtDlp(query);
    }
    return Object.assign(page, { source: "web" });
  }).catch(function (error) {
    logger.warn("downloader", "search_fallback", { message: error.message });
    return filter === "playlist" ? {items:[],continuationToken:"",source:"web"} : searchYouTubeWithYtDlp(query);
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
  var parsed;
  try { parsed = new (require("url").URL)(url); } catch (error) { return "generic"; }
  var host = parsed.hostname.toLowerCase();
  if (host === "youtu.be" || host === "youtube.com" || /\.youtube\.com$/.test(host)) {
    return parsed.pathname === "/playlist" ? "youtube_playlist" : "youtube_video";
  }
  return "generic";
}

function resolveMetadata(url, extra) {
  var cached = getPreResolved(url, extra);
  if (cached) {
    return Promise.resolve(cached);
  }
  var command = binaryManager.getYtDlpCommand();
  if (!command.executable) {
    return Promise.reject(new Error(command.error || "yt-dlp runtime is not ready."));
  }
  var args = getYtDlpBaseArgs(extra).concat([
    "--dump-single-json",
    "--skip-download",
    "--", url
  ]);
  return util.spawnProcess(command.executable, command.argsPrefix.concat(args), {
    env: getSpawnEnv(command.pythonKind),
    timeoutMs: 90000,
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
  if (!command.executable) {
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
    timeoutMs: 90000,
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

// Each job owns a temporary directory and a single queue slot across all stages.
function parseProgressLine(line) {
  var fields = line.replace(/^MEDIAOTTER_PROGRESS\s*/, "").split("|");
  if (fields.length < 5) { return null; }
  return {percent: parseFloat(fields[0]) || 0, downloadedBytes: Number(fields[1]) || 0,
    totalBytes: Number(fields[2]) || 0, speedText: fields[3] === "NA" ? "" : fields[3], etaText: fields[4] === "NA" ? "" : fields[4]};
}
function stage(record, name) { record.stage = name; emit("download:progress", record); }
function assertNotCancelled(record) { if (record._cancelled) { throw new Error("Cancelled"); } }
async function processJob(record, executable, args, options) {
  assertNotCancelled(record);
  var proc = util.spawnProcess(executable, args, options || {});
  record._process = proc;
  var result = await proc;
  record._process = null;
  assertNotCancelled(record);
  if (result.timedOut) { throw new Error("The process timed out. Check your connection and retry."); }
  return result;
}
async function probeFile(record, filePath) {
  var result = await processJob(record, binaryManager.getFfprobePath(), ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath], {timeoutMs: 30000});
  if (result.code !== 0) { throw new Error("Could not inspect downloaded media: " + result.stderr.slice(-300)); }
  var probe = util.parseJsonTolerant(result.stdout);
  if (!probe || !Array.isArray(probe.streams)) { throw new Error("Media inspection returned invalid data"); }
  return probe;
}
async function fetchMedia(record, section) {
  var command = binaryManager.getYtDlpCommand();
  var args = getYtDlpBaseArgs(record.settings);
  args.push("--no-simulate", "--no-overwrites", "-f", record.kind === "audio" ? quality.getAudioSelector() : record.selector,
    "--merge-output-format", "mkv", "-o", path.join(record._workDir, "source.%(ext)s"),
    "--progress", "--progress-template", "download:MEDIAOTTER_PROGRESS %(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress._speed_str)s|%(progress._eta_str)s",
    "--print", "after_move:MEDIAOTTER_PATH %(filepath)j");
  if (section) { args.push("--download-sections", "*" + record.range.start + "-" + record.range.end, "--force-keyframes-at-cuts"); }
  args.push("--", record.url);
  record._sourcePath = "";
  var result = await processJob(record, command.executable, command.argsPrefix.concat(args), {
    env: getSpawnEnv(command.pythonKind),
    onStdoutLine: function (line) {
      if (line.indexOf("MEDIAOTTER_PATH ") === 0) {
        try { record._sourcePath = JSON.parse(line.slice(16)); } catch (error) {}
      }
      if (line.indexOf("MEDIAOTTER_PROGRESS ") === 0) { record.progress = parseProgressLine(line); emit("download:progress", record); }
    },
    onStderrLine: function (line) {
      if (line.indexOf("MEDIAOTTER_PROGRESS ") === 0) { record.progress = parseProgressLine(line); emit("download:progress", record); }
    }
  });
  if (result.code !== 0) { var error = new Error(mapYtDlpError(result.stderr, record.url)); error.detail = result.stderr; throw error; }
  if (!record._sourcePath || !fs.existsSync(record._sourcePath) || path.dirname(record._sourcePath) !== record._workDir) { throw new Error("Download finished without a valid output file"); }
  return record._sourcePath;
}
async function normalizeMedia(record, source, locallyTrim) {
  stage(record, "finalizing");
  var input = await probeFile(record, source);
  var video = input.streams.filter(function (s) { return s.codec_type === "video" && !(s.disposition && s.disposition.attached_pic); })[0];
  var audio = input.streams.filter(function (s) { return s.codec_type === "audio"; })[0];
  if (record.kind === "audio" && !audio) { throw new Error("This source has no audio stream"); }
  if (record.kind === "video" && !video) { throw new Error("This source has no video stream"); }
  var ext = record.kind === "audio" ? ".wav" : ".mp4";
  var output = path.join(record._workDir, "ready" + ext);
  var args = ["-nostdin", "-y", "-i", source];
  if (locallyTrim) { args.push("-ss", String(record.range.start), "-t", String(record.range.end - record.range.start)); }
  if (record.kind === "audio") { args.push("-map", "0:a:0", "-vn", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2"); }
  else {
    args.push("-map", "0:v:0", "-map", "0:a:0?");
    var videoCopy = video.codec_name === "h264" && video.height <= record.maxHeight && !locallyTrim && /^(yuv420p|yuvj420p)$/.test(video.pix_fmt);
    if (videoCopy) { args.push("-c:v", "copy"); }
    else { args.push("-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p"); if (video.height > record.maxHeight) { args.push("-vf", "scale=-2:" + record.maxHeight); } stage(record, "transcoding"); }
    if (audio) { args.push("-c:a", audio.codec_name === "aac" && !locallyTrim ? "copy" : "aac"); }
    args.push("-movflags", "+faststart");
  }
  args.push(output);
  var converted = await processJob(record, binaryManager.getFfmpegPath(), args, {});
  if (converted.code !== 0) { throw new Error("Media conversion failed: " + converted.stderr.slice(-400)); }
  stage(record, "verifying");
  var probe = await probeFile(record, output);
  var duration = Number(probe.format && probe.format.duration);
  if (!isFinite(duration) || duration <= 0 || !fs.statSync(output).size) { throw new Error("Finished media is empty or has no valid duration"); }
  if (record.range && Math.abs(duration - (record.range.end - record.range.start)) > 0.75) { throw new Error("The source could not provide the requested section duration. Choose a range within the available media."); }
  var streams = probe.streams;
  if (record.kind === "audio" && !streams.some(function (s) { return s.codec_name === "pcm_s16le" && Number(s.sample_rate) === 48000 && s.channels === 2; })) { throw new Error("Audio validation failed"); }
  if (record.kind === "video" && !streams.some(function (s) { return s.codec_name === "h264" && s.height <= record.maxHeight; })) { throw new Error("Video validation failed: codec or quality cap differs from the selection"); }
  if (record.kind === "video" && streams.some(function (s) { return s.codec_type === "audio" && s.codec_name !== "aac"; })) { throw new Error("Video audio validation failed"); }
  var title = String(record.title || "MediaOtter").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 100).replace(/[ .]+$/, "") || "MediaOtter";
  var suffix = record.range ? " [" + record.range.start + "-" + record.range.end + "s]" : "";
  var finalPath = path.join(record.destDir, title + suffix + " [" + record.id + "]" + ext);
  assertNotCancelled(record);
  fs.renameSync(output, finalPath);
  record.finalPath = finalPath; record.finalSize = fs.statSync(finalPath).size;
  record.mediaInfo = {duration: duration, streams: streams.map(function (s) { return {type:s.codec_type,codec:s.codec_name,width:s.width,height:s.height,sampleRate:s.sample_rate,channels:s.channels}; })};
}
async function runDownload(record) {
  record.startedAt = Date.now(); record.stage = "running"; emit("download:start", record);
  try {
    fs.mkdirSync(record.destDir, {recursive: true});
    if (!fs.statSync(record.destDir).isDirectory()) { throw new Error("Choose a download folder, not a project file"); }
    record._workDir = fs.mkdtempSync(path.join(record.destDir, ".mediaotter-"));
    var source, locallyTrim = false;
    try { source = await fetchMedia(record, Boolean(record.range)); }
    catch (error) {
      assertNotCancelled(record);
      if (!record.range || !/ffmpeg|error opening input|failed to resolve hostname|input\/output error/i.test(error.detail || "")) { throw error; }
      util.removeDir(record._workDir);
      record._workDir = fs.mkdtempSync(path.join(record.destDir, ".mediaotter-"));
      stage(record, "running"); source = await fetchMedia(record, false); locallyTrim = true;
    }
    await normalizeMedia(record, source, locallyTrim);
    assertNotCancelled(record); record.stage = "done"; record.finishedAt = Date.now();
    record.progress = {percent:100}; logger.info("downloader", "download_complete", {id:record.id,media:record.mediaInfo}); emit("download:complete", record);
  } catch (error) {
    record.finishedAt = Date.now();
    if (record._cancelled) { record.stage = "cancelled"; emit("download:cancelled", record); }
    else { record.stage = "error"; record.error = error.message || String(error); logger.warn("downloader", "download_failed", {id:record.id,error:record.error}); emit("download:error", record); }
  } finally {
    if (record._workDir) { try { util.removeDir(record._workDir); } catch (error) {} }
    record._process = null;
    activeCount = Math.max(0, activeCount - 1); pumpQueue();
  }
}
function pumpQueue() {
  while (activeCount < CONCURRENT_DOWNLOAD_LIMIT && pendingQueue.length) { var record = pendingQueue.shift(); activeCount++; runDownload(record); }
}
function enqueueDownload(request) {
  if (!/^https?:\/\//i.test(request.url || "")) { throw new Error("Expected an HTTP(S) media URL"); }
  var runtime = binaryManager.getRuntimeStatus();
  if (!runtime.ytDlpReady || !runtime.ffmpegReady || !runtime.ffprobeReady) { throw new Error(runtime.ytDlpError || "Download engine is incomplete. Check Settings."); }
  if (request.kind !== "audio" && request.kind !== "video") { throw new Error("Choose audio or video"); }
  if (request.kind === "video" && !request.selector) { throw new Error("Choose an available video quality"); }
  if (request.range && (!isFinite(request.range.start) || !isFinite(request.range.end) || request.range.start < 0 || request.range.end <= request.range.start)) { throw new Error("Choose a valid start and end time"); }
  if (request.range && request.meta && request.meta.duration && request.range.end > request.meta.duration + 0.1) { throw new Error("The section ends after this media ends"); }
  if (!path.isAbsolute(request.destDir || "")) { throw new Error("Choose an absolute download folder"); }
  var record = Object.assign({}, request, {id: require("crypto").randomBytes(6).toString("hex"), title: request.meta && request.meta.title || "MediaOtter", settings:request.settings || {}, stage:"queued", createdAt:Date.now(), maxHeight:Number(request.settings && request.settings.maxQualityHeight) || 2160});
  activeDownloads[record.id] = record; pendingQueue.push(record); emit("download:queued", record); pumpQueue(); return record;
}
function cancelDownload(id) {
  var record = activeDownloads[id];
  if (!record || /^(done|error|cancelled)$/.test(record.stage)) { return; }
  record._cancelled = true;
  var index = pendingQueue.indexOf(record);
  if (index !== -1) { pendingQueue.splice(index, 1); record.stage = "cancelled"; emit("download:cancelled", record); return; }
  record.stage = "cancelling"; emit("download:progress", record);
  if (record._process) { record._process.cancel(); }
}
function getActiveDownloads() { return Object.keys(activeDownloads).map(function (id) { return activeDownloads[id]; }).filter(function (r) { return !/^(done|error|cancelled)$/.test(r.stage); }); }

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
