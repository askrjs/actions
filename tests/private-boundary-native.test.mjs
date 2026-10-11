// Native process/normal-tool qualification fixtures; not release graph/advisory acceptance.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { worker,action,nativeRoot,context,request,run,observer,profile,put,hash,quote,guardDisk,prepareComposite } from './private-boundary-fixture.mjs';
const read=async file=>JSON.parse(await readFile(file,'utf8'));
const absent=async file=>assert.rejects(access(file),{code:'ENOENT'});
const ok=result=>assert.equal(result.status,0,result.stderr);
const rejected=result=>assert.notEqual(result.status,0,'unexpected command acceptance');
const privateRoot=(ctx,r)=>join(ctx.metadata.RUNNER_TEMP,'askr-0.5-private-'+r.jobPolicySha256);
if(process.argv.includes('--prepare-composite')) {
 await prepareComposite();
} else {
 test('new source availability: actual private boundary worker exists',async()=>{await access(worker);});
 test('actual composite bootstrap preserved workspace cwd/argv and blocked startup injection',async()=>{
  const r=await read(join(nativeRoot,'bootstrap-request.json'));
  const root=join(process.env.RUNNER_TEMP,'askr-0.5-private-'+r.jobPolicySha256);
  const receipt=await read(join(root,'receipts/composite-bootstrap.json'));
  assert.equal(receipt.mode,'fixture');assert.equal(receipt.finalToolAuthorityAccepted,false);
  assert.deepEqual(receipt.command.args,[r.tools.bundledNpmCli.path,'install','--prefix',join(process.env.RUNNER_TEMP,'askr-candidate-toolchain'),'--ignore-scripts','--no-audit','--no-fund','npm@12.0.1']);
  assert.equal(receipt.command.cwd,process.env.GITHUB_WORKSPACE);
  assert.equal((await read(join(root,'receipts/composite-bootstrap-exit.json'))).status,0);
  for(const name of ['node-injection-ran','shell-injection-ran'])await absent(join(nativeRoot,name));
  assert.equal(hash(await readFile(join(process.env.RUNNER_TEMP,'askr-candidate-toolchain/node_modules/npm/bin/npm-cli.js'))),r.tools.npmCliSha256);
 });
 test('actual composite rejects mixed-case proxy alias before any owner effect',async()=>{
  assert.equal(process.env.BOUNDARY_PROXY_OUTCOME,'failure');await absent(join(nativeRoot,'proxy-must-not-run'));
 });
 test('native owner retains exact stdin/argv/cwd and finite env with private config/HOME/PATH',async()=>{
  const ctx=await context('owner'), file=await observer(ctx);
  const body='node '+quote(file)+" --literal 'two words'\n";
  const r=await request(ctx,'observe',body);
  const result=await run(ctx,r,{stdin:'native stdin remains owned\n',ambient:{HTTP_PROXY:'http://127.0.0.1:9/',hTtPs_PrOxY:'socks://127.0.0.1:9/',NPM_CONFIG_USERCONFIG:'/fixture/evil',npm_config_ignore_scripts:'true',ASKR_INJECT:'fixture',AUTH_SESSION_SECRET:'FIXTURE_NOT_A_SECRET'}});ok(result);
  const observed=await read(join(ctx.workspace,'observation.json'));
  assert.deepEqual(observed.argv,['--literal','two words']);assert.equal(observed.stdin,'native stdin remains owned\n');assert.equal(observed.cwd,ctx.workspace);
  for(const key of ['HTTP_PROXY','hTtPs_PrOxY','NPM_CONFIG_USERCONFIG','npm_config_ignore_scripts','ASKR_INJECT','AUTH_SESSION_SECRET','NODE_OPTIONS','NODE_PATH','BASH_ENV','ENV'])assert.ok(!(key in observed.env),key);
  assert.equal(observed.env.npm_config_proxy,'null');assert.equal(observed.env.npm_config_https_proxy,'null');
  assert.equal(observed.env.HOME,join(privateRoot(ctx,r),'home'));
  for(const key of ['npm_config_userconfig','npm_config_globalconfig'])assert.equal((await readFile(observed.env[key])).length,0);
  assert.deepEqual((await read(join(privateRoot(ctx,r),'receipts/observe.json'))).command.args,(await profile()).tools.scriptShell.args.concat(join(privateRoot(ctx,r),'scripts/observe.bash')));
 });
 test('separate calls share owned HOME while ambient PATH shim cannot replace node/npm',async()=>{
  const ctx=await context('home-path');const fake=join(ctx.root,'evil-bin');await mkdir(fake,{mode:0o700});
  for(const name of ['node','npm','node.cmd','npm.cmd'])await put(join(fake,name),'exit 91\n');
  const one=await request(ctx,'first',"node -e \"require('fs').writeFileSync(require('path').join(process.env.HOME,'shared'),'fixture')\"\nnpm --version\n");
  ok(await run(ctx,one,{ambient:{PATH:fake}}));
  const two=await request(ctx,'second',"node -e \"require('assert').equal(require('fs').readFileSync(require('path').join(process.env.HOME,'shared'),'utf8'),'fixture')\"\n");
  ok(await run(ctx,two,{ambient:{PATH:fake}}));
  const a=await read(join(privateRoot(ctx,one),'receipts/first.json')),b=await read(join(privateRoot(ctx,two),'receipts/second.json'));assert.equal(a.env.HOME,b.env.HOME);
  assert.match((await read(join(ctx.root,'first.raw.json'))).stdout,/12\.0\.1/);
 });
 test('owner failures preserve exit7 and Bash fail-fast prevents later effects',async()=>{
  const ctx=await context('failure');const r=await request(ctx,'exit-seven',"node -e \"process.exit(7)\"\nnode -e \"require('fs').writeFileSync('must-not-run','bad')\"\n");rejected(await run(ctx,r));
  assert.equal((await read(join(privateRoot(ctx,r),'receipts/exit-seven-exit.json'))).status,7);await absent(join(ctx.workspace,'must-not-run'));
 });
 test('wrong request digest, mode promotion and reserved env reject before owner effects',async()=>{
  const ctx=await context('invalid-request');const r=await request(ctx,'bad-digest',"node -e \"require('fs').writeFileSync('must-not-run','bad')\"\n");
  rejected(await run(ctx,r,{digestOverride:'0'.repeat(64)}));
  for(const [i,mutate] of [x=>x.mode='release',x=>{x.mode='release';x.authority=Object.fromEntries(['policyReviewSha256','applicationAdmissionSha256','finalInputSha256','callerInventorySha256','lifecycleInventorySha256'].map(k=>[k,'1'.repeat(64)]));},x=>x.authority.releaseQualification=true,x=>x.authority.finalToolAuthorityApproved=true,x=>x.command.environment.HTTP_PROXY='http://evil/',x=>x.command.environment.NODE_OPTIONS='--import=evil',x=>x.command.environment.NPM_CONFIG_IGNORE_SCRIPTS='true'].entries()){
   const c=structuredClone(r);c.command.id='invalid-'+i;mutate(c);rejected(await run(ctx,c));
  }
  const wrongRepo=await request(ctx,'fixture-wrong-repo',r.command.scriptBase64?Buffer.from(r.command.scriptBase64,'base64').toString():'');
  rejected(await run({...ctx,metadata:{...ctx.metadata,GITHUB_REPOSITORY:'askrjs/askr'}},wrongRepo));
  await absent(join(ctx.workspace,'must-not-run'));
 });
 test('unexpected or modified project .npmrc rejects without silently bypassing or rewriting it',async()=>{
  const ctx=await context('config');const r=await request(ctx,'unexpected-config','npm --version\n');
  const injected='proxy=socks://127.0.0.1:9/\n';await put(join(ctx.workspace,'.npmrc'),injected);rejected(await run(ctx,r));assert.equal(await readFile(join(ctx.workspace,'.npmrc'),'utf8'),injected);
  const modified=await request(ctx,'disallowed-config','npm --version\n');rejected(await run(ctx,modified));assert.equal(await readFile(join(ctx.workspace,'.npmrc'),'utf8'),injected);
 });
 test('modified private user config is retained and rejected after a command',async()=>{
  const ctx=await context('private-config');const r=await request(ctx,'tamper-private',"node -e \"require('fs').writeFileSync(process.env.npm_config_userconfig,'proxy=socks://fixture/\\n')\"\n");rejected(await run(ctx,r));
  assert.equal((await read(join(privateRoot(ctx,r),'receipts/tamper-private-exit.json'))).status,0);
  assert.equal(await readFile(join(privateRoot(ctx,r),'user.npmrc'),'utf8'),'proxy=socks://fixture/\n');
 });
 test('normal native fixture ci and pack execute install/prepack hooks without suppressing scripts',async()=>{
  await guardDisk();const ctx=await context('normal-hooks');
  const pkg={name:'askr-private-boundary-native-fixture',version:'0.0.0',files:['index.js'],scripts:{preinstall:'node hook.mjs preinstall',install:'node hook.mjs install',postinstall:'node hook.mjs postinstall',prepack:'node hook.mjs prepack'}};
  await put(join(ctx.workspace,'package.json'),JSON.stringify(pkg)+'\n');
  await put(join(ctx.workspace,'package-lock.json'),JSON.stringify({name:pkg.name,version:pkg.version,lockfileVersion:3,requires:true,packages:{'':{name:pkg.name,version:pkg.version,hasInstallScript:true}}})+'\n');
  await put(join(ctx.workspace,'index.js'),'export const fixture=true;\n');
  await put(join(ctx.workspace,'hook.mjs'),"import{appendFileSync}from'node:fs';appendFileSync('hooks.log',process.argv[2]+'\\n');\n");
  const before=hash(await readFile(join(ctx.workspace,'package-lock.json'))),body='npm ci\nnpm pack --json\n';
  const r=await request(ctx,'normal-ci-pack',body);ok(await run(ctx,r));
  assert.equal(await readFile(join(ctx.workspace,'hooks.log'),'utf8'),'preinstall\ninstall\npostinstall\nprepack\n');assert.equal(hash(await readFile(join(ctx.workspace,'package-lock.json'))),before);
  const receipt=await read(join(privateRoot(ctx,r),'receipts/normal-ci-pack.json'));assert.equal(Buffer.from(r.command.scriptBase64,'base64').toString(),body);assert.equal(receipt.env.NPM_CONFIG_AUDIT,'true');
 });
 test('literal H19 cleanup works after rejected bootstrap preflight without npm and stops exact owned server',async()=>{
  const ctx=await context('cleanup');ctx.metadata.RUNNER_TEMP=ctx.temp;
  const rejectedBootstrap=await request(ctx,'bootstrap-rejected',null,'bootstrap');
  rejectedBootstrap.tools.nodeSha256='0'.repeat(64);
  const failed=await run(ctx,rejectedBootstrap);rejected(failed);assert.match(failed.stderr,/actual tool bytes/);
  const r=await request(ctx,'cleanup-after-bootstrap-failure',null,'helper','cleanup');
  const helper=await import(pathToFileURL(join(action,'h19/qualify.mjs')).href);
  const root=join(ctx.temp,'askr-0.5-candidate-'+r.manifest.sha256);
  let info;
  try {
   info=await helper.startRegistry(root);ok(await run(ctx,r));
   const stopped=await read(join(root,'cleanup.json'));assert.equal(stopped.stopped,true);assert.equal(stopped.pid,info.pid);assert.equal(stopped.id,info.id);
   await assert.rejects(helper.registryResponds(info.registry+'__askr-health',2000));
   await absent(join(ctx.temp,'askr-candidate-toolchain'));
  } finally { if(info)await helper.stopRegistry(root); }
 });
}
