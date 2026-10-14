import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareTreeLODPair } from '../src/tree-asset.ts';

const formats = ['SCALAR', 'SCALAR', 'VEC3', 'VEC3', 'VEC3', 'VEC3', 'VEC2', 'VEC4'];
const attributes = ['_WIND', '_BRANCH_LEVEL', '_LEAF_CENTER', '_LEAF_PIVOT',
  'POSITION', 'NORMAL', 'TEXCOORD_0', 'TANGENT'];
const materials = [
  { name: 'MAT_AtlasBark', pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 } },
  { name: 'MAT_AtlasFoliage', alphaMode: 'MASK', alphaCutoff: 0.5,
    pbrMetallicRoughness: { baseColorTexture: { index: 2 } } },
];

function makeTreeGlb({ imagesFirst = false, accessorUsesImage = false, geometrySeed = 17,
  imageMutationOffset = -1 } = {}) {
  const binary = new Uint8Array(56);
  const imageOffset = imagesFirst ? 0 : 40;
  const geometryOffset = imagesFirst ? 16 : 0;
  for (let image = 0; image < 4; image++) {
    for (let i = 0; i < 4; i++) binary[imageOffset + image * 4 + i] = 32 + image * 4 + i;
  }
  if (imageMutationOffset >= 0) binary[imageOffset + imageMutationOffset] ^= 0xff;
  for (let i = 0; i < 40; i++) binary[geometryOffset + i] = (geometrySeed + i) & 0xff;
  const bufferViews = [
    ...Array.from({ length: 4 }, (_, image) => ({ buffer: 0, byteOffset: imageOffset + image * 4, byteLength: 4 })),
    { buffer: 0, byteOffset: geometryOffset, byteLength: 8 },
    { buffer: 0, byteOffset: geometryOffset + 8, byteLength: 16 },
    { buffer: 0, byteOffset: geometryOffset + 24, byteLength: 16 },
  ];
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: materials.map((_, material) => ({ material, attributes: Object.fromEntries(
      attributes.map((name, index) => [name, index]) ) })) }],
    materials: structuredClone(materials), textures: [{ source: 0 }, { source: 1 }, { source: 2 }, { source: 3 }],
    images: Array.from({ length: 4 }, (_, bufferView) => ({ bufferView, mimeType: 'image/png' })),
    buffers: [{ byteLength: binary.length }], bufferViews,
    accessors: formats.map((type, index) => ({ bufferView: accessorUsesImage && index === 0
      ? 0 : 4 + Math.min(2, Math.floor(index / 3)),
      componentType: 5126, count: 1, type })),
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = (jsonBytes.length + 3) & ~3;
  const glb = new ArrayBuffer(28 + jsonLength + binary.length);
  const view = new DataView(glb), bytes = new Uint8Array(glb);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, glb.byteLength, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20, 20 + jsonLength); bytes.set(jsonBytes, 20);
  view.setUint32(20 + jsonLength, binary.length, true); view.setUint32(24 + jsonLength, 0x004e4942, true);
  bytes.set(binary, 28 + jsonLength);
  return glb;
}

function parseGlb(buffer) {
  const view = new DataView(buffer);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)));
  const binaryLength = view.getUint32(20 + jsonLength, true);
  const binary = new Uint8Array(buffer, 28 + jsonLength, binaryLength);
  return { json, binary };
}

function updateGlbJson(buffer, update) {
  const { json, binary } = parseGlb(buffer);
  update(json);
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = (jsonBytes.length + 3) & ~3;
  const glb = new ArrayBuffer(28 + jsonLength + binary.length);
  const view = new DataView(glb), bytes = new Uint8Array(glb);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, glb.byteLength, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20, 20 + jsonLength); bytes.set(jsonBytes, 20);
  view.setUint32(20 + jsonLength, binary.length, true); view.setUint32(24 + jsonLength, 0x004e4942, true);
  bytes.set(binary, 28 + jsonLength);
  return glb;
}

test('texture-free LOD1 parser input omits a verified trailing image payload and remaps accessors', () => {
  const lod0 = makeTreeGlb({ geometrySeed: 17 }), lod1 = makeTreeGlb({ geometrySeed: 99 });
  const originalLod1 = parseGlb(lod1);
  const expectedGeometry = originalLod1.binary.slice(0, 40);
  const prepared = prepareTreeLODPair(lod0, lod1);
  const parserInput = parseGlb(prepared.lod1GeometryBuffer);

  assert.equal(prepared.embeddedTextureBytes, 16);
  assert.equal(parserInput.json.images, undefined);
  assert.equal(parserInput.json.textures, undefined);
  assert.equal(parserInput.json.bufferViews.length, 3);
  assert.equal(parserInput.json.buffers[0].byteLength, expectedGeometry.length);
  assert.deepEqual(parserInput.json.accessors.map(accessor => accessor.bufferView), [0, 0, 0, 1, 1, 1, 2, 2]);
  assert.deepEqual(parserInput.binary, expectedGeometry);
  assert.deepEqual(prepared.foliagePng, new Uint8Array(parseGlb(lod0).binary).slice(48, 52));
});

test('image payload before geometry falls back to the original parser binary layout', () => {
  const lod0 = makeTreeGlb(), lod1 = makeTreeGlb({ imagesFirst: true, geometrySeed: 99 });
  const source = parseGlb(lod1), prepared = prepareTreeLODPair(lod0, lod1);
  const parserInput = parseGlb(prepared.lod1GeometryBuffer);

  assert.equal(parserInput.json.bufferViews.length, 7);
  assert.equal(parserInput.json.buffers[0].byteLength, source.binary.length);
  assert.deepEqual(parserInput.binary, source.binary);
  assert.deepEqual(parserInput.json.accessors.map(accessor => accessor.bufferView), [4, 4, 4, 5, 5, 5, 6, 6]);
});

test('a trailing image bufferView referenced by geometry prevents compaction', () => {
  const lod0 = makeTreeGlb(), lod1 = makeTreeGlb({ accessorUsesImage: true, geometrySeed: 99 });
  const source = parseGlb(lod1), prepared = prepareTreeLODPair(lod0, lod1);
  const parserInput = parseGlb(prepared.lod1GeometryBuffer);

  assert.equal(parserInput.json.bufferViews.length, 7);
  assert.deepEqual(parserInput.binary, source.binary);
  assert.deepEqual(parserInput.json.accessors.map(accessor => accessor.bufferView), [0, 4, 4, 5, 5, 5, 6, 6]);
});

test('exact image equality rejects first, middle, and last byte mismatches', () => {
  const lod0 = makeTreeGlb();
  for (const imageMutationOffset of [0, 8, 15]) {
    const lod1 = makeTreeGlb({ imageMutationOffset, geometrySeed: 99 });
    assert.throws(() => prepareTreeLODPair(lod0, lod1), /Tree LOD image \d differs/);
  }
});

test('exact image equality rejects mismatched image lengths', () => {
  const lod0 = makeTreeGlb(), lod1 = updateGlbJson(makeTreeGlb({ geometrySeed: 99 }), json => {
    json.bufferViews[0].byteLength--;
  });
  assert.throws(() => prepareTreeLODPair(lod0, lod1), /Tree LOD image 0 differs/);
});
