"use strict";

/**
 * MediaOtter — download history (local only).
 */

var fs = require("fs");
var path = require("path");
var util = require("./util.js");
var settings = require("./settings.js");

var HISTORY_PATH = "";

function getHistoryPath() {
  if (!HISTORY_PATH) {
    HISTORY_PATH = path.join(util.getStateDir(), "history.json");
  }
  return HISTORY_PATH;
}

function read() {
  var entries = [];
  try {
    var data = JSON.parse(fs.readFileSync(getHistoryPath(), "utf8"));
    if (Array.isArray(data)) {
      entries = data;
    }
  } catch (error) {
    entries = [];
  }
  return entries;
}

function persist(entries) {
  var limit = settings.read().historyLimit || 200;
  var trimmed = entries.slice(0, limit);
  try {
    fs.mkdirSync(path.dirname(getHistoryPath()), { recursive: true });
    fs.writeFileSync(getHistoryPath(), JSON.stringify(trimmed, null, 2) + "\n", { mode: 384 });
  } catch (error) {
    /* ignore */
  }
  return trimmed;
}

function add(entry) {
  var entries = read();
  var record = Object.assign({
    id: String(Date.now()) + "_" + Math.floor(Math.random() * 100000),
    completedAt: new Date().toISOString()
  }, entry);
  entries.unshift(record);
  return persist(entries);
}

function remove(id) {
  return persist(read().filter(function (entry) { return entry.id !== id; }));
}

function clear() {
  return persist([]);
}

function findByPath(filePath) {
  return read().filter(function (entry) { return entry.filePath === filePath; });
}

module.exports = {
  read: read,
  add: add,
  remove: remove,
  clear: clear,
  findByPath: findByPath
};
