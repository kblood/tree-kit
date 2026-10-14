import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BufferAttribute} from 'three';
import {InstanceUpdateRanges} from '../src/instance-update-ranges.ts';
import {BaselineInstanceUpdateRanges} from './helpers/instance-update-ranges-baseline.mjs';

const state=attribute=>({ranges:attribute.updateRanges.map(range=>({...range})),version:attribute.version,
  data:Buffer.from(attribute.array.buffer,attribute.array.byteOffset,attribute.array.byteLength)});
const fixture=(Class,ArrayType,itemSize)=>({ranges:new Class(),attribute:new BufferAttribute(new ArrayType(256*itemSize),itemSize)});
const pending=ranges=>ranges.ranges.map(range=>({...range}));

for(const ArrayType of [Float32Array,Uint16Array])for(const itemSize of [1,2,3,4,16]){
  test(`${ArrayType.name}/${itemSize}: duplicates, contained, touching, bridge, sparse and cap parity`,()=>{
    const pair=[BaselineInstanceUpdateRanges,InstanceUpdateRanges].map(Class=>fixture(Class,ArrayType,itemSize));
    const scenarios=[[],[4,4,5,3,4],[0,2,1],[18,0,16,2,14,4,12,6,10,8,20,22],
      [128,2,75,44,200,18,111,245,30,86,159,32]];
    for(const indices of scenarios){
      for(const index of indices){
        for(const {ranges,attribute} of pair){
          for(let k=0;k<itemSize;k++)attribute.array[index*itemSize+k]=index*itemSize+k+.25;
          ranges.include(index,itemSize);
        }
        assert.deepEqual(pending(pair[1].ranges),pending(pair[0].ranges));
        assert.ok(pending(pair[1].ranges).length<=8);
      }
      const before=state(pair[1].attribute);
      const bytes=pair.map(({ranges,attribute})=>ranges.flush(attribute));
      assert.equal(bytes[1],bytes[0]);assert.deepEqual(state(pair[1].attribute),state(pair[0].attribute));
      assert.deepEqual(state(pair[1].attribute).data,before.data,'flush never writes data');
      assert.equal(bytes[1],pair[1].attribute.updateRanges.reduce((n,r)=>n+r.count,0)*ArrayType.BYTES_PER_ELEMENT);
      assert.equal(pair[1].attribute.version,before.version+(indices.length?1:0));
      assert.deepEqual(pending(pair[1].ranges),[]);
      for(const {attribute} of pair)attribute.clearUpdateRanges();
    }
  });

  test(`${ArrayType.name}/${itemSize}: seeded differential frames with clear and postponed GPU consumption`,()=>{
    const pair=[BaselineInstanceUpdateRanges,InstanceUpdateRanges].map(Class=>fixture(Class,ArrayType,itemSize));
    let seed=0x72616e67;const random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/2**32);
    for(let frame=0;frame<250;frame++){
      const writes=Math.floor(random()*25);
      for(let write=0;write<writes;write++){
        const index=Math.floor(random()*256),value=Math.floor(random()*60000)+.375;
        for(const {ranges,attribute} of pair){
          for(let k=0;k<itemSize;k++)attribute.array[index*itemSize+k]=value+k;
          ranges.include(index,itemSize);
        }
        assert.deepEqual(pending(pair[1].ranges),pending(pair[0].ranges));
        if(random()<.25){
          assert.equal(pair[1].ranges.flush(pair[1].attribute),pair[0].ranges.flush(pair[0].attribute));
          assert.deepEqual(state(pair[1].attribute),state(pair[0].attribute));
        }
      }
      assert.equal(pair[1].ranges.flush(pair[1].attribute),pair[0].ranges.flush(pair[0].attribute));
      assert.deepEqual(state(pair[1].attribute),state(pair[0].attribute));
      if(frame%7===0)for(const {attribute} of pair)attribute.clearUpdateRanges();
    }
  });
}

test('sorted cap preserves the earliest smallest-gap tie and bridge ordering',()=>{
  const ranges=new InstanceUpdateRanges(),attribute=new BufferAttribute(new Float32Array(64),1);
  for(const index of [16,14,12,10,8,6,4,2,0])ranges.include(index,1);
  assert.deepEqual(pending(ranges),[{start:0,end:3},...Array.from({length:7},(_,i)=>({start:4+i*2,end:5+i*2}))]);
  ranges.include(3,1);ranges.flush(attribute);
  assert.deepEqual(attribute.updateRanges,[{start:0,count:5},...Array.from({length:6},(_,i)=>({start:6+i*2,count:1}))]);
});

test('zero work leaves existing uploads and version unchanged; postponed uploads merge until cleared',()=>{
  for(const Class of [BaselineInstanceUpdateRanges,InstanceUpdateRanges]){
    const {ranges,attribute}=fixture(Class,Float32Array,1);
    attribute.addUpdateRange(30,2);attribute.needsUpdate=true;
    const initial=state(attribute);assert.equal(ranges.flush(attribute),0);assert.deepEqual(state(attribute),initial);
    ranges.include(5,1);assert.equal(ranges.flush(attribute),12);
    ranges.include(6,1);assert.equal(ranges.flush(attribute),16);
    assert.deepEqual(attribute.updateRanges,[{start:5,count:2},{start:30,count:2}]);
    attribute.clearUpdateRanges();ranges.include(12,1);assert.equal(ranges.flush(attribute),4);
    assert.deepEqual(attribute.updateRanges,[{start:12,count:1}]);assert.equal(attribute.version,4);
    assert.equal(ranges.flush(attribute),0);assert.equal(attribute.version,4);
  }
});

test('pre-existing contained and bridging component ranges retain exact baseline semantics',()=>{
  const pair=[BaselineInstanceUpdateRanges,InstanceUpdateRanges].map(Class=>fixture(Class,Float32Array,4));
  for(const {ranges,attribute} of pair){
    ranges.include(2,4);ranges.include(4,4);
    attribute.addUpdateRange(9,2);attribute.addUpdateRange(12,4);attribute.addUpdateRange(8,12);
  }
  assert.equal(pair[1].ranges.flush(pair[1].attribute),pair[0].ranges.flush(pair[0].attribute));
  assert.deepEqual(state(pair[1].attribute),state(pair[0].attribute));
  assert.deepEqual(pair[1].attribute.updateRanges,[{start:8,count:12}]);
});

test('mixed component widths and historically unchecked numeric inputs preserve baseline behavior',()=>{
  const scenarios=[[[5,4],[5,4],[6,4],[4,4],[1,32],[40,1]],
    [[0,0],[-0,-0],[2,0]],[[1,-2],[.5,3],[-1,2]],
    [[0,1],[NaN,1],[2,1]],[[Infinity,1],[0,Infinity],[-Infinity,1]]];
  for(const calls of scenarios){
    const pair=[BaselineInstanceUpdateRanges,InstanceUpdateRanges].map(Class=>fixture(Class,Float32Array,1));
    for(const [index,components] of calls){
      for(const {ranges} of pair)ranges.include(index,components);
      assert.deepEqual(pending(pair[1].ranges),pending(pair[0].ranges));
    }
    assert.equal(pair[1].ranges.flush(pair[1].attribute),pair[0].ranges.flush(pair[0].attribute));
    assert.deepEqual(state(pair[1].attribute),state(pair[0].attribute));
  }
});
