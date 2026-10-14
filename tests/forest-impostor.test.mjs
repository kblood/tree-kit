import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {ForestImpostors} from '../src/forest-impostor.ts';
test('far proxy bounds instance allocation and validates physical transforms',()=>{
  for(const capacity of [0,-1,1.5,229377,Infinity])assert.throws(()=>new ForestImpostors(capacity));
  const f=new ForestImpostors(8),p=new THREE.Vector3(100,200,300),q=new THREE.Quaternion();
  try{
    assert.equal(f.commit(),0);f.write(2,p,16,q,.3,900);assert.equal(f.mesh.geometry.instanceCount,3);
    assert.equal(f.commit(),8*48);assert.equal(f.commit(),0);
    assert.deepEqual(Array.from(f.positions.array.slice(8,12)),[100,200,300,16]);
    for(const index of [-1,8,.5,NaN])assert.throws(()=>f.write(index,p,16,q,.3,900));
    assert.throws(()=>f.write(0,p,NaN,q,.3,900));assert.throws(()=>f.write(0,p,16,new THREE.Quaternion(1,1,1,1),.3,900));
    assert.throws(()=>f.write(0,new THREE.Vector3(1e100,0,0),16,q,.3,900));
    f.write(2,p,0,q,.3,900);assert.equal(f.positions.getW(2),0,'zero height retires a slot');
  }finally{f.dispose();}
});
test('hidden batches retain uploads without accumulating unbounded ranges',()=>{
  const f=new ForestImpostors(8),p=new THREE.Vector3(),q=new THREE.Quaternion();
  try{
    for(let i=0;i<1000;i++){f.write(i%8,p,16,q,.5,0);f.commit();}
    for(const a of [f.positions,f.rotations,f.parameters])assert.deepEqual(a.updateRanges,[{start:0,count:32}]);
  }finally{f.dispose();}
});

test('scattered ownership writes coalesce by 256-slot blocks and touch only ownership',()=>{
  const f=new ForestImpostors(4096);f.mesh.visible=false;
  try{
    const transformVersions=[f.positions.version,f.rotations.version,f.parameters.version],ownershipVersion=f.ownership.version,dirtyBlocks=new Set();
    const expected=new Map();
    for(let i=0;i<1000;i++){
      const index=(i*13)%4096,level=(i%255)+1;f.setOwnership(index,level);expected.set(index,level);dirtyBlocks.add(Math.floor(index/256));
    }
    const bytes=f.commit(),ranges=f.ownership.updateRanges.map(range=>({...range}));
    assert.ok(bytes<=dirtyBlocks.size*256*2,'ownership upload is bounded by two bytes per slot in each dirty block');
    assert.equal(bytes,ranges.reduce((sum,range)=>sum+range.count*2,0));
    assert.ok(ranges.length>0);for(const range of ranges)assert.equal(range.start%256,0);
    for(const [index,level] of expected)assert.equal(f.ownership.array[index],level);
    assert.equal(f.ownership.version,ownershipVersion+1);assert.deepEqual([f.positions.version,f.rotations.version,f.parameters.version],transformVersions);
    assert.deepEqual(f.ownership.updateRanges,ranges,'hidden objects retain pending ownership upload ranges');
    assert.equal(f.commit(),0,'repeated unchanged ownership writes schedule no upload');
    assert.equal(f.ownership.version,ownershipVersion+1);assert.deepEqual(f.ownership.updateRanges,ranges);
    for(const [index,level] of expected)f.setOwnership(index,level);
    assert.equal(f.commit(),0);assert.equal(f.ownership.version,ownershipVersion+1);
  }finally{f.dispose();}
});

test('reusing an impostor slot resets ownership and rejects invalid ownership writes',()=>{
  const f=new ForestImpostors(512),p=new THREE.Vector3(1,2,3),q=new THREE.Quaternion();
  try{
    assert.throws(()=>f.setOwnership(-1,1));assert.throws(()=>f.setOwnership(512,1));
    for(const level of [-1,257,1.5,NaN,Infinity])assert.throws(()=>f.setOwnership(0,level));
    f.setOwnership(300,128);assert.equal(f.commit(),512);assert.equal(f.ownership.array[300],128);
    const ownershipVersion=f.ownership.version;f.write(300,p,16,q,.5,900);
    assert.equal(f.ownership.array[300],0,'a reused slot starts with no prior near/far ownership');
    assert.equal(f.commit(),64*48+512);assert.equal(f.ownership.version,ownershipVersion+1);
  }finally{f.dispose();}
});

test('rebasing uploads positions without changing rotation, parameters, or ownership',()=>{
  const f=new ForestImpostors(16),p=new THREE.Vector3(2,3,4),q=new THREE.Quaternion();
  try{
    f.write(3,p,12,q,.25,600);f.commit();
    const before={position:f.positions.version,rotation:f.rotations.version,parameters:f.parameters.version,ownership:f.ownership.version};
    const untouchedRanges=[f.rotations.updateRanges.map(r=>({...r})),f.parameters.updateRanges.map(r=>({...r})),f.ownership.updateRanges.map(r=>({...r}))];
    const prepared=Float32Array.from({length:f.positions.array.length},(_,i)=>i*.125);
    assert.equal(f.replacePositions(prepared),prepared.byteLength);
    assert.deepEqual(Array.from(f.positions.array),Array.from(prepared));
    assert.equal(f.positions.version,before.position+1);
    assert.equal(f.rotations.version,before.rotation);assert.equal(f.parameters.version,before.parameters);assert.equal(f.ownership.version,before.ownership);
    assert.deepEqual(f.positions.updateRanges,[{start:0,count:prepared.length}]);
    assert.deepEqual(f.rotations.updateRanges,untouchedRanges[0]);assert.deepEqual(f.parameters.updateRanges,untouchedRanges[1]);assert.deepEqual(f.ownership.updateRanges,untouchedRanges[2]);
  }finally{f.dispose();}
});
test('distant static edits upload bounded blocks and retirement leaves rotation and colour untouched',()=>{
  const f=new ForestImpostors(229376),p=new THREE.Vector3(),q=new THREE.Quaternion();
  try{
    f.write(1,p,16,q,.5,0);f.write(229000,p,16,q,.5,0);
    assert.equal(f.commit(),2*64*48,'two blocks rather than their enormous intervening span');
    for(const attr of [f.positions,f.rotations,f.parameters]){assert.equal(attr.updateRanges.length,2);attr.clearUpdateRanges();}
    const rotation=f.rotations.version,parameters=f.parameters.version;
    f.retire(1);assert.equal(f.commit(),64*16);
    assert.equal(f.positions.getW(1),0);assert.equal(f.rotations.version,rotation);assert.equal(f.parameters.version,parameters);
    assert.throws(()=>f.retire(-1));assert.throws(()=>f.retire(229376));
  }finally{f.dispose();}
});
test('a rebase includes pending position writes once while retaining other static uploads',()=>{
  const f=new ForestImpostors(128);
  try{
    f.write(3,new THREE.Vector3(),16,new THREE.Quaternion(),.5,0);
    const prepared=f.positions.array.slice(),positionBytes=f.replacePositions(prepared);
    const otherBytes=f.commit();
    assert.equal(positionBytes,128*16);assert.equal(otherBytes,64*32);
    assert.deepEqual(f.positions.updateRanges,[{start:0,count:128*4}]);
  }finally{f.dispose();}
});
