import {LEGACY_TREE_TRUNK} from './tree-shape.ts';
import {TREE_CANOPY_HEIGHT_RANGE_M,TREE_CANOPY_REFERENCE_HEIGHT_M,type TreeCanopyProfile,type TreeTrunkProfile} from './tree-canopy-profile.ts';
import {treeAllometryBox} from './tree-allometry.ts';

export type FamilyProxyBounds={
  /** Centre of the proxy's linear-height box per metre of canonical tree height. */
  centerPerHeight:[number,number,number];
  /** Half-extents of the proxy's linear-height box per metre of canonical height. */
  extentPerHeight:[number,number,number];
  /** Constant metric margin for leaf-card offsets, independent of tree height. */
  metricMarginM:number;
  /** Horizontal extent per metre of height contributed by structural lean. */
  leanPerHeight?:number;
};
export type EvaluatedFamilyProxyBounds={centerM:[number,number,number];extentM:[number,number,number]};

const finite=(x:number)=>Number.isFinite(x);

/** Tight axis-aligned union of occupied family bands and the existing legacy
 * trunk, expressed as a height-scaled box plus an independent metric card margin.
 * This bounds the analytic proxy representation, not every detailed mesh vertex. */
export function deriveFamilyProxyBounds(profile:TreeCanopyProfile):FamilyProxyBounds{
  if(!profile||profile.referenceHeightM!==TREE_CANOPY_REFERENCE_HEIGHT_M||!Array.isArray(profile.bands)||profile.bands.length!==4||
    !finite(profile.maxLeafOffsetM)||profile.maxLeafOffsetM<0)throw new Error('Invalid canopy profile for family proxy bounds');
  let minX=-Math.max(LEGACY_TREE_TRUNK.topRadius,LEGACY_TREE_TRUNK.baseRadius),maxX=-minX;
  let minY:number=0,maxY:number=LEGACY_TREE_TRUNK.height;
  let minZ=minX,maxZ=maxX,occupied=0;
  for(const band of profile.bands){
    if(!band||typeof band.populated!=='boolean'||!Number.isInteger(band.count)||band.count<0||
      !band.centerM||band.centerM.length!==3||!band.centerM.every(finite)||!finite(band.radiusM)||band.radiusM<0||
      !finite(band.halfHeightM)||band.halfHeightM<0)throw new Error('Invalid crown band for family proxy bounds');
    if(!band.populated){if(band.count!==0)throw new Error('Empty crown bands must have zero samples');continue;}
    if(band.count===0)throw new Error('Populated crown bands require samples');
    occupied++;
    const cx=band.centerM[0]/TREE_CANOPY_REFERENCE_HEIGHT_M,cy=band.centerM[1]/TREE_CANOPY_REFERENCE_HEIGHT_M,
      cz=band.centerM[2]/TREE_CANOPY_REFERENCE_HEIGHT_M,
      rx=band.radiusM/TREE_CANOPY_REFERENCE_HEIGHT_M,ry=band.halfHeightM/TREE_CANOPY_REFERENCE_HEIGHT_M;
    minX=Math.min(minX,cx-rx);maxX=Math.max(maxX,cx+rx);
    minY=Math.min(minY,cy-ry);maxY=Math.max(maxY,cy+ry);
    minZ=Math.min(minZ,cz-rx);maxZ=Math.max(maxZ,cz+rx);
  }
  if(!occupied)throw new Error('Family proxy profile has no populated crown bands');
  const centerPerHeight:[number,number,number]=[(minX+maxX)/2,(minY+maxY)/2,(minZ+maxZ)/2];
  const extentPerHeight:[number,number,number]=[(maxX-minX)/2,(maxY-minY)/2,(maxZ-minZ)/2];
  if(![...centerPerHeight,...extentPerHeight].every(finite)||extentPerHeight.some(x=>x<=0))throw new Error('Invalid derived family proxy bounds');
  return {centerPerHeight,extentPerHeight,metricMarginM:profile.maxLeafOffsetM};
}

/** Extend the family box for its measured trunk and every pool variant. Twist
 * rotates about the trunk, so the horizontal box becomes the enclosing circle;
 * crown scale also applies to the metric card margin, as in the far shader. */
export function deriveVariantFamilyProxyBounds(profile:TreeCanopyProfile,envelope:{scale:number;leanFraction:number},trunk?:TreeTrunkProfile|null):FamilyProxyBounds{
  const base=deriveFamilyProxyBounds(profile);
  if(!envelope||!finite(envelope.scale)||envelope.scale<1||!finite(envelope.leanFraction)||envelope.leanFraction<0)throw new Error('Invalid variant envelope');
  let minY=base.centerPerHeight[1]-base.extentPerHeight[1],maxY=base.centerPerHeight[1]+base.extentPerHeight[1];
  let radius=Math.hypot(Math.abs(base.centerPerHeight[0])+base.extentPerHeight[0],Math.abs(base.centerPerHeight[2])+base.extentPerHeight[2]);
  if(trunk){
    if(![trunk.heightM,trunk.baseRadiusM,trunk.topRadiusM].every(finite)||trunk.heightM<=0||trunk.baseRadiusM<=0||trunk.topRadiusM<0)throw new Error('Invalid trunk profile');
    maxY=Math.max(maxY,trunk.heightM/TREE_CANOPY_REFERENCE_HEIGHT_M);minY=Math.min(minY,0);
    radius=Math.max(radius,trunk.baseRadiusM/TREE_CANOPY_REFERENCE_HEIGHT_M);
  }
  const horizontal=envelope.scale*radius+envelope.leanFraction;
  return {centerPerHeight:[0,(minY+maxY)/2,0],extentPerHeight:[horizontal,(maxY-minY)/2,horizontal],metricMarginM:base.metricMarginM*envelope.scale,leanPerHeight:envelope.leanFraction};
}

/** Scale only the skeleton envelope by rendered height and the horizontal
 * crown/trunk ratios (same box growth as the far shader). Leaf/card margins remain in metres. */
export function evaluateFamilyProxyBounds(bounds:FamilyProxyBounds,heightM:number,ratios:{crownRatio:number;trunkRatio:number}={crownRatio:1,trunkRatio:1}):EvaluatedFamilyProxyBounds{
  if(!bounds||!Number.isFinite(heightM)||heightM<TREE_CANOPY_HEIGHT_RANGE_M[0]||heightM>TREE_CANOPY_HEIGHT_RANGE_M[1]||
    !ratios||!finite(ratios.crownRatio)||!finite(ratios.trunkRatio)||ratios.crownRatio<=0||ratios.trunkRatio<=0||!bounds.centerPerHeight||bounds.centerPerHeight.length!==3||
    !bounds.extentPerHeight||bounds.extentPerHeight.length!==3||!finite(bounds.metricMarginM)||bounds.metricMarginM<0||
    ![...bounds.centerPerHeight,...bounds.extentPerHeight].every(finite)||bounds.extentPerHeight.some(x=>x<=0))
    throw new Error('Invalid family proxy bounds or unsupported tree height');
  const box=treeAllometryBox(bounds.centerPerHeight,bounds.extentPerHeight,ratios.crownRatio,ratios.trunkRatio,bounds.leanPerHeight??0);
  return {
    centerM:box.center.map(x=>x*heightM) as [number,number,number],
    extentM:box.extent.map(x=>x*heightM+bounds.metricMarginM) as [number,number,number],
  };
}
