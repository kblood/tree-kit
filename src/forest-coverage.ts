/** Full coverage is 256, not 255: all 256 possible hash values must pass. */
export const quantizeForestCoverage=(coverage:number)=>Math.floor(Math.max(0,Math.min(1,coverage))*256+.5);
export const forestCoverageGLSL=`
uint atlasForestHash(uint seed){
  uvec2 pixel=uvec2(gl_FragCoord.xy);
  uint h=pixel.x*1664525u+pixel.y*1013904223u;
  h^=h>>16u;h*=2246822519u;h^=h>>13u;
  return (h+seed)&255u;
}
uint atlasForestLevel(float coverage){return uint(clamp(coverage,0.0,1.0)*256.0+.5);}
`;
/** CPU oracle for the exact unsigned integer shader operation. */
export function forestScreenHash(x:number,y:number,seed=0){
  let h=(Math.imul(x>>>0,1664525)+Math.imul(y>>>0,1013904223))>>>0;
  h=(h^(h>>>16))>>>0;h=Math.imul(h,2246822519)>>>0;h=(h^(h>>>13))>>>0;
  return (h+seed)&255;
}
