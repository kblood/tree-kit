import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Texture} from 'three';
import {decodeTreeFoliageSidecar,installTreeFoliageSidecar} from '../src/tree-foliage-sidecar.ts';
const hash=x=>createHash('sha256').update(x).digest('hex');
function fixture(){
 const png=new Uint8Array([137,80,78,71]),data=new ArrayBuffer(1024*1024*4),bytes=new Uint8Array(data);bytes.fill(127);
 const digest=hash(bytes),report=level=>({level,width:2048>>level,height:2048>>level,mode:'per-cell',targetCoverage:.2,coverage:.2,coverageError:0,perCellCoverage:Array(16).fill(.2)});
 const manifest={schemaVersion:1,operation:'atlas-tree-foliage-coverage-mips-1',algorithm:'tree-foliage-coverage-mips-1',
  width:2048,height:2048,columns:4,rows:4,format:'RGBA8-straight-sRGB',alphaCutoff:.5,maxLevel:1,
  basePngSha256:hash(png),payloadBytes:bytes.length,payloadSha256:digest,
  sidecar:{bytes:bytes.length,sha256:digest,levels:[{level:1,width:1024,height:1024,offset:0,byteLength:bytes.length,sha256:digest}]},
  policy:{baseCoverage:.2,baseCellCoverage:Array(16).fill(.2)},coverage:[report(0),report(1)]};
 return{png,sidecar:{manifest,data}};
}
test('sidecar binds original PNG and exact bounded mip bytes',async()=>{
 const {png,sidecar}=fixture(),decoded=await decodeTreeFoliageSidecar(sidecar,png,.5);
 assert.equal(decoded.maxLevel,1);assert.equal(decoded.levels.length,1);
 assert.equal(decoded.levels[0].data[0],127);assert.equal(decoded.levels[0].data.buffer,sidecar.data);
 assert.deepEqual(decoded.cellGrid,[4,4]);
 await assert.rejects(decodeTreeFoliageSidecar(sidecar,new Uint8Array([1]),.5),/source PNG/);
 new Uint8Array(sidecar.data)[0]^=1;
 await assert.rejects(decodeTreeFoliageSidecar(sidecar,png,.5),/payload hash/);
});
test('sidecar rejects mismatched tables, unbounded dimensions and incompatible alpha policy',async()=>{
 const {png,sidecar}=fixture(),m=sidecar.manifest;
 for(const mutate of [x=>x.width=4096,x=>x.maxLevel=12,x=>x.sidecar.levels[0].offset=4,
  x=>x.sidecar.levels[0].width=512,x=>x.sidecar.levels.push({...x.sidecar.levels[0]}),
  x=>x.coverage[1].coverage=NaN,x=>x.policy.baseCellCoverage=[]]){
  const copy=structuredClone(m);mutate(copy);await assert.rejects(decodeTreeFoliageSidecar({manifest:copy,data:sidecar.data},png,.5));
 }
 await assert.rejects(decodeTreeFoliageSidecar(sidecar,png,.4),/contract/);
 const changed=structuredClone(m);changed.sidecar.levels[0].sha256='0'.repeat(64);
 await assert.rejects(decodeTreeFoliageSidecar({manifest:changed,data:sidecar.data},png,.5),/level hash/);
});
test('installation keeps texture identity and base image, restores state and owns lower pixel storage',async()=>{
 const originalImageData=globalThis.ImageData;
 globalThis.ImageData=class{constructor(data,width,height){this.data=data;this.width=width;this.height=height;}};
 const {png,sidecar}=fixture(),image={width:2048,height:2048},texture=new Texture(image),old=texture.mipmaps;
 texture.flipY=false;texture.colorSpace='srgb';texture.wrapS=1001;
 try{
  const result=await installTreeFoliageSidecar(texture,sidecar,png,.5);
  assert.equal(texture.image,image);assert.equal(texture.mipmaps[0],image);assert.equal(texture.mipmaps.length,2);
  assert.equal(texture.generateMipmaps,false);assert.equal(texture.flipY,false);assert.equal(texture.colorSpace,'srgb');assert.equal(texture.wrapS,1001);
  assert.notEqual(texture.mipmaps[1].data.buffer,sidecar.data);
  await assert.rejects(installTreeFoliageSidecar(texture,sidecar,png,.5),/already installed/);
  result.dispose();result.dispose();assert.equal(texture.mipmaps,old);assert.equal(texture.generateMipmaps,true);
  const again=await installTreeFoliageSidecar(texture,sidecar,png,.5);again.dispose();
 }finally{globalThis.ImageData=originalImageData;texture.dispose();}
});
test('failed validation never mutates a shared texture',async()=>{
 const {png,sidecar}=fixture(),texture=new Texture({width:2048,height:2048}),old=texture.mipmaps;
 sidecar.manifest.basePngSha256='0'.repeat(64);
 await assert.rejects(installTreeFoliageSidecar(texture,sidecar,png,.5),/source PNG/);
 assert.equal(texture.mipmaps,old);assert.equal(texture.generateMipmaps,true);texture.dispose();
});
