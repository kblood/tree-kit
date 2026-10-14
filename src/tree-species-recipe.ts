/** Presentation contract only: never part of canonical surface-cell addresses. */
export const TREE_RECIPE_VERSION='tree-recipe-1';
export const TREE_VARIANT_COUNT=8;
export const TREE_ASSET_VERSION='temperate-branching-v1';

export type TreeFamilyKind='branching'|'spire';
export type TreeSpeciesRecipe=Readonly<{
  version:typeof TREE_RECIPE_VERSION; speciesId:string; lineageId:string;
  family:TreeFamilyKind; sourceFingerprint:string;
  heightM:number; crownWidthM:number; trunkDiameterM:number;
  branchCount:number; branchAngleRad:number; curvature:number;
  leafLengthM:number; leafWidthM:number; leafDensity:number;
  barkSRGB:string; foliageSRGB:string;
}>;
/** Minimal serialized species inputs consumed by the Tree Kit. This DTO keeps
 * recipe generation independent of Atlas' dated Biosphere model. */
export type TreeSpeciesCandidate=Readonly<{id:string;kind:string;family:string}>;
export type TreeSpeciesInput=TreeSpeciesCandidate&Readonly<{
  lineageId:string;
  traits:Readonly<{
    heightM:number;widthRatio:number;branchCount:number;branchAngle:number;
    curvature:number;leafLength:number;leafWidth:number;leafDensity:number;
    color:string;woodColor:string;
  }>;
}>;
export type TreeInstanceAppearance=Readonly<{variant:number;barkBrightness:number;foliageBrightness:number;windPhase01:number;textureVariant:number}>;
export type TreeSpeciesBinding=Readonly<{recipe:TreeSpeciesRecipe;appearance:TreeInstanceAppearance}>;

function hash(text:string){
  let h=2166136261;
  for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}
  h^=h>>>16;h=Math.imul(h,0x7feb352d);h^=h>>>15;h=Math.imul(h,0x846ca68b);
  return (h^(h>>>16))>>>0;
}
const unit=(...parts:unknown[])=>hash(JSON.stringify(parts))/0x100000000;

/** The caller supplies the already dated/eligible catalogue species. Rendezvous
 * assignment is independent of enumeration order and unrelated non-tree species.
 * Adding a tree species can transfer some assignments; it does not move cells. */
export function bindTreeSpecies<T extends TreeSpeciesCandidate>(cellId:string,eligibleSpecies:readonly T[]):T|null {
  if(!cellId)throw new Error('Canonical cell id is required');
  let chosen:T|null=null,best=-1;
  for(const species of eligibleSpecies){
    if(species.kind!=='tree'||(species.family!=='branching'&&species.family!=='spire'))continue;
    const score=hash(JSON.stringify([cellId,species.id,'tree-species-binding-1']));
    if(score>best||(score===best&&species.id<(chosen?.id??''))){chosen=species;best=score;}
  }
  return chosen;
}

/** Convert existing catalogue traits into a physical rendering envelope. The
 * trunk/crown relationship is an art heuristic, not a botanical simulation. */
export function treeSpeciesRecipe(species:TreeSpeciesInput):TreeSpeciesRecipe {
  if(!species.id||!species.lineageId)throw new Error('Catalogue species and lineage ids are required');
  if(species.kind!=='tree'||(species.family!=='branching'&&species.family!=='spire'))throw new Error('A catalogue tree species is required');
  const t=species.traits;
  for(const key of ['heightM','widthRatio','branchCount','branchAngle','curvature','leafLength','leafWidth','leafDensity'] as const)
    if(!Number.isFinite(t[key]))throw new Error(`Non-finite tree trait ${key}`);
  if(t.heightM<=0||t.widthRatio<=0||t.leafLength<=0||t.leafWidth<=0||t.branchCount<1||t.leafDensity<0||t.leafDensity>1)throw new Error('Invalid tree physical envelope');
  if(!/^#[0-9a-f]{6}$/i.test(t.color)||!/^#[0-9a-f]{6}$/i.test(t.woodColor))throw new Error('Tree colours must be sRGB hex');
  const source=[species.id,species.lineageId,species.family,t.heightM,t.widthRatio,t.branchCount,t.branchAngle,t.curvature,t.leafLength,t.leafWidth,t.leafDensity,t.color,t.woodColor];
  return Object.freeze({version:TREE_RECIPE_VERSION,speciesId:species.id,lineageId:species.lineageId,family:species.family,
    sourceFingerprint:hash(JSON.stringify(source)).toString(16).padStart(8,'0'),
    heightM:t.heightM,crownWidthM:t.heightM*t.widthRatio,
    trunkDiameterM:t.heightM*(species.family==='spire'?.026:.034),
    branchCount:Math.round(t.branchCount),branchAngleRad:t.branchAngle,curvature:t.curvature,
    leafLengthM:t.leafLength,leafWidthM:t.leafWidth,leafDensity:t.leafDensity,
    barkSRGB:t.woodColor,foliageSRGB:t.color});
}

export function treeStructuralVariant(recipe:TreeSpeciesRecipe,variant:number){
  if(!Number.isInteger(variant)||variant<0||variant>=TREE_VARIANT_COUNT)throw new Error('Tree variant is outside the bounded pool');
  const u=(channel:string)=>unit(recipe.version,recipe.speciesId,recipe.sourceFingerprint,variant,channel);
  const heightScale=.94+.12*u('height'),crownScale=.93+.14*u('crown');
  return Object.freeze({variant,branchSeed:hash(JSON.stringify([recipe.version,recipe.speciesId,variant,'branches'])),
    heightM:recipe.heightM*heightScale,crownWidthM:recipe.crownWidthM*heightScale*crownScale,
    trunkDiameterM:recipe.trunkDiameterM*heightScale,
    branchCount:Math.max(3,Math.round(recipe.branchCount*(.9+.2*u('branches')))),
    branchAngleRad:recipe.branchAngleRad+(.08*u('angle')-.04),
    curvature:recipe.curvature+(.08*u('curve')-.04),
    // Leaves keep their species dimensions when the whole tree grows taller.
    leafLengthM:recipe.leafLengthM,leafWidthM:recipe.leafWidthM,
    leafDensity:Math.min(1,recipe.leafDensity*(.94+.12*u('density')))});
}

/** Cheap per-instance shader parameters. Tints multiply separate bark/leaf
 * masks; they never choose a new topology or a new species. */
export function treeInstanceAppearance(recipe:TreeSpeciesRecipe,cellId:string):TreeInstanceAppearance {
  if(!cellId)throw new Error('Canonical cell id is required');
  const u=(channel:string)=>unit(recipe.version,recipe.speciesId,cellId,channel);
  return Object.freeze({variant:Math.floor(u('variant')*TREE_VARIANT_COUNT),
    barkBrightness:.92+.16*u('bark'),foliageBrightness:.9+.2*u('foliage'),
    windPhase01:u('wind'),textureVariant:Math.floor(u('texture')*4)});
}

export function treeGeometryCacheKey(recipe:TreeSpeciesRecipe,variant:number,lod:0|1|2,assetVersion=TREE_ASSET_VERSION){
  if(![0,1,2].includes(lod)||!assetVersion)throw new Error('Tree asset version and valid LOD are required');
  treeStructuralVariant(recipe,variant);
  return JSON.stringify([recipe.version,assetVersion,recipe.speciesId,recipe.sourceFingerprint,variant,lod]);
}
