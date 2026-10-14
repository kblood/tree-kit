import * as THREE from 'three';
import {forestCoverageGLSL} from './forest-coverage.ts';
import {treeAllometryGLSL,TREE_ALLOMETRY_IDENTITY_CODE,TREE_ALLOMETRY_VERSION} from './tree-allometry.ts';
import {LEGACY_TREE_TRUNK} from './tree-shape.ts';

/** Identical canonical ownership in color and the sun's depth pass. Hidden
 * legacy slots must not cast a second tree underneath their detailed asset. */
export function installLegacyForestCoverage(material:THREE.Material){
  const prior=material.onBeforeCompile,key=material.customProgramCacheKey();
  material.onBeforeCompile=function(shader,renderer){
    prior.call(this,shader,renderer);
    shader.vertexShader='attribute float instanceCoverage,instanceForestSeed;\nflat varying float vForestCoverage,vForestSeed;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvForestCoverage=instanceCoverage;vForestSeed=instanceForestSeed;');
    shader.fragmentShader='flat varying float vForestCoverage,vForestSeed;\n'+forestCoverageGLSL+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <alphahash_fragment>',`#ifdef USE_ALPHAHASH
      diffuseColor.a *= vForestCoverage;
      #include <alphahash_fragment>
      #else
      if(atlasForestHash(uint(vForestSeed+.5))>=atlasForestLevel(vForestCoverage))discard;
      #endif`);
  };
  material.customProgramCacheKey=()=>`${key}/legacy-forest-coverage-3`;
}
/** Species crown/trunk proportions for the unit-height legacy primitive, in
 * colour and depth alike. `instanceTreeAllometry` holds the packed ratio code
 * minus the identity code, so an unwritten slot keeps authored proportions. */
export function installLegacyTreeAllometry(material:THREE.Material){
  const prior=material.onBeforeCompile,key=material.customProgramCacheKey();
  material.onBeforeCompile=function(shader,renderer){
    prior.call(this,shader,renderer);
    shader.vertexShader=`attribute float instanceTreeAllometry;\n${treeAllometryGLSL}
vec2 legacyTreeAllometry(){return treeAllometryRatios((instanceTreeAllometry+${TREE_ALLOMETRY_IDENTITY_CODE}.0)*256.0);}\n`+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <beginnormal_vertex>',`#include <beginnormal_vertex>
      {float k=treeAllometryHorizontalRatio(position.xz,${LEGACY_TREE_TRUNK.baseRadius},legacyTreeAllometry());
        objectNormal=normalize(vec3(objectNormal.x/k,objectNormal.y,objectNormal.z/k));}`);
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
      transformed=treeAllometryPoint(transformed,${LEGACY_TREE_TRUNK.baseRadius},legacyTreeAllometry());`);
  };
  material.customProgramCacheKey=()=>`${key}/${TREE_ALLOMETRY_VERSION}`;
}
export function forestMaterial(vertexColors:boolean){
  const material=new THREE.MeshLambertMaterial({vertexColors,color:vertexColors?0xffffff:0x456c28});
  installLegacyTreeAllometry(material);installLegacyForestCoverage(material);return material;
}
export function forestDepthMaterial(){
  const material=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking});
  installLegacyTreeAllometry(material);installLegacyForestCoverage(material);return material;
}
