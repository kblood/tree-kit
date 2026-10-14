import * as THREE from 'three';
import {liveGlsl} from './tree-impostor-reference-shader.ts';

/** Experimental thin, two-sided leaf response. Uses the sampled base colour
 * times a linear tint for transmission: a bounded subset inspired by Khronos
 * diffuse transmission, not a KHR_materials_diffuse_transmission importer.
 * The host's specular/Fresnel calculations are retained verbatim. */
export type LeafTransmissionOptions={factor?:number;tint?:readonly [number,number,number]};
const VERSION='atlas-leaf-diffuse-1';
const installed=new WeakSet<THREE.Material>();

function replaceLiveOnce(source:string,anchor:string,replacement:string){
  const live=liveGlsl(source),at=live.indexOf(anchor);
  if(at<0||live.indexOf(anchor,at+anchor.length)>=0)throw new Error(`Leaf transmission shader hook changed: ${anchor}`);
  return source.slice(0,at)+replacement+source.slice(at+anchor.length);
}

const declarations=`
uniform float atlasLeafTransmission;
uniform vec3 atlasLeafTransmissionTint;
vec3 atlasLeafBackIrradiance = vec3(0.0);
vec3 atlasLeafBackIblIrradiance = vec3(0.0);
vec3 atlasLeafGeometricNormal = vec3(0.0);
`;

// Branch on a shared uniform so factor zero executes the exact original
// diffuse expression and does not sample opposite-hemisphere environment maps.
function split(original:string,expression:string){
  return `if (atlasLeafTransmission > 0.0) {\n${expression}\n} else {\n${original}\n}`;
}

/** Exported for source-contract tests. Does not mutate global ShaderChunk. */
export function patchLeafTransmissionShader(fragmentShader:string,physicalChunk=THREE.ShaderChunk.lights_physical_pars_fragment,normalChunk=THREE.ShaderChunk.normal_fragment_begin){
  if(liveGlsl(fragmentShader).includes('atlasLeafTransmission'))throw new Error('Leaf transmission is already installed');
  replaceLiveOnce(normalChunk,'vec3 nonPerturbedNormal = normal;','vec3 nonPerturbedNormal = normal;');
  let chunk=physicalChunk;
  const direct='reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );';
  chunk=replaceLiveOnce(chunk,direct,split(direct,`
    vec3 backIrradiance = saturate(dot(-atlasLeafGeometricNormal, directLight.direction)) * directLight.color;
    reflectedLight.directDiffuse += ((1.0-atlasLeafTransmission)*irradiance
      + atlasLeafTransmission*atlasLeafTransmissionTint*backIrradiance) * BRDF_Lambert(material.diffuseColor);`));

  const area='reflectedLight.directDiffuse += lightColor * material.diffuseColor * LTC_Evaluate( normal, viewDir, position, mat3( 1.0 ), rectCoords );';
  chunk=replaceLiveOnce(chunk,area,split(area,`
    reflectedLight.directDiffuse += lightColor * material.diffuseColor * (
      (1.0-atlasLeafTransmission)*LTC_Evaluate(normal, viewDir, position, mat3(1.0), rectCoords)
      + atlasLeafTransmission*atlasLeafTransmissionTint*LTC_Evaluate(-atlasLeafGeometricNormal, viewDir, position, mat3(1.0), rectCoords));`));

  const indirect='reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );';
  chunk=replaceLiveOnce(chunk,indirect,split(indirect,`
    reflectedLight.indirectDiffuse += ((1.0-atlasLeafTransmission)*irradiance
      + atlasLeafTransmission*atlasLeafTransmissionTint*atlasLeafBackIrradiance) * BRDF_Lambert(material.diffuseColor);`));

  const environment='reflectedLight.indirectDiffuse += diffuse * cosineWeightedIrradiance;';
  chunk=replaceLiveOnce(chunk,environment,split(environment,`
    reflectedLight.indirectDiffuse += diffuse * ((1.0-atlasLeafTransmission)*cosineWeightedIrradiance
      + atlasLeafTransmission*atlasLeafTransmissionTint*atlasLeafBackIblIrradiance*RECIPROCAL_PI);`));
  let shader=replaceLiveOnce(fragmentShader,'#include <lights_physical_pars_fragment>',declarations+chunk);
  shader=replaceLiveOnce(shader,'#include <lights_fragment_begin>',`
    // nonPerturbedNormal already includes vertex wind and DoubleSide flipping.
    // Transmission follows the thin surface, not bumps that can cross its side.
    atlasLeafGeometricNormal = nonPerturbedNormal;
    #include <lights_fragment_begin>
    if (atlasLeafTransmission > 0.0) {
      atlasLeafBackIrradiance = getAmbientLightIrradiance(ambientLightColor);
      #ifdef USE_LIGHT_PROBES
        atlasLeafBackIrradiance += getLightProbeIrradiance(lightProbe, -atlasLeafGeometricNormal);
      #endif
      #if NUM_HEMI_LIGHTS > 0
        #pragma unroll_loop_start
        for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
          atlasLeafBackIrradiance += getHemisphereLightIrradiance(hemisphereLights[ i ], -atlasLeafGeometricNormal);
        }
        #pragma unroll_loop_end
      #endif
    }`);
  shader=replaceLiveOnce(shader,'#include <lights_fragment_maps>',`#include <lights_fragment_maps>
    #if defined(USE_ENVMAP) && defined(STANDARD) && defined(ENVMAP_TYPE_CUBE_UV)
      if (atlasLeafTransmission > 0.0) {
        atlasLeafBackIblIrradiance = getIBLIrradiance(-atlasLeafGeometricNormal);
      }
    #endif`);
  // Both opposite irradiances must exist before the host calls its indirect REs.
  const live=liveGlsl(shader),end=live.indexOf('#include <lights_fragment_end>');
  if(end<0||live.indexOf('#include <lights_fragment_end>',end+1)>=0||end<live.lastIndexOf('atlasLeafBackIblIrradiance = getIBLIrradiance'))throw new Error('Leaf transmission indirect-light order changed');
  const normals=live.indexOf('#include <normal_fragment_maps>'),begin=live.indexOf('#include <lights_fragment_begin>'),maps=live.indexOf('#include <lights_fragment_maps>');
  if(normals<0||live.indexOf('#include <normal_fragment_maps>',normals+1)>=0||normals>begin||begin>maps||maps>end)throw new Error('Leaf transmission normal/light order changed');
  return shader;
}

function values(options:LeafTransmissionOptions){
  if(options===null||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='factor'&&key!=='tint'))throw new Error('Leaf transmission options must contain only factor and tint');
  const factor=options.factor===undefined?0:options.factor,tint=options.tint===undefined?[1,1,1]:options.tint;
  if(typeof factor!=='number'||!Number.isFinite(factor)||factor<0||factor>1||!Array.isArray(tint)||tint.length!==3||[0,1,2].some(i=>!Number.isFinite(tint[i])||tint[i]<0||tint[i]>1))throw new Error('Leaf transmission factor and linear tint must be in [0,1]');
  return {factor,tint:[tint[0],tint[1],tint[2]] as const};
}

function validateMaterial(material:THREE.MeshStandardMaterial){
  const physical=material as THREE.MeshPhysicalMaterial;
  if(!material.isMeshStandardMaterial||material.side!==THREE.DoubleSide||material.metalness!==0||material.metalnessMap||material.lightMap||material.aoMap||(physical.transmission??0)!==0||physical.transmissionMap)throw new Error('Leaf transmission requires a two-sided dielectric without metalness maps, lightmaps, AO maps or glass transmission');
}

/** Call AFTER the wind/deformation adapter. Shared uniforms work for all
 * instances and LODs; depth/distance materials are deliberately not changed.
 * Material flags affecting the supported domain must remain valid at compile.
 * Reapply explicitly if a material is cloned (Three does not clone hooks). */
export function installLeafTransmission(material:THREE.MeshStandardMaterial,options:LeafTransmissionOptions={}){
  const initial=values(options);validateMaterial(material);
  if(installed.has(material))throw new Error('Leaf transmission is already installed on this material');
  const factor={value:initial.factor},tint={value:new THREE.Vector3(...initial.tint)};
  const previousCompile=material.onBeforeCompile;
  // Capture the default key before installing our wrapper: Three's default key
  // reads this.onBeforeCompile and would otherwise describe the wrapper itself.
  const previousKey=material.customProgramCacheKey.bind(material);
  const baseKey=previousKey();
  const defaultKey=material.customProgramCacheKey===THREE.Material.prototype.customProgramCacheKey;
  const compile:THREE.Material['onBeforeCompile']=function(this:THREE.Material,shader,renderer){
    validateMaterial(material);
    previousCompile.call(this,shader,renderer);
    const patched=patchLeafTransmissionShader(shader.fragmentShader);
    if(shader.uniforms.atlasLeafTransmission||shader.uniforms.atlasLeafTransmissionTint)throw new Error('Leaf transmission uniform collision');
    shader.uniforms.atlasLeafTransmission=factor;
    shader.uniforms.atlasLeafTransmissionTint=tint;
    shader.fragmentShader=patched;
  };
  const key=()=>`${defaultKey?baseKey:previousKey()}|${VERSION}`;
  material.onBeforeCompile=compile;material.customProgramCacheKey=key;
  installed.add(material);material.needsUpdate=true;
  return {
    assertInstalled(){if(material.onBeforeCompile!==compile||material.customProgramCacheKey!==key)throw new Error('Leaf transmission hook was replaced after installation');},
    /** Values update atomically; no material/program per tree or per setting. */
    set(options:LeafTransmissionOptions){const next=values(options);factor.value=next.factor;tint.value.set(...next.tint);},
    get factor(){return factor.value;},
    get tint():readonly [number,number,number]{return [tint.value.x,tint.value.y,tint.value.z];},
  };
}
