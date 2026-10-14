import * as THREE from 'three';

/** Far-atlas foliage direct lighting that matches the detailed crowns.
 *
 * A far-atlas texel stores the mean (renormalized) normal of many leaf cards.
 * Lambert on that mean normal, max(0, n̄·l), is not the mean of the per-card
 * Lambert terms the detailed LOD1 draws (Jensen: the clamp is convex). Against
 * the light it is near zero while detailed cards tilted toward the sun still
 * light up; with the sun behind the viewer it is ~1.35x too bright.
 *
 * Model the texel's leaf normals as a cos^k lobe about the stored mean. For
 * pdf ∝ cos^2 θ the expected clamped cosine has the closed form
 * 3/16 (1 + n̄·l)^2, and the lobe's mean cosine is (k+1)/(k+2) = 0.75, which is
 * what the packaged LOD1 Oak and Pine crowns measure (0.73-0.76, CPU raster in
 * tests/forest-foliage-lobe.test.mjs). Bark keeps plain Lambert. */
export const FOREST_FOLIAGE_LOBE_VERSION='forest-foliage-lobe-cos2-1';
export const FOREST_FOLIAGE_LOBE_EXPONENT=2;
export function forestFoliageLobeCosine(cosine:number){
  const x=Math.min(2,Math.max(0,1+cosine));return 3/16*x*x;
}
/** leafFraction 1 uses the lobe, 0 plain Lambert; `treeFoliageLobe` is set per fragment. */
export const forestFoliageLobeGLSL=`float treeFoliageLobe=0.0;
float treeFoliageDirect(float cosine){float x=clamp(1.0+cosine,0.0,2.0);return mix(clamp(cosine,0.0,1.0),0.1875*x*x,treeFoliageLobe);}
`;
const LAMBERT_DOT='float dotNL = saturate( dot( geometryNormal, directLight.direction ) );';
/** Replace the Lambert include with the same chunk whose direct cosine goes through treeFoliageDirect. */
export function installForestFoliageLobe(fragmentShader:string){
  const include='#include <lights_lambert_pars_fragment>',chunk=THREE.ShaderChunk.lights_lambert_pars_fragment;
  if(fragmentShader.split(include).length!==2||chunk.split(LAMBERT_DOT).length!==2)throw new Error('Forest foliage lobe anchor changed');
  return fragmentShader.replace(include,chunk.replace(LAMBERT_DOT,'float dotNL = treeFoliageDirect( dot( geometryNormal, directLight.direction ) );'));
}
