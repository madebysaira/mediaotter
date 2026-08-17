"use strict";

/**
 * MediaOtter — LIVE OAuth end-to-end test (paste-back flow).
 *
 * This script prints a Google authorization URL. The user opens it in their
 * browser, signs in and consents, and the browser lands on
 * http://127.0.0.1:8787/?code=...&state=... (nothing listens there, but the
 * address bar shows the full URL). The user pastes that URL back into stdin.
 *
 * The script validates state, exchanges the code (PKCE + client secret),
 * stores tokens in <stateDir>/auth.json (0600), then fetches the real
 * userinfo, playlists, liked videos via the YouTube Data API.
 *
 * Usage:  node scripts/live-auth.js            # full consent flow
 *         node scripts/live-auth.js --verify   # reuse stored tokens only
 */

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var https = require("https");
var querystring = require("querystring");
var readline = require("readline");

var VERIFY_ONLY = process.argv.slice(2).indexOf("--verify") !== -1;

var ROOT = path.resolve(__dirname, "..");
var auth = require(path.join(ROOT, "extension", "js", "auth.js"));
var playlists = require(path.join(ROOT, "extension", "js", "playlists.js"));
var util = require(path.join(ROOT, "extension", "js", "util.js"));

var REDIRECT_URI = "http://127.0.0.1:8787/";
var TOKEN_URL = "https://oauth2.googleapis.com/token";
var AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
var SCOPES = "openid email profile https://www.googleapis.com/auth/youtube.readonly";
var PKCE_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

function randomString(length) {
  var bytes = crypto.randomBytes(length);
  var result = "";
  for (var i = 0; i < length; i += 1) {
    result += PKCE_CHARSET[bytes[i] % PKCE_CHARSET.length];
  }
  return result;
}

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function postForm(urlStr, form) {
  return new Promise(function (resolve, reject) {
    var body = querystring.stringify(form);
    var parsed = new URL(urlStr);
    var req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + (parsed.search || ""),
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        "Accept": "application/json"
      }
    }, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        var text = Buffer.concat(chunks).toString("utf8");
        var data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, data: data });
        } else {
          reject(new Error("HTTP " + res.statusCode + " — " + text.slice(0, 300)));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, function () { req.destroy(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

async function main() {
  var credsPath = path.join(ROOT, "extension", "js", "credentials.json");
  var creds;
  try {
    creds = JSON.parse(fs.readFileSync(credsPath, "utf8"));
  } catch (error) {
    console.error("Cannot read " + credsPath + ". Add credentials first.");
    process.exit(1);
  }
  if (!creds || !creds.clientId || creds.clientId.indexOf("REPLACE_WITH") !== -1) {
    console.error("No real clientId in " + credsPath + ".");
    process.exit(1);
  }

  var stateDir = util.getStateDir();
  var authPath = path.join(stateDir, "auth.json");

  // --verify: no consent, just re-fetch with stored tokens.
  if (VERIFY_ONLY) {
    if (!fs.existsSync(authPath)) {
      console.error("No " + authPath + " — run the full flow first.");
      process.exit(1);
    }
    await verifyData();
    console.log("\nLIVE SIGN-IN VERIFIED ✓ (verify mode)");
    return;
  }

  var pendingPath = path.join(stateDir, "pending-oauth.json");

  // Resume an interrupted flow: the verifier must survive process restarts or the
  // authorization code becomes unexchangeable (PKCE).
  var verifier = null;
  var state = null;
  if (fs.existsSync(pendingPath)) {
    try {
      var pending = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
      verifier = pending.verifier || null;
      state = pending.state || null;
    } catch (e) { /* regenerate */ }
  }
  var resumed = Boolean(verifier && state);
  if (!resumed) {
    verifier = randomString(64);
    state = randomString(32);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(pendingPath, JSON.stringify({ verifier: verifier, state: state }, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(pendingPath, 0o600);
  }
  var challenge = base64url(crypto.createHash("sha256").update(verifier).digest());

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

  console.log("\n===============================================================");
  console.log("OPEN THIS URL IN YOUR BROWSER, SIGN IN, APPROVE, THEN");
  console.log("PASTE BACK THE FULL http://127.0.0.1:8787/... URL FROM THE");
  console.log("ADDRESS BAR:");
  if (resumed) {
    console.log("(resumed flow — same URL as before, paste the fresh redirect)");
  }
  console.log("===============================================================");
  console.log(authorizeUrl);
  console.log("===============================================================");

  var rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  var redirectUrl = process.argv[2] || await new Promise(function (resolve) {
    rl.question("\nPaste the redirect URL here: ", resolve);
  });
  rl.close();

  var parsed;
  try {
    parsed = new URL(redirectUrl);
  } catch (error) {
    console.error("That doesn't look like a URL. Expected http://127.0.0.1:8787/?code=...&state=...");
    process.exit(1);
  }
  var params = {};
  parsed.searchParams.forEach(function (value, key) { params[key] = value; });

  if (params.error) {
    console.error("Google returned error: " + params.error + (params.error_description ? " — " + params.error_description : ""));
    process.exit(1);
  }
  if (!params.code) {
    console.error("No ?code= parameter found in the pasted URL.");
    process.exit(1);
  }
  if (params.state !== state) {
    console.error("STATE MISMATCH — aborting (possible CSRF).");
    process.exit(1);
  }

  console.log("State validated ✓  — exchanging code for tokens…");

  var form = {
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: REDIRECT_URI,
    client_id: creds.clientId,
    client_secret: creds.clientSecret || "",
    code_verifier: verifier
  };
  var res;
  try {
    res = await postForm(TOKEN_URL, form);
  } catch (error) {
    console.error("Token exchange FAILED: " + error.message);
    process.exit(1);
  }
  var body = res.data;
  if (!body || !body.access_token) {
    console.error("No access_token in response.");
    process.exit(1);
  }

  var expiryMs = Date.now() + (parseInt(body.expires_in, 10) || 3600) * 1000 - 60000;
  var stateDir = util.getStateDir();
  var authPath = path.join(stateDir, "auth.json");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify({
    accessToken: body.access_token,
    refreshToken: body.refresh_token || "",
    expiryMs: expiryMs
  }, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(authPath, 0o600);
  try { fs.unlinkSync(pendingPath); } catch (e) { /* already gone */ }
  console.log("Tokens stored at " + authPath + " (0600, not signed in message will follow)");

  await verifyData();

  console.log("\n==================");
  console.log("LIVE SIGN-IN VERIFIED ✓ (refresh token: " + (body.refresh_token ? "YES" : "NO") + ")");
}

async function verifyData() {
  var info = await auth.getUserInfo();
  console.log("\n— userinfo —");
  console.log(info ? JSON.stringify({ name: info.name, email: info.email }, null, 2) : "(null)");

  var myLists = await playlists.listMyPlaylists();
  console.log("\n— playlists (" + (myLists ? myLists.length : 0) + ") —");
  if (myLists && myLists.length) {
    myLists.slice(0, 5).forEach(function (p) {
      console.log("  • " + JSON.stringify(p.title) + "  (" + p.count + " items)");
    });
  }

  var liked = await playlists.getLikedVideos();
  console.log("\n— liked videos (" + (liked ? liked.length : 0) + ") —");
  if (liked && liked.length) {
    liked.slice(0, 5).forEach(function (v) {
      console.log("  • " + v.title);
    });
  }
}

main().catch(function (error) {
  console.error("FATAL: " + error.message);
  process.exit(2);
});
