import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {maintenanceReadOnly,maintenanceWriteGuard} from '../src/maintenanceMode.js';
test('maintenance mode is explicit and invalid values fail closed',()=>{
  assert.equal(maintenanceReadOnly({}),false);assert.equal(maintenanceReadOnly({DPV_MAINTENANCE_READ_ONLY:'true'}),true);
  assert.throws(()=>maintenanceReadOnly({DPV_MAINTENANCE_READ_ONLY:'typo'}));
});
test('maintenance blocks all mutation methods before handlers while allowing reads',()=>{
  for(const method of ['POST','PUT','PATCH','DELETE']){let code;const res={status(n){assert.equal(n,503);return this;},json(v){code=v.code;}};
    maintenanceWriteGuard(true)({method},res,()=>assert.fail('handler must not run'));assert.equal(code,'MAINTENANCE_READ_ONLY');}
  for(const method of ['GET','HEAD','OPTIONS']){let called=false;maintenanceWriteGuard(true)({method},{},()=>called=true);assert.equal(called,true);}
});
test('normal mode preserves existing write handlers',()=>{let called=false;maintenanceWriteGuard(false)({method:'POST'},{},()=>called=true);assert.equal(called,true);});
test('read-only batch preview is explicitly permitted without allowing batch creation',()=>{
  let called=false;maintenanceWriteGuard(true)({method:'POST',path:'/api/research/batches/preview'},{},()=>called=true);assert.equal(called,true);
  let status;maintenanceWriteGuard(true)({method:'POST',path:'/api/research/batches'},{status(n){status=n;return this;},json(){}},()=>assert.fail());assert.equal(status,503);
});
test('read-only startup exits before the job queue starts',()=>{
  const source=readFileSync(new URL('../src/server.js',import.meta.url),'utf8').split('async function start()')[1];
  assert.ok(source);
  assert.ok(source.indexOf('if (maintenanceMode)')>=0);
  assert.ok(source.indexOf('return;')<source.indexOf('await jobQueue.start()'));
});
