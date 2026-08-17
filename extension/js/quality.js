"use strict";

/**
 * MediaOtter — format & compatibility planner.
 * Given yt-dlp -J metadata, plan the best download candidate per quality cap,
 * prioritizing Premiere/AE-friendly muxed MP4 (H.264/AAC), then video+audio merge,
 * then optional transcode. Mirrors Sidestream's selection philosophy.
 */

var util = require("./util.js");

var CODEC_PREFERENCE = ["h264", "avc1", "vp9", "av01", "hevc", "h265"];
var QUALITY_CAPS = [
  { label: "2160p", height: 2160 },
  { label: "1440p", height: 1440 },
  { label: "1080p", height: 1080 },
  { label: "720p", height: 720 },
  { label: "480p", height: 480 }
];

function getCodecRank(codec) {
  var name = String(codec || "").toLowerCase().split(".")[0];
  // avc1/avc3 are H.264 — normalize so rank matches "h264"
  if (name.indexOf("avc") === 0) {
    name = "h264";
  }
  for (var index = 0; index < CODEC_PREFERENCE.length; index += 1) {
    if (name.indexOf(CODEC_PREFERENCE[index]) === 0) {
      return CODEC_PREFERENCE.length - index;
    }
  }
  return 0;
}

function isVideoOnly(format) {
  return format && format.vcodec && format.vcodec !== "none" && (!format.acodec || format.acodec === "none");
}

function isAudioOnly(format) {
  return format && format.acodec && format.acodec !== "none" && (!format.vcodec || format.vcodec === "none");
}

function isMuxed(format) {
  return format && format.vcodec && format.vcodec !== "none" && format.acodec && format.acodec !== "none";
}

function formatHeight(format) {
  return util.parseInteger(format.height);
}

function formatSize(format) {
  var raw = util.parseFloatValue(format.filesize);
  if (raw === null) {
    raw = util.parseFloatValue(format.filesize_approx);
  }
  return raw;
}

function compareFormats(left, right) {
  var score = getCodecRank(right.vcodec) - getCodecRank(left.vcodec);
  if (score !== 0) {
    return score;
  }
  score = formatHeight(right) - formatHeight(left);
  if (score !== 0) {
    return score;
  }
  score = formatSize(right) - formatSize(left);
  if (score !== 0) {
    return score > 0 ? 1 : -1;
  }
  return util.parseInteger(right.tbr) - util.parseInteger(left.tbr);
}

function pickBestVideoStream(formats, maxHeight) {
  var candidates = (formats || []).filter(function (format) {
    if (!isVideoOnly(format)) {
      return false;
    }
    var height = formatHeight(format);
    return height > 0 && height <= maxHeight;
  });
  candidates.sort(compareFormats);
  return candidates[0] || null;
}

function pickBestAudioStream(formats) {
  var candidates = (formats || []).filter(function (format) {
    return isAudioOnly(format) || isMuxed(format);
  });
  candidates.sort(function (left, right) {
    var score = formatSize(right) - formatSize(left);
    if (score !== 0) {
      return score > 0 ? 1 : -1;
    }
    score = util.parseInteger(right.abr) - util.parseInteger(left.abr);
    if (score !== 0) {
      return score;
    }
    return getCodecRank(right.acodec) - getCodecRank(left.acodec);
  });
  return candidates[0] || null;
}

function pickBestMuxed(formats, maxHeight) {
  var candidates = (formats || []).filter(function (format) {
    if (!isMuxed(format)) {
      return false;
    }
    var height = formatHeight(format);
    return height > 0 && height <= maxHeight;
  });
  candidates.sort(compareFormats);
  return candidates[0] || null;
}

function capEntryFor(cap, formats, allowEncoding) {
  var muxed = pickBestMuxed(formats, cap.height);
  var videoStream = pickBestVideoStream(formats, cap.height);
  var audioStream = pickBestAudioStream(formats);
  var hasH264 = muxed ? getCodecRank(muxed.vcodec) >= getCodecRank("h264") : false;
  var mergePossible = Boolean(videoStream && audioStream);
  var needsTranscode = !muxed && videoStream && !hasH264 && getCodecRank(videoStream.vcodec) < getCodecRank("h264");

  var entry = {
    label: cap.label,
    height: cap.height,
    available: Boolean(muxed || (mergePossible && allowEncoding) || mergePossible),
    muxed: muxed,
    videoStream: videoStream,
    audioStream: audioStream,
    hasMuxedH264: Boolean(muxed && hasH264),
    requiresMerge: !muxed && mergePossible,
    transcodeOffered: !muxed && needsTranscode && allowEncoding,
    codec: muxed ? String(muxed.vcodec).split(".")[0] : (videoStream ? String(videoStream.vcodec).split(".")[0] : ""),
    sizeBytes: formatSize(muxed || videoStream) || null
  };
  entry.selector = entry.selector = buildSelector(entry, cap);
  return entry;
}

function buildSelector(entry, cap) {
  var height = cap.height;
  if (entry.muxed) {
    // H.264 preference applied via --format-sort; chain just prefers muxed MP4.
    return "best[height<=?" + height + "][ext=mp4]/best[height<=?" + height + "]/best";
  }
  if (entry.transcodeOffered || entry.requiresMerge) {
    return "bestvideo[height<=?" + height + "]+bestaudio/best[height<=?" + height + "]/best";
  }
  return "best[height<=?" + height + "]/best";
}

/** Sorting for Premiere/AE-friendliness: resolution first, then H.264 > AAC > MP4. */
function getFormatSortArgs() {
  return ["--format-sort", "res,codec:h264,acodec:aac,ext:mp4"];
}

function getAudioSelector() {
  return "bestaudio/best";
}

/** Build the quality-option list for the result card UI. */
function planVideoCandidates(meta, settings) {
  var formats = meta && meta.formats ? meta.formats : [];
  var maxIndex = 0;
  var userCap = settings && settings.maxQualityHeight ? settings.maxQualityHeight : 2160;

  QUALITY_CAPS.forEach(function (cap, index) {
    if (cap.height <= userCap) {
      maxIndex = index + 1;
    }
  });

  var result = [];
  var index;
  for (index = 0; index < maxIndex; index += 1) {
    var cap = QUALITY_CAPS[index];
    var entry = capEntryFor(cap, formats, Boolean(settings && settings.allowEncoding));
    if (entry.available) {
      result.push(entry);
    }
  }
  return result;
}

function estimateAudioSize(formats) {
  var best = pickBestAudioStream(formats);
  return best ? formatSize(best) : null;
}

module.exports = {
  QUALITY_CAPS: QUALITY_CAPS,
  planVideoCandidates: planVideoCandidates,
  getAudioSelector: getAudioSelector,
  getFormatSortArgs: getFormatSortArgs,
  estimateAudioSize: estimateAudioSize,
  isMuxed: isMuxed,
  isVideoOnly: isVideoOnly,
  isAudioOnly: isAudioOnly,
  pickBestAudioStream: pickBestAudioStream
};
