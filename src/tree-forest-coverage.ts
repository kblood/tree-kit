import type {Material} from 'three';
import {forestCoverageGLSL} from './forest-coverage.ts';
import {liveGlsl} from './tree-impostor-reference-shader.ts';

/** Compose canonical forest ownership with native leaf alpha and wind. The
 * same hook belongs on the color, depth and distance materials. */
export function installTreeForestCoverage(material:Material){
  const prior=material.onBeforeCompile,key=material.customProgramCacheKey;
  const baseKey=key.call(material);
  material.onBeforeCompile=function(shader,renderer){
    prior.call(this,shader,renderer);
    const vertexAnchor='#include <begin_vertex>',fragmentAnchor='#include <alphahash_fragment>';
    function insert(source:string,anchor:string,replacement:string){
      const live=liveGlsl(source),index=live.indexOf(anchor);
      if(index<0||live.indexOf(anchor,index+anchor.length)>=0)throw new Error(`Forest tree shader anchor changed: ${anchor}`);
      return source.slice(0,index)+replacement+source.slice(index+anchor.length);
    }
    shader.vertexShader='attribute vec2 instanceForest;\nflat varying vec2 vAtlasForest;\n'+insert(shader.vertexShader,vertexAnchor,vertexAnchor+'\nvAtlasForest=instanceForest;');
    shader.fragmentShader='flat varying vec2 vAtlasForest;\n'+forestCoverageGLSL+insert(shader.fragmentShader,fragmentAnchor,
      'if(atlasForestHash(uint(vAtlasForest.y+.5))>=atlasForestLevel(vAtlasForest.x))discard;\n'+fragmentAnchor);
  };
  material.customProgramCacheKey=()=>`${baseKey}/atlas-tree-forest-coverage-1`;
}
