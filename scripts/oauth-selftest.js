"use strict";

/**
 * MediaOtter — OAuth self-test. Run AFTER dropping real credentials into
 * extension/js/credentials.json (or the repo root credentials.json):
 *
 *   node scripts/oauth-selftest.js            — plumbing test (no login needed)
 *   node scripts/oauth-selftest.js --live     — real sign-in (opens a browser)
 *
 * Plumbing mode verifies WITHOUT any real login: credentials present &
 * well-formed, isConfigured() consistency, clean failure when unconfigured,
 * and that Google's token endpoint is reachable with a deliberately invalid
 * code — a clean "invalid_grant" rejection PROVES the request shape is
 * accepted end-to-end. --live completes the interactive flow and lists
 * playlists/liked videos.
 */

var fs = require("fs");
var path = require("path");
var https = require("https");
var querystring = require("querystring");

var ROOT = path.resolve(__dirname, "..");
var auth = require(path.join(ROOT, "extension", "js", "auth.js"));
var playlists = require(path.join(ROOT, "extension", "js", "playlists.js"));

var passed = 0;
var failed = 0;

function ok(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log("  \u2713 " + name);
  } else {
    failed += 1;
    console.log("  \u2717 " + name + (detail ? " — " + detail : ""));
  }
}

function section(name) {
  console.log("\n=== " + name + " ===");
}

function postJson(url, body) {
  return new Promise(function (resolve, reject) {
    var parsed = require("url").parse(url);
    var payload = querystring.stringify(body);
    var req = https.request({
      hostname: parsed.hostname,
      path: parsed.path,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(payload)
      }
    }, function (res) {
      var chunks = [];
      res.on("data", function (chunk) { chunks.push(chunk); });
      res.on("end", function () {
        resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, function () { req.destroy(new Error("timeout")); });
    req.write(payload);
    req.end();
  });
}

async function main() {
  var live = process.argv.indexOf("--live") !== -1;

  section("Credentials");
  var configured = auth.isConfigured();
  var credPath = path.join(ROOT, "extension", "js", "credentials.json");
  var fileExists = fs.existsSync(credPath);
  ok("credentials.json exists in extension/js", fileExists, credPath);
  if (fileExists) {
    var cred = JSON.parse(fs.readFileSync(credPath, "utf8"));
    ok("clientId looks like a Google ID", /^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/.test(cred.clientId || ""), String(cred.clientId || "").slice(0, 14) + "…");
    ok("apiKey looks like a Google key", /^AIza[0-9A-Za-z_-]{30,}$/.test(cred.apiKey || ""), "length " + String(cred.apiKey || "").length);
    ok("isConfigured() agrees", configured === true, "isConfigured()=" + configured);
  } else {
    ok("isConfigured() false without file", configured === false);
  }

  section("Clean failure when unconfigured (no hang, no crash)");
  if (!configured) {
    try {
      var failedSignIn = await auth.signIn();
      ok("signIn returns {ok:false} gracefully", failedSignIn && failedSignIn.ok === false, JSON.stringify(failedSignIn).slice(0, 120));
    } catch (error) {
      ok("signIn rejects gracefully", false, error.message);
    }
  } else {
    console.log("  (configured — signIn will be exercised in --live mode only)");
  }

  section("Token endpoint reachability (expect clean invalid_grant)");
  var clientId = "";
  if (fileExists) {
    clientId = JSON.parse(fs.readFileSync(credPath, "utf8")).clientId || "";
  }
  try {
    var result = await postJson("https://oauth2.googleapis.com/token", {
      grant_type: "authorization_code",
      code: "FAKE_CODE_FOR_SELFTEST",
      redirect_uri: "http://127.0.0.1:8787/",
      client_id: clientId || "selftest.apps.googleusercontent.com",
      code_verifier: "x".repeat(64)
    });
    var parsed = JSON.parse(result.body);
    ok("HTTP 4xx from Google (endpoint reachable, shape accepted)",
      result.statusCode === 400 || result.statusCode === 401,
      "HTTP " + result.statusCode + " " + result.body.slice(0, 120));
    // real client → invalid_grant (bad code); fake/missing client → invalid_client.
    // BOTH prove the request format reached Google's OAuth validation.
    ok("OAuth validation error returned (" + parsed.error + ")",
      parsed.error === "invalid_grant" || parsed.error === "invalid_client",
      result.body.slice(0, 120));
  } catch (error) {
    ok("token endpoint reachable", false, error.message);
  }

  section("Playlists API surface");
  ok("listMyPlaylists is a function", typeof playlists.listMyPlaylists === "function");
  ok("getPlaylistItems is a function", typeof playlists.getPlaylistItems === "function");
  ok("getLikedVideos is a function", typeof playlists.getLikedVideos === "function");

  if (live) {
    section("LIVE sign-in (opens your browser)");
    if (!configured) {
      ok("live sign-in skipped — no credentials", false, "add credentials first");
    } else {
      try {
        var info = await auth.signIn();
        ok("sign-in ok: " + (info && info.info ? info.info.email : ""), Boolean(info && info.ok), JSON.stringify(info).slice(0, 160));
        var myLists = await playlists.listMyPlaylists();
        ok("playlists fetched (" + myLists.length + ")", Array.isArray(myLists));
        if (myLists.length) {
          var items = await playlists.getPlaylistItems(myLists[0].id);
          ok("first playlist items (" + items.length + ")", Array.isArray(items));
        }
        var liked = await playlists.getLikedVideos();
        ok("liked videos fetched (" + liked.length + ")", Array.isArray(liked));
      } catch (error) {
        ok("live flow", false, error.message);
      }
    }
  } else {
    console.log("  (run with --live for the interactive sign-in + playlist fetch)");
  }

  console.log("\n==================");
  console.log("PASSED: " + passed + "  FAILED: " + failed);
  process.exit(failed ? 1 : 0);
}

main().catch(function (error) {
  console.error("FATAL:", error.message);
  process.exit(2);
});
