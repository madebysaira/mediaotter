"use strict";
var fs=require("fs"),path=require("path"),cp=require("child_process"),crypto=require("crypto");
var root=path.resolve(__dirname,".."),bin=path.join(root,"extension","binaries"),metadata=JSON.parse(fs.readFileSync(path.join(bin,"release.json"),"utf8"));
var layout=process.platform+"-"+process.arch;
var runtime=require(root+"/extension/js/binary-manager").getRuntimeStatus();
["ytDlpReady","ffmpegReady","ffprobeReady","denoReady"].forEach(function(key){if(!runtime[key]){throw new Error(key+" is false for "+layout);}});
var checked=0;
Object.keys(metadata.releases).forEach(function(key){(metadata.releases[key].assets||[]).forEach(function(asset){
  var rel=asset.outputPath.replace(/^binaries\//,"");var file=path.join(bin,rel);
  if(!fs.existsSync(file)||fs.statSync(file).isDirectory()){return;}
  if(asset.sha256&&crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")!==asset.sha256){throw new Error("Checksum mismatch: "+rel);}checked++;
});});
[[runtime.ytDlpPath,["--version"]],[runtime.ffmpegPath,["-version"]],[runtime.ffprobePath,["-version"]],[runtime.denoPath,["--version"]]].forEach(function(entry){var probe=cp.spawnSync(entry[0],entry[1],{encoding:"utf8",timeout:15000});if(probe.status!==0){throw new Error("Cannot execute "+path.basename(entry[0])+": "+probe.stderr);}console.log(probe.stdout.split("\n")[0]);});
console.log("Verified "+checked+" checksums; "+layout+" runtime executable");
