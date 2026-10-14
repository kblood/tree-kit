import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {installTreeForestCoverage} from '../src/tree-forest-coverage.ts';
import {installLeafTransmission} from '../src/tree-leaf-transmission.ts';
import {liveGlsl} from '../src/tree-impostor-reference-shader.ts';

for(const [name,make] of [
  ['standard',()=>new THREE.MeshStandardMaterial({side:THREE.DoubleSide})],
  ['depth',()=>new THREE.MeshDepthMaterial()],
  ['distanceRGBA',()=>new THREE.MeshDistanceMaterial()],
])test(`forest ownership composes with ${name} shaders and retains native leaf alpha`,()=>{
  const material=make(),base=THREE.ShaderLib[name];
  let priorCalls=0;
  material.onBeforeCompile=function(shader){assert.equal(this,material);priorCalls++;shader.uniforms.prior={value:42};};
  material.customProgramCacheKey=()=>`prior-${name}`;
  installTreeForestCoverage(material);
  const shader={vertexShader:base.vertexShader,fragmentShader:base.fragmentShader,uniforms:{}};
  material.onBeforeCompile(shader,{});
  assert.equal(priorCalls,1);assert.equal(shader.uniforms.prior.value,42);
  assert.equal(material.customProgramCacheKey(),`prior-${name}/atlas-tree-forest-coverage-1`);
  assert.match(shader.vertexShader,/vAtlasForest=instanceForest;/);
  assert.match(shader.fragmentShader,/atlasForestHash\(uint\(vAtlasForest.y\+\.5\)\)/);
  assert.equal(shader.fragmentShader.split('#include <alphahash_fragment>').length,2);
  assert.ok(shader.fragmentShader.includes('#include <alphatest_fragment>'));
  assert.ok(shader.fragmentShader.indexOf('>=atlasForestLevel(vAtlasForest.x))discard;')<shader.fragmentShader.indexOf('#include <alphahash_fragment>'));
  material.dispose();
});

test('forest shader insertion ignores comment anchors and fails on absent or duplicated live anchors',()=>{
  const material=new THREE.MeshStandardMaterial();installTreeForestCoverage(material);
  const base=THREE.ShaderLib.standard;
  const make=()=>({uniforms:{},vertexShader:'// #include <begin_vertex>\n'+base.vertexShader,
    fragmentShader:'/* #include <alphahash_fragment> */\n'+base.fragmentShader});
  const shader=make();material.onBeforeCompile(shader,{});
  assert.equal(liveGlsl(shader.vertexShader).split('vAtlasForest=instanceForest;').length,2);
  for(const [field,anchor] of [['vertexShader','#include <begin_vertex>'],['fragmentShader','#include <alphahash_fragment>']]){
    const missing=make();missing[field]=missing[field].replaceAll(anchor,'');
    assert.throws(()=>material.onBeforeCompile(missing,{}),/shader anchor changed/);
    const duplicate=make();duplicate[field]+='\n'+anchor;
    assert.throws(()=>material.onBeforeCompile(duplicate,{}),/shader anchor changed/);
  }
  material.dispose();
});

test('optional leaf transmission can wrap forest coverage without losing either hook',()=>{
  const material=new THREE.MeshStandardMaterial({side:THREE.DoubleSide,metalness:0});
  installTreeForestCoverage(material);
  const controller=installLeafTransmission(material,{factor:.35});
  const shader={uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader};
  material.onBeforeCompile(shader,{});controller.assertInstalled();
  assert.match(shader.fragmentShader,/atlasForestLevel\(vAtlasForest.x\)/);
  assert.match(shader.fragmentShader,/atlasLeafTransmission/);
  assert.match(material.customProgramCacheKey(),/atlas-tree-forest-coverage-1/);
  material.dispose();
});
