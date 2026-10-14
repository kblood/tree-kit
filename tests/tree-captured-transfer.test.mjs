import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {ShaderLib,ShaderChunk} from 'three';
import {loadTreeCapture,TreeCapturedImpostor} from '../src/tree-captured-impostor.ts';
import {treeCaptureViews} from '../src/tree-impostor-views.ts';
import {createTreeDiffuseTransfer} from '../src/tree-diffuse-transfer.ts';
import {patchTreeDiffuseTransferPhysical,treeDiffuseTransferGLSL} from '../src/tree-diffuse-transfer-shader.ts';

const TRANSFER_ORDER=['A','Nx','Ny','Nz','Qxx','Qyy','Qxy','Qxz','Qyz'];
const hash=b=>createHash('sha256').update(b).digest('hex');
function bytes(array){return new Uint8Array(array.buffer.slice(array.byteOffset,array.byteOffset+array.byteLength));}

function fixture({grid=3,size=32,transfer=true}={}){
  const views=treeCaptureViews(grid),files=new Map(),artifacts=[];
  for(let mip=0,width=size;width>=1;mip++,width/=2){
    const colour=new Float32Array(width*width*4),data=new Float32Array(width*width*4),classification=new Float32Array(width*width);
    for(let p=0;p<width*width;p++){
      colour.set([.5,.25,.1,.5],p*4);
      data.set([-Math.SQRT1_2,Math.SQRT1_2,0,.4],p*4);
      classification[p]=.6;
    }
    const channels=[['colour',colour],['data',data],['classification',classification]];
    if(transfer)channels.push(['diffuse-transfer',createTreeDiffuseTransfer(width,colour,data)]);
    for(const view of views)for(const [channel,array] of channels){
      const attachment='view-'+String(view.index).padStart(3,'0')+'/mip-'+mip+'.'+channel+'.f32';
      const payload=bytes(array);
      files.set(attachment,payload.buffer);
      artifacts.push({path:attachment,bytes:payload.byteLength,sha256:hash(payload)});
    }
  }
  return {files,manifest:{
    schemaVersion:2,operation:'atlas-tree-impostor-capture-2',version:'tree-material-capture-2',
    rowOrder:'bottom-to-top',colour:'linear-unassociated-rgb-area-coverage',
    data:'object-normal-xyz-normalized-frontmost-depth',classification:'leaf-fraction',
    options:{grid,size,heightM:16,...(transfer?{diffuseTransfer:true}:{})},
    ...(transfer?{diffuseTransfer:'area-associated-linear-rgb-moments-1',diffuseTransferOrder:TRANSFER_ORDER}:{}),
    views,radius:8,center:[0,8,0],artifacts,
  }};
}
function reader(files){return async path=>{const data=files.get(path);if(!data)throw new Error('Fixture missing '+path);return data.slice(0);};}
function materials(){return [
  new THREE.MeshStandardMaterial({name:'MAT_AtlasBark',metalness:0,roughness:.9}),
  new THREE.MeshStandardMaterial({name:'MAT_AtlasFoliage',metalness:0,roughness:.8}),
];}

test('transfer sidecar loads seven RGBA16F arrays within the 32 MiB budget and retains signed moments',async()=>{
  const {files,manifest}=fixture({grid:17,size:32});
  const capture=await loadTreeCapture(manifest,reader(files),{filtering:'coverage-weighted'});
  try{
    assert.equal(capture.transferTextures.length,7);
    const texelCount=(4*32*32-1)/3,expectedBytes=289*texelCount*72;
    assert.equal(capture.bytes,expectedBytes);
    assert.ok(capture.bytes<=32*1024*1024);
    for(const texture of capture.transferTextures){
      assert.equal(texture.format,THREE.RGBAFormat);
      assert.equal(texture.type,THREE.HalfFloatType);
      assert.equal(texture.colorSpace,THREE.NoColorSpace);
      assert.equal(texture.generateMipmaps,false);
      assert.equal(texture.mipmaps.length,6);
      assert.deepEqual(texture.mipmaps.map(level=>level.width),[32,16,8,4,2,1]);
      assert.ok(texture.mipmaps.every(level=>level.data instanceof Uint16Array));
    }
    const negativeNx=THREE.DataUtils.fromHalfFloat(capture.transferTextures[0].mipmaps[0].data[3]);
    const positiveNy=THREE.DataUtils.fromHalfFloat(capture.transferTextures[1].mipmaps[0].data[2]);
    assert.ok(negativeNx<0,'signed Nx must survive half-float packing; got '+negativeNx);
    assert.ok(positiveNy>0,'signed Ny must survive half-float packing; got '+positiveNy);
    assert.ok(Math.abs(negativeNx+.25*Math.SQRT1_2)<.001);
    assert.ok(Math.abs(positiveNy-.25*Math.SQRT1_2)<.001);
  }finally{capture.dispose();}
});

test('transfer load rejects malformed metadata, missing/hash-mismatched data and over-budget manifests before texture creation',async()=>{
  const base=fixture();let reads=0;
  const counting=files=>async path=>{reads++;return reader(files)(path);};
  const badOrder=structuredClone(base.manifest);badOrder.diffuseTransferOrder[2]='Nbad';
  await assert.rejects(loadTreeCapture(badOrder,counting(base.files)),/Unsupported diffuse transfer contract/);
  assert.equal(reads,0,'contract rejection precedes attachment reads');
  const undeclared=structuredClone(base.manifest);undeclared.options.diffuseTransfer=false;
  await assert.rejects(loadTreeCapture(undeclared,counting(base.files)),/Undeclared diffuse transfer attachment/);
  assert.equal(reads,0);

  const missing=fixture();missing.manifest.artifacts=missing.manifest.artifacts.filter(a=>!a.path.endsWith('.diffuse-transfer.f32'));
  await assert.rejects(loadTreeCapture(missing.manifest,counting(missing.files)),/Capture attachment length is invalid/);

  const corrupt=fixture();const record=corrupt.manifest.artifacts.find(a=>a.path.endsWith('mip-0.diffuse-transfer.f32'));record.sha256='0'.repeat(64);
  await assert.rejects(loadTreeCapture(corrupt.manifest,counting(corrupt.files)),/Capture attachment hash mismatch/);

  const over=fixture({grid:17,size:64});reads=0;
  await assert.rejects(loadTreeCapture(over.manifest,counting(over.files)),/exceeds 32 MiB/);
  assert.equal(reads,0,'budget rejection precedes payload reads');
});

test('transfer albedo moments must equal alpha-associated capture RGB',async()=>{
  const {files,manifest}=fixture();
  const path='view-000/mip-0.diffuse-transfer.f32',modified=new Float32Array(files.get(path).slice(0));
  modified[0]+=.1;
  const payload=bytes(modified);files.set(path,payload.buffer);
  manifest.artifacts.find(a=>a.path===path).sha256=hash(payload);
  await assert.rejects(loadTreeCapture(manifest,reader(files)),/Diffuse transfer albedo\/coverage mismatch/);
});

test('capture dispose releases all seven transfer textures as well as the three base arrays',async()=>{
  const {files,manifest}=fixture();
  const capture=await loadTreeCapture(manifest,reader(files));
  const disposed=new Set(),textures=[capture.colourTexture,capture.dataTexture,capture.classTexture,...capture.transferTextures];
  for(const texture of textures)texture.addEventListener('dispose',()=>disposed.add(texture));
  capture.dispose();
  assert.equal(capture.transferTextures.length,7);
  assert.equal(disposed.size,10);
  assert.ok(textures.every(texture=>disposed.has(texture)));
});

test('optional transfer shader binds ten arrays, defaults off, normalizes by coverage and preserves specular paths',async()=>{
  const samplerDeclaration=treeDiffuseTransferGLSL.match(/uniform sampler2DArray ([^;]+);/)?.[1].split(',')??[];
  assert.deepEqual(samplerDeclaration,['captureTransfer0','captureTransfer1','captureTransfer2','captureTransfer3','captureTransfer4','captureTransfer5','captureTransfer6']);
  assert.match(treeDiffuseTransferGLSL,/transferA\+=a\.xyz\*viewWeight/);
  assert.match(treeDiffuseTransferGLSL,/transferNx\+=vec3\(a\.w,b\.xy\)\*viewWeight/);
  assert.match(treeDiffuseTransferGLSL,/transferNy\+=vec3\(b\.zw,c\.x\)\*viewWeight/);
  assert.match(treeDiffuseTransferGLSL,/transferNz\+=c\.yzw\*viewWeight/);
  assert.match(treeDiffuseTransferGLSL,/transferQxx\+=d\.xyz\*viewWeight/);
  assert.match(treeDiffuseTransferGLSL,/transferQyy\+=vec3\(d\.w,e\.xy\)\*viewWeight/);
  assert.match(treeDiffuseTransferGLSL,/transferQxy\+=vec3\(e\.zw,f\.x\)\*viewWeight/);
  assert.match(treeDiffuseTransferGLSL,/transferQxz\+=f\.yzw\*viewWeight/);
  assert.match(treeDiffuseTransferGLSL,/transferQyz\+=g\.xyz\*viewWeight/);
  assert.match(treeDiffuseTransferGLSL,/transferA\/=coverage/);
  assert.match(treeDiffuseTransferGLSL,/transferQyz\/=coverage/);
  const patched=patchTreeDiffuseTransferPhysical(ShaderChunk.lights_physical_pars_fragment);
  assert.match(patched,/if\(captureDiffuseTransfer>\.5\)reflectedLight\.directDiffuse/);
  assert.match(patched,/reflectedLight\.indirectDiffuse\+=max\(transferIrradiance,vec3\(0\)\)\*RECIPROCAL_PI/);
  assert.match(patched,/reflectedLight\.directDiffuse \+= irradiance \* BRDF_Lambert\( material\.diffuseColor \);/);
  assert.match(patched,/reflectedLight\.indirectDiffuse \+= irradiance \* BRDF_Lambert\( material\.diffuseColor \);/);

  const {files,manifest}=fixture(),capture=await loadTreeCapture(manifest,reader(files));
  const proxy=new TreeCapturedImpostor(capture,materials());
  try{
    assert.equal(proxy.uniforms.captureDiffuseTransfer.value,0,'the experiment is opt-in');
    assert.equal(proxy.uniforms.captureTransfer0.value,capture.transferTextures[0]);
    assert.equal(proxy.uniforms.captureTransfer6.value,capture.transferTextures[6]);
    assert.equal(Object.keys(proxy.uniforms).filter(k=>/^captureTransfer[0-6]$/.test(k)).length,7);
    assert.equal(['captureColour','captureData','captureClass',...Array.from({length:7},(_,i)=>'captureTransfer'+i)].length,10);
    assert.equal(proxy.mesh.material.customProgramCacheKey(),'atlas-captured-tree-lab-4-legacy-unassociated-7');
    const shader={uniforms:{},vertexShader:ShaderLib.physical.vertexShader,fragmentShader:ShaderLib.physical.fragmentShader};
    proxy.mesh.material.onBeforeCompile(shader,{});
    assert.equal(Object.keys(shader.uniforms).filter(k=>/^captureTransfer[0-6]$/.test(k)).length,7);
    assert.equal(['captureColour','captureData','captureClass',...Array.from({length:7},(_,i)=>'captureTransfer'+i)].filter(k=>k in shader.uniforms).length,10);
    assert.match(shader.fragmentShader,/#define CAPTURE_DIFFUSE_TRANSFER/);
    assert.match(shader.fragmentShader,/accumulateTransfer\(uv,layer,captureMip,viewWeight\)/);
    assert.match(shader.fragmentShader,/normalizeTransfer\(captureCoverage\)/);
    assert.match(shader.fragmentShader,/captureDiffuseTransfer/);
    assert.match(shader.fragmentShader,/#if defined\(USE_ENVMAP\).*NUM_RECT_AREA_LIGHTS > 0/s,
      'area-light environment sampling guard is present in the composed shader');
    assert.equal((shader.fragmentShader.match(/getPointLightInfo\( pointLight, geometryPosition, directLight \)/g)??[]).length,4,
      'direct-light shader chunk is still composed for the base branch and three per-view evaluations');
    assert.match(shader.fragmentShader,/capturePerViewDirectSpecular0=reflectedLight\.directSpecular/);
    assert.match(shader.fragmentShader,/capturePerViewIndirectSpecular2=reflectedLight\.indirectSpecular/);
    assert.match(shader.fragmentShader,/RE_Direct\( directLight, geometryPosition/);
    assert.match(shader.fragmentShader,/RE_IndirectSpecular/);
  }finally{proxy.dispose();capture.dispose();}
});
