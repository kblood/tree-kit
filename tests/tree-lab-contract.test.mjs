import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const html=await readFile(new URL('../tree-asset-lab.html',import.meta.url),'utf8');
const source=await readFile(new URL('../src/tree-asset-lab.ts',import.meta.url),'utf8');

test('standalone lab wires every fixed DOM control and both optional tree families',()=>{
  const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]));
  const fixed=[...source.matchAll(/(?:\$<[^>]+>\(|\$\()'([^']+)'/g)].map(match=>match[1]);
  assert.deepEqual(fixed.filter(id=>!ids.has(id)),[]);
  for(const id of ['branch-lod0','branch-lod1','branch-mip-manifest','branch-mip-payload',
    'spire-lod0','spire-lod1','spire-mip-manifest','spire-mip-payload'])assert.ok(ids.has(id),`missing ${id}`);
});

test('lab exercises the same family library, bark pool, mixed detailed tiers and far-atlas capture as Atlas',()=>{
  assert.match(source,/new ForestTreeFamilyLibrary/);
  assert.match(source,/shareBarkTextures:shareBark/);
  assert.match(source,/setShareBarkTextures/);
  assert.match(source,/nextLibrary\.replace\(inputs,options\)/);
  assert.match(source,/mixedLOD/);
  assert.match(source,/new ForestFarAtlas/);
  assert.match(source,/createCaptureBatch:/);
  assert.match(source,/atlas\.step\(renderer,2\)/);
});
