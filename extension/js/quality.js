"use strict";

// A candidate contains exact format IDs, actual dimensions, and conversion needs.
// Never silently exceed the selected cap or substitute a lower muxed stream.
var QUALITY_CAPS = [2160, 1440, 1080, 720, 480].map(function (height) {
  return {label: height + "p", height: height};
});
function isMuxed(f) { return Boolean(f && f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none"); }
function isVideoOnly(f) { return Boolean(f && f.vcodec && f.vcodec !== "none" && (!f.acodec || f.acodec === "none")); }
function isAudioOnly(f) { return Boolean(f && f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none")); }
function isH264(f) { return /^(avc[13]|h264)/i.test(f && f.vcodec || ""); }
function isAAC(f) { return /^(mp4a|aac)/i.test(f && f.acodec || ""); }
function size(f) { return f ? Number(f.filesize || f.filesize_approx) || null : null; }
function usable(f) { return f && f.format_id && !f.has_drm && !/^mhtml/.test(f.protocol || ""); }
function pickBestAudioStream(formats) {
  var audio = (formats || []).filter(function (f) { return usable(f) && isAudioOnly(f); });
  if (!audio.length) { audio = (formats || []).filter(function (f) { return usable(f) && isMuxed(f); }); }
  audio.sort(function (a, b) { return Number(isAAC(b)) - Number(isAAC(a)) || (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0); });
  return audio[0] || null;
}
function planVideoCandidates(meta, settings) {
  var formats = meta && Array.isArray(meta.formats) ? meta.formats : [];
  var max = Number(settings && settings.maxQualityHeight) || 2160;
  var allow = !settings || settings.allowEncoding !== false;
  var result = [], seen = {};
  QUALITY_CAPS.filter(function (cap) { return cap.height <= max; }).forEach(function (cap) {
    var videos = formats.filter(function (f) {
      return usable(f) && (isVideoOnly(f) || isMuxed(f)) && Number(f.height) > 0 && Number(f.height) <= cap.height && (allow || isH264(f));
    });
    videos.sort(function (a, b) {
      return b.height - a.height || Number(isH264(b)) - Number(isH264(a)) || Number(isMuxed(b) && isAAC(b)) - Number(isMuxed(a) && isAAC(a)) || (b.fps || 0) - (a.fps || 0) || (b.tbr || 0) - (a.tbr || 0);
    });
    var video = videos[0];
    if (!video) { return; }
    var audio = isMuxed(video) ? video : pickBestAudioStream(formats.filter(isAudioOnly));
    var selector = String(video.format_id) + (audio && audio !== video ? "+" + audio.format_id : "");
    if (seen[selector]) { return; } seen[selector] = true;
    var convert = !isH264(video) || Boolean(audio && !isAAC(audio));
    result.push({
      label: video.height + "p", height: video.height, width: video.width || null, capHeight: cap.height,
      available: true, selector: selector, muxed: isMuxed(video) ? video : null,
      videoStream: video, audioStream: audio, hasMuxedH264: isMuxed(video) && isH264(video),
      requiresMerge: Boolean(audio && audio !== video), requiresTranscode: convert,
      transcodeOffered: convert, codec: String(video.vcodec).split(".")[0],
      sizeBytes: size(video) && (!audio || audio === video || size(audio)) ? size(video) + (audio && audio !== video ? size(audio) : 0) : null
    });
  });
  if (!result.length) {
    // Direct files and generic HLS often expose no dimensions until downloaded.
    var unknown = formats.filter(function (f) { return usable(f) && !f.height && f.vcodec !== "none" && /^(mp4|mov|webm|mkv|m3u8)$/.test(f.ext || f.video_ext || ""); })[0];
    if (unknown && allow) { result.push({label:"Original · up to " + max + "p",height:0,capHeight:max,available:true,selector:String(unknown.format_id),requiresTranscode:true,transcodeOffered:true,codec:"inspect after download",sizeBytes:size(unknown)}); }
  }
  return result;
}
module.exports = {
  QUALITY_CAPS: QUALITY_CAPS, planVideoCandidates: planVideoCandidates,
  getAudioSelector: function () { return "bestaudio/best"; },
  getFormatSortArgs: function () { return ["--format-sort", "res,codec:h264,acodec:aac,ext:mp4"]; },
  estimateAudioSize: function (formats) { return size(pickBestAudioStream(formats)); },
  isMuxed: isMuxed, isVideoOnly: isVideoOnly, isAudioOnly: isAudioOnly, pickBestAudioStream: pickBestAudioStream
};
