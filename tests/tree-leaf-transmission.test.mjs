import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {installLeafTransmission,patchLeafTransmissionShader} from '../src/tree-leaf-transmission.ts';

const shaderFixture=()=>({
  uniforms:{},
  vertexShader:THREE.ShaderLib.standard.vertexShader,
  fragmentShader:THREE.ShaderLib.standard.fragmentShader,
});
const live=(source)=>source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,(m)=>m.replace(/[^\r\n]/g,' '));

function material(){return new THREE.MeshStandardMaterial({side:THREE.DoubleSide,metalness:0});}

test('default values preserve zero-transmission expressions and public setting updates are atomic',()=>{
  const mat=material(),control=installLeafTransmission(mat);
  assert.equal(control.factor,0);
  assert.deepEqual(control.tint,[1,1,1]);
  const before={factor:control.factor,tint:control.tint};
  for(const options of [
    null,[],{factor:null},{tint:null},{factor:.2,unknown:1},
    {factor:-0.01},{factor:1.01},{factor:NaN},{factor:Infinity},
    {tint:[-0.1,1,1]},{tint:[1,1,1.1]},{tint:[1,NaN,1]},
    {tint:[1,1]},{tint:new Float32Array([1,1,1])},{tint:[1,,1]},
  ]) assert.throws(()=>control.set(options));
  assert.equal(control.factor,before.factor);
  assert.deepEqual(control.tint,before.tint,'a rejected pair does not partially update either uniform');
  control.set({factor:0.65,tint:[0.4,0.7,1]});
  assert.equal(control.factor,0.65);
  assert.deepEqual(control.tint,[0.4,0.7,1]);
  assert.throws(()=>installLeafTransmission(mat),/already installed/);
});

test('patch preserves the host specular paths and branches around every added diffuse contribution',()=>{
  const host=THREE.ShaderChunk.lights_physical_pars_fragment;
  const patched=patchLeafTransmissionShader(THREE.ShaderLib.standard.fragmentShader,host);
  const cleaned=live(patched);
  const specularExpressions=[
    'reflectedLight.directSpecular += lightColor * fresnel * LTC_Evaluate( normal, viewDir, position, mInv, rectCoords );',
    'reflectedLight.directSpecular += irradiance * BRDF_GGX_Multiscatter( directLight.direction, geometryViewDir, geometryNormal, material );',
    'reflectedLight.indirectSpecular += radiance * singleScattering;',
    'reflectedLight.indirectSpecular += multiScattering * cosineWeightedIrradiance;',
  ];
  for(const expression of specularExpressions){
    assert.equal((cleaned.match(new RegExp(expression.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))??[]).length,
      (live(host).match(new RegExp(expression.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))??[]).length,
      `host specular path remains unchanged: ${expression}`);
  }
  assert.equal((cleaned.match(/if\s*\(\s*atlasLeafTransmission\s*>\s*0\.0\s*\)/g)??[]).length,6,
    'four diffuse equations plus ambient-light and environment sampling are opt-in');
  for(const original of [
    'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );',
    'reflectedLight.directDiffuse += lightColor * material.diffuseColor * LTC_Evaluate( normal, viewDir, position, mat3( 1.0 ), rectCoords );',
    'reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );',
    'reflectedLight.indirectDiffuse += diffuse * cosineWeightedIrradiance;',
  ]) assert.ok(cleaned.includes(`else {\n${original}\n}`),`factor zero keeps exact host expression: ${original}`);

  assert.ok(cleaned.includes('atlasLeafTransmissionTint*backIrradiance'));
  assert.ok(cleaned.includes('atlasLeafTransmissionTint*LTC_Evaluate(-atlasLeafGeometricNormal'));
  assert.ok(cleaned.includes('atlasLeafTransmissionTint*atlasLeafBackIrradiance'));
  assert.ok(cleaned.includes('atlasLeafTransmissionTint*atlasLeafBackIblIrradiance'));
  assert.ok(cleaned.indexOf('atlasLeafBackIrradiance = getAmbientLightIrradiance')<cleaned.indexOf('#include <lights_fragment_maps>'));
  assert.ok(cleaned.indexOf('atlasLeafBackIblIrradiance = getIBLIrradiance')<cleaned.indexOf('#include <lights_fragment_end>'),
    'opposite-hemisphere irradiance is sampled before indirect RE evaluation');
  assert.ok(cleaned.includes('atlasLeafGeometricNormal = nonPerturbedNormal;'));
  assert.ok(cleaned.includes('getLightProbeIrradiance(lightProbe, -atlasLeafGeometricNormal)'));
  assert.ok(cleaned.includes('getHemisphereLightIrradiance(hemisphereLights[ i ], -atlasLeafGeometricNormal)'));
  assert.ok(cleaned.indexOf('atlasLeafGeometricNormal = nonPerturbedNormal;')<cleaned.indexOf('#include <lights_fragment_begin>'));
});

test('install composes prior compile hooks and cache key while exposing shared uniforms',()=>{
  const mat=material();
  let priorCalled=0,priorThis=null,priorRenderer=null;
  mat.onBeforeCompile=function(shader,renderer){priorCalled++;priorThis=this;priorRenderer=renderer;shader.vertexShader+='\n// preserved leaf-wind hook';shader.uniforms.windTime={value:7};};
  const priorKey=mat.customProgramCacheKey();
  const priorVersion=mat.version;
  const control=installLeafTransmission(mat,{factor:0.2,tint:[0.5,0.8,0.9]});
  control.assertInstalled();
  assert.ok(mat.version>priorVersion,'installation marks material program for recompilation');
  assert.equal(mat.customProgramCacheKey(),`${priorKey}|atlas-leaf-diffuse-1`);
  const shader=shaderFixture();
  const renderer={label:'test renderer'};
  mat.onBeforeCompile(shader,renderer);
  assert.equal(priorCalled,1);
  assert.equal(priorThis,mat);
  assert.equal(priorRenderer,renderer);
  assert.ok(shader.vertexShader.includes('// preserved leaf-wind hook'));
  assert.deepEqual(shader.uniforms.windTime,{value:7});
  assert.deepEqual(shader.uniforms.atlasLeafTransmission, {value:0.2});
  assert.deepEqual(shader.uniforms.atlasLeafTransmissionTint.value.toArray(),[0.5,0.8,0.9]);
  assert.match(shader.fragmentShader,/atlasLeafBackIblIrradiance/);
  const sharedFactor=shader.uniforms.atlasLeafTransmission,sharedTint=shader.uniforms.atlasLeafTransmissionTint;
  const shader2=shaderFixture();mat.onBeforeCompile(shader2,renderer);
  assert.equal(shader2.uniforms.atlasLeafTransmission,sharedFactor,'compiled variants share the same factor uniform');
  assert.equal(shader2.uniforms.atlasLeafTransmissionTint,sharedTint,'compiled variants share the same tint uniform');
  control.set({factor:0.8,tint:[0.1,0.2,0.3]});
  assert.equal(shader.uniforms.atlasLeafTransmission.value,0.8);
  assert.deepEqual(shader2.uniforms.atlasLeafTransmissionTint.value.toArray(),[0.1,0.2,0.3]);
  control.assertInstalled();
  const installedHook=mat.onBeforeCompile;
  mat.onBeforeCompile=function(...args){return installedHook.apply(this,args);};
  assert.throws(()=>control.assertInstalled(),/hook was replaced/);
  mat.onBeforeCompile=installedHook;control.assertInstalled();
  mat.metalness=0.1;
  assert.throws(()=>mat.onBeforeCompile(shaderFixture(),renderer),/requires a two-sided dielectric/,'unsupported material edits fail at recompile');

  const custom=material();
  custom.customProgramCacheKey=()=> 'caller-key';
  installLeafTransmission(custom);
  assert.equal(custom.customProgramCacheKey(),'caller-key|atlas-leaf-diffuse-1');
});

test('source guards ignore comment-shaped anchors and reject missing or duplicate live hooks',()=>{
  const anchor='reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );';
  const original=THREE.ShaderChunk.lights_physical_pars_fragment;
  assert.throws(()=>patchLeafTransmissionShader(THREE.ShaderLib.standard.fragmentShader,original.replace(anchor,'')),/shader hook changed/);
  assert.throws(()=>patchLeafTransmissionShader(THREE.ShaderLib.standard.fragmentShader,`${original}\n${anchor}`),/shader hook changed/);
  assert.throws(()=>patchLeafTransmissionShader(THREE.ShaderLib.standard.fragmentShader.replace('#include <lights_fragment_maps>',''),original),/shader hook changed/);
  assert.throws(()=>patchLeafTransmissionShader(THREE.ShaderLib.standard.fragmentShader.replace('#include <lights_fragment_begin>','#include <lights_fragment_begin>\n#include <lights_fragment_begin>'),original),/shader hook changed/);
  const wrongOrder=THREE.ShaderLib.standard.fragmentShader.replace('#include <lights_fragment_maps>','').replace('#include <lights_fragment_end>','#include <lights_fragment_end>\n#include <lights_fragment_maps>');
  assert.throws(()=>patchLeafTransmissionShader(wrongOrder,original),/indirect-light order changed/);
  const normalHook='vec3 nonPerturbedNormal = normal;';
  assert.throws(()=>patchLeafTransmissionShader(THREE.ShaderLib.standard.fragmentShader,original,THREE.ShaderChunk.normal_fragment_begin.replace(normalHook,'')),/shader hook changed/);
  assert.throws(()=>patchLeafTransmissionShader(THREE.ShaderLib.standard.fragmentShader,original,`${THREE.ShaderChunk.normal_fragment_begin}\n${normalHook}`),/shader hook changed/);
  const commentOnlyNormal=`// ${normalHook}\n${THREE.ShaderChunk.normal_fragment_begin.replace(normalHook,'')}`;
  assert.throws(()=>patchLeafTransmissionShader(THREE.ShaderLib.standard.fragmentShader,original,commentOnlyNormal),/shader hook changed/);
  const fake=`// ${anchor}\n${original}`;
  const ignoresComment=patchLeafTransmissionShader(THREE.ShaderLib.standard.fragmentShader,fake);
  assert.ok(live(ignoresComment).includes(anchor),'comment-shaped copy does not hide or duplicate the live expression');
  const already=patchLeafTransmissionShader(THREE.ShaderLib.standard.fragmentShader,original);
  assert.throws(()=>patchLeafTransmissionShader(already,original),/already installed/);
});

test('installation rejects materials outside the explicitly supported leaf domain',()=>{
  const variants=[
    new THREE.MeshStandardMaterial({side:THREE.FrontSide}),
    new THREE.MeshStandardMaterial({side:THREE.DoubleSide,metalness:0.1}),
    new THREE.MeshStandardMaterial({side:THREE.DoubleSide,metalness:0,metalnessMap:new THREE.Texture()}),
    new THREE.MeshStandardMaterial({side:THREE.DoubleSide,metalness:0,lightMap:new THREE.Texture()}),
    new THREE.MeshStandardMaterial({side:THREE.DoubleSide,metalness:0,aoMap:new THREE.Texture()}),
    new THREE.MeshPhysicalMaterial({side:THREE.DoubleSide,metalness:0,transmission:0.1}),
  ];
  for(const mat of variants) assert.throws(()=>installLeafTransmission(mat),/requires a two-sided dielectric/);
});
