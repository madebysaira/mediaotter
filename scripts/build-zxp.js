"use strict";
// Developer ZIP by default; genuine signed ZXP when publisher certificate is supplied.
var fs=require("fs"),path=require("path"),cp=require("child_process"),crypto=require("crypto");
var root=path.resolve(__dirname,".."),dist=path.join(root,"dist"),ext=path.join(root,"extension");
function run(cmd,args,options){var result=cp.spawnSync(cmd,args,Object.assign({stdio:"inherit"},options||{}));if(result.status!==0){throw new Error(cmd+" failed");}}
run(process.execPath,[path.join(root,"scripts/validate.js")]);run(process.execPath,[path.join(root,"tests/regression.js")]);run(process.execPath,[path.join(root,"scripts/verify-binaries.js")]);
var version=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8")).version;
var commit=cp.spawnSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).stdout.trim();
var dirty=Boolean(cp.spawnSync("git",["status","--porcelain"],{cwd:root,encoding:"utf8"}).stdout.trim());
fs.writeFileSync(path.join(ext,"build-info.json"),JSON.stringify({version:version,sourceCommit:commit,sourceDirty:dirty,builtAt:new Date().toISOString(),platform:process.platform,arch:process.arch},null,2)+"\n");
fs.mkdirSync(dist,{recursive:true});
var signed=Boolean(process.env.MEDIAOTTER_SIGN_CERT),name="mediaotter-"+version+"-"+process.platform+"-"+process.arch+(signed?".zxp":"-developer.zip"),output=path.join(dist,name);
var staging=fs.mkdtempSync(path.join(require("os").tmpdir(),"mediaotter-package-")),panel=path.join(staging,"MediaOtter");
function copyTree(from,to){fs.mkdirSync(to,{recursive:true});fs.readdirSync(from).forEach(function(file){
  if(file==="credentials.json"||file.charAt(0)==="."||/\.(log|p12|pfx|secret)$/.test(file)){return;}
  var source=path.join(from,file),target=path.join(to,file),stat=fs.lstatSync(source);if(stat.isSymbolicLink()){throw new Error("Unexpected symlink in package: "+file);}
  if(stat.isDirectory()){copyTree(source,target);}else{fs.copyFileSync(source,target);fs.chmodSync(target,stat.mode&511);}
});}
copyTree(ext,panel);
fs.copyFileSync(path.join(root,"LICENSE"),path.join(panel,"LICENSE"));
fs.copyFileSync(path.join(root,"docs/THIRD-PARTY.md"),path.join(panel,"THIRD-PARTY.md"));
try {
if(signed){
  if(!process.env.MEDIAOTTER_SIGN_PASSWORD||!process.env.MEDIAOTTER_ZXPSIGNCMD){throw new Error("Set signing password and ZXPSignCmd path");}
  run(process.env.MEDIAOTTER_ZXPSIGNCMD,["-sign",panel,output,process.env.MEDIAOTTER_SIGN_CERT,process.env.MEDIAOTTER_SIGN_PASSWORD]);
  run(process.env.MEDIAOTTER_ZXPSIGNCMD,["-verify",output]);
}else{
  fs.copyFileSync(path.join(root,"scripts/Install.command"),path.join(staging,"Install.command"));fs.chmodSync(path.join(staging,"Install.command"),493);
  fs.copyFileSync(path.join(root,"docs/INSTALL.md"),path.join(staging,"README.md"));
  copyTree(path.join(root,"docs"),path.join(staging,"docs"));
  var entries=[];function checksums(dir){fs.readdirSync(dir).sort().forEach(function(file){var full=path.join(dir,file);if(fs.statSync(full).isDirectory()){checksums(full);}else{entries.push(crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")+"  "+path.relative(staging,full));}});}checksums(staging);fs.writeFileSync(path.join(staging,"FILES.sha256"),entries.join("\n")+"\n");
  if(fs.existsSync(output)){fs.unlinkSync(output);}
  var result=cp.spawnSync("zip",["-r","-X",output,"."],{cwd:staging,encoding:"utf8"});
  if(result.status!==0){throw new Error(result.stderr||"ZIP tool unavailable; use signed distribution tooling for this platform");}
}
var hash=crypto.createHash("sha256").update(fs.readFileSync(output)).digest("hex");fs.writeFileSync(output+".sha256",hash+"  "+name+"\n");console.log("Built "+output);
} finally {require(root+"/extension/js/util").removeDir(staging);}
