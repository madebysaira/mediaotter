"use strict";
// Owned fixture media: generated image and tone, served locally through real yt-dlp.
var fs=require("fs"),path=require("path"),os=require("os"),http=require("http"),assert=require("assert");
var root=path.resolve(__dirname,".."),temp=fs.mkdtempSync(path.join(os.tmpdir(),"mediaotter-integration-"));
process.env.MEDIAOTTER_STATE_DIR=path.join(temp,"state");
var util=require(root+"/extension/js/util"),bin=require(root+"/extension/js/binary-manager"),engine=require(root+"/extension/js/downloader"),quality=require(root+"/extension/js/quality");
var server, url;
function download(request) {
  return new Promise(function(resolve,reject){
    var record=engine.enqueueDownload(Object.assign({url:url,destDir:path.join(temp,"downloads"),settings:{maxQualityHeight:720,allowEncoding:true}},request));
    var unsubDone=engine.on("download:complete",function(r){if(r.id===record.id){cleanup();resolve(r);}});
    var unsubFail=engine.on("download:error",function(r){if(r.id===record.id){cleanup();reject(new Error(r.error));}});
    function cleanup(){unsubDone();unsubFail();}
  });
}
async function main(){
  var fixture=path.join(temp,"fixture.mp4");
  var generated=await util.spawnProcess(bin.getFfmpegPath(),["-v","error","-f","lavfi","-i","testsrc2=size=320x180:rate=25","-f","lavfi","-i","sine=frequency=440:sample_rate=44100","-t","5","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac",fixture]);assert.strictEqual(generated.code,0,generated.stderr);
  var webm=path.join(temp,"fixture.webm");
  var encoded=await util.spawnProcess(bin.getFfmpegPath(),["-v","error","-i",fixture,"-c:v","libvpx-vp9","-deadline","realtime","-cpu-used","8","-c:a","libopus",webm]);assert.strictEqual(encoded.code,0,encoded.stderr);
  var files={"/fixture.mp4":fs.readFileSync(fixture),"/fixture.webm":fs.readFileSync(webm)};
  server=http.createServer(function(req,res){
    var bytes=files[req.url];if(!bytes){res.writeHead(404);res.end();return;}
    var match=/bytes=(\d+)-(\d*)/.exec(req.headers.range||"");var a=match?Number(match[1]):0,b=match&&match[2]?Number(match[2]):bytes.length-1;
    res.writeHead(match?206:200,{"Content-Type":/webm$/.test(req.url)?"video/webm":"video/mp4","Accept-Ranges":"bytes","Content-Length":b-a+1,...(match?{"Content-Range":"bytes "+a+"-"+b+"/"+bytes.length}:{})});if(req.method==="HEAD"){res.end();}else{res.end(bytes.slice(a,b+1));}
  });await new Promise(function(resolve){server.listen(0,"127.0.0.1",resolve);});url="http://127.0.0.1:"+server.address().port+"/fixture.mp4";
  var meta=await engine.resolveMetadata(url,{}), candidates=quality.planVideoCandidates(meta,{maxQualityHeight:720,allowEncoding:true});assert.ok(candidates.length, JSON.stringify(meta));console.log("PASS real yt-dlp metadata and exact quality selection");
  var results=await Promise.all([download({kind:"audio",meta:meta}),download({kind:"video",meta:meta,selector:candidates[0].selector}),download({kind:"audio",meta:meta,range:{start:1,end:3}})]);
  results.forEach(function(r){assert.ok(fs.existsSync(r.finalPath));assert.ok(r.finalSize>0);assert.ok(r.mediaInfo);});assert.ok(Math.abs(results[2].mediaInfo.duration-2)<0.15);assert.ok(results[0].mediaInfo.streams.some(function(s){return s.codec==="pcm_s16le"&&Number(s.sampleRate)===48000&&s.channels===2;}));assert.ok(results[1].mediaInfo.streams.some(function(s){return s.codec==="h264";}));console.log("PASS audio/video/section actual download, conversion, FFprobe verification and queued third job");
  var webmUrl=url.replace("mp4","webm"),webmMeta=await engine.resolveMetadata(webmUrl,{}),webmChoices=quality.planVideoCandidates(webmMeta,{maxQualityHeight:144,allowEncoding:true});assert.ok(webmChoices.length);
  var converted=await download({url:webmUrl,kind:"video",meta:webmMeta,selector:webmChoices[0].selector,settings:{maxQualityHeight:144,allowEncoding:true}});
  assert.ok(converted.mediaInfo.streams.some(function(s){return s.codec==="h264"&&s.height===144;}));assert.ok(converted.mediaInfo.streams.some(function(s){return s.codec==="aac";}));console.log("PASS VP9/Opus conversion to H264/AAC and enforced output height cap");
  var clipped=await download({kind:"video",meta:meta,selector:candidates[0].selector,range:{start:1,end:3}});assert.ok(Math.abs(clipped.mediaInfo.duration-2)<0.15);console.log("PASS video section has requested duration");
  var bad=engine.enqueueDownload({url:url.replace("/fixture","/missing"),kind:"audio",destDir:path.join(temp,"downloads"),settings:{},meta:meta});engine.cancelDownload(bad.id);
  await new Promise(function(resolve){var off=engine.on("download:cancelled",function(r){if(r.id===bad.id){off();resolve();}});});assert.strictEqual(engine.getActiveDownloads().length,0);assert.ok(!fs.readdirSync(path.join(temp,"downloads")).some(function(f){return f.indexOf(".mediaotter-")===0;}));console.log("PASS cancellation releases slot and removes temporary media");
  if(process.env.MEDIAOTTER_KEEP_FIXTURES){console.log("Fixtures saved: "+temp);}else{util.removeDir(temp);}
}
main().catch(function(error){console.error(error);process.exitCode=1;}).finally(function(){if(server){server.close();}});
