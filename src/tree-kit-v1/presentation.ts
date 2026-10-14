/** Tree Kit public API v1: shared allometry, canopy analysis and LOD variants. */
export {
  FOREST_VARIANT_COUNT,
  FOREST_VARIANT_CROWN_RAMP,
  FOREST_VARIANT_LIMITS,
  FOREST_VARIANT_TWIST_FLOOR,
  FOREST_VARIANT_VERSION,
  forestStructuralVariant,
  forestStructuralVariants,
  forestVariantCrownWeight,
  forestVariantEnvelope,
  forestVariantGLSL,
  forestVariantClumpHash,
  forestVariantPoint,
  forestVariantRadiusBound,
  forestVariantRemovesLeaf,
  forestVariantTwist,
  forestVariantUniformData,
} from '../tree-structural-variant.ts';
export type {ForestStructuralVariant} from '../tree-structural-variant.ts';
export {
  TREE_ALLOMETRY_CARD,
  TREE_ALLOMETRY_RATIO,
  TREE_ALLOMETRY_RATIO_MAX,
  TREE_ALLOMETRY_REFERENCE_HEIGHT_M,
  TREE_ALLOMETRY_VERSION,
  TREE_FAMILY_ALLOMETRY_ENVELOPE,
  TREE_LEGACY_ALLOMETRY_ENVELOPE,
  TREE_ALLOMETRY_REASONS,
  TREE_ALLOMETRY_IDENTITY_CODE,
  LEGACY_TREE_ALLOMETRY,
  forestTreeDimensions,
  forestFamilyBoundRadius,
  forestFamilyEnvelopeRadius,
  legacyTreeBoundSphere,
  packTreeAllometryParameter,
  packTreeAllometryRatios,
  quantizeTreeAllometryRatio,
  treeAllometryCrownHalfWidthM,
  treeAllometryBox,
  treeAllometryCardScale,
  treeAllometryGLSL,
  treeAllometryLeafDepthScale,
  treeAllometryRadial,
  treeAllometryReference,
  treeAllometryRatioFromCode,
  treeAllometryAtlasStretch,
  treeAllometryPoint,
  validateTreeAllometryReference,
  unpackTreeAllometryParameter,
  unpackTreeAllometryRatios,
} from '../tree-allometry.ts';
export type {
  ForestTreeDimensions,
  TreeAllometryCrownReference,
  TreeAllometryReason,
  TreeAllometryReference,
} from '../tree-allometry.ts';
export {
  TREE_CANOPY_HEIGHT_RANGE_M,
  TREE_CANOPY_REFERENCE_HEIGHT_M,
  TREE_CANOPY_WIND_MAX_ANGLE_RAD,
  deriveTreeCanopyMetadata,
} from '../tree-canopy-profile.ts';
export type {TreeCanopyMetadata, TreeCanopyProfile, TreeCullingBounds, TreeTrunkProfile, CrownBand} from '../tree-canopy-profile.ts';
export {alphaWeightedLinearRgbMean,deriveTreeBaseColorStatistics} from '../tree-canopy-profile.ts';
export {deriveFamilyProxyBounds, deriveVariantFamilyProxyBounds,evaluateFamilyProxyBounds} from '../tree-canopy-bounds.ts';
export type {FamilyProxyBounds,EvaluatedFamilyProxyBounds} from '../tree-canopy-bounds.ts';
export {TREE_KIT_API_VERSION} from './version.ts';
export {createLegacyTreeGeometry,treeQuaternion,LEGACY_TREE_BOUND,LEGACY_TREE_LOBES,LEGACY_TREE_SHAPE_VERSION,LEGACY_TREE_TRUNK} from '../tree-shape.ts';
export {forestMaterial,forestDepthMaterial,installLegacyForestCoverage,installLegacyTreeAllometry} from '../forest-material.ts';
export {forestCoverageGLSL,forestScreenHash,quantizeForestCoverage} from '../forest-coverage.ts';
export {installTreeForestCoverage} from '../tree-forest-coverage.ts';
export {TREE_LOD_COVERAGE_VERSION,TREE_LOD_COVERAGE_VIEWS,calibrateTreeLodCardScale,treeProjectedAreaM2} from '../tree-lod-coverage.ts';
export {FOREST_FOLIAGE_LOBE_EXPONENT,FOREST_FOLIAGE_LOBE_VERSION,forestFoliageLobeCosine,forestFoliageLobeGLSL,installForestFoliageLobe} from '../forest-foliage-lobe.ts';
