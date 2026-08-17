"use strict";

/**
 * MediaOtter — YouTube Data API helpers (playlists, liked videos).
 * Requires a valid OAuth token from auth.js.
 */

var https = require("https");
var querystring = require("querystring");
var util = require("./util.js");
var auth = require("./auth.js");

var BASE_URL = "https://www.googleapis.com/youtube/v3";

// Resolve a thumbnail from snippet.thumbnails
function pickThumbnail(thumbnails) {
  if (!thumbnails || typeof thumbnails !== "object") {
    return "";
  }
  if (thumbnails.medium && thumbnails.medium.url) {
    return thumbnails.medium.url;
  }
  if (thumbnails.high && thumbnails.high.url) {
    return thumbnails.high.url;
  }
  if (thumbnails.default && thumbnails.default.url) {
    return thumbnails.default.url;
  }
  // Fallback to any available
  var keys = Object.keys(thumbnails);
  for (var i = 0; i < keys.length; i += 1) {
    var t = thumbnails[keys[i]];
    if (t && t.url) { return t.url; }
  }
  return "";
}

// Perform a YouTube API GET with Bearer token and timeout
function apiGet(url, token) {
  if (util && typeof util.httpGet === "function") {
    return util.httpGet(url, {
      json: true,
      timeoutMs: 15000,
      headers: { Authorization: "Bearer " + token }
    }).then(function (result) {
      // Normalize to { data, statusCode }
      if (result && result.data !== undefined) {
        return { data: result.data, statusCode: result.statusCode || 200 };
      }
      return { data: result, statusCode: 200 };
    });
  }
  // Fallback to raw https
  return new Promise(function (resolve, reject) {
    var parsed = new URL(url);
    var options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        "User-Agent": "MediaOtter/CEP"
      }
    };
    var req = https.request(options, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        var text = Buffer.concat(chunks).toString("utf8");
        var data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        if (res.statusCode === 200) {
          resolve({ data: data, statusCode: res.statusCode });
        } else {
          var err = new Error("Request failed with HTTP " + res.statusCode);
          err.statusCode = res.statusCode;
          err.data = data;
          reject(err);
        }
      });
    });
    req.on("error", function (e) { reject(e); });
    req.setTimeout(15000, function () { req.destroy(new Error("Request timed out")); });
    req.end();
  });
}

// Ensure we have a token or throw the required error
async function requireToken() {
  var token = await auth.getAccessToken();
  if (!token) {
    throw new Error("Sign in to browse your YouTube");
  }
  return token;
}

// Generic paginated fetch helper
async function paginatedGet(baseParams, endpoint, mapItem) {
  var token = await requireToken();
  var all = [];
  var pageToken = "";
  var pages = 0;
  var retried = false;

  while (pages < 3) {
    var params = {};
    var k;
    for (k in baseParams) { if (Object.prototype.hasOwnProperty.call(baseParams, k)) { params[k] = baseParams[k]; } }
    if (pageToken) { params.pageToken = pageToken; }
    var url = BASE_URL + endpoint + "?" + querystring.stringify(params);

    var result;
    try {
      result = await apiGet(url, token);
    } catch (error) {
      var code = error && error.statusCode;
      // Try to extract code from message if not set
      if (!code && error && error.message && error.message.indexOf("401") !== -1) { code = 401; }
      if (code === 401 && !retried) {
        retried = true;
        var newToken = await auth.getAccessToken();
        if (!newToken) {
          throw new Error("Sign in to browse your YouTube");
        }
        token = newToken;
        try {
          result = await apiGet(url, token);
        } catch (e2) {
          throw new Error(e2.message || "YouTube request failed");
        }
      } else {
        throw new Error(error.message || "YouTube request failed");
      }
    }

    var data = result && result.data ? result.data : {};
    var items = data.items || [];
    for (var i = 0; i < items.length; i += 1) {
      var mapped = mapItem(items[i]);
      if (mapped) {
        all.push(mapped);
        if (all.length >= 150) { break; }
      }
    }
    if (all.length >= 150) { break; }
    pageToken = data.nextPageToken || "";
    pages += 1;
    if (!pageToken) { break; }
  }

  if (all.length > 150) { all = all.slice(0, 150); }
  return all;
}

// List the signed-in user's playlists
async function listMyPlaylists() {
  return paginatedGet(
    { part: "snippet,contentDetails", mine: "true", maxResults: "50" },
    "/playlists",
    function (item) {
      var id = item.id || "";
      var snippet = item.snippet || {};
      var title = snippet.title || "";
      var thumbnail = pickThumbnail(snippet.thumbnails);
      var count = 0;
      if (item.contentDetails && typeof item.contentDetails.itemCount === "number") {
        count = item.contentDetails.itemCount;
      } else if (item.contentDetails && item.contentDetails.itemCount) {
        count = parseInt(item.contentDetails.itemCount, 10) || 0;
      }
      return { id: id, title: String(title), thumbnail: String(thumbnail), count: count };
    }
  );
}

// List liked videos
async function getLikedVideos() {
  return paginatedGet(
    { part: "snippet", myRating: "like", maxResults: "50" },
    "/videos",
    function (item) {
      var id = item.id || "";
      // For videos, item.id is the video id
      if (!id && item.snippet && item.snippet.resourceId && item.snippet.resourceId.videoId) {
        id = item.snippet.resourceId.videoId;
      }
      if (!id) { return null; }
      var snippet = item.snippet || {};
      var title = snippet.title || "";
      var thumbnail = pickThumbnail(snippet.thumbnails);
      var url = "https://www.youtube.com/watch?v=" + id;
      return { id: String(id), title: String(title), thumbnail: String(thumbnail), url: url };
    }
  );
}

// List items in a playlist
async function getPlaylistItems(playlistId) {
  if (!playlistId) {
    throw new Error("Missing playlistId");
  }
  return paginatedGet(
    { part: "snippet", maxResults: "50", playlistId: String(playlistId) },
    "/playlistItems",
    function (item) {
      var snippet = item.snippet || {};
      var videoId = "";
      if (snippet.resourceId && snippet.resourceId.videoId) {
        videoId = snippet.resourceId.videoId;
      }
      if (!videoId) { return null; }
      var title = snippet.title || "";
      var thumbnail = pickThumbnail(snippet.thumbnails);
      var url = "https://www.youtube.com/watch?v=" + videoId;
      return { id: String(videoId), title: String(title), thumbnail: String(thumbnail), url: url };
    }
  );
}

module.exports = {
  listMyPlaylists: listMyPlaylists,
  getLikedVideos: getLikedVideos,
  getPlaylistItems: getPlaylistItems
};
