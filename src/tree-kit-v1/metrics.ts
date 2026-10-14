/** Tree Kit public API v1: CPU/GPU resource estimates for owned tree batches. */
export {
  forestMemoryFootprint,
  forestMeshBufferFootprint,
  forestTextureFootprint,
} from '../forest-resource-accounting.ts';
export type {
  ForestBufferFootprint,
  ForestMemoryFootprint,
  ForestTextureFootprint,
} from '../forest-resource-accounting.ts';
export {TREE_KIT_API_VERSION} from './version.ts';
