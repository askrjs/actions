// Native qualification fixtures only. Dynamic fixture hashes never confer release authority.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath, stat, access, appendFile } from 'node:fs/promises';
import { join, dirname, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const worker = resolve('actions/private-caller-boundary/boundary.mjs');
export const action = dirname(worker);
export const nativeRoot = join(process.env.RUNNER_TEMP, 'askr-private-boundary-native');
export const NPM_CLI = '8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7';
export async function put(file, value) { await writeFile(file,value,{flag:'wx',mode:0o600}); }
export async function dir(path) { await mkdir(path,{recursive:true,mode:0o700}); return realpath(path); }
export async function guardDisk() {
  const { statfs } = await import('node:fs/promises'); const f=await statfs(process.env.RUNNER_TEMP);
  const free=Number(f.bavail)*Number(f.bsize); assert.ok(free>=8*1024**3,'8GiB native fixture guard'); return free;
}
export async function context(name) {
  const root=await dir(join(nativeRoot,'contexts',name));
  const workspace=await dir(join(root,'workspace')), temp=await dir(join(root,'temp'));
  await put(join(temp,'github-env'),'');await put(join(temp,'github-path'),'');
  return {root,workspace,temp,metadata:{RUNNER_TEMP:await realpath(process.env.RUNNER_TEMP),GITHUB_WORKSPACE:workspace,GITHUB_REPOSITORY:'askrjs/actions',GITHUB_SHA:process.env.GITHUB_SHA,GITHUB_ENV:join(temp,'github-env'),GITHUB_PATH:join(temp,'github-path'),GITHUB_ACTION_PATH:await realpath(action),RUNNER_OS:process.env.RUNNER_OS,GITHUB_RUN_ID:process.env.GITHUB_RUN_ID,GITHUB_RUN_ATTEMPT:process.env.GITHUB_RUN_ATTEMPT,BOUNDARY_REQUESTED_HEAD:process.env.GITHUB_SHA}};
}
export async function profile() { return JSON.parse(await readFile(join(nativeRoot,'profile.json'),'utf8')); }
export async function configs(workspace) {
  try { const b=await readFile(join(workspace,'.npmrc'));return [{path:'.npmrc',base64:b.toString('base64'),sha256:hash(b)}]; }
  catch(e) { if(e.code!=='ENOENT')throw e;return [{path:'.npmrc',base64:null,sha256:null}]; }
}
export async function request(ctx,id,body,kind='script',phase=null) {
  const tools=(await profile()).tools;
  const repos=['askr',...['auth','charts','cli','fetch','i18n','logos','lucide','monaco','node','orm','otel','schema','server','testing','themes','ui','vite'].map(x=>'askr-'+x)];
  const manifest=Buffer.from(JSON.stringify({schemaVersion:1,release:'0.5.0',complete:true,toolchain:{node:'24.21.0',npm:'12.0.1'},packages:repos.map(repo=>({name:'@askrjs/'+repo.replace(/^askr-/,''),repo:'askrjs/'+repo,commit:'2'.repeat(40),tree:'3'.repeat(40),packageJsonSha256:'4'.repeat(64),lockSha256:'5'.repeat(64),archiveSha512:'6'.repeat(128)}))}));
  const sourceHash=hash(await readFile(fileURLToPath(import.meta.url)));
  return {schema:1,mode:'fixture',platform:process.platform,jobPolicySha256:hash(ctx.root),authority:{fixtureSourceSha256:sourceHash,fixturePolicySha256:hash(await readFile(join(action,'policy.mjs'))),releaseQualification:false,finalToolAuthorityApproved:false},manifest:{ref:'2'.repeat(40),sha256:hash(manifest),base64:manifest.toString('base64')},tools,helperConfigs:repos.map(repo=>({repo:'askrjs/'+repo,commit:'2'.repeat(40),tree:'3'.repeat(40),npmrcBase64:null,npmrcSha256:null})),command:{id,kind,phase,registry:'public',cwd:'.',scriptBase64:kind==='script'?Buffer.from(body).toString('base64'):null,scriptSha256:kind==='script'?hash(body):null,projectConfigs:await configs(ctx.workspace),environment:{}}};
}
// Fixture owner processes are awaited with a finite deadline and bounded raw logs.
// A timeout/error is never accepted as an injection or exit-code success.
export async function run(ctx,r,{ambient={},stdin='',digestOverride=null}={}) {
  await guardDisk();
  const raw=Buffer.from(JSON.stringify(r)); const id=r.command.id;
  const env={...process.env,...ctx.metadata,...ambient,CI:'true',GITHUB_ACTIONS:'true',NODE_OPTIONS:'',NODE_PATH:'',BASH_ENV:'',ENV:'',BOUNDARY_REQUEST_BASE64:raw.toString('base64'),BOUNDARY_REQUEST_SHA256:digestOverride??hash(raw)};
  const windows=process.platform==='win32';
  let taskkillPath;
  if(windows) {
    assert.ok(typeof process.env.SystemRoot==='string' && process.env.SystemRoot.length>0,'actual SystemRoot required');
    const systemRoot=await realpath(process.env.SystemRoot);
    taskkillPath=await realpath(join(systemRoot,'System32','taskkill.exe'));
    assert.equal(taskkillPath.toLowerCase(),join(systemRoot,'System32','taskkill.exe').toLowerCase(),'canonical SystemRoot taskkill required');
    assert.ok((await stat(taskkillPath)).isFile(),'regular taskkill required');
  }
  // POSIX detached:true creates a fixture-owned process group inherited by Bash/npm.
  // Windows tree termination is requested while this exact owned root is still live.
  const child=spawn(process.execPath,[worker],{cwd:ctx.workspace,env,shell:false,windowsHide:true,detached:!windows,stdio:['pipe','pipe','pipe']});
  const buffers={stdout:[],stderr:[]},timers=new Set(),cleanupErrors=[];
  let bytes=0,timeout=false,overflow=false,hardDeadline=false,spawnError;
  let childExited=false,childClosed=false,result={status:null,signal:null},observed;
  let termination=null,kill,killClosed=false,killResult=null,killPromise;
  const later=(fn,ms)=>{const timer=setTimeout(()=>{timers.delete(timer);fn();},ms);timers.add(timer);return timer;};
  const clearTimers=()=>{for(const timer of timers)clearTimeout(timer);timers.clear();};
  const safeError=e=>({name:e?.name??'Error',code:e?.code??null});
  const terminate=()=>{
    if(termination || childClosed)return;
    if(!Number.isSafeInteger(child.pid)||child.pid<=0) { cleanupErrors.push('owned child has no valid PID');return; }
    termination={strategy:windows?'live-root-taskkill-tree':'owned-posix-process-group',pid:child.pid,taskkillPath:windows?taskkillPath:null};
    if(windows) {
      if(childExited || child.exitCode!==null || child.signalCode!==null) {
        termination.rootAlreadyExited=true;
        cleanupErrors.push('owned Windows root exited before tree termination; no dead-PID retry');
        return;
      }
      try {
        kill=spawn(taskkillPath,['/PID',String(child.pid),'/T','/F'],{env:{SystemRoot:process.env.SystemRoot},shell:false,windowsHide:true,stdio:'ignore'});
        killPromise=new Promise(done=>{
          kill.once('error',e=>{termination.taskkillError=safeError(e);cleanupErrors.push('owned taskkill spawn failed');});
          kill.once('close',(status,signal)=>{killClosed=true;killResult={status,signal};if(status!==0||signal!==null)cleanupErrors.push('owned taskkill did not exit cleanly');done();});
        });
      } catch(e) { termination.taskkillError=safeError(e);cleanupErrors.push('owned taskkill spawn threw'); }
    } else {
      try { process.kill(-child.pid,'SIGKILL');termination.groupSignal='SIGKILL'; }
      catch(e) { termination.groupError=safeError(e);if(e.code!=='ESRCH')cleanupErrors.push('owned process-group termination failed'); }
    }
  };
  const closed=new Promise(done=>child.once('close',(status,signal)=>{childClosed=true;result={status,signal};done(result);}));
  child.once('exit',()=>{childExited=true;});
  child.once('error',e=>{spawnError=e;});
  for(const name of ['stdout','stderr'])child[name].on('data',b=>{bytes+=b.length;if(bytes>4*1024*1024){overflow=true;terminate();}else buffers[name].push(b);});
  child.stdin.on('error',()=>{});
  try {
    later(()=>{timeout=true;terminate();},180000);
    const hard=new Promise(done=>later(()=>{hardDeadline=true;terminate();done();},190000));
    try { child.stdin.end(stdin); } catch(e) { spawnError=e;terminate(); }
    await Promise.race([closed,hard]);
  } finally {
    clearTimers();
    if(!childClosed)terminate();
    if(kill && !killClosed) {
      let cleanupDeadline=false;
      try {
        await Promise.race([killPromise,new Promise(done=>later(()=>{cleanupDeadline=true;done();},5000))]);
        if(cleanupDeadline) {
          cleanupErrors.push('owned taskkill failed to close within5s');
          try { if(kill.exitCode===null && kill.signalCode===null)kill.kill('SIGKILL'); }
          catch(e) { termination.taskkillKillError=safeError(e); }
          if(!killClosed)kill.unref();
        }
      } finally { clearTimers(); }
    }
    // A hard failure never certifies cleanup. Release only local observer handles,
    // retain uncertainty in the receipt and fail; do not target a dead Windows PID.
    if(!childClosed) {
      cleanupErrors.push('owned child close unobserved at hard deadline');
      child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.unref();
    }
    observed={...result,spawnError:spawnError?safeError(spawnError):null,timeout,overflow,hardDeadline,childExitObserved:childExited,childCloseObserved:childClosed,termination,taskkillCloseObserved:killClosed,taskkillResult:killResult,cleanupErrors,stdout:Buffer.concat(buffers.stdout).toString(),stderr:Buffer.concat(buffers.stderr).toString(),fixtureAuthorityOnly:true,releaseQualification:false,finalToolAuthorityApproved:false};
    await put(join(ctx.root,id+'.raw.json'),JSON.stringify(observed,null,2)+'\n');
  }
  assert.equal(timeout,false,'timeout is not a passing negative');assert.equal(overflow,false);assert.equal(hardDeadline,false,'hard deadline is not a passing negative');assert.equal(spawnError,undefined);assert.equal(cleanupErrors.length,0,'owned cleanup uncertainty is not acceptance');assert.equal(childClosed,true);assert.equal(result.signal,null);
  return observed;
}
export const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
export async function observer(ctx) {
 const file=join(ctx.workspace,'observe.mjs');
 await put(file,"import{writeFile,readFile}from'node:fs/promises';let input='';for await(const b of process.stdin)input+=b;await writeFile('observation.json',JSON.stringify({env:process.env,cwd:process.cwd(),argv:process.argv.slice(2),execPath:process.execPath,stdin:input}));\n");return file;
}
export async function prepareComposite() {
 assert.equal(process.version,'v24.21.0');assert.equal(process.env.GITHUB_REPOSITORY,'askrjs/actions');
 await guardDisk();await dir(nativeRoot);
 const nodePath=await realpath(process.execPath), shell=await realpath(process.env.BOUNDARY_FIXTURE_BASH);
 const candidates=[join(dirname(nodePath),'node_modules/npm/bin/npm-cli.js'),join(dirname(nodePath),'../lib/node_modules/npm/bin/npm-cli.js')];
 const matches=[];for(const candidate of candidates){try{await access(candidate);matches.push(await realpath(candidate));}catch(e){if(e.code!=='ENOENT')throw e;}}
 assert.equal(new Set(matches).size,1,'one actual bundled npm CLI');
 const pathDirectories=[];for(const candidate of process.env.PATH.split(delimiter).filter(Boolean)){try{const physical=await realpath(candidate);if((await stat(physical)).isDirectory()&&!pathDirectories.includes(physical))pathDirectories.push(physical);}catch(e){if(e.code!=='ENOENT')throw e;}}
 const tools={nodeSha256:hash(await readFile(nodePath)),bundledNpmCli:{path:matches[0],sha256:hash(await readFile(matches[0]))},npmCliSha256:NPM_CLI,pathDirectories,system:process.platform==='win32'?{SystemRoot:process.env.SystemRoot,ComSpec:process.env.ComSpec,PATHEXT:process.env.PATHEXT}:{},scriptShell:{path:shell,sha256:hash(await readFile(shell)),args:['--noprofile','--norc','-e','-o','pipefail']}};
 await put(join(nativeRoot,'profile.json'),JSON.stringify({tools,fixtureAuthorityOnly:true,actualFinalPlatformAdmission:false},null,2)+'\n');
 const ctx={root:nativeRoot,workspace:await realpath(process.env.GITHUB_WORKSPACE)};
 const r=await request(ctx,'composite-bootstrap',null,'bootstrap');
 await put(join(nativeRoot,'bootstrap-request.json'),JSON.stringify(r,null,2)+'\n');
 const raw=Buffer.from(JSON.stringify(r));
 const proxy=await request(ctx,'proxy-rejection','node -e '+quote("require('fs').writeFileSync("+JSON.stringify(join(nativeRoot,'proxy-must-not-run'))+",'bad')")+'\n');
 const proxyRaw=Buffer.from(JSON.stringify(proxy));
 await put(join(nativeRoot,'proxy-request.json'),JSON.stringify(proxy,null,2)+'\n');
 await put(join(nativeRoot,'startup-node.cjs'),"require('node:fs').writeFileSync("+JSON.stringify(join(nativeRoot,'node-injection-ran'))+",'bad');\n");
 await put(join(nativeRoot,'startup-shell.bash'),'echo bad > '+quote(join(nativeRoot,'shell-injection-ran'))+'\n');
 await appendFile(process.env.GITHUB_ENV,'BOUNDARY_PROXY_REQUEST='+proxyRaw.toString('base64')+'\nBOUNDARY_PROXY_DIGEST='+hash(proxyRaw)+'\nBOUNDARY_FIXTURE_REQUEST='+raw.toString('base64')+'\nBOUNDARY_FIXTURE_DIGEST='+hash(raw)+'\nBOUNDARY_FIXTURE_NODE_INJECT='+join(nativeRoot,'startup-node.cjs')+'\nBOUNDARY_FIXTURE_SHELL_INJECT='+join(nativeRoot,'startup-shell.bash')+'\n');
}
