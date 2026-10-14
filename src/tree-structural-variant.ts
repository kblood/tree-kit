import {TREE_VARIANT_COUNT} from './tree-species-recipe.ts';
import type {TreeFamilyKind as ForestTreeKind} from './tree-species-recipe.ts';
import {TREE_CANOPY_HEIGHT_RANGE_M} from './tree-canopy-profile.ts';

/** Appearance version for bounded per-family structural variants. It is not a
 * population, species or placement version: canonical cells never read it. */
export const FOREST_VARIANT_VERSION='forest-structural-variant-1';
export const FOREST_VARIANT_COUNT=TREE_VARIANT_COUNT;

/** Per-family limits. Heights follow the rendered allometry; only horizontal crown structure,
 * tier rotation and clump presence change. Roots stay at the canonical ground. */
export const FOREST_VARIANT_LIMITS:Readonly<Record<ForestTreeKind,Readonly<{anisotropy:number;leanFraction:number;twistRad:number;thinning:number;clumpRefM:number}>>>=Object.freeze({
  branching:Object.freeze({anisotropy:.16,leanFraction:.045,twistRad:.55,thinning:.14,clumpRefM:1.6}),
  spire:Object.freeze({anisotropy:.08,leanFraction:.025,twistRad:.8,thinning:.1,clumpRefM:1.2}),
});

/** Minimum |twist| as a fraction of the family limit. */
export const FOREST_VARIANT_TWIST_FLOOR=.35;

export type ForestStructuralVariant=Readonly<{
  kind:ForestTreeKind;index:number;
  /** Horizontal crown scale in the tree frame, reached above the lower trunk. */
  crownScale:readonly [number,number];
  /** Horizontal top displacement as a fraction of canonical height; bends as t². */
  lean:readonly [number,number];
  /** Rotation of branch tiers about the trunk, linear in normalized height. */
  twistRad:number;
  /** Fraction of reference-space leaf clumps removed (age/damage form). */
  thinning:number;
  clumpRefM:number;
}>;

function hash(text:string){
  let h=2166136261;
  for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}
  h^=h>>>16;h=Math.imul(h,0x7feb352d);h^=h>>>15;h=Math.imul(h,0x846ca68b);
  return (h^(h>>>16))>>>0;
}
/** Stratified channel values: every channel visits each eighth of its range
 * exactly once across the pool, so no two-variant pool collapses together. */
function stratified(kind:ForestTreeKind,channel:string){
  const order=Array.from({length:FOREST_VARIANT_COUNT},(_,i)=>i)
    .sort((a,b)=>hash(JSON.stringify([FOREST_VARIANT_VERSION,kind,channel,a]))-hash(JSON.stringify([FOREST_VARIANT_VERSION,kind,channel,b]))||a-b);
  const unit=new Array<number>(FOREST_VARIANT_COUNT);
  order.forEach((variant,rank)=>{unit[variant]=(rank+.5)/FOREST_VARIANT_COUNT;});
  return unit;
}

const pools=new Map<ForestTreeKind,readonly ForestStructuralVariant[]>();
export function forestStructuralVariants(kind:ForestTreeKind):readonly ForestStructuralVariant[]{
  if(kind!=='branching'&&kind!=='spire')throw new Error('Unsupported forest structural family');
  const cached=pools.get(kind);if(cached)return cached;
  const limit=FOREST_VARIANT_LIMITS[kind];
  const [sx,sz,lean,direction,twist,sign,thin]=['scale-x','scale-z','lean','lean-direction','twist','twist-sign','thinning'].map(c=>stratified(kind,c));
  const pool=Object.freeze(Array.from({length:FOREST_VARIANT_COUNT},(_,index)=>{
    const angle=2*Math.PI*direction[index],magnitude=limit.leanFraction*lean[index];
    // Tier twist has a floor so no member collapses to the authored skeleton
    // when its other independently stratified channels all rank low.
    return Object.freeze({kind,index,
      crownScale:Object.freeze([1+limit.anisotropy*(2*sx[index]-1),1+limit.anisotropy*(2*sz[index]-1)] as const),
      lean:Object.freeze([magnitude*Math.cos(angle),magnitude*Math.sin(angle)] as const),
      twistRad:(sign[index]<.5?-1:1)*limit.twistRad*(FOREST_VARIANT_TWIST_FLOOR+(1-FOREST_VARIANT_TWIST_FLOOR)*twist[index]),
      thinning:limit.thinning*thin[index],clumpRefM:limit.clumpRefM});
  }));
  pools.set(kind,pool);return pool;
}

/** The dated binding already carries a bounded variant from canonical ID and species. */
export function forestStructuralVariant(kind:ForestTreeKind,index:number){
  if(!Number.isInteger(index)||index<0||index>=FOREST_VARIANT_COUNT)throw new Error('Forest variant is outside the bounded pool');
  return forestStructuralVariants(kind)[index];
}

/** Normalized-height ramp over which crown scale reaches full strength. It
 * starts above the root flare and below the widest (lowest) Pine whorls. */
export const FOREST_VARIANT_CROWN_RAMP=Object.freeze([.05,.3] as const);
const smoothstep=(a:number,b:number,x:number)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
export const forestVariantCrownWeight=(t:number)=>smoothstep(FOREST_VARIANT_CROWN_RAMP[0],FOREST_VARIANT_CROWN_RAMP[1],t);
/** CPU oracle for the shader: tree-frame metres, y up, canonical height. */
export function forestVariantPoint(variant:ForestStructuralVariant|null,point:readonly [number,number,number],heightM:number):[number,number,number]{
  let [x,y,z]=point;
  if(!variant)return [x,y,z];
  const t=Math.max(0,Math.min(1,y/heightM)),w=forestVariantCrownWeight(t);
  x*=1+(variant.crownScale[0]-1)*w;z*=1+(variant.crownScale[1]-1)*w;
  const theta=variant.twistRad*t,c=Math.cos(theta),s=Math.sin(theta);
  [x,z]=[c*x+s*z,-s*x+c*z];
  return [x+variant.lean[0]*heightM*t*t,y,z+variant.lean[1]*heightM*t*t];
}
export function forestVariantTwist(variant:ForestStructuralVariant|null,y:number,heightM:number){
  return variant?variant.twistRad*Math.max(0,Math.min(1,y/heightM)):0;
}
/** Same unsigned integer operations as `atlasVariantHash`. */
export function forestVariantClumpHash(cell:readonly [number,number,number],seed:number){
  let h=(Math.imul(cell[0]>>>0,73856093)^Math.imul(cell[1]>>>0,19349663)^Math.imul(cell[2]>>>0,83492791)^Math.imul(seed>>>0,2654435761))>>>0;
  h=(h^(h>>>16))>>>0;h=Math.imul(h,2246822519)>>>0;h=(h^(h>>>13))>>>0;h=Math.imul(h,3266489917)>>>0;h=(h^(h>>>16))>>>0;
  return h;
}
/** Reference-space leaf pivots decide clump removal, so every LOD and shadow
 * pass removes the same clumps for one individual's variant. */
export function forestVariantRemovesLeaf(variant:ForestStructuralVariant|null,pivotRef:readonly [number,number,number]){
  if(!variant||variant.thinning<=0)return false;
  const cell=pivotRef.map(v=>Math.floor(v/variant.clumpRefM)+1024) as [number,number,number];
  return (forestVariantClumpHash(cell,variant.index+1)&65535)/65536<variant.thinning;
}

/** Conservative culling growth for every pool member. `radiusM` must already
 * enclose all supported heights and wind; leaf-card offsets stay metric. */
export function forestVariantEnvelope(pool:readonly ForestStructuralVariant[]){
  if(!Array.isArray(pool)||pool.length>FOREST_VARIANT_COUNT||pool.some((v:ForestStructuralVariant,i:number)=>v.index!==i||![...v.crownScale,...v.lean,v.twistRad,v.thinning,v.clumpRefM].every(Number.isFinite)||
    v.crownScale.some((s:number)=>s<=0)||v.thinning<0||v.thinning>=1||v.clumpRefM<=0))throw new Error('Invalid forest structural variant pool');
  return {scale:Math.max(1,...pool.flatMap(v=>v.crownScale)),leanFraction:Math.max(0,...pool.map(v=>Math.hypot(...v.lean)))};
}
/** Conservative culling growth for every pool member. `radiusM` must already
 * enclose all supported heights and wind; leaf-card offsets stay metric. */
export function forestVariantRadiusBound(pool:readonly ForestStructuralVariant[],radiusM:number,maxLeafOffsetM:number,cardScaleMax=1){
  if(![radiusM,maxLeafOffsetM,cardScaleMax].every(Number.isFinite)||radiusM<=0||maxLeafOffsetM<0||cardScaleMax<1)throw new Error('Invalid variant bound input');
  const {scale,leanFraction}=forestVariantEnvelope(pool);
  // |pivot| <= R+m. Horizontal scale/twist/lean act on the skeleton only;
  // the rotated card offset may then grow to cardScaleMax*m.
  return scale*(radiusM+maxLeafOffsetM)+leanFraction*TREE_CANOPY_HEIGHT_RANGE_M[1]+cardScaleMax*maxLeafOffsetM;
}

/** Two vec4 per variant: (scaleX, scaleZ, leanX, leanZ), (twist, thinning, clump, 0). */
export function forestVariantUniformData(pool:readonly ForestStructuralVariant[]){
  forestVariantEnvelope(pool);
  const out=new Float32Array(FOREST_VARIANT_COUNT*8);
  for(let i=0;i<FOREST_VARIANT_COUNT;i++)out.set([1,1,0,0,0,0,1,0],i*8);
  for(const v of pool)out.set([v.crownScale[0],v.crownScale[1],v.lean[0],v.lean[1],v.twistRad,v.thinning,v.clumpRefM,0],v.index*8);
  return out;
}

export const forestVariantGLSL=`
float atlasVariantCrownWeight(float t){return smoothstep(${FOREST_VARIANT_CROWN_RAMP[0]},${FOREST_VARIANT_CROWN_RAMP[1]},t);}
uint atlasVariantHash(uvec3 q,uint seed){
  uint h=(q.x*73856093u)^(q.y*19349663u)^(q.z*83492791u)^(seed*2654435761u);
  h^=h>>16u;h*=2246822519u;h^=h>>13u;h*=3266489917u;h^=h>>16u;return h;
}
vec3 atlasVariantPoint(vec3 p,float heightM,vec4 a,vec4 b){
  float t=clamp(p.y/heightM,0.0,1.0),w=atlasVariantCrownWeight(t);
  p.xz*=mix(vec2(1.0),a.xy,w);
  float theta=b.x*t,c=cos(theta),s=sin(theta);
  p.xz=vec2(c*p.x+s*p.z,-s*p.x+c*p.z);
  p.xz+=a.zw*heightM*t*t;
  return p;
}
vec3 atlasVariantRotate(vec3 v,float theta){
  float c=cos(theta),s=sin(theta);return vec3(c*v.x+s*v.z,v.y,-s*v.x+c*v.z);
}
bool atlasVariantRemovesLeaf(vec3 pivotRef,float variant,vec4 b){
  if(b.y<=0.0)return false;
  uvec3 cell=uvec3(ivec3(floor(pivotRef/b.z))+1024);
  return float(atlasVariantHash(cell,uint(variant+.5))&65535u)/65536.0<b.y;
}
`;
