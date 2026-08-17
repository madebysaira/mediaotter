"use strict";

/**
 * MediaOtter — panel controller (runs inside CEP's Node-enabled Chromium).
 * Wires the UI to the download engine. No telemetry, everything local.
 */

var fs = require("fs");
var path = require("path");

var util = require("./util.js");
var logger = require("./logger.js");
var settings = require("./settings.js");
var history = require("./history.js");
var downloader = require("./downloader.js");
var quality = require("./quality.js");
var binaryManager = require("./binary-manager.js");
var cookieJar = require("./cookie-jar.js");
var csbridge = require("./csbridge.js");
var auth = require("./auth.js");
var playlists = require("./playlists.js");

var VERSION = "1.0.0";
var REPO_URL = "https://github.com/mediaotter/mediaotter";

var state = {
  screen: "search",
  searchQuery: "",
  searchFilter: "all",
  searchItems: [],
  continuationToken: "",
  searching: false,
  loadingMore: false,
  selectedMeta: null,
  selectedUrl: "",
  activeDownloads: {},
  suggestIndex: -1,
  playlistMode: "playlists",
  playlistItems: []
};

var els = {};

function $(id) { return document.getElementById(id); }

function on(selector, event, handler) {
  document.querySelectorAll(selector).forEach(function (el) {
    el.addEventListener(event, handler);
  });
}

// ─── formatting helpers ─────────────────────────────────────

function fmtBytes(bytes) {
  if (!bytes || isNaN(bytes)) { return "—"; }
  var units = ["B", "KB", "MB", "GB", "TB"];
  var value = Number(bytes);
  var unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return (unit === 0 ? value : value.toFixed(1)) + " " + units[unit];
}

function fmtDuration(seconds) {
  if (!seconds || isNaN(seconds)) { return ""; }
  var total = Math.round(Number(seconds));
  var hours = Math.floor(total / 3600);
  var minutes = Math.floor((total % 3600) / 60);
  var secs = total % 60;
  if (hours > 0) { return hours + ":" + String(minutes).padStart(2, "0") + ":" + String(secs).padStart(2, "0"); }
  return minutes + ":" + String(secs).padStart(2, "0");
}

function fmtViews(views) {
  var value = Number(views);
  if (!value || isNaN(value)) { return ""; }
  if (value >= 1000000000) { return (value / 1000000000).toFixed(1) + "B"; }
  if (value >= 1000000) { return (value / 1000000).toFixed(1) + "M"; }
  if (value >= 1000) { return (value / 1000).toFixed(1) + "K"; }
  return String(value);
}

/** "1:23" / "83" / "1:02:30" → seconds, or NaN. */
function parseTimeToSeconds(text) {
  var parts = String(text || "").trim().split(":");
  var seconds = 0;
  for (var i = 0; i < parts.length; i += 1) {
    var part = parseInt(parts[i], 10);
    if (isNaN(part) || part < 0) { return NaN; }
    seconds = seconds * 60 + part;
  }
  return seconds;
}

function escapeHtml(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ─── toasts ────────────────────────────────────────────────

function toast(message, kind) {
  var box = els.toasts;
  var el = document.createElement("div");
  el.className = "toast " + (kind || "info");
  var icons = { ok: "fa-circle-check", err: "fa-circle-exclamation", info: "fa-circle-info" };
  el.innerHTML = '<i class="fa-solid ' + (icons[kind] || icons.info) + '"></i><span>' + escapeHtml(message) + "</span>";
  box.appendChild(el);
  setTimeout(function () {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.3s";
    setTimeout(function () { el.remove(); }, 320);
  }, 3800);
}

// ─── screens / navigation ──────────────────────────────────

function showScreen(name) {
  state.screen = name;
  ["search", "downloads", "playlists", "settings"].forEach(function (key) {
    els["screen-" + key].classList.toggle("active", key === name);
  });
  els.btnHistory.classList.toggle("active", name === "downloads");
  els.btnSettings.classList.toggle("active", name === "settings");
  if (name === "downloads") { renderActiveDownloads(); renderHistory(); }
  if (name === "playlists") { renderAccount(); }
}

// ─── search ────────────────────────────────────────────────

var suggestTimer = null;

function wireSearch() {
  els.searchInput.addEventListener("input", function () {
    els.searchClear.classList.toggle("hidden", !els.searchInput.value);
    clearTimeout(suggestTimer);
    var query = els.searchInput.value.trim();
    if (query.length < 2) { hideSuggestions(); return; }
    suggestTimer = setTimeout(function () { fetchSuggestions(query); }, 220);
  });

  els.searchInput.addEventListener("keydown", function (event) {
    var items = document.querySelectorAll(".suggest-item");
    if (items.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        state.suggestIndex = (state.suggestIndex + 1) % items.length;
        markSuggestion(items);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        state.suggestIndex = (state.suggestIndex - 1 + items.length) % items.length;
        markSuggestion(items);
        return;
      }
      if (event.key === "Enter" && state.suggestIndex >= 0) {
        event.preventDefault();
        els.searchInput.value = items[state.suggestIndex].dataset.query;
        hideSuggestions();
        runSearch();
        return;
      }
    }
    if (event.key === "Enter") {
      event.preventDefault();
      hideSuggestions();
      runSearch();
    }
  });

  els.searchInput.addEventListener("focus", function () {
    if (els.searchInput.value.trim().length >= 2) { fetchSuggestions(els.searchInput.value.trim()); }
  });

  els.searchClear.addEventListener("click", function () {
    els.searchInput.value = "";
    els.searchClear.classList.add("hidden");
    hideSuggestions();
    els.searchInput.focus();
  });

  document.addEventListener("click", function (event) {
    if (!event.target.closest(".search-form")) { hideSuggestions(); }
  });
}

function markSuggestion(items) {
  items.forEach(function (item, index) {
    item.classList.toggle("sel", index === state.suggestIndex);
  });
}

function fetchSuggestions(query) {
  downloader.fetchSuggestions(query).then(function (suggestions) {
    if (document.activeElement !== els.searchInput) { return; }
    state.suggestIndex = -1;
    if (!suggestions.length) { hideSuggestions(); return; }
    els.suggestBox.innerHTML = suggestions.map(function (suggestion) {
      return '<div class="suggest-item" data-query="' + escapeHtml(suggestion) + '"><i class="fa-solid fa-magnifying-glass"></i><span>' + escapeHtml(suggestion) + "</span></div>";
    }).join("");
    els.suggestBox.classList.remove("hidden");
    els.suggestBox.querySelectorAll(".suggest-item").forEach(function (item) {
      item.addEventListener("mousedown", function (event) {
        event.preventDefault();
        els.searchInput.value = item.dataset.query;
        hideSuggestions();
        runSearch();
      });
    });
  }).catch(function () { /* suggestions are best-effort */ });
}

function hideSuggestions() {
  els.suggestBox.classList.add("hidden");
  state.suggestIndex = -1;
}

function runSearch() {
  var query = els.searchInput.value.trim();
  if (!query) { return; }
  state.searchQuery = query;
  state.searchFilter = document.querySelector(".filter-chip.active").dataset.filter;
  state.searching = true;
  state.searchItems = [];
  state.continuationToken = "";
  renderResults([]);
  setStatus('Searching for "' + query + '"…');

  downloader.searchYouTube(query, state.searchFilter).then(function (result) {
    state.searching = false;
    state.searchItems = result.items;
    state.continuationToken = result.continuationToken || "";
    renderResults(state.searchItems);
    setStatus(result.items.length ? result.items.length + " results for \"" + query + "\"" : "No results for \"" + query + "\"");
    els.resultsMore.classList.toggle("hidden", !state.continuationToken);
  }).catch(function (error) {
    state.searching = false;
    renderResults([]);
    setStatus("");
    toast("Search failed: " + error.message, "err");
  });
}

function loadMore() {
  if (!state.continuationToken || state.loadingMore) { return; }
  state.loadingMore = true;
  els.btnMore.disabled = true;
  els.btnMore.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading…';
  downloader.loadMoreResults(state.continuationToken, { query: state.searchQuery, filter: state.searchFilter }).then(function (result) {
    state.loadingMore = false;
    els.btnMore.disabled = false;
    els.btnMore.innerHTML = '<i class="fa-solid fa-angles-down"></i> Load more';
    state.searchItems = state.searchItems.concat(result.items);
    state.continuationToken = result.continuationToken || "";
    renderResults(state.searchItems);
    els.resultsMore.classList.toggle("hidden", !state.continuationToken);
    setStatus(state.searchItems.length + " results");
  }).catch(function (error) {
    state.loadingMore = false;
    els.btnMore.disabled = false;
    els.btnMore.innerHTML = '<i class="fa-solid fa-angles-down"></i> Load more';
    toast("Could not load more: " + error.message, "err");
  });
}

function renderResults(items) {
  els.results.innerHTML = items.map(function (item) {
    var isPlaylist = item.kind === "playlist";
    var thumb = item.thumbnail || "";
    return '<div class="result-card" data-id="' + escapeHtml(item.id) + '" data-kind="' + item.kind + '">' +
      '<div class="thumb">' +
        (thumb ? '<img src="' + escapeHtml(thumb) + '" loading="lazy" alt="" />' : "") +
        (isPlaylist
          ? '<span class="pl-count"><i class="fa-solid fa-list"></i>' + (item.count || "") + "</span>"
          : '<span class="play-badge"><i class="fa-solid fa-play"></i></span><span class="dur">' + (item.duration || "") + "</span>") +
      "</div>" +
      '<div class="result-info">' +
        '<div class="result-title">' + escapeHtml(item.title) + "</div>" +
        '<div class="result-sub">' +
          (item.channel ? "<span>" + escapeHtml(item.channel) + "</span><span class='sep'>•</span>" : "") +
          (item.views ? "<span>" + escapeHtml(item.views) + "</span>" : "") +
          (item.published ? "<span>" + escapeHtml(item.published) + "</span>" : "") +
          (isPlaylist ? '<span class="chip pl"><i class="fa-solid fa-list-ul"></i> Playlist</span>' : '<span class="chip yt"><i class="fa-brands fa-youtube"></i> YouTube</span>') +
        "</div>" +
      "</div>" +
    "</div>";
  }).join("") + (state.searching ? '<div class="skeleton"></div><div class="skeleton"></div>' : "");

  els.results.querySelectorAll(".result-card").forEach(function (card) {
    card.addEventListener("click", function () { openPreview(card.dataset.id, card.dataset.kind); });
  });
}

function setStatus(text) {
  els.resultsStatus.textContent = text;
}

// ─── paste URL ─────────────────────────────────────────────

function fetchPasted() {
  var rawUrl = els.pasteInput.value.trim();
  if (!rawUrl) { return; }
  var url = normalizeUrl(rawUrl);
  if (!url) { toast("That doesn't look like a URL.", "err"); return; }
  setStatus("Fetching " + url + "…");
  els.pasteGo.disabled = true;
  els.pasteGo.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

  downloader.classifyUrl(url).then(function (kind) {
    if (kind === "playlist") {
      return downloader.fetchPlaylistEntries(url, {}).then(function (result) {
        setStatus("");
        els.pasteGo.disabled = false;
        els.pasteGo.innerHTML = "Fetch";
        renderPlaylistEntries(result);
        state.pastePlaylist = result;
      });
    }
    return downloader.resolveMetadata(url, {}).then(function (meta) {
      setStatus("");
      els.pasteGo.disabled = false;
      els.pasteGo.innerHTML = "Fetch";
      state.selectedUrl = meta.webpage_url || url;
      state.selectedMeta = meta;
      openPreviewById(meta.id || state.selectedUrl, "video", meta);
    });
  }).catch(function (error) {
    setStatus("");
    els.pasteGo.disabled = false;
    els.pasteGo.innerHTML = "Fetch";
    toast("Could not fetch: " + error.message, "err");
  });
}

function normalizeUrl(text) {
  var trimmed = String(text).trim();
  if (/^https?:\/\//i.test(trimmed)) { return trimmed; }
  if (trimmed.indexOf("youtu.be/") !== -1 || trimmed.indexOf("youtube.com/") !== -1 || trimmed.indexOf(".") !== -1) {
    return "https://" + trimmed;
  }
  return "";
}

function renderPlaylistEntries(result) {
  showScreen("search");
  setStatus("");
  els.results.innerHTML = result.entries.map(function (item, index) {
    var thumb = item.thumbnail || "";
    return '<div class="result-card" data-idx="' + index + '" data-kind="video">' +
      '<div class="thumb">' +
        (thumb ? '<img src="' + escapeHtml(thumb) + '" loading="lazy" alt="" />' : "") +
        '<span class="dur">' + (item.duration || "") + "</span>" +
      "</div>" +
      '<div class="result-info">' +
        '<div class="result-title">' + (index + 1) + ". " + escapeHtml(item.title) + "</div>" +
        '<div class="result-sub"><span class="chip yt"><i class="fa-brands fa-youtube"></i> Playlist item</span></div>' +
      "</div>" +
    "</div>";
  }).join("");
  els.results.querySelectorAll(".result-card").forEach(function (card) {
    card.addEventListener("click", function () {
      var entry = result.entries[Number(card.dataset.idx)];
      if (entry) { downloader.resolveMetadata(entry.url).then(function (meta) { openPreviewById(entry.id, "video", meta); }); }
    });
  });
}

// ─── preview ───────────────────────────────────────────────

function openPreview(id, kind) {
  var item = state.searchItems.filter(function (it) { return it.id === id; })[0];
  if (!item) { return; }
  if (kind === "playlist") {
    openPlaylistById(item.id, item);
    return;
  }
  var watchUrl = "https://www.youtube.com/watch?v=" + item.id;
  if (item.url) { /* keep */ }
  downloader.resolveMetadata(item.url || watchUrl, {}).then(function (meta) {
    openPreviewById(item.id, "video", meta);
  }).catch(function (error) {
    toast("Could not load preview: " + error.message, "err");
  });
}

function openPreviewById(id, kind, meta) {
  state.selectedUrl = (meta && meta.webpage_url) || (kind === "playlist" ? "" : "https://www.youtube.com/watch?v=" + id);
  state.selectedMeta = meta || null;

  var title = (meta && meta.title) || (kind === "playlist" ? id : "Video");
  var channel = (meta && meta.uploader) || (meta && meta.channel) || "";
  var views = meta && meta.view_count ? fmtViews(meta.view_count) + " views" : "";
  var duration = meta && meta.duration ? fmtDuration(meta.duration) : "";
  var description = (meta && meta.description) || "";

  els.previewTitle.textContent = title;
  els.previewChannel.textContent = channel;
  els.previewStats.textContent = [duration, views].filter(Boolean).join(" · ");
  els.previewAvatar.textContent = (channel || "?").trim().charAt(0).toUpperCase();
  els.previewDesc.textContent = description.slice(0, 600);
  els.previewFrame.src = "https://www.youtube.com/embed/" + id + "?autoplay=1&rel=0&modestbranding=1";
  els.previewOpen.href = state.selectedUrl;

  els.rangeStart.value = "";
  els.rangeEnd.value = "";

  // quality options
  var html = "";
  var audioSize = quality.estimateAudioSize(meta && meta.formats);
  html += '<div class="qrow">' +
    '<div class="q-main"><div class="q-name"><i class="fa-solid fa-music"></i> Audio only</div>' +
    '<div class="q-sub">WAV · PCM 48 kHz stereo <span class="badge h264">Premiere-ready</span>' +
    (audioSize ? "<span>" + fmtBytes(audioSize) + "</span>" : "") + "</div></div>" +
    '<button class="q-dl" data-dl="audio" title="Download audio"><i class="fa-solid fa-download"></i></button></div>';

  if (kind !== "playlist" && meta && meta.formats && meta.formats.length) {
    var candidates = quality.planVideoCandidates(meta, settings.read());
    candidates.forEach(function (candidate) {
      var badges = [];
      if (candidate.hasMuxedH264) { badges.push('<span class="badge h264">H.264</span>'); }
      if (candidate.requiresMerge) { badges.push('<span class="badge warn">Merge</span>'); }
      if (candidate.transcodeOffered) { badges.push('<span class="badge warn">Transcode</span>'); }
      var sub = candidate.codec ? candidate.codec + " · " : "";
      if (candidate.sizeBytes) { sub += fmtBytes(candidate.sizeBytes) + " "; }
      html += '<div class="qrow">' +
        '<div class="q-main"><div class="q-name">' + candidate.label + "</div>" +
        '<div class="q-sub">' + sub + badges.join("") + "</div></div>" +
        '<button class="q-dl" data-dl="video" data-selector="' + escapeHtml(candidate.selector) + '" data-transcode="' + (candidate.requiresTranscode ? "1" : "0") + '" title="Download video"><i class="fa-solid fa-download"></i></button></div>';
    });
  }

  els.previewActions.innerHTML = html;
  els.previewActions.querySelectorAll(".q-dl").forEach(function (button) {
    button.addEventListener("click", function () {
      var range = getRange();
      if (range && range.invalid) {
        toast("Range: use minutes:seconds, e.g. 1:30 – 2:45", "err");
        return;
      }
      startDownload({
        url: state.selectedUrl,
        kind: button.dataset.dl,
        selector: button.dataset.selector,
        transcode: button.dataset.transcode === "1",
        range: range && range.ok ? range : null,
        meta: state.selectedMeta
      });
    });
  });

  els.preview.classList.remove("hidden");
}

function getRange() {
  var start = els.rangeStart.value.trim();
  var end = els.rangeEnd.value.trim();
  if (!start && !end) { return null; }
  var startSec = start ? parseTimeToSeconds(start) : 0;
  var endSec = end ? parseTimeToSeconds(end) : NaN;
  if (isNaN(startSec) || (end && isNaN(endSec))) { return { invalid: true }; }
  if (!end && start) { return { invalid: true }; }
  if (endSec <= startSec) { return { invalid: true }; }
  return { ok: true, start: startSec, end: endSec };
}

// ─── downloads ─────────────────────────────────────────────

function startDownload(options) {
  var rootPromise;
  var current = settings.read();
  if (current.downloadLocation === "custom" && current.customPath) {
    rootPromise = Promise.resolve({ ok: true, path: current.customPath });
  } else {
    rootPromise = csbridge.resolveDownloadRoot("").then(function (result) {
      if (result.ok && !result.path && csbridge.isCEP()) {
        return { ok: false, error: "Open a project first — MediaOtter saves downloads into your project folder." };
      }
      if (result.ok && !result.path && !csbridge.isCEP()) {
        return { ok: true, path: util.getStateDir() + "/downloads" };
      }
      return result;
    });
  }

  rootPromise.then(function (root) {
    if (!root.ok) { toast(root.error || "No download folder.", "err"); return; }
    var record = downloader.enqueueDownload({
      url: options.url,
      kind: options.kind,
      selector: options.selector,
      transcode: options.transcode,
      range: options.range,
      destDir: root.path,
      settings: settings.read(),
      meta: options.meta
    });
    toast(options.kind === "audio" ? "Downloading audio…" : "Downloading video…", "info");
    showScreen("downloads");
  }).catch(function (error) {
    toast("Could not start download: " + error.message, "err");
  });
}

function renderActiveDownloads() {
  var ids = Object.keys(state.activeDownloads);
  els.downloadsEmpty.classList.toggle("hidden", ids.length > 0);
  els.activeDownloads.innerHTML = ids.map(function (id) {
    var record = state.activeDownloads[id];
    var percent = record.percent != null ? Math.round(record.percent) : 0;
    var stageClass = record.stage === "merging" || record.stage === "postprocessing" ? "merging" : "running";
    var metrics = "";
    if (record.stage === "done") {
      metrics = '<span class="m"><i class="fa-solid fa-check"></i> ' + fmtBytes(record.finalSize || record.downloadedBytes || 0) + "</span>";
    } else if (record.stage === "error" || record.stage === "cancelled") {
      metrics = '<span class="m"><i class="fa-solid fa-circle-exclamation"></i> ' + escapeHtml(record.error || "") + "</span>";
    } else {
      metrics = '<span class="m"><i class="fa-solid fa-percent"></i> ' + percent + "%</span>" +
        (record.downloadedBytes ? '<span class="m"><i class="fa-solid fa-database"></i> ' + fmtBytes(record.downloadedBytes) + "</span>" : "") +
        (record.totalBytes ? '<span class="m"><i class="fa-solid fa-box"></i> ' + fmtBytes(record.totalBytes) + "</span>" : "") +
        (record.speed ? '<span class="m"><i class="fa-solid fa-gauge-high"></i> ' + escapeHtml(record.speed) + "</span>" : "") +
        (record.eta ? '<span class="m"><i class="fa-solid fa-hourglass-half"></i> ' + escapeHtml(record.eta) + "</span>" : "");
    }
    var actions = "";
    if (record.stage === "done") {
      actions = '<div class="dl-done-actions">' +
        '<button class="btn sm primary" data-import="' + id + '"><i class="fa-solid fa-box-archive"></i> Import to project</button>' +
        '<button class="btn sm" data-reveal="' + id + '"><i class="fa-solid fa-folder-open"></i> Show in Finder</button>' +
        "</div>";
    } else if (record.stage === "running" || record.stage === "merging") {
      actions = '<button class="dl-cancel" data-cancel="' + id + '" title="Cancel"><i class="fa-solid fa-xmark"></i></button>';
    }
    return '<div class="dl-card" data-id="' + id + '">' +
      '<div class="dl-head">' +
        '<span class="dl-status ' + stageClass + '"></span>' +
        '<span class="dl-title">' + escapeHtml(record.title || record.url) + "</span>" +
        '<span class="dl-kind">' + record.kind + "</span>" +
        actions +
      "</div>" +
      (record.stage !== "done" && record.stage !== "error" && record.stage !== "cancelled"
        ? '<div class="progress-track"><div class="progress-fill ' + stageClass + '" style="width:' + percent + '%"></div></div>' : "") +
      '<div class="dl-metrics">' + metrics + "</div>" +
    "</div>";
  }).join("");

  els.activeDownloads.querySelectorAll("[data-import]").forEach(function (button) {
    button.addEventListener("click", function () { importRecord(button.dataset.import); });
  });
  els.activeDownloads.querySelectorAll("[data-reveal]").forEach(function (button) {
    button.addEventListener("click", function () { revealRecord(button.dataset.reveal); });
  });
  els.activeDownloads.querySelectorAll("[data-cancel]").forEach(function (button) {
    button.addEventListener("click", function () { cancelRecord(button.dataset.cancel); });
  });
}

function importRecord(id) {
  var record = state.activeDownloads[id];
  if (!record || !record.finalPath) { return; }
  csbridge.importIntoHost(record.finalPath, { addToTimeline: false }).then(function (result) {
    if (result.ok) { toast("Imported into your project ✓", "ok"); }
    else { toast("Import failed: " + result.error, "err"); }
  });
}

function revealRecord(id) {
  var record = state.activeDownloads[id];
  if (!record || !record.finalPath) { return; }
  if (csbridge.isCEP()) {
    csbridge.revealInFinder(record.finalPath);
  } else {
    toast("Not in a host app (dev mode).", "info");
  }
}

function cancelRecord(id) {
  downloader.cancelDownload(id);
}

function renderHistory() {
  var entries = history.read();
  els.historyList.innerHTML = entries.length ? entries.map(function (entry) {
    return '<div class="history-item" draggable="true" data-file="' + escapeHtml(entry.filePath) + '">' +
      (entry.thumbnail ? '<img class="hi-thumb" src="' + escapeHtml(entry.thumbnail) + '" alt="" />' : '<div class="hi-thumb" style="background:var(--card-solid)"></div>') +
      '<div class="hi-title"><div>' + escapeHtml(entry.title) + "</div>" +
      '<div class="hi-meta">' + (entry.kind || "") + " · " + fmtBytes(entry.size || 0) + " · " + entry.completedAt.slice(0, 10) + "</div></div>" +
      '<div class="hi-actions">' +
        '<button class="icon-btn" title="Import to project" data-himport="' + escapeHtml(entry.filePath) + '"><i class="fa-solid fa-box-archive"></i></button>' +
        '<button class="icon-btn" title="Show in Finder" data-hreveal="' + escapeHtml(entry.filePath) + '"><i class="fa-solid fa-folder-open"></i></button>' +
        '<button class="icon-btn" title="Remove" data-hremove="' + escapeHtml(entry.id) + '"><i class="fa-solid fa-trash-can"></i></button>' +
      "</div>" +
    "</div>";
  }).join("") : '<div class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><p>No downloads yet.</p></div>';

  els.historyList.querySelectorAll("[data-himport]").forEach(function (button) {
    button.addEventListener("click", function () { csbridge.importIntoHost(button.dataset.himport, { addToTimeline: false }).then(handleImportResult); });
  });
  els.historyList.querySelectorAll("[data-hreveal]").forEach(function (button) {
    button.addEventListener("click", function () { if (csbridge.isCEP()) { csbridge.revealInFinder(button.dataset.hreveal); } });
  });
  els.historyList.querySelectorAll("[data-hremove]").forEach(function (button) {
    button.addEventListener("click", function () { history.remove(button.dataset.hremove); renderHistory(); });
  });
  els.historyList.querySelectorAll(".history-item").forEach(function (item) {
    item.addEventListener("dragstart", function (event) {
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("text/uri-list", "file://" + item.dataset.file);
      event.dataTransfer.setData("text/plain", item.dataset.file);
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", function () { item.classList.remove("dragging"); });
  });
}

function handleImportResult(result) {
  if (result.ok) { toast("Imported into your project ✓", "ok"); }
  else { toast("Import failed: " + result.error, "err"); }
}

// ─── playlists / account ───────────────────────────────────

function renderAccount() {
  var card = els.accountCard;
  if (!auth.isConfigured()) {
    card.innerHTML = '<div class="account-hero">' +
      '<div class="acc-avatar"><i class="fa-solid fa-user"></i></div>' +
      '<div><div class="acc-name">Connect your YouTube</div>' +
      '<div class="acc-email">Browse your own playlists, likes &amp; subscriptions</div></div></div>' +
      '<div class="acc-actions">' +
        '<button class="btn primary" id="btn-oauth"><i class="fa-solid fa-arrow-right-to-bracket"></i> Sign in with Google</button>' +
        '<button class="btn ghost" id="btn-creds-help"><i class="fa-solid fa-circle-question"></i> Setup credentials</button>' +
      "</div>" +
      '<p class="acc-note">Open source? You bring your own free Google Cloud credentials — see the Setup guide. Your tokens stay on this Mac.</p>';
    els.playlistTabs.classList.add("hidden");
    els.playlistGrid.innerHTML = "";
    els.playlistItems.classList.add("hidden");
    wireOnce(card, "#btn-oauth", function () { signInFlow(); });
    wireOnce(card, "#btn-creds-help", function () { openCredentialsHelp(); });
    return;
  }

  auth.getUserInfo().then(function (info) {
    var signedIn = Boolean(info);
    card.innerHTML = signedIn
      ? '<div class="account-hero">' +
          '<div class="acc-avatar">' + (info.avatarUrl ? '<img src="' + escapeHtml(info.avatarUrl) + '" alt="" />' : escapeHtml((info.name || "?").charAt(0).toUpperCase())) + "</div>" +
          '<div><div class="acc-name">' + escapeHtml(info.name || "") + "</div>" +
          '<div class="acc-email">' + escapeHtml(info.email || "") + "</div></div></div>" +
          '<div class="acc-actions"><button class="btn ghost" id="btn-signout"><i class="fa-solid fa-right-from-bracket"></i> Sign out</button></div>'
      : '<div class="account-hero">' +
          '<div class="acc-avatar"><i class="fa-solid fa-user"></i></div>' +
          '<div><div class="acc-name">Signed out</div>' +
          '<div class="acc-email">Connect to browse your playlists</div></div></div>' +
          '<div class="acc-actions"><button class="btn primary" id="btn-oauth"><i class="fa-solid fa-arrow-right-to-bracket"></i> Sign in</button></div>';
    wireOnce(card, "#btn-oauth", function () { signInFlow(); });
    wireOnce(card, "#btn-signout", function () { auth.signOut().then(renderAccount); });
    els.playlistTabs.classList.toggle("hidden", !signedIn);
    if (signedIn) { loadPlaylistTab("playlists"); }
    else { els.playlistGrid.innerHTML = ""; }
  });
}

function signInFlow() {
  toast("Opening Google sign-in in your browser…", "info");
  auth.signIn().then(function (result) {
    if (result && result.ok) { toast("Signed in ✓", "ok"); }
    else { toast("Sign-in failed: " + ((result && result.error) || "unknown error"), "err"); }
    renderAccount();
  });
}

function openCredentialsHelp() {
  if (csbridge.isCEP()) {
    csbridge.openExternalUrl("https://github.com/mediaotter/mediaotter/blob/main/docs/CREDENTIALS.md");
  } else {
    toast("See docs/CREDENTIALS.md in the repo.", "info");
  }
}

function loadPlaylistTab(tab) {
  state.playlistMode = tab;
  document.querySelectorAll("[data-ptab]").forEach(function (button) {
    button.classList.toggle("active", button.dataset.ptab === tab);
  });
  els.playlistGrid.classList.remove("hidden");
  els.playlistItems.classList.add("hidden");
  els.btnPlaylistBack.classList.add("hidden");

  var promise = tab === "playlists" ? playlists.listMyPlaylists() : playlists.getLikedVideos();
  els.playlistGrid.innerHTML = '<div class="skeleton"></div>';
  promise.then(function (items) {
    if (!items || !items.length) {
      els.playlistGrid.innerHTML = '<div class="empty-state"><i class="fa-solid fa-list-ul"></i><p>' + (tab === "playlists" ? "No playlists found." : "No liked videos.") + "</p></div>";
      return;
    }
    els.playlistGrid.innerHTML = items.map(function (item) {
      var thumb = item.thumbnail || "";
      return '<div class="playlist-item-card" data-id="' + escapeHtml(item.id) + '">' +
        '<div class="thumb"><img src="' + escapeHtml(thumb) + '" alt="" /></div>' +
        '<div class="result-info"><div class="result-title">' + escapeHtml(item.title) + "</div>" +
        '<div class="result-sub"><span>' + (item.count ? item.count + " items" : "") + "</span></div></div></div>";
    }).join("");
    els.playlistGrid.querySelectorAll(".playlist-item-card").forEach(function (card) {
      card.addEventListener("click", function () {
        if (tab === "playlists") { openPlaylistById(card.dataset.id, null); }
        else { openLikedVideo(card.dataset.id); }
      });
    });
  }).catch(function (error) {
    els.playlistGrid.innerHTML = '<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>' + escapeHtml(error.message) + "</p></div>";
  });
}

function openLikedVideo(videoId) {
  var watchUrl = "https://www.youtube.com/watch?v=" + videoId;
  downloader.resolveMetadata(watchUrl, {}).then(function (meta) {
    openPreviewById(videoId, "video", meta);
  }).catch(function (error) {
    toast("Could not load video: " + error.message, "err");
  });
}

function openPlaylistById(playlistId, item) {
  var playlistUrl = "https://www.youtube.com/playlist?list=" + playlistId;
  downloader.fetchPlaylistEntries(playlistUrl, {}).then(function (result) {
    state.playlistItems = result.entries || [];
    els.playlistGrid.classList.add("hidden");
    els.btnPlaylistBack.classList.remove("hidden");
    els.playlistItems.classList.remove("hidden");
    els.playlistItems.innerHTML = state.playlistItems.map(function (entry, index) {
      return '<div class="playlist-item-card" data-idx="' + index + '">' +
        '<div class="thumb"><img src="' + escapeHtml(entry.thumbnail || "") + '" alt="" /></div>' +
        '<div class="result-info"><div class="result-title">' + (index + 1) + ". " + escapeHtml(entry.title) + "</div>" +
        '<div class="result-sub"><span>' + escapeHtml(entry.channel || "") + "</span></div></div></div>";
    }).join("");
    els.playlistItems.querySelectorAll(".playlist-item-card").forEach(function (card) {
      card.addEventListener("click", function () {
        var entry = state.playlistItems[Number(card.dataset.idx)];
        downloader.resolveMetadata(entry.url).then(function (meta) {
          openPreviewById(entry.id, "video", meta);
        });
      });
    });
  }).catch(function (error) {
    toast("Could not open playlist: " + error.message, "err");
  });
}

var wiredCards = {};

function wireOnce(container, selector, handler) {
  var button = container.querySelector(selector);
  if (!button) { return; }
  if (wiredCards[selector]) { return; }
  wiredCards[selector] = true;
  button.addEventListener("click", handler);
}

// ─── settings ──────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelectorAll(".seg-btn[data-theme]").forEach(function (button) {
    button.classList.toggle("active", button.dataset.theme === theme);
  });
}

function renderSettings() {
  var current = settings.read();
  els.setQuality.value = String(current.maxQualityHeight);
  els.setEncoding.checked = Boolean(current.allowEncoding);
  document.querySelectorAll(".seg-btn[data-loc]").forEach(function (button) {
    button.classList.toggle("active", button.dataset.loc === current.downloadLocation);
  });
  els.rowCustomPath.classList.toggle("hidden", current.downloadLocation !== "custom");
  els.setCustomPath.value = current.customPath || "";
  els.setCookies.value = current.cookiesBrowser || "";
  applyTheme(current.theme);
  els.setPause.checked = Boolean(current.pausePreviewWhenHidden);
  renderCookieStatus("");
  els.aboutText.textContent = "MediaOtter " + VERSION + " — search & download video/audio straight into Premiere Pro and After Effects. Powered by yt-dlp " + binaryManager.getRuntimeStatus().ytDlpVersion + ". Open source, free, no telemetry.";
}

function renderCookieStatus(message, kind) {
  els.cookieStatus.textContent = message || "";
  els.cookieStatus.className = "cookie-status" + (kind ? " " + kind : "");
}

function wireSettings() {
  els.setQuality.addEventListener("change", function () {
    settings.write({ maxQualityHeight: Number(els.setQuality.value) });
  });
  els.setEncoding.addEventListener("change", function () {
    settings.write({ allowEncoding: els.setEncoding.checked });
  });
  document.querySelectorAll(".seg-btn[data-loc]").forEach(function (button) {
    button.addEventListener("click", function () {
      document.querySelectorAll(".seg-btn[data-loc]").forEach(function (b) { b.classList.remove("active"); });
      button.classList.add("active");
      settings.write({ downloadLocation: button.dataset.loc });
      els.rowCustomPath.classList.toggle("hidden", button.dataset.loc !== "custom");
    });
  });
  document.querySelectorAll(".seg-btn[data-theme]").forEach(function (button) {
    button.addEventListener("click", function () {
      applyTheme(button.dataset.theme);
      settings.write({ theme: button.dataset.theme });
    });
  });
  els.btnBrowse.addEventListener("click", function () {
    if (csbridge.isCEP()) {
      csbridge.evalScript('(function(){ try { var folder = Folder.selectDialog("Choose download folder"); return folder ? folder.fsName : ""; } catch (e) { return ""; } })();').then(function (result) {
        if (result.ok && result.value) {
          els.setCustomPath.value = result.value;
          settings.write({ customPath: result.value });
          toast("Download folder set", "ok");
        }
      });
    } else {
      toast("Folder picking works inside Premiere/AE.", "info");
    }
  });
  els.setCustomPath.addEventListener("change", function () {
    settings.write({ customPath: els.setCustomPath.value.trim() });
  });
  els.setCookies.addEventListener("change", function () {
    var browser = els.setCookies.value;
    settings.write({ cookiesBrowser: browser });
    if (!browser) { renderCookieStatus("YouTube browser session off."); return; }
    renderCookieStatus("Testing " + browser + " cookies…", "");
    cookieJar.probeBrowser(browser).then(function (result) {
      if (result.ok) { renderCookieStatus("✓ " + browser + " session ready — private & age-restricted downloads enabled.", "ok"); }
      else { renderCookieStatus(result.error || "Could not read cookies.", "err"); }
    });
  });
  els.setPause.addEventListener("change", function () {
    settings.write({ pausePreviewWhenHidden: els.setPause.checked });
  });
  els.btnCheckUpdates.addEventListener("click", function () {
    els.btnCheckUpdates.disabled = true;
    binaryManager.checkForUpdates().then(function (result) {
      els.btnCheckUpdates.disabled = false;
      if (result.updated) { toast("yt-dlp updated to " + result.version + " ✓", "ok"); renderSettings(); }
      else { toast("yt-dlp is up to date (" + result.version + ")", "info"); }
    }).catch(function (error) {
      els.btnCheckUpdates.disabled = false;
      toast("Update check failed: " + error.message, "err");
    });
  });
  els.btnOpenRepo.addEventListener("click", function () {
    if (csbridge.isCEP()) { csbridge.openExternalUrl(REPO_URL); }
  });
}

// ─── engine events ─────────────────────────────────────────

function bindEngineEvents() {
  downloader.on("download:start", function (record) {
    state.activeDownloads[record.id] = record;
    renderActiveDownloads();
  });
  downloader.on("download:progress", function (record) {
    state.activeDownloads[record.id] = record;
    if (state.screen === "downloads") { renderActiveDownloads(); }
    else { updateDownloadMini(record); }
  });
  downloader.on("download:complete", function (record) {
    state.activeDownloads[record.id] = record;
    history.add({
      title: record.title || "",
      kind: record.kind || "video",
      url: record.url || "",
      filePath: record.finalPath || "",
      size: record.finalSize || record.downloadedBytes || 0,
      thumbnail: (record.meta && record.meta.thumbnail) || ""
    });
    renderActiveDownloads();
    renderHistory();
    if (csbridge.isCEP()) {
      csbridge.importIntoHost(record.finalPath, { addToTimeline: false }).then(function (result) {
        if (!result.ok) { toast("Downloaded ✓ — import failed: " + result.error, "err"); }
      });
    }
  });
  downloader.on("download:error", function (record) {
    state.activeDownloads[record.id] = record;
    renderActiveDownloads();
    toast(record.error || "Download failed.", "err");
  });
  downloader.on("download:cancelled", function (record) {
    state.activeDownloads[record.id] = record;
    renderActiveDownloads();
  });
}

function updateDownloadMini(record) {
  var badge = els.btnHistory;
  if (record.stage === "running" || record.stage === "merging") {
    badge.classList.add("downloading");
  }
}

// ─── boot ──────────────────────────────────────────────────

function bindNavigation() {
  els.btnHistory.addEventListener("click", function () { showScreen("downloads"); });
  els.btnSettings.addEventListener("click", function () { showScreen("settings"); });
  document.querySelectorAll(".pill[data-tab]").forEach(function (pill) {
    pill.addEventListener("click", function () {
      document.querySelectorAll(".pill[data-tab]").forEach(function (p) { p.classList.toggle("active", p === pill); });
      els.searchForm.classList.toggle("hidden", pill.dataset.tab !== "search");
      els.pasteForm.classList.toggle("hidden", pill.dataset.tab !== "paste");
    });
  });
  document.querySelectorAll(".filter-chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      document.querySelectorAll(".filter-chip").forEach(function (c) { c.classList.toggle("active", c === chip); });
      state.searchFilter = chip.dataset.filter;
    });
  });
  els.pasteGo.addEventListener("click", fetchPasted);
  els.pasteInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") { fetchPasted(); }
  });
  els.btnMore.addEventListener("click", loadMore);
  els.btnClearHistory.addEventListener("click", function () {
    history.clear();
    renderHistory();
    toast("History cleared", "info");
  });
  els.previewBack.addEventListener("click", function () {
    els.preview.classList.add("hidden");
    els.previewFrame.src = "about:blank";
  });
  els.btnClearRange.addEventListener("click", function () {
    els.rangeStart.value = "";
    els.rangeEnd.value = "";
  });
  document.querySelectorAll("[data-ptab]").forEach(function (button) {
    button.addEventListener("click", function () { loadPlaylistTab(button.dataset.ptab); });
  });
  els.btnPlaylistBack.addEventListener("click", function () {
    els.playlistItems.classList.add("hidden");
    els.playlistGrid.classList.remove("hidden");
    els.btnPlaylistBack.classList.add("hidden");
  });
}

function init() {
  els = {
    toasts: $("toasts"),
    screenSearch: $("screen-search"),
    screenDownloads: $("screen-downloads"),
    screenPlaylists: $("screen-playlists"),
    screenSettings: $("screen-settings"),
    btnHistory: $("btn-history"),
    btnSettings: $("btn-settings"),
    searchInput: $("search-input"),
    searchClear: $("search-clear"),
    suggestBox: $("suggest-box"),
    searchForm: $("search-form"),
    pasteForm: $("paste-form"),
    pasteInput: $("paste-input"),
    pasteGo: $("paste-go"),
    results: $("results"),
    resultsMore: $("results-more"),
    resultsStatus: $("results-status"),
    btnMore: $("btn-more"),
    activeDownloads: $("active-downloads"),
    downloadsEmpty: $("downloads-empty"),
    historyList: $("history-list"),
    btnClearHistory: $("btn-clear-history"),
    accountCard: $("account-card"),
    playlistTabs: $("playlist-tabs"),
    playlistGrid: $("playlist-grid"),
    playlistItems: $("playlist-items"),
    btnPlaylistBack: $("btn-playlist-back"),
    preview: $("preview"),
    previewBack: $("preview-back"),
    previewOpen: $("preview-open"),
    previewFrame: $("preview-frame"),
    previewTitle: $("preview-title"),
    previewChannel: $("preview-channel"),
    previewStats: $("preview-stats"),
    previewAvatar: $("preview-avatar"),
    previewDesc: $("preview-desc"),
    previewActions: $("preview-actions"),
    rangeStart: $("range-start"),
    rangeEnd: $("range-end"),
    btnClearRange: $("btn-clear-range"),
    setQuality: $("set-quality"),
    setEncoding: $("set-encoding"),
    setCustomPath: $("set-custom-path"),
    rowCustomPath: $("row-custom-path"),
    btnBrowse: $("btn-browse"),
    setCookies: $("set-cookies"),
    cookieStatus: $("cookie-status"),
    setPause: $("set-pause"),
    aboutText: $("about-text"),
    btnCheckUpdates: $("btn-check-updates"),
    btnOpenRepo: $("btn-open-repo")
  };

  var siteCount = $("site-count");
  if (siteCount) { siteCount.textContent = "1000+"; }

  wireSearch();
  wireSettings();
  bindNavigation();
  bindEngineEvents();
  renderSettings();
  renderHistory();

  var host = csbridge.isCEP() ? csbridge.getHostName() : "dev";
  var hostVersion = csbridge.isCEP() ? csbridge.getHostVersion() : "";
  logger.info("MediaOtter " + VERSION + " started in " + host + " " + hostVersion);

  if (csbridge.isCEP()) {
    csbridge.ensureHostScript().then(function (result) {
      if (!result.ok) { logger.warn("hostscript load failed: " + result.error); }
    });
  }
  if (settings.read().autoCheckUpdates) {
    binaryManager.autoCheckForUpdates().then(function (result) {
      if (result && result.updated) { toast("yt-dlp updated to " + result.version + " ✓", "ok"); }
    }).catch(function () { /* background check must never crash the panel */ });
  }
}

document.addEventListener("DOMContentLoaded", init);
