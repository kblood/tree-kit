/** Tree Kit public API v1: validated GLB families, canopy material setup and wind. */
export {
  TREE_REFERENCE_HEIGHT_M,
  TREE_WIND_PERIOD_NS,
  loadTreeAssetFamily,
  prepareTreeLODPair,
  treeLodCardScale,
  treeVertexMeters,
  treeWindPhase,
} from '../tree-asset.ts';
export type {
  TreeAssetFamily,
  TreeAssetOptions,
  TreeCanopyPresentation,
  TreeCardCompensation,
  TreeInstanceAllometry,
} from '../tree-asset.ts';
export {TreeBarkTexturePool} from '../tree-bark-texture-pool.ts';
export type {TreeBarkTextureLease, TreeBarkTextureRole} from '../tree-bark-texture-pool.ts';
export {decodeTreeFoliageSidecar,installTreeFoliageSidecar} from '../tree-foliage-sidecar.ts';
export type {TreeFoliageMipSidecar} from '../tree-foliage-sidecar.ts';
export {
  buildTreeFoliageMipPixels,
  installTreeFoliageCoverageMipmaps,
  TREE_FOLIAGE_ALPHA_CUTOFF,
  TREE_FOLIAGE_ATLAS_COLUMNS,
  TREE_FOLIAGE_ATLAS_ROWS,
  TREE_FOLIAGE_MIPS_VERSION,
} from '../tree-foliage-mips.ts';
export type {
  InstalledTreeFoliageMipChain,
  TreeFoliageMipLevelReport,
  TreeFoliageMipOptions,
  TreeFoliageMipPixelChain,
  TreeFoliageMipPixels,
} from '../tree-foliage-mips.ts';
export {installLeafTransmission} from '../tree-leaf-transmission.ts';
export type {LeafTransmissionOptions} from '../tree-leaf-transmission.ts';
export {
  TREE_FOLIAGE_LOD_CUTOFF_STEP,
  TREE_FOLIAGE_LOD_CUTOFF_VERSION,
  calibrateTreeFoliageLodCutoffs,
  installTreeFoliageLodCutoff,
  sampleTreeFoliageBilinearAlpha,
  sampleTreeFoliageTrilinearAlpha,
  treeFoliageLodCutoff,
  treeFoliageLodCutoffGLSL,
} from '../tree-foliage-cutoff.ts';
export type {TreeFoliageAlphaLevel,TreeFoliageLodCutoffs} from '../tree-foliage-cutoff.ts';
export {TREE_KIT_API_VERSION} from './version.ts';
