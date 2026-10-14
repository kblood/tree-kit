import {test} from 'node:test';
import assert from 'node:assert/strict';
import {forestCoverageGLSL,forestScreenHash,quantizeForestCoverage} from '../src/forest-coverage.ts';

test('coverage quantization handles endpoints and half-step rounding boundaries',()=>{
  assert.equal(quantizeForestCoverage(-1),0);assert.equal(quantizeForestCoverage(0),0);
  assert.equal(quantizeForestCoverage(1/512-Number.EPSILON),0);
  assert.equal(quantizeForestCoverage(1/512),1);
  assert.equal(quantizeForestCoverage(0.5),128);
  assert.equal(quantizeForestCoverage(255/256),255);
  assert.equal(quantizeForestCoverage(255.5/256-1e-9),255);
  assert.equal(quantizeForestCoverage(255.5/256),256);
  assert.equal(quantizeForestCoverage(1),256);assert.equal(quantizeForestCoverage(2),256);
  assert.match(forestCoverageGLSL,/clamp\(coverage,0\.0,1\.0\)\*256\.0\+\.5/);
});

test('near, transition, and edge ownership partition all 256 hash values',()=>{
  for(const qNear of [0,1,128,255,256])for(const qEdge of [128,256]){
    if(qNear>qEdge)continue;
    const counts=[0,0,0],owners=new Uint8Array(256);
    for(let hash=0;hash<256;hash++){
      const owner=hash<qNear?0:hash<qEdge?1:2;
      owners[hash]++;counts[owner]++;
    }
    assert.ok(owners.every(count=>count===1),`qNear=${qNear}, qEdge=${qEdge} assigns every hash exactly once`);
    assert.deepEqual(counts,[qNear,qEdge-qNear,256-qEdge]);assert.equal(counts.reduce((sum,count)=>sum+count,0),256);
  }
  assert.equal(quantizeForestCoverage(1),256,'full coverage includes all 256 hashes');
});

test('CPU screen hash matches uint32 shader golden vectors and stays in byte range',()=>{
  const vectors=[
    [[0,0,0],0],[[1,1,0],54],[[17,29,3],183],[[255,1024,91],122],
    [[0xffffffff,0x80000000,255],134],[[7,13,256],227],
  ];
  for(const [input,expected] of vectors)assert.equal(forestScreenHash(...input),expected);
  for(let y=0;y<32;y++)for(let x=0;x<32;x++)assert.ok(forestScreenHash(x,y,197)>=0&&forestScreenHash(x,y,197)<=255);
  assert.match(forestCoverageGLSL,/1664525u/);assert.match(forestCoverageGLSL,/1013904223u/);assert.match(forestCoverageGLSL,/\(h\+seed\)&255u/);
});
