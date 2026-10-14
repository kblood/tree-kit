import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {extname} from 'node:path';
import {
  TREE_KIT_API_VERSION,
  TREE_RECIPE_VERSION,
  bindTreeSpecies,
  treeGeometryCacheKey,
  treeInstanceAppearance,
  treeSpeciesRecipe,
} from '#tree-kit/v1/recipes';
import {
  FOREST_VARIANT_COUNT,
  TREE_ALLOMETRY_VERSION,
  forestStructuralVariants,
  forestMaterial,
  forestVariantUniformData,
  treeAllometryBox,
} from '#tree-kit/v1/presentation';
import {
  TREE_KIT_API_VERSION as assetsApiVersion,
  TREE_WIND_PERIOD_NS,
  loadTreeAssetFamily,
  prepareTreeLODPair,
  installLeafTransmission,
  treeWindPhase,
} from '#tree-kit/v1/assets';
import {InstanceUpdateRanges,TreeInstancePasses,TreeInstanceRows,FOREST_PRESENTATION_VERSION,forestPresentationFamily,packForestPresentation,unpackForestPresentation} from '#tree-kit/v1/instances';
import {forestMemoryFootprint,forestMeshBufferFootprint,forestTextureFootprint} from '#tree-kit/v1/metrics';
import {
  FOREST_FAR_ATLAS_VERSION,
  FOREST_FAR_ATLAS_LAYOUT,
  ForestFarAtlas,
  ForestImpostors,
  TREE_VIEW_VERSION,
  TreeCapturedImpostor,
  decodeTreeView,
  encodeTreeView,
  loadTreeCapture,
  adaptImpostorShader,
  createTreeDiffuseTransfer,
  reduceTreeDiffuseTransfer,
  evaluateTreeDiffuseTransfer,
} from '#tree-kit/v1/impostors';

test('Tree Kit v1 public import paths expose deterministic recipes and presentation contracts',()=>{
  assert.equal(TREE_KIT_API_VERSION,'1.0.0');
  assert.equal(assetsApiVersion,TREE_KIT_API_VERSION);
  assert.equal(TREE_RECIPE_VERSION,'tree-recipe-1');
  assert.equal(TREE_ALLOMETRY_VERSION,'tree-allometry-2');
  const species=[
    {id:'oak-a',lineageId:'oak-lineage',kind:'tree',family:'branching',traits:{heightM:18,widthRatio:.78,branchCount:9,branchAngle:.62,curvature:.12,leafLength:.19,leafWidth:.11,leafDensity:.78,color:'#426b37',woodColor:'#574536'}},
    {id:'pine-a',lineageId:'pine-lineage',kind:'tree',family:'spire',traits:{heightM:21,widthRatio:.44,branchCount:7,branchAngle:.7,curvature:.06,leafLength:.12,leafWidth:.05,leafDensity:.66,color:'#335a3d',woodColor:'#554637'}},
  ];
  const binding=bindTreeSpecies('body/cell/42',species);
  assert.ok(binding);
  assert.equal(binding.id,bindTreeSpecies('body/cell/42',[...species].reverse())?.id);
  const recipe=treeSpeciesRecipe(binding);
  const appearance=treeInstanceAppearance(recipe,'body/cell/42');
  assert.equal(appearance.variant>=0&&appearance.variant<FOREST_VARIANT_COUNT,true);
  assert.equal(treeGeometryCacheKey(recipe,appearance.variant,1),treeGeometryCacheKey(recipe,appearance.variant,1));
  assert.equal(forestStructuralVariants(recipe.family).length,FOREST_VARIANT_COUNT);
  assert.equal(forestVariantUniformData(forestStructuralVariants(recipe.family)).length,FOREST_VARIANT_COUNT*8);
  const box=treeAllometryBox([0,0,0],[1,2,1],1,1);
  assert.ok([...box.center,...box.extent].every(Number.isFinite));
  assert.equal(TREE_WIND_PERIOD_NS,7_000_000_000n);
  assert.equal(treeWindPhase(-1n),treeWindPhase(TREE_WIND_PERIOD_NS-1n));
  assert.equal(typeof loadTreeAssetFamily,'function');
  assert.equal(typeof prepareTreeLODPair,'function');
  assert.equal(typeof installLeafTransmission,'function');
  assert.equal(typeof TreeInstancePasses,'function');
  assert.equal(typeof TreeInstanceRows,'function');
  assert.equal(typeof InstanceUpdateRanges,'function');
  assert.equal(typeof forestMemoryFootprint,'function');
  assert.equal(typeof forestMeshBufferFootprint,'function');
  assert.equal(typeof forestTextureFootprint,'function');
  assert.equal(FOREST_PRESENTATION_VERSION,'forest-presentation-3');
  const forestCode=packForestPresentation('branching',1,1,7);
  const decodedForest=unpackForestPresentation(forestCode);
  assert.equal(decodedForest.kind,'branching');assert.equal(decodedForest.variant,7);
  assert.ok(Math.abs(decodedForest.bark-1)<.002&&Math.abs(decodedForest.foliage-1)<.002);
  assert.equal(forestPresentationFamily({representation:'family',kind:'spire'},{has:kind=>kind==='spire'}),'spire');
  assert.equal(typeof forestMaterial,'function');
  assert.equal(FOREST_FAR_ATLAS_VERSION,'forest-far-atlas-2');
  assert.equal(FOREST_FAR_ATLAS_LAYOUT.grid,9);
  assert.equal(typeof ForestFarAtlas,'function');
  assert.equal(typeof ForestImpostors,'function');
  assert.equal(TREE_VIEW_VERSION,'tree-full-octahedral-1');
  assert.equal(typeof TreeCapturedImpostor,'function');
  assert.equal(typeof loadTreeCapture,'function');
  assert.equal(typeof adaptImpostorShader,'function');
  assert.equal(typeof createTreeDiffuseTransfer,'function');
  assert.equal(typeof reduceTreeDiffuseTransfer,'function');
  assert.equal(typeof evaluateTreeDiffuseTransfer,'function');
  assert.deepEqual(decodeTreeView(...encodeTreeView([0,1,0])).map(x=>Math.round(x*1e6)/1e6),[0,1,0]);
});

test('Tree Kit v1 entrypoints have no transitive dependency on Atlas adapters',async()=>{
  const root=new URL('../',import.meta.url),pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  const forbidden=/(?:^|\/)(?:catalog|biosphere-model|world-time|local-aerial-perspective|planet-[^/]+|main)\.ts$/;
  const resolveImport=(specifier,from)=>{
    let target=specifier;
    if(specifier.startsWith('#')){
      target=pkg.imports?.[specifier];
      while(target&&typeof target==='object')target=target.default??target.node??target.import??target.types;
      if(typeof target!=='string')return null;
      return new URL(target,root);
    }
    if(!specifier.startsWith('.'))return null;
    let url=new URL(specifier,from);
    if(!extname(url.pathname))for(const suffix of ['.ts','.js','.mjs']){const candidate=new URL(`${url.href}${suffix}`);if(existsSync(candidate)){url=candidate;break;}}
    return url;
  };
  const pending=['recipes','presentation','assets','instances','impostors','metrics'].map(name=>new URL(`src/tree-kit-v1/${name}.ts`,root));
  const visited=new Set(),violations=[];
  while(pending.length){
    const url=pending.pop(),path=decodeURIComponent(url.pathname).replaceAll('\\','/');
    if(visited.has(url.href)||!path.startsWith(decodeURIComponent(root.pathname).replaceAll('\\','/')))continue;
    visited.add(url.href);
    if(forbidden.test(path))violations.push(path);
    const source=await readFile(url,'utf8');
    const imports=[...source.matchAll(/(?:\bfrom\s*|\bimport\s*\()(['"])([^'"]+)\1/g),...source.matchAll(/\bimport\s*(['"])([^'"]+)\1/g)];
    for(const match of imports){const resolved=resolveImport(match[2],url);if(resolved)pending.push(resolved);}
  }
  assert.deepEqual(violations,[]);
});
