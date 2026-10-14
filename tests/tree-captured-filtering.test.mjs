import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {ShaderLib} from 'three';
import {loadTreeCapture,TreeCapturedImpostor} from '../src/tree-captured-impostor.ts';
import {treeCaptureViews} from '../src/tree-impostor-views.ts';
import {packTreeCaptureLayer} from '../src/tree-impostor-filter.ts';

function fixture(){
  const grid=3,size=32,views=treeCaptureViews(grid),files=new Map(),artifacts=[];
  for(let mip=0,width=size;width>=1;mip++,width/=2)for(const view of views){
    const colour=new Float32Array(width*width*4),data=new Float32Array(width*width*4),classification=new Float32Array(width*width);
    // One partially covered material sample and one transparent padded sample
    // whose unassociated attributes are deliberately bright/nearby.
    colour.set([.25,.5,.75,.5]);data.set([0,0,1,.6]);classification[0]=.8;
    if(width>1){colour.set([1,1,1,0],4);data.set([1,0,0,.95],4);classification[1]=1;}
    for(const [channel,array] of [['colour',colour],['data',data],['classification',classification]]){
      const path=`view-${String(view.index).padStart(3,'0')}/mip-${mip}.${channel}.f32`;
      const bytes=new Uint8Array(array.buffer.slice(array.byteOffset,array.byteOffset+array.byteLength));
      files.set(path,bytes.buffer);
      artifacts.push({path,bytes:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex')});
    }
  }
  return {files,manifest:{schemaVersion:2,operation:'atlas-tree-impostor-capture-2',version:'tree-material-capture-2',
    rowOrder:'bottom-to-top',colour:'linear-unassociated-rgb-area-coverage',data:'object-normal-xyz-normalized-frontmost-depth',classification:'leaf-fraction',
    options:{grid,size,heightM:16},views,radius:8,center:[0,8,0],artifacts}};
}
const read=files=>async path=>files.get(path);

test('loader keeps the historical unassociated default and offers coverage-weighted packing without mutating capture bytes',async()=>{
  const {files,manifest}=fixture(),snapshot=new Map([...files].map(([p,b])=>[p,new Uint8Array(b.slice(0))]));
  const legacy=await loadTreeCapture(manifest,read(files));
  const weighted=await loadTreeCapture(manifest,read(files),{filtering:'coverage-weighted'});
  assert.equal(legacy.filtering,'legacy-unassociated');
  assert.equal(weighted.filtering,'coverage-weighted');
  const legacyColour=legacy.colourTexture.mipmaps[0].data,weightedColour=weighted.colourTexture.mipmaps[0].data;
  assert.equal(legacyColour[4],255,'legacy mode retains the transparent white capture padding');
  assert.equal(weightedColour[4],0,'weighted mode removes transparent padding from filtered colour');
  assert.equal(weightedColour[3],128);
  const rawColour=new Float32Array(files.get('view-000/mip-0.colour.f32'));
  const rawData=new Float32Array(files.get('view-000/mip-0.data.f32'));
  const rawClass=new Float32Array(files.get('view-000/mip-0.classification.f32'));
  const expected=packTreeCaptureLayer(rawColour,rawData,rawClass);
  assert.deepEqual(weighted.colourTexture.mipmaps[0].data.slice(0,8),expected.colour.slice(0,8));
  assert.deepEqual(weighted.dataTexture.mipmaps[0].data.slice(0,8),expected.data.slice(0,8));
  assert.deepEqual(weighted.classTexture.mipmaps[0].data.slice(0,8),expected.classification.slice(0,8));
  for(const [path,buffer] of files)assert.deepEqual(new Uint8Array(buffer),snapshot.get(path),`source attachment changed: ${path}`);
  legacy.dispose();weighted.dispose();
});

test('shader hook compensates weighted colour, depth/normal and leaf-class samples while legacy remains opt-out',async()=>{
  assert.match(ShaderLib.physical.fragmentShader,/#include <lights_fragment_begin>\s*#include <lights_fragment_maps>\s*#include <lights_fragment_end>/,
    'the pinned MeshPhysical shader provides the exact lighting sequence the lab adapts');
  const {files,manifest}=fixture(),makeMaterials=()=>[
    new THREE.MeshStandardMaterial({name:'MAT_AtlasBark',metalness:0,roughness:.9}),
    new THREE.MeshStandardMaterial({name:'MAT_AtlasFoliage',metalness:0,roughness:.8}),
  ];
  for(const [filtering,expected] of [['legacy-unassociated',0],['coverage-weighted',1]]){
    const capture=await loadTreeCapture(manifest,read(files),{filtering}),proxy=new TreeCapturedImpostor(capture,makeMaterials());
    assert.equal(proxy.uniforms.captureCoverageWeighted.value,expected);
    assert.equal(proxy.uniforms.captureRelightViews.value,0,'per-view PBR is an opt-in lab experiment');
    const shader={uniforms:{},vertexShader:'#include <begin_vertex>',fragmentShader:[
      '#include <logdepthbuf_fragment>','#include <alphahash_fragment>','#include <normal_fragment_begin>',
      '#include <roughnessmap_fragment>','#include <lights_physical_fragment>','#include <lights_fragment_begin>','#include <lights_fragment_maps>','#include <lights_fragment_end>','#include <opaque_fragment>','#include <dithering_fragment>',
    ].join('\n')};
    proxy.mesh.material.onBeforeCompile(shader,{});
    assert.match(shader.fragmentShader,/captureCoverageWeighted/);
    assert.match(shader.fragmentShader,/data\s*\/=?\s*max\(alpha,1e-6\)/);
    assert.match(shader.fragmentShader,/colour\.rgb\s*\/=?\s*alpha/);
    assert.match(shader.fragmentShader,/classification\.r\s*\/=?\s*alpha/);
    assert.match(shader.fragmentShader,/vec3\(-hitView\.z\)/,'depth diagnostic writes metric view depth after display transforms');
    assert.match(shader.fragmentShader,/gl_FragColor\.a=captureCoverage/,'colour diagnostic retains continuous coverage');
    assert.match(shader.fragmentShader,/hitDistance=dot\(weights,vec3\(t0,t1,t2\)\)/,'depth uses continuous material weights');
    assert.match(shader.fragmentShader,/leaf>\.5&&dot\(normal,rd\)>0\./,'two-sided leaf normals face the viewing ray before blending');
    assert.match(shader.fragmentShader,/captureRelightViews/);
    assert.match(shader.fragmentShader,/captureViewHit0=.*t0/);assert.match(shader.fragmentShader,/captureViewHit1=.*t1/);assert.match(shader.fragmentShader,/captureViewHit2=.*t2/);
    assert.equal((shader.fragmentShader.match(/getPointLightInfo\( pointLight, geometryPosition, directLight \)/g)??[]).length,4,
      'the legacy branch and all three views use the installed Three PBR direct-light chunk');
    assert.equal((shader.fragmentShader.match(/roughnessFactor=mix\(captureRoughness\.x,captureRoughness\.y,l[012]\)/g)??[]).length,3);
    assert.equal((shader.fragmentShader.match(/capturedSpecular=mix\(captureSpecular\.x,captureSpecular\.y,l[012]\)/g)??[]).length,3);
    assert.match(shader.fragmentShader,/reflectedLight\.directDiffuse=capturePerViewDirectDiffuse0\*weights\.x/);
    assert.equal(shader.uniforms.captureCoverageWeighted.value,expected);
    proxy.dispose();capture.dispose();
  }
});

test('loader rejects unknown filtering modes before reading attachments',async()=>{
  const {manifest}=fixture();let reads=0;
  await assert.rejects(loadTreeCapture(manifest,async()=>{reads++;return new ArrayBuffer(0);},{filtering:'mystery'}),/Unsupported tree capture filtering mode/);
  assert.equal(reads,0);
});
