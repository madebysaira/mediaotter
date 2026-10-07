"use strict";
var assert = require("assert"), fs = require("fs"), path = require("path"), os = require("os"), vm = require("vm");
var root = path.resolve(__dirname, "..");
var temp = fs.mkdtempSync(path.join(os.tmpdir(), "mediaotter-unit-"));
process.env.MEDIAOTTER_STATE_DIR = path.join(temp, "state");
var util = require(root + "/extension/js/util"), quality = require(root + "/extension/js/quality");
var count = 0;
function test(name, fn) { fn(); count++; console.log("PASS " + name); }
async function main() {
  var entry=fs.readFileSync(root+"/extension/js/app.js","utf8").split('var VERSION =')[0];
  test("browser entry loads real modules from an absolute extension root", function () {var c={window:{location:{pathname:encodeURI(root+"/extension/index.html")}},document:{body:{}},process:process,require:require("module").createRequire(root+"/extension/index.html")};vm.createContext(c);vm.runInContext(entry,c);assert.strictEqual(c.util,util);assert.strictEqual(c.extensionRoot,root+"/extension");});
  test("missing CEP Node displays an initialization error", function () {var c={window:{location:{pathname:"/extension/index.html"}},document:{body:{}}};vm.createContext(c);assert.throws(function(){vm.runInContext(entry,c);},/Node runtime/);assert.ok(c.document.body.textContent.indexOf("could not start")!==-1);});
  var formats = [480,720,1080,2160].map(function (h) { return {format_id:"v"+h, height:h, vcodec:"vp9", acodec:"none", ext:"webm"}; });
  formats.push({format_id:"a",vcodec:"none",acodec:"opus",abr:128});
  test("720 cap is enforced and exact format IDs retained", function () {
    var c = quality.planVideoCandidates({formats:formats}, {maxQualityHeight:720,allowEncoding:true});
    assert.deepStrictEqual(c.map(function (x) { return x.height; }), [720,480]); assert.strictEqual(c[0].selector,"v720+a"); assert.strictEqual(c[0].requiresTranscode,true);
  });
  test("audio-only / absent formats return no video candidates", function () { assert.deepStrictEqual(quality.planVideoCandidates({formats:[]}), []); assert.deepStrictEqual(quality.planVideoCandidates({formats:[formats[4]]}), []); });
  test("lower muxed resolution does not override 1080 separate video", function () {
    var c = quality.planVideoCandidates({formats: formats.concat([{format_id:"mux",height:360,vcodec:"avc1",acodec:"mp4a"}])}, {maxQualityHeight:1080,allowEncoding:true}); assert.strictEqual(c[0].height,1080);
  });
  test("encoding disabled offers only available H264 video", function () { assert.deepStrictEqual(quality.planVideoCandidates({formats:formats},{allowEncoding:false}),[]); });
  test("unknown direct-file codecs require explicit encoding permission", function () {var m={formats:[{format_id:"direct",ext:"mp4"}]};assert.strictEqual(quality.planVideoCandidates(m,{allowEncoding:true}).length,1);assert.strictEqual(quality.planVideoCandidates(m,{allowEncoding:false}).length,0);});
  test("corrupt persistent JSON falls back; writes are private", function () { var f=path.join(temp,"data.json"); fs.writeFileSync(f,"oops"); assert.deepStrictEqual(util.readJson(f,[]),[]); util.writeJson(f,{ok:true}); assert.strictEqual(fs.statSync(f).mode & 511,384); });
  var bin = {name:"MediaOtter",type:2,children:{numItems:0}};
  function File(p) { this.fsName=p; this.exists=true; this.parent={fsName:path.dirname(p)}; }
  var project={path:"/test/A project.prproj",rootItem:{children:{0:bin,numItems:1}},importFiles:function () {return false;}};
  var context={app:{name:"Adobe Premiere Pro",project:project},File:File};vm.createContext(context);vm.runInContext(fs.readFileSync(root+"/extension/jsx/hostscript.jsx","utf8"),context);
  test("saved project's parent is returned", function () { assert.strictEqual(context.mediaotter.getProjectFolder(),"/test"); });
  test("unsaved project yields empty directory", function () { project.path=""; assert.strictEqual(context.mediaotter.getProjectFolder(),"");project.path="/test/A project.prproj"; });
  test("host rejects false import result", function () { assert.strictEqual(JSON.parse(context.mediaotter.importFile('{"filePath":"/test/test.mp4"}')).ok,false); });
  test("host verifies item, preserves path and does not duplicate bin imports", function () {
    var calls=0;project.importFiles=function () {calls++;bin.children[0]={name:"test.mp4",getMediaPath:function(){return "/test/test.mp4";}};bin.children.numItems=1;return true;};
    assert.strictEqual(JSON.parse(context.mediaotter.importFile('{"filePath":"/test/test.mp4"}')).ok,true);context.mediaotter.importFile('{"filePath":"/test/test.mp4"}');assert.strictEqual(calls,1);
  });
  test("timeline failure retains honest bin success with warning", function () {project.activeSequence=null;var r=JSON.parse(context.mediaotter.importFile('{"filePath":"/test/test.mp4","addToTimeline":true}')); assert.strictEqual(r.ok,true);assert.strictEqual(r.timelineAdded,false);assert.ok(r.warning);});
  test("false timeline result does not report insertion success", function () {project.activeSequence={getPlayerPosition:function(){return {};},insertClip:function(){return false;}};var r=JSON.parse(context.mediaotter.importFile('{"filePath":"/test/test.mp4","addToTimeline":true}'));assert.strictEqual(r.ok,true);assert.strictEqual(r.timelineAdded,false);assert.ok(r.warning);});
  var bridgeSource = fs.readFileSync(root+"/extension/js/csbridge.js","utf8");
  var bridgeContext={module:{exports:{}},window:{__adobe_cep__:{}},CSInterface:function(){this.getSystemPath=function(){return root+"/extension";};this.evalScript=function(script,cb){cb("EvalScript error.");};},SystemPath:{EXTENSION:"extension"},setTimeout:setTimeout,clearTimeout:clearTimeout,Promise:Promise,require:require};vm.createContext(bridgeContext);vm.runInContext(bridgeSource,bridgeContext);
  assert.strictEqual((await bridgeContext.module.exports.ensureHostScript()).ok,false);count++;console.log("PASS evalScript errors never mark host ready");
  var lines=[];await util.spawnProcess(process.execPath,["-e","process.stdout.write('MEDIA');setTimeout(()=>process.stdout.write('OTTER_PATH café\\nlast'),30)"],{onStdoutLine:function(line){lines.push(line);}});assert.deepStrictEqual(lines,["MEDIAOTTER_PATH café","last"]);count++;console.log("PASS split output lines and final unterminated line");
  var timed=await util.spawnProcess(process.execPath,["-e","setInterval(()=>{},1000)"],{timeoutMs:80});assert.strictEqual(timed.timedOut,true);count++;console.log("PASS process deadline kills child");
  var cancelled=util.spawnProcess(process.execPath,["-e","setInterval(()=>{},1000)"]);setTimeout(function(){cancelled.cancel();},80);assert.strictEqual((await cancelled).cancelled,true);count++;console.log("PASS process cancellation");
  var engine=require(root+"/extension/js/downloader");
  test("YouTube classification uses hostname and single-video URLs with list remain videos",function(){assert.strictEqual(engine.classifyUrl("https://youtube.com.evil.test/a"),"generic");assert.strictEqual(engine.classifyUrl("https://www.youtube.com/watch?v=123&list=abc"),"youtube_video");assert.strictEqual(engine.classifyUrl("https://www.youtube.com/playlist?list=abc"),"youtube_playlist");});
  var handler,ready=false,fakeServer={on:function(){},listen:function(port,host,callback){callback();},close:function(){}};
  var authContext={module:{exports:{}},__dirname:path.join(root,"extension/js"),process:process,Buffer:Buffer,setTimeout:setTimeout,clearTimeout:clearTimeout,require:function(name){if(name==="http"){return {createServer:function(fn){handler=fn;return fakeServer;}};}if(name==="./util.js"){return util;}return require(name);}};
  vm.createContext(authContext);vm.runInContext(fs.readFileSync(root+"/extension/js/auth.js","utf8"),authContext);
  var received=authContext.waitForCode("expected-state",500,function(){ready=true;});assert.strictEqual(ready,true);
  var response={writeHead:function(){},end:function(){}};handler({url:"/?error=access_denied&state=wrong-state"},response);handler({url:"/?code=fixture-code&state=expected-state"},response);assert.strictEqual(await received,"fixture-code");count++;console.log("PASS OAuth opens after listening and rejects unsolicited error callbacks");
  console.log(count+" regression checks passed");
}
main().catch(function(error){console.error(error);process.exitCode=1;}).finally(function(){util.removeDir(temp);});
