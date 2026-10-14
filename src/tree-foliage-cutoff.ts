import type {Material} from 'three';
import {liveGlsl} from './tree-impostor-reference-shader.ts';

/** Mip-level-aware foliage alpha cutoff.
 *
 * The coverage-preserving mip chain (tree-foliage-coverage-mips-1) makes each
 * *texel* of a reduced level pass the authored MASK cutoff in the right
 * proportion, but it does so by parking passing texels just above the cutoff.
 * Hardware trilinear filtering then blends those texels with their failing
 * neighbours and with the adjacent level, so at the mip levels LOD1 crowns use
 * between ~150 m and the far-atlas hand-off, a fixed 0.5 test keeps only a
 * third of the Pine needle area (CPU emulation, docs/tree-handoff-2026-09-29.md).
 *
 * This module measures, once per family and deterministically, the alpha
 * distribution the GPU actually produces at each fractional mip level λ and
 * picks the cutoff that keeps the base level's coverage there. λ=0 is pinned
 * to the authored cutoff, so full-resolution close-ups are unchanged. */
export const TREE_FOLIAGE_LOD_CUTOFF_VERSION='tree-foliage-lod-cutoff-1';
/** Table spacing in mip levels. The shader interpolates linearly between entries. */
export const TREE_FOLIAGE_LOD_CUTOFF_STEP=.5;
const DEFAULT_GRID=256;

export type TreeFoliageAlphaLevel={width:number;height:number;data:ArrayLike<number>};
export type TreeFoliageLodCutoffs={
  version:string;step:number;maxLevel:number;authoredCutoff:number;baseCoverage:number;grid:number;
  /** Cutoff for λ = index × step. */
  cutoffs:number[];
  /** Fraction of trilinear samples the authored cutoff keeps at the same λ (before). */
  authoredCoverage:number[];
  /** Fraction the calibrated cutoff keeps (after). */
  calibratedCoverage:number[];
};

function alphaAt(level:TreeFoliageAlphaLevel,x:number,y:number){
  const w=level.width,h=level.height,i=((x%w)+w)%w,j=((y%h)+h)%h;
  return level.data[(j*w+i)*4+3]!/255;
}
/** Bilinear alpha with repeat wrap and texel-centre convention (GL_LINEAR). */
export function sampleTreeFoliageBilinearAlpha(level:TreeFoliageAlphaLevel,u:number,v:number){
  const x=u*level.width-.5,y=v*level.height-.5,x0=Math.floor(x),y0=Math.floor(y),fx=x-x0,fy=y-y0;
  return (alphaAt(level,x0,y0)*(1-fx)+alphaAt(level,x0+1,y0)*fx)*(1-fy)+(alphaAt(level,x0,y0+1)*(1-fx)+alphaAt(level,x0+1,y0+1)*fx)*fy;
}
/** GL_LINEAR_MIPMAP_LINEAR alpha at fractional level λ (clamped to the chain). */
export function sampleTreeFoliageTrilinearAlpha(levels:readonly TreeFoliageAlphaLevel[],u:number,v:number,lambda:number){
  const max=levels.length-1,l=Math.min(max,Math.max(0,lambda)),l0=Math.floor(l),l1=Math.min(max,l0+1),f=l-l0;
  const a=sampleTreeFoliageBilinearAlpha(levels[l0]!,u,v);
  return f===0?a:a*(1-f)+sampleTreeFoliageBilinearAlpha(levels[l1]!,u,v)*f;
}

function assertLevels(levels:readonly TreeFoliageAlphaLevel[]){
  if(!Array.isArray(levels)||levels.length<2||levels.length>12)throw new Error('Foliage cutoff calibration needs a base level and at least one mip');
  for(let i=0;i<levels.length;i++){
    const level=levels[i]!,w=levels[0]!.width>>i,h=levels[0]!.height>>i;
    if(!level||level.width!==Math.max(1,w)||level.height!==Math.max(1,h)||!level.data||level.data.length!==level.width*level.height*4)
      throw new Error('Foliage cutoff calibration needs a complete power-of-two RGBA mip chain');
  }
}

/** Deterministic: a fixed jittered lattice (integer hash offsets) over the
 * whole texture, trilinear alpha per λ, and the (1 − baseCoverage) quantile. */
export function calibrateTreeFoliageLodCutoffs(levels:readonly TreeFoliageAlphaLevel[],baseCoverage:number,authoredCutoff:number,
  options:{grid?:number}={}):TreeFoliageLodCutoffs{
  assertLevels(levels);
  if(!(Number.isFinite(baseCoverage)&&baseCoverage>0&&baseCoverage<1))throw new Error('Foliage base coverage must lie strictly between 0 and 1');
  if(!(Number.isFinite(authoredCutoff)&&authoredCutoff>0&&authoredCutoff<1))throw new Error('Foliage cutoff must lie strictly between 0 and 1');
  const grid=options.grid??DEFAULT_GRID;
  if(!Number.isInteger(grid)||grid<16||grid>1024)throw new Error('Invalid foliage cutoff calibration grid');
  const maxLevel=levels.length-1,steps=Math.round(maxLevel/TREE_FOLIAGE_LOD_CUTOFF_STEP)+1;
  const u=new Float64Array(grid*grid),v=new Float64Array(grid*grid);
  for(let j=0,k=0;j<grid;j++)for(let i=0;i<grid;i++,k++){
    u[k]=(i+((j*7919+i*104729)%997)/997)/grid;v[k]=(j+((i*6007+j*3571)%991)/991)/grid;
  }
  const values=new Float64Array(grid*grid),cutoffs:number[]=[],authoredCoverage:number[]=[],calibratedCoverage:number[]=[];
  const keep=(sorted:Float64Array,c:number)=>{let lo=0,hi=sorted.length;while(lo<hi){const m=(lo+hi)>>1;if(sorted[m]!<c)lo=m+1;else hi=m;}return (sorted.length-lo)/sorted.length;};
  for(let s=0;s<steps;s++){
    const lambda=s*TREE_FOLIAGE_LOD_CUTOFF_STEP;
    for(let k=0;k<values.length;k++)values[k]=sampleTreeFoliageTrilinearAlpha(levels,u[k]!,v[k]!,lambda);
    values.sort();
    const quantile=values[Math.min(values.length-1,Math.max(0,Math.floor((1-baseCoverage)*values.length)))]!;
    // Never below one 8-bit step: fully transparent texels must still discard.
    const cutoff=s===0?authoredCutoff:Math.min(1,Math.max(1/255,quantile));
    cutoffs.push(+cutoff.toFixed(6));authoredCoverage.push(keep(values,authoredCutoff));calibratedCoverage.push(keep(values,cutoffs[s]!));
  }
  return {version:TREE_FOLIAGE_LOD_CUTOFF_VERSION,step:TREE_FOLIAGE_LOD_CUTOFF_STEP,maxLevel,authoredCutoff,baseCoverage,grid,cutoffs,authoredCoverage,calibratedCoverage};
}

/** JS mirror of the GLSL lookup (used by tests and CPU emulation). */
export function treeFoliageLodCutoff(table:Pick<TreeFoliageLodCutoffs,'cutoffs'|'step'|'maxLevel'>,lambda:number){
  const x=Math.min(table.maxLevel,Math.max(0,lambda))/table.step,i=Math.floor(x),j=Math.min(table.cutoffs.length-1,i+1);
  return table.cutoffs[i]!+(table.cutoffs[j]!-table.cutoffs[i]!)*(x-i);
}

export function treeFoliageLodCutoffGLSL(count:number,maxLevel:number,step:number){
  return `uniform float atlasFoliageCutoffs[${count}];
float atlasFoliageLodCutoff(vec2 uv){
  vec2 texel=uv*vec2(textureSize(map,0));
  float rho=max(length(dFdx(texel)),length(dFdy(texel)));
  float x=clamp(log2(max(rho,1e-8)),0.0,${maxLevel.toFixed(1)})/${step.toFixed(4)};
  int i=int(floor(x));int j=min(i+1,${count-1});
  return mix(atlasFoliageCutoffs[i],atlasFoliageCutoffs[j],x-float(i));
}
`;
}
const ANCHOR='#include <alphatest_fragment>';

/** Replace three's fixed alphaTest with the λ-calibrated table. Install on the
 * foliage colour material and its depth/distance shadow materials (and the far
 * atlas capture) so every pass keeps the same leaves. Requires a mapped MASK
 * material; hashed-alpha materials are left alone. */
export function installTreeFoliageLodCutoff(material:Material&{map?:unknown;alphaTest:number;alphaHash?:boolean},table:TreeFoliageLodCutoffs){
  if(!material.map||!(material.alphaTest>0)||material.alphaHash)throw new Error('LOD cutoff needs a mapped alpha-tested foliage material');
  if(table.version!==TREE_FOLIAGE_LOD_CUTOFF_VERSION||table.cutoffs.length!==Math.round(table.maxLevel/table.step)+1)throw new Error('Invalid foliage LOD cutoff table');
  const prior=material.onBeforeCompile,key=material.customProgramCacheKey;
  const uniform={value:table.cutoffs.slice()};
  material.onBeforeCompile=function(shader,renderer){
    prior.call(this,shader,renderer);
    const live=liveGlsl(shader.fragmentShader),index=live.indexOf(ANCHOR);
    if(index<0||live.indexOf(ANCHOR,index+ANCHOR.length)>=0)throw new Error(`Foliage cutoff shader anchor changed: ${ANCHOR}`);
    shader.uniforms.atlasFoliageCutoffs=uniform;
    const body=`#ifdef USE_ALPHATEST
  {
    float atlasAlphaTest=atlasFoliageLodCutoff(vMapUv);
    #ifdef ALPHA_TO_COVERAGE
    diffuseColor.a=smoothstep(atlasAlphaTest,atlasAlphaTest+fwidth(diffuseColor.a),diffuseColor.a);
    if(diffuseColor.a==0.0)discard;
    #else
    if(diffuseColor.a<atlasAlphaTest)discard;
    #endif
  }
#endif`;
    const main=live.search(/\bvoid\s+main\s*\(/);
    if(main<0)throw new Error('Foliage cutoff shader has no main()');
    const src=shader.fragmentShader;
    shader.fragmentShader=src.slice(0,main)+`#ifdef USE_MAP\n${treeFoliageLodCutoffGLSL(table.cutoffs.length,table.maxLevel,table.step)}#endif\n`+src.slice(main,index)+body+src.slice(index+ANCHOR.length);
  };
  material.customProgramCacheKey=()=>`${key.call(material)}/${TREE_FOLIAGE_LOD_CUTOFF_VERSION}/${table.cutoffs.length}`;
  material.needsUpdate=true;
  return uniform;
}
