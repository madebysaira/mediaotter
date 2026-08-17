"use strict";

/**
 * MediaOtter — host bridge (CSInterface ↔ ExtendScript).
 * Talks to hostscript.jsx in both Premiere Pro and After Effects.
 * Safe to load outside CEP (dev/test mode): every call degrades gracefully.
 */

var csInterface = null;
var hostScriptLoaded = false;

function init() {
  if (typeof window !== "undefined" && window.__adobe_cep__) {
    try {
      csInterface = new CSInterface();
    } catch (error) {
      csInterface = null;
    }
  }
}

function isCEP() {
  return Boolean(csInterface) && typeof window !== "undefined" && Boolean(window.__adobe_cep__);
}

function getHostName() {
  try {
    return csInterface.getHostEnvironment().appName || "";
  } catch (error) {
    return "";
  }
}

function getHostVersion() {
  try {
    return csInterface.getHostEnvironment().appVersion || "";
  } catch (error) {
    return "";
  }
}

/** Promise wrapper around evalScript; resolves {ok, value} | {ok:false, error}. */
function evalScript(script) {
  return new Promise(function (resolve) {
    if (!isCEP()) {
      resolve({ ok: false, error: "Not in a host app (dev mode)" });
      return;
    }
    var done = false;
    var timer = setTimeout(function () {
      if (!done) {
        done = true;
        resolve({ ok: false, error: "Host script timed out" });
      }
    }, 15000);
    try {
      csInterface.evalScript(script, function (value) {
        if (done) { return; }
        done = true;
        clearTimeout(timer);
        resolve({ ok: true, value: value == null ? "" : String(value) });
      });
    } catch (error) {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, error: error.message || String(error) });
      }
    }
  });
}

/** Evaluate extension/jsx/hostscript.jsx once; call before using mediaotter.* functions. */
function ensureHostScript() {
  if (hostScriptLoaded) { return Promise.resolve({ ok: true }); }
  var extensionPath = "";
  try {
    extensionPath = csInterface.getSystemPath(SystemPath.EXTENSION) || "";
  } catch (error) {
    /* keep empty */
  }
  var scriptPath = (extensionPath || ".") + "/jsx/hostscript.jsx";
  var script = "$.evalFile(\"" + scriptPath.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\");";
  return evalScript(script).then(function (result) {
    if (result.ok) {
      hostScriptLoaded = true;
      return { ok: true };
    }
    return { ok: false, error: result.error || "Host script not loaded" };
  });
}

/** @returns Promise<{ok, path}> — project folder when inside a host, "" otherwise. */
function resolveDownloadRoot() {
  return ensureHostScript().then(function (loaded) {
    if (!loaded.ok) { return { ok: false, error: loaded.error }; }
    return evalScript("mediaotter.getProjectFolder()").then(function (result) {
      return { ok: result.ok, path: result.ok ? (result.value || "") : "", error: result.error };
    });
  });
}

/**
 * Import a downloaded file into the host project.
 * @param {string} filePath absolute path
 * @param {{addToTimeline?: boolean, addToComp?: boolean}} options
 */
function importIntoHost(filePath, options) {
  var payload = {
    filePath: filePath,
    binName: "MediaOtter",
    addToTimeline: Boolean(options && options.addToTimeline),
    addToComp: Boolean(options && options.addToComp)
  };
  var jsonStr = JSON.stringify(payload);
  return ensureHostScript().then(function (loaded) {
    if (!loaded.ok) { return { ok: false, error: loaded.error }; }
    return evalScript("mediaotter.importFile(" + JSON.stringify(jsonStr) + ")").then(function (result) {
      if (!result.ok) { return { ok: false, error: result.error }; }
      try {
        var parsed = JSON.parse(result.value);
        return parsed && parsed.ok ? parsed : { ok: false, error: (parsed && parsed.error) || "Import failed" };
      } catch (error) {
        return { ok: false, error: "Host returned unparseable result" };
      }
    });
  });
}

function revealInFinder(filePath) {
  return ensureHostScript().then(function (loaded) {
    if (!loaded.ok) { return; }
    return evalScript("mediaotter.revealInFinder(" + JSON.stringify(filePath) + ")");
  });
}

function openExternalUrl(url) {
  return ensureHostScript().then(function (loaded) {
    if (!loaded.ok) { return; }
    return evalScript("mediaotter.openUrl(" + JSON.stringify(url) + ")");
  });
}

init();

module.exports = {
  isCEP: isCEP,
  getHostName: getHostName,
  getHostVersion: getHostVersion,
  evalScript: evalScript,
  ensureHostScript: ensureHostScript,
  resolveDownloadRoot: resolveDownloadRoot,
  importIntoHost: importIntoHost,
  revealInFinder: revealInFinder,
  openExternalUrl: openExternalUrl
};
