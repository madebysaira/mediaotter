"use strict";

/**
 * MediaOtter — Google OAuth (PKCE) + token storage.
 * Runs in CEP 10 (Node 12.14) and plain Node. ES2017 only.
 * Security: no token logging, refresh token only in <stateDir>/auth.json (0600), no client secret.
 */

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var http = require("http");
var https = require("https");
var childProcess = require("child_process");
var querystring = require("querystring");
var util = require("./util.js");

var CREDENTIALS_PATH = path.join(__dirname, "credentials.json");
var REDIRECT_URI = "http://127.0.0.1:8787/";
var TOKEN_URL = "https://oauth2.googleapis.com/token";
var USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
var AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
var SCOPES = "openid email profile https://www.googleapis.com/auth/youtube.readonly";

var PKCE_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

// Track last getAccessToken call to support forced refresh on quick retry (401 handling)
var lastTokenCallTime = 0;
var lastReturnedToken = null;

// Return path to auth.json (computed dynamically so mocked getStateDir works)
function getAuthPath() {
  return path.join(util.getStateDir(), "auth.json");
}

// Check if a value is a placeholder like REPLACE_WITH...
function isPlaceholder(value) {
  return typeof value === "string" && value.indexOf("REPLACE_WITH") !== -1;
}

// Read credentials.json, return {clientId, apiKey} or null
function getCredentials() {
  try {
    var raw = fs.readFileSync(CREDENTIALS_PATH, "utf8");
    var data = JSON.parse(raw);
    var clientId = data && data.clientId ? String(data.clientId).trim() : "";
    var apiKey = data && data.apiKey ? String(data.apiKey).trim() : "";
    if (!clientId || !apiKey) {
      return null;
    }
    if (isPlaceholder(clientId) || isPlaceholder(apiKey)) {
      return null;
    }
    return { clientId: clientId, apiKey: apiKey };
  } catch (error) {
    return null;
  }
}

// Read auth.json, return token set or null
function readAuth() {
  // Prefer util.readJson if available, else fallback
  if (util && typeof util.readJson === "function") {
    try {
      var fromUtil = util.readJson(getAuthPath());
      if (fromUtil && typeof fromUtil === "object") {
        return fromUtil;
      }
    } catch (error) {
      // fallback to direct read
    }
  }
  try {
    var text = fs.readFileSync(getAuthPath(), "utf8");
    var parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
    return null;
  } catch (error) {
    return null;
  }
}

// Persist token set with mode 0600
function writeAuth(data) {
  var filePath = getAuthPath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (error) {
    // ignore
  }
  // Prefer util.writeJson if available but ensure 0600
  if (util && typeof util.writeJson === "function") {
    try {
      util.writeJson(filePath, data);
      try { fs.chmodSync(filePath, 0o600); } catch (e) {}
      return;
    } catch (error) {
      // fallback
    }
  }
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch (e) {}
  } catch (error) {
    // persistence must not throw
  }
}

// Delete auth.json
function deleteAuth() {
  var filePath = getAuthPath();
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    // ignore if missing
  }
}

// Base64url encode a buffer
function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// Generate random string from PKCE charset
function randomString(length) {
  var bytes = crypto.randomBytes(length);
  var result = "";
  for (var i = 0; i < length; i += 1) {
    result += PKCE_CHARSET[bytes[i] % PKCE_CHARSET.length];
  }
  return result;
}

// POST form-encoded to token endpoint, with timeout
function postForm(urlStr, form, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var body = querystring.stringify(form);
    var parsed = new URL(urlStr);
    var options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + (parsed.search || ""),
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        "Accept": "application/json"
      }
    };
    var req = https.request(options, function (res) {
      var chunks = [];
      res.on("data", function (chunk) { chunks.push(chunk); });
      res.on("end", function () {
        var text = Buffer.concat(chunks).toString("utf8");
        var data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, data: data, text: text });
        } else {
          var err = new Error("Token request failed with HTTP " + res.statusCode);
          err.statusCode = res.statusCode;
          err.data = data;
          err.text = text;
          reject(err);
        }
      });
    });
    req.on("error", function (err) { reject(err); });
    req.setTimeout(timeoutMs || 10000, function () {
      req.destroy(new Error("Request timed out"));
    });
    req.write(body);
    req.end();
  });
}

// Fetch userinfo via https or util.httpGet, with timeout
function fetchUserInfoRequest(token, timeoutMs) {
  // Prefer util.httpGet when available
  if (util && typeof util.httpGet === "function") {
    return util.httpGet(USERINFO_URL, {
      json: true,
      timeoutMs: timeoutMs || 10000,
      headers: { Authorization: "Bearer " + token }
    }).then(function (result) {
      // util.httpGet resolves with { data, statusCode } on json:true
      if (result && result.data) {
        return { data: result.data, statusCode: result.statusCode || 200 };
      }
      // fallback shape
      return { data: result, statusCode: 200 };
    });
  }
  // Fallback to raw https
  return new Promise(function (resolve, reject) {
    var parsed = new URL(USERINFO_URL);
    var options = {
      hostname: parsed.hostname,
      path: parsed.pathname,
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
          var err = new Error("Userinfo failed with HTTP " + res.statusCode);
          err.statusCode = res.statusCode;
          err.data = data;
          reject(err);
        }
      });
    });
    req.on("error", function (e) { reject(e); });
    req.setTimeout(timeoutMs || 10000, function () { req.destroy(new Error("Request timed out")); });
    req.end();
  });
}

// Open URL in system browser detached
function openBrowser(url) {
  var plat = process.platform;
  var cmd;
  if (plat === "darwin") {
    cmd = 'open "' + url.replace(/"/g, '\\"') + '"';
  } else if (plat === "win32") {
    cmd = 'cmd.exe /c start "" "' + url.replace(/"/g, '\\"') + '"';
  } else {
    cmd = 'xdg-open "' + url.replace(/"/g, '\\"') + '"';
  }
  try {
    childProcess.exec(cmd, function () {});
  } catch (error) {
    // ignore — browser open is best-effort
  }
}

// Wait for OAuth redirect on 127.0.0.1:8787
function waitForCode(expectedState, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var server = null;
    var timer = null;
    var finished = false;

    function cleanup() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (server) {
        try { server.close(); } catch (e) {}
        server = null;
      }
    }

    server = http.createServer(function (req, res) {
      try {
        // Use url parse for Node 12 compatibility
        var urlModule = require("url");
        var parsed = urlModule.parse(req.url, true);
        var pathname = parsed.pathname || "/";
        var query = parsed.query || {};
        if (pathname !== "/" && pathname !== "") {
          res.writeHead(404, { "Content-Type": "text/html" });
          res.end("Not found");
          return;
        }
        if (query.error) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end('<html><body><h1>Sign-in failed</h1><p>' + String(query.error).replace(/</g, "&lt;") + '</p></body></html>');
          if (!finished) {
            finished = true;
            cleanup();
            reject(new Error(String(query.error)));
          }
          return;
        }
        var code = query.code;
        var state = query.state;
        if (code && state === expectedState) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end('<html><head><title>MediaOtter</title></head><body><h1>Signed in to MediaOtter \u2014 you can close this window</h1><script>window.close();setTimeout(function(){window.location="about:blank"},1000)</script></body></html>');
          if (!finished) {
            finished = true;
            cleanup();
            resolve(String(code));
          }
          return;
        }
        if (code && state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end('<html><body><h1>State mismatch</h1></body></html>');
          return;
        }
        // No code yet
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end('<html><body><h1>Waiting for sign-in...</h1></body></html>');
      } catch (e) {
        try { res.writeHead(500); res.end("Error"); } catch (ee) {}
      }
    });

    server.on("error", function (err) {
      if (!finished) {
        finished = true;
        cleanup();
        reject(err);
      }
    });

    server.listen(8787, "127.0.0.1", function () {});

    timer = setTimeout(function () {
      if (!finished) {
        finished = true;
        cleanup();
        reject(new Error("Sign-in timed out"));
      }
    }, timeoutMs || 60000);
  });
}

// True when credentials.json has real clientId and apiKey
function isConfigured() {
  var creds = getCredentials();
  return Boolean(creds && creds.clientId && creds.apiKey);
}

// True when an unexpired-usable token set exists; refresh lazily at next API call
function isSignedIn() {
  var data = readAuth();
  if (!data || !data.accessToken) {
    return false;
  }
  // If expiry is in the future, definitely signed in
  if (data.expiryMs && data.expiryMs > Date.now()) {
    return true;
  }
  // If we have a refresh token, we can refresh lazily
  if (data.refreshToken) {
    return true;
  }
  // No refresh token and expiry missing or past -> not signed in
  return false;
}

// Fetch user info with Bearer token; on 401 refresh once and retry; on failure resolve null
async function getUserInfo() {
  try {
    var token = await getAccessToken();
    if (!token) {
      return null;
    }
    var result;
    try {
      result = await fetchUserInfoRequest(token, 10000);
    } catch (error) {
      // On 401 try refresh once and retry
      var code = error && error.statusCode;
      if (code === 401) {
        // Force a refresh by calling internal refresh helper, then retry
        try {
          var refreshed = await refreshFor401(token);
          if (refreshed) {
            token = refreshed;
            result = await fetchUserInfoRequest(token, 10000);
          } else {
            return null;
          }
        } catch (e2) {
          return null;
        }
      } else {
        return null;
      }
    }
    var data = result && result.data ? result.data : result;
    if (!data || typeof data !== "object") {
      return null;
    }
    var name = data.name || "";
    var email = data.email || "";
    var avatarUrl = data.picture || data.avatarUrl || "";
    // Some google responses use different fields
    if (!avatarUrl && data.picture) { avatarUrl = data.picture; }
    return { name: String(name), email: String(email), avatarUrl: String(avatarUrl) };
  } catch (error) {
    return null;
  }
}

// Internal helper to force refresh on 401 (used by getUserInfo)
async function refreshFor401(oldToken) {
  var creds = getCredentials();
  var data = readAuth();
  if (!creds || !data || !data.refreshToken) {
    return null;
  }
  try {
    var form = {
      grant_type: "refresh_token",
      refresh_token: data.refreshToken,
      client_id: creds.clientId
    };
    var res = await postForm(TOKEN_URL, form, 10000);
    var body = res.data;
    if (!body || !body.access_token) { return null; }
    var expiryMs = Date.now() + (parseInt(body.expires_in, 10) || 3600) * 1000 - 60000;
    var next = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || data.refreshToken,
      expiryMs: expiryMs
    };
    writeAuth(next);
    // Update tracking so next getAccessToken returns new token
    lastReturnedToken = next.accessToken;
    lastTokenCallTime = Date.now();
    return next.accessToken;
  } catch (error) {
    var c = error && error.statusCode;
    if (c === 400 || c === 401) {
      deleteAuth();
    }
    return null;
  }
}

// Start PKCE sign-in flow
async function signIn() {
  try {
    var creds = getCredentials();
    if (!creds) {
      return { ok: false, error: "Set up your Google credentials first (docs/CREDENTIALS.md)" };
    }
    var verifier = randomString(64);
    var challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
    var state = randomString(32);

    var authorizeUrl = AUTH_BASE +
      "?client_id=" + encodeURIComponent(creds.clientId) +
      "&redirect_uri=" + encodeURIComponent(REDIRECT_URI) +
      "&response_type=code" +
      "&scope=" + encodeURIComponent(SCOPES) +
      "&access_type=offline" +
      "&prompt=consent" +
      "&code_challenge=" + encodeURIComponent(challenge) +
      "&code_challenge_method=S256" +
      "&state=" + encodeURIComponent(state);

    openBrowser(authorizeUrl);

    var code;
    try {
      code = await waitForCode(state, 60000);
    } catch (error) {
      var msg = error && error.message ? error.message : "Sign-in failed";
      if (msg === "access_denied") {
        msg = "Sign-in was cancelled";
      } else if (msg.indexOf("timed out") !== -1) {
        msg = "Sign-in timed out";
      }
      return { ok: false, error: msg };
    }

    var form = {
      grant_type: "authorization_code",
      code: code,
      redirect_uri: REDIRECT_URI,
      client_id: creds.clientId,
      code_verifier: verifier
    };

    var tokenRes;
    try {
      tokenRes = await postForm(TOKEN_URL, form, 15000);
    } catch (error) {
      var emsg = "Sign-in failed";
      if (error && error.statusCode === 400) {
        emsg = "Invalid authorization code";
      } else if (error && error.message && error.message.indexOf("timed out") !== -1) {
        emsg = "Sign-in timed out";
      }
      return { ok: false, error: emsg };
    }

    var body = tokenRes.data;
    if (!body || !body.access_token) {
      return { ok: false, error: "Invalid token response" };
    }

    var expiryMs = Date.now() + (parseInt(body.expires_in, 10) || 3600) * 1000 - 60000;
    var toStore = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || "",
      expiryMs: expiryMs
    };
    // If Google did not return refresh_token, keep existing one if any (rare on re-consent without prompt)
    if (!toStore.refreshToken) {
      var existing = readAuth();
      if (existing && existing.refreshToken) {
        toStore.refreshToken = existing.refreshToken;
      }
    }

    writeAuth(toStore);

    var info = null;
    try {
      info = await getUserInfo();
    } catch (e) {
      info = null;
    }
    return { ok: true, info: info };
  } catch (error) {
    // Never throw — redact any token material
    var m = error && error.message ? error.message : "Sign-in failed";
    return { ok: false, error: String(m) };
  }
}

// Delete auth.json; resolve true
async function signOut() {
  deleteAuth();
  // Reset tracking
  lastReturnedToken = null;
  lastTokenCallTime = 0;
  return true;
}

// Return a usable access token, refreshing when near expiry; on revoked delete and return null
async function getAccessToken() {
  var creds = getCredentials();
  if (!creds) {
    return null;
  }
  var data = readAuth();
  if (!data || !data.accessToken) {
    return null;
  }
  var now = Date.now();
  var isNearExpiry = !data.expiryMs || (data.expiryMs - now < 60 * 1000);
  var isForced = (now - lastTokenCallTime < 5000 && lastReturnedToken === data.accessToken);

  if (!isNearExpiry && !isForced) {
    lastTokenCallTime = now;
    lastReturnedToken = data.accessToken;
    return data.accessToken;
  }

  // Need to refresh if we have a refresh token
  if (!data.refreshToken) {
    // No refresh token — if not expired return current, else null
    if (data.expiryMs && data.expiryMs > now) {
      lastTokenCallTime = now;
      lastReturnedToken = data.accessToken;
      return data.accessToken;
    }
    return null;
  }

  try {
    var form = {
      grant_type: "refresh_token",
      refresh_token: data.refreshToken,
      client_id: creds.clientId
    };
    var res = await postForm(TOKEN_URL, form, 10000);
    var body = res.data;
    if (!body || !body.access_token) {
      return null;
    }
    var expiryMs = Date.now() + (parseInt(body.expires_in, 10) || 3600) * 1000 - 60000;
    var next = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || data.refreshToken,
      expiryMs: expiryMs
    };
    writeAuth(next);
    lastTokenCallTime = Date.now();
    lastReturnedToken = next.accessToken;
    return next.accessToken;
  } catch (error) {
    var code = error && error.statusCode;
    if (code === 400 || code === 401) {
      deleteAuth();
      lastReturnedToken = null;
      lastTokenCallTime = 0;
      return null;
    }
    // On network timeout or other transient, return existing token if still valid for a bit
    if (data.expiryMs && data.expiryMs > Date.now()) {
      lastTokenCallTime = now;
      lastReturnedToken = data.accessToken;
      return data.accessToken;
    }
    return null;
  }
}

module.exports = {
  isConfigured: isConfigured,
  isSignedIn: isSignedIn,
  getUserInfo: getUserInfo,
  signIn: signIn,
  signOut: signOut,
  getAccessToken: getAccessToken
};
