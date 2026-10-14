import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {forestMemoryFootprint,forestMeshBufferFootprint,forestTextureFootprint} from '../src/forest-resource-accounting.ts';

test('mesh buffer estimates count shared and interleaved backing buffers once',()=>{
  const geometry=new THREE.BufferGeometry(),positions=new Float32Array(9);
  const shared=new THREE.BufferAttribute(positions,3);
  geometry.setAttribute('position',shared);geometry.setAttribute('normal',shared);
  geometry.setAttribute('instanceTree',new THREE.InstancedBufferAttribute(new Float32Array(2),2));
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0,1,2]),1));
  const interleaved=new Float32Array(8),other=new THREE.BufferGeometry();
  other.setAttribute('custom',{data:{array:interleaved},itemSize:2,count:4});
  const matrix=new THREE.InstancedBufferAttribute(new Float32Array(16),16),colour=new THREE.InstancedBufferAttribute(new Float32Array(3),3);
  const meshes=[{geometry,instanceMatrix:matrix,instanceColor:colour},{geometry,instanceMatrix:matrix,instanceColor:colour}];
  const value=forestMeshBufferFootprint(meshes,[other]);
  assert.equal(value.geometryBytes,positions.byteLength+6+interleaved.byteLength);
  assert.equal(value.instanceBytes,8+matrix.array.byteLength+colour.array.byteLength);
  assert.equal(value.geometryGpuEstimateBytes,positions.byteLength+6+interleaved.byteLength);
  assert.equal(value.instanceGpuEstimateBytes,8+matrix.array.byteLength+colour.array.byteLength);
  assert.equal(value.geometryCount,2);
  assert.equal(value.totalBytes,value.geometryBytes+value.instanceBytes);
});

test('CPU shared backing stores and GPU attribute uploads use different identities and byte lengths',()=>{
  const buffer=new ArrayBuffer(64),geometry=new THREE.BufferGeometry();
  const left=new THREE.BufferAttribute(new Float32Array(buffer,0,4),1);
  const right=new THREE.BufferAttribute(new Float32Array(buffer,32,4),1);
  geometry.setAttribute('treePivot',left);geometry.setAttribute('treeStiffness',right);
  const interleaved=new THREE.InterleavedBuffer(new Float32Array(12),3);
  geometry.setAttribute('instanceRecord',new THREE.InterleavedBufferAttribute(interleaved,3,0));
  const instancedData=new THREE.InstancedInterleavedBuffer(new Float32Array(8),2,1);
  geometry.setAttribute('treeInstancedRecord',new THREE.InterleavedBufferAttribute(instancedData,2,0));
  const result=forestMeshBufferFootprint([{geometry}]);
  assert.equal(result.geometryBytes,64+interleaved.array.byteLength,
    'tree-prefixed per-vertex attributes stay geometry data and shared CPU storage counts once');
  assert.equal(result.instanceBytes,instancedData.array.byteLength,
    'only the instanced interleaved data belongs to instance storage');
  assert.equal(result.geometryGpuEstimateBytes,left.array.byteLength+right.array.byteLength+interleaved.array.byteLength,
    'two BufferAttributes sharing a CPU backing store upload separate GPU buffers; interleaved views share one upload');
  assert.equal(result.instanceGpuEstimateBytes,instancedData.array.byteLength);
});

test('mixed geometry and instance use of one CPU buffer has order-independent category attribution',()=>{
  const backing=new ArrayBuffer(64),geometry=new THREE.BufferGeometry();
  const vertex=new THREE.BufferAttribute(new Float32Array(backing,0,8),2);
  const matrix=new THREE.BufferAttribute(new Float32Array(backing,0,16),16);
  geometry.setAttribute('position',vertex);
  const geometryMesh={geometry},instanceMesh={geometry:new THREE.BufferGeometry(),instanceMatrix:matrix};
  const forward=forestMeshBufferFootprint([geometryMesh,instanceMesh]);
  const reverse=forestMeshBufferFootprint([instanceMesh,geometryMesh]);
  assert.deepEqual(forward,reverse);
  assert.equal(forward.geometryBytes,64,'mixed CPU backing storage is attributed to geometry deterministically');
  assert.equal(forward.instanceBytes,0);
  assert.equal(forward.geometryGpuEstimateBytes,32,'separate vertex and instance attributes still represent two GPU uploads');
  assert.equal(forward.instanceGpuEstimateBytes,64);
});

test('shared textures count decoded image sources once and GPU storage per texture object',()=>{
  const base={width:4,height:4},mip2={width:2,height:2},mip1={width:1,height:1};
  const texture={image:base,mipmaps:[base,mip2,mip1],generateMipmaps:false,minFilter:THREE.LinearMipmapLinearFilter,
    format:THREE.RGBAFormat,type:THREE.UnsignedByteType};
  const value=forestTextureFootprint([texture,texture]);
  assert.deepEqual(value,{decodedCpuBytes:(16+4+1)*4,gpuEstimateBytes:(16+4+1)*4,textureCount:1,imageSourceCount:3});
  const second={...texture};
  assert.deepEqual(forestTextureFootprint([texture,second]),{
    decodedCpuBytes:(16+4+1)*4,gpuEstimateBytes:2*(16+4+1)*4,textureCount:2,imageSourceCount:3});
});

test('ordinary mipmapped RGBA texture estimates the full GPU mip chain',()=>{
  const texture={image:{width:4,height:4},mipmaps:[],generateMipmaps:true,minFilter:THREE.LinearMipmapLinearFilter,
    format:THREE.RGBAFormat,type:THREE.UnsignedByteType};
  assert.equal(forestTextureFootprint([texture]).gpuEstimateBytes,(16+4+1)*4);
});

test('forest ledger combines legacy buffers, family buffers, unique images and atlas storage without double counting',()=>{
  const legacyGeometry=new THREE.BufferGeometry();legacyGeometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(3),3));
  const legacy={geometry:legacyGeometry,instanceMatrix:new THREE.InstancedBufferAttribute(new Float32Array(16),16),
    instanceColor:new THREE.InstancedBufferAttribute(new Float32Array(3),3)};
  const familyGeometry=new THREE.BufferGeometry();familyGeometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(6),3));
  const batchGeometry=familyGeometry.clone();batchGeometry.setAttribute('instanceTree',new THREE.InstancedBufferAttribute(new Float32Array(2),2));
  const batch={geometry:batchGeometry,instanceMatrix:new THREE.InstancedBufferAttribute(new Float32Array(16),16),
    instanceColor:new THREE.InstancedBufferAttribute(new Float32Array(3),3)};
  const base={width:4,height:4},texture={image:base,mipmaps:[base,{width:2,height:2},{width:1,height:1}],
    generateMipmaps:false,minFilter:THREE.LinearMipmapLinearFilter,format:THREE.RGBAFormat,type:THREE.UnsignedByteType};
  const value=forestMemoryFootprint({legacyMeshes:[legacy],familyGeometries:[familyGeometry],familyMeshes:[batch],
    familyTextures:[texture,texture],embeddedImageFileBytes:13,farAtlasResidentBytes:1000});
  assert.equal(value.geometryCpuBytes,12+24+24);
  assert.equal(value.instanceCpuBytes,16*4+3*4+2*4+16*4+3*4);
  assert.equal(value.decodedTextureCpuBytes,(16+4+1)*4);
  assert.equal(value.gpuTextureEstimateBytes,(16+4+1)*4);
  assert.equal(value.embeddedImageFileBytes,13,'compressed source image bytes stay separate from decoded and GPU estimates');
  assert.equal(value.estimatedGpuBytes,value.geometryCpuBytes+value.instanceCpuBytes+value.gpuTextureEstimateBytes+1000);
  assert.equal(value.retainedCpuBytes,value.geometryCpuBytes+value.instanceCpuBytes+value.decodedTextureCpuBytes);
});
