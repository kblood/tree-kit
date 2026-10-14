import test from 'node:test';
import assert from 'node:assert/strict';
import {DataUtils} from 'three';
import {packTreeCaptureLayer} from '../src/tree-impostor-filter.ts';

test('GPU attributes share quantized alpha and ignore transparent padded material',()=>{
  const colour=new Float32Array([.4,.2,.1,.5, 1,1,1,0]);
  const data=new Float32Array([0,-1,0,.6, 1,0,0,-1]),leaf=new Float32Array([1,0]);
  const before=[colour.slice(),data.slice(),leaf.slice()],packed=packTreeCaptureLayer(colour,data,leaf),alpha=128/255;
  assert.equal(packed.colour[3],128);
  assert.ok(Math.abs(DataUtils.fromHalfFloat(packed.data[1])+alpha)<.001);
  assert.ok(Math.abs(DataUtils.fromHalfFloat(packed.data[3])-.6*alpha)<.001);
  assert.equal(packed.classification[0],128);
  for(const channel of Object.values(packed))assert.ok(Array.from(channel.slice(4)).every(x=>x===0),'transparent padding contributes no attribute weight');
  assert.deepEqual([colour,data,leaf],before);
  // Filtering against the second (transparent) texel preserves the first
  // surface depth/normal after division, rather than blending toward -1.
  const filteredAlpha=alpha*.25;
  assert.ok(Math.abs(DataUtils.fromHalfFloat(packed.data[3])*.25/filteredAlpha-.6)<.002);
});

test('GPU packing rejects malformed, nonfinite and out-of-range capture planes',()=>{
  const c=new Float32Array([1,1,1,1]),d=new Float32Array([0,1,0,0]),l=new Float32Array([1]);
  assert.throws(()=>packTreeCaptureLayer(c,new Float32Array(3),l),/shape/);
  for(const invalid of [NaN,Infinity,-.1,1.1]){const bad=c.slice();bad[0]=invalid;assert.throws(()=>packTreeCaptureLayer(bad,d,l),/value/);}
  assert.throws(()=>packTreeCaptureLayer(c,d,new Float32Array([2])),/fraction/);
});
