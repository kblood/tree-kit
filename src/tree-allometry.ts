import type {TreeSpeciesBinding} from './tree-species-recipe.ts';
import type {TreeFamilyKind} from './tree-species-recipe.ts';
import {TREE_CANOPY_HEIGHT_RANGE_M,type TreeCanopyProfile} from './tree-canopy-profile.ts';
import {treeStructuralVariant} from './tree-species-recipe.ts';
import {LEGACY_TREE_LOBES,LEGACY_TREE_TRUNK} from './tree-shape.ts';

/** Presentation channel for rendered tree dimensions. Canonical cell identity,
 * occupancy, position, yaw, date and species binding never read it; changing
 * it changes only the drawn geometry. The canonical 10–22 m population height
 * remains a canonical record, used for drawing only when no dated species binds. */
export const TREE_ALLOMETRY_VERSION='tree-allometry-2';
export const TREE_ALLOMETRY_REFERENCE_HEIGHT_M=16;

/** Crown and trunk ratios are relative to height-proportional scaling of the
 * representation's reference (1 = the authored proportions). Both near and far
 * paths use the same 8-bit value: k = min + q*step, with 1 exactly encodable.
 * v2 lowers the minimum from .25 to .125 so slender conifer recipes encode. */
export const TREE_ALLOMETRY_RATIO=Object.freeze({min:.125,step:1/128,levels:256});
export const TREE_ALLOMETRY_RATIO_MAX=TREE_ALLOMETRY_RATIO.min+(TREE_ALLOMETRY_RATIO.levels-1)*TREE_ALLOMETRY_RATIO.step;

/** Detailed family envelope (v2). The skeleton scales with height and its
 * crown radially by the crown ratio; leaf cards (foliage clumps) scale by
 * `treeAllometryCardScale`, which keeps the side-view leaf-area density of the
 * authored 16 m crown over the drawn silhouette. Beyond these limits the packaged Oak/Pine skeleton is not
 * used: heights fall back to the legacy primitive at physical size and ratios
 * clamp, each with a recorded reason. */
export const TREE_FAMILY_ALLOMETRY_ENVELOPE=Object.freeze({
  heightM:TREE_CANOPY_HEIGHT_RANGE_M,
  crownRatio:Object.freeze([.125,1.75] as const),
  trunkRatio:Object.freeze([.5,1.5] as const),
});
/** Foliage-card scale bounds. Cards never grow past the authored size, so every
 * existing card/leaf bound stays conservative; the floor keeps clumps visible. */
export const TREE_ALLOMETRY_CARD=Object.freeze({min:.2,max:1});
export type TreeAllometryCrownReference={trunkRadiusM:number;crownRadiusM:number;cardExtentM:number};
const validCrownReference=(r:TreeAllometryCrownReference|null|undefined):r is TreeAllometryCrownReference=>
  !!r&&[r.trunkRadiusM,r.crownRadiusM,r.cardExtentM].every(finite)&&r.crownRadiusM>r.trunkRadiusM&&r.trunkRadiusM>=0&&r.cardExtentM>=0;
/** Card scale per unit height scale (u = c/s) that keeps the authored side-view
 * leaf-area density. The family has a fixed clump count, so card area (c^2)
 * must follow the drawn side area (s^2 x stretch), where the stretch (drawn
 * half-width over the 16 m identity half-width rc+ce, per unit s) itself
 * contains the card fringe: (rc+ce)u^2 - ce*u - A = 0 with A = tr*rt + cr*(rc-rt).
 * u = 1 at identity ratios. */
function cardScalePerHeight(r:TreeAllometryCrownReference,crownRatio:number,trunkRatio:number){
  const A=trunkRatio*r.trunkRadiusM+crownRatio*(r.crownRadiusM-r.trunkRadiusM),R=r.crownRadiusM+r.cardExtentM;
  return (r.cardExtentM+Math.sqrt(r.cardExtentM*r.cardExtentM+4*R*A))/(2*R);
}
/** Leaf-card (foliage clump) scale of one family draw, derived from the family
 * reference, rendered height and both ratio codes, so no channel is added.
 * Without a reference (legacy, unpresented) cards keep their authored size. */
export function treeAllometryCardScale(reference:TreeAllometryCrownReference|null,heightM:number,crownRatio:number,trunkRatio:number){
  if(![heightM,crownRatio,trunkRatio].every(finite)||heightM<=0||crownRatio<=0||trunkRatio<=0)throw new Error('Invalid tree card scale input');
  if(!validCrownReference(reference))return 1;
  return clamp(heightM/TREE_ALLOMETRY_REFERENCE_HEIGHT_M*cardScalePerHeight(reference,crownRatio,trunkRatio),TREE_ALLOMETRY_CARD.min,TREE_ALLOMETRY_CARD.max);
}
/** Drawn crown half-width (m): mapped p95 pivot spread plus the scaled card extent. */
export function treeAllometryCrownHalfWidthM(reference:TreeAllometryCrownReference,heightM:number,crownRatio:number,trunkRatio:number){
  const s=heightM/TREE_ALLOMETRY_REFERENCE_HEIGHT_M,r=reference;
  return s*(trunkRatio*r.trunkRadiusM+crownRatio*(r.crownRadiusM-r.trunkRadiusM))+treeAllometryCardScale(reference,heightM,crownRatio,trunkRatio)*r.cardExtentM;
}
/** Horizontal stretch of the 16 m far-atlas capture (identity ratios, unit
 * cards) that gives the detailed crown width at this height and ratios. Without
 * a family reference it is the crown ratio. Mirrors GLSL `treeAllometryAtlasStretch`. */
export function treeAllometryAtlasStretch(reference:TreeAllometryCrownReference|null,heightM:number,crownRatio:number,trunkRatio:number){
  if(!validCrownReference(reference)||!(heightM>0))return crownRatio;
  const s=heightM/TREE_ALLOMETRY_REFERENCE_HEIGHT_M;
  return treeAllometryCrownHalfWidthM(reference,heightM,crownRatio,trunkRatio)/(s*(reference.crownRadiusM+reference.cardExtentM));
}
/** Leaf optical-depth scale of a far-atlas member, relative to its 16 m
 * capture: card area over drawn side area, c^2/(s^2 x stretch). Exactly 1
 * unless the card scale is clamped. Mirrors GLSL `treeAllometryLeafDepthScale`. */
export function treeAllometryLeafDepthScale(reference:TreeAllometryCrownReference|null,heightM:number,crownRatio:number,trunkRatio:number){
  const s=heightM/TREE_ALLOMETRY_REFERENCE_HEIGHT_M,c=treeAllometryCardScale(reference,heightM,crownRatio,trunkRatio);
  return c*c/(s*s*treeAllometryAtlasStretch(reference,heightM,crownRatio,trunkRatio));
}
/** The legacy primitive has no metric leaves; any positive species height up to
 * the catalogue's own trait limit is drawn at its physical size. */
export const TREE_LEGACY_ALLOMETRY_ENVELOPE=Object.freeze({heightM:Object.freeze([.1,40] as const)});

export type TreeAllometryReason='no-dated-species'|'family-not-presented'|'family-missing-allometry-reference'|
  'height-below-family-envelope'|'height-above-family-envelope'|'crown-ratio-clamped'|'trunk-ratio-clamped'|
  'legacy-height-out-of-range'|'legacy-crown-ratio-clamped'|'legacy-trunk-ratio-clamped';
export const TREE_ALLOMETRY_REASONS:readonly TreeAllometryReason[]=Object.freeze(['no-dated-species','family-not-presented',
  'family-missing-allometry-reference','height-below-family-envelope','height-above-family-envelope','crown-ratio-clamped',
  'trunk-ratio-clamped','legacy-height-out-of-range','legacy-crown-ratio-clamped','legacy-trunk-ratio-clamped']);

/** Reference measurements of one loaded family at the 16 m skeleton. Crown and
 * trunk figures come from the actual LOD0 vertices; skeleton extents and leaf
 * offsets cover both LODs. The variant/card terms make per-instance bounds
 * conservative for the adopted structural pool and card growth. */
export type TreeAllometryReference=Readonly<{
  version:typeof TREE_ALLOMETRY_VERSION;referenceHeightM:16;
  /** 95th-percentile horizontal distance of foliage pivots from the trunk axis. */
  crownRadiusM:number;
  /** Representative metric card extent (75th-percentile leaf offset). */
  cardExtentM:number;
  /** Measured trunk base radius (branch level 0, near the ground). */
  trunkRadiusM:number;
  /** Maximum horizontal distance of any bark vertex or leaf pivot from the axis. */
  skeletonRadiusM:number;
  /** Maximum |y| of any bark vertex or leaf pivot. */
  skeletonHeightM:number;
  /** Maximum source leaf offset from its pivot, metres. */
  maxLeafOffsetM:number;
  /** Largest horizontal structural-variant scale and lean fraction of the pool. */
  variantScale:number;variantLeanFraction:number;
  /** Largest card scale applied by LOD calibration and distance compensation. */
  cardScaleMax:number;
}>;

export type ForestTreeDimensions=Readonly<{
  version:typeof TREE_ALLOMETRY_VERSION;
  representation:'family'|'legacy';kind:TreeFamilyKind|null;speciesId:string|null;
  /** Rendered height (Float32-exact), metres. */
  heightM:number;
  /** Quantized horizontal crown and trunk ratios shared by every representation. */
  crownRatio:number;trunkRatio:number;
  /** Packed pair: crown q + 256 * trunk q. */
  ratioCode:number;
  /** Ratios for the legacy primitive drawing the same physical crown width and
   * trunk diameter (equal to `ratioCode` for the legacy representation). */
  legacyRatioCode:number;
  /** Physical dimensions drawn after quantization and clamping. */
  crownWidthM:number;trunkDiameterM:number;
  /** Foliage-card scale (family draws; 1 for legacy). */
  cardScale:number;
  /** Individual species dimensions before representation limits. */
  targetHeightM:number;targetCrownWidthM:number;targetTrunkDiameterM:number;
  reasons:readonly TreeAllometryReason[];
}>;

const finite=(x:number)=>Number.isFinite(x);
const clamp=(x:number,a:number,b:number)=>Math.min(b,Math.max(a,x));

export function quantizeTreeAllometryRatio(ratio:number){
  if(!finite(ratio))throw new Error('Tree allometry ratio must be finite');
  const R=TREE_ALLOMETRY_RATIO;
  return clamp(Math.round((ratio-R.min)/R.step),0,R.levels-1);
}
export function treeAllometryRatioFromCode(q:number){
  if(!Number.isInteger(q)||q<0||q>=TREE_ALLOMETRY_RATIO.levels)throw new Error('Invalid tree allometry ratio code');
  return TREE_ALLOMETRY_RATIO.min+q*TREE_ALLOMETRY_RATIO.step;
}
export function packTreeAllometryRatios(crownRatio:number,trunkRatio:number){
  return quantizeTreeAllometryRatio(crownRatio)+256*quantizeTreeAllometryRatio(trunkRatio);
}
export function unpackTreeAllometryRatios(code:number){
  if(!Number.isInteger(code)||code<0||code>=65536)throw new Error('Invalid packed tree allometry ratios');
  return {crownRatio:treeAllometryRatioFromCode(code%256),trunkRatio:treeAllometryRatioFromCode(Math.floor(code/256))};
}
export const TREE_ALLOMETRY_IDENTITY_CODE=packTreeAllometryRatios(1,1);

/** Far parameter channel: 8-bit roll seed plus both ratio codes, below 2^24 so
 * it is exact in Float32. The roll seed is floor(roll*256), as in the hash channel. */
export function packTreeAllometryParameter(roll:number,ratioCode:number){
  if(!finite(roll)||roll<0||roll>=1)throw new Error('Invalid forest roll');
  unpackTreeAllometryRatios(ratioCode);
  return Math.min(255,Math.floor(roll*256))+256*ratioCode;
}
export function unpackTreeAllometryParameter(value:number){
  if(!Number.isInteger(value)||value<0||value>=2**24)throw new Error('Invalid packed tree allometry parameter');
  const ratioCode=Math.floor(value/256);
  return {rollSeed:value%256,roll:(value%256+.5)/256,ratioCode,...unpackTreeAllometryRatios(ratioCode)};
}

/** Legacy primitive reference, per metre of height, from the shared shape. */
export const LEGACY_TREE_ALLOMETRY=Object.freeze((()=>{
  const x=LEGACY_TREE_LOBES.flatMap(([cx,,,s])=>[cx-s,cx+s]),z=LEGACY_TREE_LOBES.flatMap(([,,cz,s])=>[cz-s,cz+s]);
  const crownDiameterPerHeight=((Math.max(...x)-Math.min(...x))+(Math.max(...z)-Math.min(...z)))/2;
  const radiusPerHeight=Math.max(LEGACY_TREE_TRUNK.baseRadius,...LEGACY_TREE_LOBES.map(([cx,,cz,s])=>Math.hypot(cx,cz)+s));
  const topPerHeight=Math.max(LEGACY_TREE_TRUNK.height,...LEGACY_TREE_LOBES.map(([,cy,,s])=>cy+s*.85));
  return {crownDiameterPerHeight,trunkDiameterPerHeight:2*LEGACY_TREE_TRUNK.baseRadius,trunkRadiusPerHeight:LEGACY_TREE_TRUNK.baseRadius,
    radiusPerHeight,topPerHeight};
})());

/** Derive the family reference from the loaded LOD profiles and pool limits. */
export function treeAllometryReference(lod0:TreeCanopyProfile,lod1:TreeCanopyProfile,
  pool:{variantScale:number;variantLeanFraction:number;cardScaleMax:number}):TreeAllometryReference{
  const crownRadiusM=lod0?.crownRadiusM,trunkRadiusM=lod0?.trunk?.baseRadiusM;
  const skeletonRadiusM=Math.max(lod0?.skeleton?.radiusM??NaN,lod1?.skeleton?.radiusM??NaN);
  const skeletonHeightM=Math.max(lod0?.skeleton?.heightM??NaN,lod1?.skeleton?.heightM??NaN);
  const maxLeafOffsetM=Math.max(lod0?.maxLeafOffsetM??NaN,lod1?.maxLeafOffsetM??NaN);
  const cardExtentM=lod0?.cardExtentM??maxLeafOffsetM;
  return validateTreeAllometryReference({version:TREE_ALLOMETRY_VERSION,referenceHeightM:16,crownRadiusM:crownRadiusM!,cardExtentM,
    trunkRadiusM:trunkRadiusM!,skeletonRadiusM,skeletonHeightM,maxLeafOffsetM,...pool});
}
export function validateTreeAllometryReference(reference:TreeAllometryReference):TreeAllometryReference{
  const r=reference;
  if(!r||r.version!==TREE_ALLOMETRY_VERSION||r.referenceHeightM!==16||
    ![r.crownRadiusM,r.cardExtentM,r.trunkRadiusM,r.skeletonRadiusM,r.skeletonHeightM,r.maxLeafOffsetM,r.variantScale,r.variantLeanFraction,r.cardScaleMax].every(finite)||
    r.crownRadiusM<=r.trunkRadiusM||r.trunkRadiusM<=0||r.cardExtentM<0||r.maxLeafOffsetM<r.cardExtentM||r.skeletonRadiusM<Math.max(r.crownRadiusM,r.trunkRadiusM)||
    r.skeletonHeightM<=0||r.variantScale<1||r.variantLeanFraction<0||r.cardScaleMax<1)throw new Error('Invalid tree allometry reference');
  return Object.freeze({...r});
}

type Presented={allometry?:TreeAllometryReference|null};
// Presentation references are immutable once adopted; validate each once.
const validatedReferences=new WeakSet<object>();
function validReference(reference:TreeAllometryReference){
  if(validatedReferences.has(reference))return true;
  try{validateTreeAllometryReference(reference);}catch{return false;}
  validatedReferences.add(reference);return true;
}

function legacyDimensions(speciesId:string|null,heightM:number,crownWidthM:number,trunkDiameterM:number,reasons:TreeAllometryReason[]):ForestTreeDimensions{
  const [minH,maxH]=TREE_LEGACY_ALLOMETRY_ENVELOPE.heightM;
  let h=heightM;
  if(!(h>=minH&&h<=maxH)){reasons.push('legacy-height-out-of-range');h=clamp(finite(h)?h:16,minH,maxH);}
  h=Math.fround(h);
  const L=LEGACY_TREE_ALLOMETRY,crownTarget=crownWidthM/(h*L.crownDiameterPerHeight),trunkTarget=trunkDiameterM/(h*L.trunkDiameterPerHeight);
  const crownQ=quantizeTreeAllometryRatio(crownTarget),trunkQ=quantizeTreeAllometryRatio(trunkTarget);
  const crownRatio=treeAllometryRatioFromCode(crownQ),trunkRatio=treeAllometryRatioFromCode(trunkQ);
  const half=TREE_ALLOMETRY_RATIO.step/2;
  if(Math.abs(crownRatio-crownTarget)>half+1e-12)reasons.push('legacy-crown-ratio-clamped');
  if(Math.abs(trunkRatio-trunkTarget)>half+1e-12)reasons.push('legacy-trunk-ratio-clamped');
  return Object.freeze({version:TREE_ALLOMETRY_VERSION,representation:'legacy' as const,kind:null,speciesId,heightM:h,crownRatio,trunkRatio,
    ratioCode:crownQ+256*trunkQ,legacyRatioCode:crownQ+256*trunkQ,crownWidthM:crownRatio*h*L.crownDiameterPerHeight,trunkDiameterM:trunkRatio*h*L.trunkDiameterPerHeight,cardScale:1,
    targetHeightM:heightM,targetCrownWidthM:crownWidthM,targetTrunkDiameterM:trunkDiameterM,reasons:Object.freeze(reasons)});
}

/** One rendered-dimension decision per canonical individual, shared by near,
 * far and legacy draws. The individual's dated species recipe and its bounded
 * structural variant (from canonical ID) supply height, crown width and trunk
 * diameter; the presented family reference converts them to skeleton ratios. */
export function forestTreeDimensions(binding:TreeSpeciesBinding|null,canonicalHeightM:number,
  families:{get(kind:TreeFamilyKind):Presented|undefined}):ForestTreeDimensions{
  if(!binding){
    if(!finite(canonicalHeightM)||canonicalHeightM<=0)throw new Error('Canonical tree height is required');
    // Proxy fallback: the canonical population height with legacy proportions.
    const L=LEGACY_TREE_ALLOMETRY;
    return legacyDimensions(null,canonicalHeightM,canonicalHeightM*L.crownDiameterPerHeight,canonicalHeightM*L.trunkDiameterPerHeight,['no-dated-species']);
  }
  const recipe=binding.recipe,individual=treeStructuralVariant(recipe,binding.appearance.variant);
  const H=individual.heightM,W=individual.crownWidthM,D=individual.trunkDiameterM;
  const kind=recipe.family,presented=families.get(kind);
  if(!presented)return legacyDimensions(recipe.speciesId,H,W,D,['family-not-presented']);
  const reference=presented.allometry;
  if(!reference||!validReference(reference))return legacyDimensions(recipe.speciesId,H,W,D,['family-missing-allometry-reference']);
  const E=TREE_FAMILY_ALLOMETRY_ENVELOPE;
  if(H<E.heightM[0])return legacyDimensions(recipe.speciesId,H,W,D,['height-below-family-envelope']);
  if(H>E.heightM[1])return legacyDimensions(recipe.speciesId,H,W,D,['height-above-family-envelope']);
  const reasons:TreeAllometryReason[]=[];
  const heightM=Math.fround(H),scale=heightM/TREE_ALLOMETRY_REFERENCE_HEIGHT_M;
  const rt=reference.trunkRadiusM,rc=reference.crownRadiusM;
  const trunkTarget=D/(2*scale*rt),trunkLimited=clamp(trunkTarget,...E.trunkRatio);
  if(trunkLimited!==trunkTarget)reasons.push('trunk-ratio-clamped');
  const trunkQ=quantizeTreeAllometryRatio(trunkLimited),trunkRatio=treeAllometryRatioFromCode(trunkQ);
  // Crown spread = mapped pivot spread plus the scaled cards on both sides. The
  // radial map moves a pivot at rc to trunk*rt + crown*(rc-rt); the card scale
  // also grows with the crown ratio, so the half-width is monotonic in it.
  const half=(crown:number)=>treeAllometryCrownHalfWidthM(reference,heightM,crown,trunkRatio),target=W/2;
  const loQ=quantizeTreeAllometryRatio(E.crownRatio[0]),hiQ=quantizeTreeAllometryRatio(E.crownRatio[1]);
  let crownQ:number;
  if(!(target>=half(E.crownRatio[0])&&target<=half(E.crownRatio[1]))){
    reasons.push('crown-ratio-clamped');crownQ=target<half(E.crownRatio[0])?loQ:hiQ;
  }else{
    let lo:number=E.crownRatio[0],hi:number=E.crownRatio[1];
    for(let i=0;i<48;i++){const mid=(lo+hi)/2;if(half(mid)<target)lo=mid;else hi=mid;}
    // Nearest drawn width among the neighbouring codes (the map is not linear).
    const q0=quantizeTreeAllometryRatio((lo+hi)/2),error=(q:number)=>Math.abs(half(treeAllometryRatioFromCode(q))-target);crownQ=q0;
    for(const q of [q0-1,q0+1])if(q>=loQ&&q<=hiQ&&error(q)<error(crownQ))crownQ=q;
  }
  const crownRatio=treeAllometryRatioFromCode(crownQ),cardScale=treeAllometryCardScale(reference,heightM,crownRatio,trunkRatio);
  const crownWidthM=2*half(crownRatio),trunkDiameterM=2*scale*trunkRatio*rt;
  // A hidden or mid-range legacy draw of this individual matches the drawn family widths.
  const L=LEGACY_TREE_ALLOMETRY,legacyCrown=crownWidthM/(heightM*L.crownDiameterPerHeight),legacyTrunk=trunkDiameterM/(heightM*L.trunkDiameterPerHeight);
  const legacyRatioCode=packTreeAllometryRatios(legacyCrown,legacyTrunk),legacy=unpackTreeAllometryRatios(legacyRatioCode),halfStep=TREE_ALLOMETRY_RATIO.step/2;
  if(Math.abs(legacy.crownRatio-legacyCrown)>halfStep+1e-12)reasons.push('legacy-crown-ratio-clamped');
  if(Math.abs(legacy.trunkRatio-legacyTrunk)>halfStep+1e-12)reasons.push('legacy-trunk-ratio-clamped');
  return Object.freeze({version:TREE_ALLOMETRY_VERSION,representation:'family' as const,kind,speciesId:recipe.speciesId,heightM,crownRatio,trunkRatio,
    ratioCode:crownQ+256*trunkQ,legacyRatioCode,crownWidthM,trunkDiameterM,cardScale,targetHeightM:H,targetCrownWidthM:W,targetTrunkDiameterM:D,reasons:Object.freeze(reasons)});
}

/** CPU oracle of `treeAllometryRadial`: the trunk core scales by the trunk
 * ratio and everything outside it by the crown ratio, offset so branches stay
 * attached to the trunk surface. Continuous; |result|/|xz| lies between both ratios. */
export function treeAllometryRadial(x:number,z:number,trunkRadius:number,crownRatio:number,trunkRatio:number):[number,number]{
  const r=Math.hypot(x,z);
  if(r<=1e-6)return [x*trunkRatio,z*trunkRatio];
  const mapped=trunkRatio*Math.min(r,trunkRadius)+crownRatio*Math.max(r-trunkRadius,0);
  return [x*mapped/r,z*mapped/r];
}
/** Reference-skeleton point (16 m frame) to rendered tree-frame metres, before
 * the structural variant. Leaf-card offsets are added afterwards, scaled by
 * `treeAllometryCardScale`. */
export function treeAllometryPoint(point:readonly [number,number,number],reference:{trunkRadiusM:number},dimensions:{heightM:number;crownRatio:number;trunkRatio:number}):[number,number,number]{
  const s=dimensions.heightM/TREE_ALLOMETRY_REFERENCE_HEIGHT_M;
  const [x,z]=treeAllometryRadial(point[0],point[2],reference.trunkRadiusM,dimensions.crownRatio,dimensions.trunkRatio);
  return [x*s,point[1]*s,z*s];
}

/** Root-centred sphere radius enclosing every rendered vertex of one family
 * instance: radial mapping, variant scale/twist/lean, rigid leaf wind and card growth. */
export function forestFamilyBoundRadius(reference:TreeAllometryReference,dimensions:{heightM:number;crownRatio:number;trunkRatio:number}){
  const r=reference,d=dimensions,s=d.heightM/TREE_ALLOMETRY_REFERENCE_HEIGHT_M;
  if(![d.heightM,d.crownRatio,d.trunkRatio].every(finite)||d.heightM<=0||d.crownRatio<=0||d.trunkRatio<=0)throw new Error('Invalid tree dimensions');
  const horizontal=r.variantScale*s*Math.max(d.crownRatio,d.trunkRatio)*r.skeletonRadiusM+r.variantLeanFraction*d.heightM;
  return Math.hypot(horizontal,s*r.skeletonHeightM)+r.cardScaleMax*r.maxLeafOffsetM;
}
/** Largest bound over the complete family envelope. */
export function forestFamilyEnvelopeRadius(reference:TreeAllometryReference){
  const E=TREE_FAMILY_ALLOMETRY_ENVELOPE;
  return forestFamilyBoundRadius(reference,{heightM:E.heightM[1],crownRatio:E.crownRatio[1],trunkRatio:E.trunkRatio[1]});
}
/** Legacy sphere: centred on the axis at half the primitive top. */
export function legacyTreeBoundSphere(dimensions:{heightM:number;crownRatio:number;trunkRatio:number}){
  const L=LEGACY_TREE_ALLOMETRY,h=dimensions.heightM,m=Math.max(dimensions.crownRatio,dimensions.trunkRatio);
  return {centerHeightM:h*L.topPerHeight/2,radiusM:h*Math.hypot(m*L.radiusPerHeight,L.topPerHeight/2)};
}
/** Horizontal box growth matching `treeAllometryBox`, all in one unit. The
 * radial map moves each horizontal coordinate by a factor between both ratios;
 * `lean` is the part of the extent contributed by structural lean, which the
 * analytic bands apply after allometry (unscaled) and the atlas scales by the
 * crown ratio. */
export function treeAllometryBox(center:readonly number[],extent:readonly number[],crownRatio:number,trunkRatio:number,lean=0){
  if(![...center,...extent,crownRatio,trunkRatio,lean].every(finite)||crownRatio<=0||trunkRatio<=0||lean<0||lean>Math.min(extent[0],extent[2])+1e-12)
    throw new Error('Invalid tree allometry box');
  const m=Math.max(crownRatio,trunkRatio),f=Math.min(crownRatio,trunkRatio),grow=(e:number,c:number)=>(e-lean)*m+lean*Math.max(m,1)+Math.abs(c)*(m-f);
  return {center:[center[0]*m,center[1],center[2]*m] as [number,number,number],
    extent:[grow(extent[0],center[0]),extent[1],grow(extent[2],center[2])] as [number,number,number]};
}

/** Shared GLSL; `ratios` is (crown, trunk). `family` is the reference trunk
 * radius, p95 crown radius and card extent in metres (all zero: no reference). */
export const treeAllometryGLSL=`
float treeAllometryCardScale(float heightM,vec2 ratios,vec3 family){
  if(family.y<=family.x)return 1.0;
  float A=ratios.y*family.x+ratios.x*(family.y-family.x),R=family.y+family.z;
  float u=(family.z+sqrt(family.z*family.z+4.0*R*A))/(2.0*R);
  return clamp(heightM/${TREE_ALLOMETRY_REFERENCE_HEIGHT_M}.0*u,${TREE_ALLOMETRY_CARD.min},${TREE_ALLOMETRY_CARD.max}.0);
}
float treeAllometryAtlasStretch(float heightM,vec2 ratios,vec3 family){
  if(family.y<=family.x||heightM<=0.0)return ratios.x;
  float s=heightM/${TREE_ALLOMETRY_REFERENCE_HEIGHT_M}.0;
  return (s*(ratios.y*family.x+ratios.x*(family.y-family.x))+treeAllometryCardScale(heightM,ratios,family)*family.z)/(s*(family.y+family.z));
}
float treeAllometryLeafDepthScale(float heightM,vec2 ratios,vec3 family){
  float s=heightM/${TREE_ALLOMETRY_REFERENCE_HEIGHT_M}.0,c=treeAllometryCardScale(heightM,ratios,family);
  return c*c/(s*s*treeAllometryAtlasStretch(heightM,ratios,family));
}
vec2 treeAllometryRatios(float packed){
  return vec2(${TREE_ALLOMETRY_RATIO.min})+vec2(mod(floor(packed/256.0),256.0),floor(packed/65536.0))*${TREE_ALLOMETRY_RATIO.step};
}
float treeAllometryRoll(float packed){return (mod(packed,256.0)+.5)/256.0;}
vec2 treeAllometryRadial(vec2 xz,float trunkRadius,vec2 ratios){
  float r=length(xz);
  if(r<=1e-6)return xz*ratios.y;
  return xz*((ratios.y*min(r,trunkRadius)+ratios.x*max(r-trunkRadius,0.0))/r);
}
vec3 treeAllometryPoint(vec3 p,float trunkRadius,vec2 ratios){
  vec2 horizontal=treeAllometryRadial(p.xz,trunkRadius,ratios);return vec3(horizontal.x,p.y,horizontal.y);
}
float treeAllometryHorizontalRatio(vec2 xz,float trunkRadius,vec2 ratios){return length(xz)<trunkRadius?ratios.y:ratios.x;}
void treeAllometryBox(inout vec3 centre,inout vec3 extent,vec2 ratios,float lean){
  float m=max(ratios.x,ratios.y),f=min(ratios.x,ratios.y);
  extent.xz=(extent.xz-vec2(lean))*m+vec2(lean*max(m,1.0))+abs(centre.xz)*(m-f);centre.xz*=m;
}
`;
