import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {TreeBarkTexturePool} from '../src/tree-bark-texture-pool.ts';
import {ForestTreeFamilyLibrary} from '../src/forest-tree-family-library.ts';
import {forestTextureFootprint} from '../src/forest-resource-accounting.ts';
// Compact encoded-content identity fixture; no image decoding or GPU work.
const png=(salt=0)=>{const b=new Uint8Array(25);b.set([137,80,78,71,13,10,26,10]);const v=new DataView(b.buffer);v.setUint32(16,1024);v.setUint32(20,1024);b[24]=salt;return b;};
function texture(image){const t=new THREE.Texture(image??{width:1024,height:1024,closed:0,close(){this.closed++;}});t.minFilter=THREE.LinearMipmapLinearFilter;t.wrapS=t.wrapT=THREE.RepeatWrapping;t.disposals=0;t.addEventListener('dispose',()=>t.disposals++);return t;}
test('exact content/state shares resources; duplicate decode closes immediately and only final lease disposes shared source',async()=>{
 const p=new TreeBarkTexturePool(),a=texture(),b=texture(),first=await p.acquire(a,png(),'bark-base-color'),second=await p.acquire(b,png(),'bark-base-color');
 assert.equal(first.texture,second.texture);assert.equal(b.disposals,1);assert.equal(b.image.closed,1);assert.equal(a.disposals,0);
 const before=forestTextureFootprint([texture(),texture()]),after=forestTextureFootprint([first.texture,second.texture]);assert.equal(before.decodedCpuBytes-after.decodedCpuBytes,4194304);assert.equal(before.gpuEstimateBytes-after.gpuEstimateBytes,5592404);
 first.release();first.release();assert.equal(a.disposals,0);assert.equal(a.image.closed,0);assert.equal(p.diagnostics().leases,1);second.release();assert.equal(a.disposals,1);assert.equal(a.image.closed,1);assert.equal(p.diagnostics().entries,0);
});
test('different SHA, role and sampling/colour/UV state do not alias; state mutation and capacity fail before ownership transfer',async()=>{
 const p=new TreeBarkTexturePool(),leases=[],a=texture();leases.push(await p.acquire(a,png(),'bark-base-color'));
 for(const mutate of [t=>t.colorSpace=THREE.SRGBColorSpace,t=>t.wrapS=THREE.ClampToEdgeWrapping,t=>t.repeat.set(2,1),t=>t.channel=1,t=>t.flipY=false]){const t=texture();mutate(t);const l=await p.acquire(t,png(),'bark-base-color');assert.notEqual(l.texture,a);leases.push(l);}
 const normal=texture();leases.push(await p.acquire(normal,png(),'bark-normal'));const other=texture();leases.push(await p.acquire(other,png(1),'bark-base-color'));
 const rejected=texture();await assert.rejects(p.acquire(rejected,png(2),'bark-base-color'),/capacity/);assert.equal(rejected.disposals,0);assert.equal(rejected.image.closed,0);
 a.repeat.set(3,1);await assert.rejects(p.acquire(texture(),png(),'bark-base-color'),/state changed/);
 for(const l of leases)l.release();assert.equal(p.diagnostics().entries,0);assert.equal(p.diagnostics().leases,0);
});
test('different texture states sharing one decoded image close it only after all owning entries release',async()=>{
 const image={width:1024,height:1024,closed:0,close(){this.closed++;}},p=new TreeBarkTexturePool(),a=texture(image),b=texture(image);b.flipY=false;
 const l=await p.acquire(a,png(),'bark-normal'),m=await p.acquire(b,png(),'bark-normal');l.release();assert.equal(image.closed,0);m.release();assert.equal(image.closed,1);
});
function fixture(){let fail=false,block=null;const originals=[];const loader=async(a,b,o)=>{
 const leases=[];try{for(const [salt,role] of [[0,'bark-base-color'],[1,'bark-normal']]){const t=texture();originals.push(t);leases.push(await o.sharedBarkTextures.acquire(t,png(salt),role));}
  if(block){const f=block;block=null;await f();}if(fail&&a===2)throw new Error('fixture failed second family');
  return {forestCoverage:true,maxRadiusM:20,textures:new Set(leases.map(l=>l.texture)),setDate(){},createBatch(){return{group:new THREE.Group(),dispose(){this.group.removeFromParent();}};},dispose(){for(const l of leases)l.release();}};
 }catch(e){for(const l of leases)l.release();throw e;}};
 const library=new ForestTreeFamilyLibrary(new THREE.Group(),loader,x=>x.id,[2,2],{shareBarkTextures:true});return{library,originals,setFail(v){fail=v;},setBlock(f){block=f;}};
}
const inputs=[{kind:'branching',lod0:1,lod1:1},{kind:'spire',lod0:2,lod1:2}];
test('atomic replacement rollback preserves live family resources and clear cancels staged adoption without leaking leases',async()=>{
 const f=fixture(),lib=f.library;assert.equal(await lib.replace(inputs),true);const old=lib.entries.get('branching'),shared=[...old.family.textures];assert.equal(lib.barkTextureDiagnostics().leases,4);
 f.setFail(true);await assert.rejects(lib.replace(inputs),/second family/);assert.equal(lib.entries.get('branching'),old);assert.equal(lib.barkTextureDiagnostics().leases,4);for(const t of shared)assert.equal(t.disposals,0);
 f.setFail(false);let release,entered;const wait=new Promise(r=>release=r),arrival=new Promise(r=>entered=r);f.setBlock(async()=>{entered();await wait;});const pending=lib.replace(inputs);await arrival;lib.clear();assert.equal(lib.barkTextureDiagnostics().leases,2);release();assert.equal(await pending,false);assert.equal(lib.barkTextureDiagnostics().leases,0);for(const t of shared)assert.equal(t.disposals,1);lib.dispose();
});
