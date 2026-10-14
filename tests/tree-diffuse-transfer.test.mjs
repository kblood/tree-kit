import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';

const vite=await createServer({configFile:false,optimizeDeps:{noDiscovery:true},server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'});
const {createTreeDiffuseTransfer,reduceTreeDiffuseTransfer,evaluateTreeDiffuseTransfer}=await vite.ssrLoadModule('/src/tree-diffuse-transfer.ts');
const close=(actual,expected)=>{assert.equal(actual.length,expected.length);for(let i=0;i<actual.length;i++)assert.ok(Math.abs(actual[i]-expected[i])<1e-6,`index ${i}: ${actual[i]} != ${expected[i]}`);};
test('tree diffuse transfer coefficients are area associated and retain signed moments',()=>{
  const c=new Float32Array([.8,.3,.1,1,.8,.3,.1,1,.8,.3,.1,1,.8,.3,.1,1]);
  const n=new Float32Array([1,0,0,1,0,1,0,1,0,0,-1,1,-1,0,0,1]);
  const values=createTreeDiffuseTransfer(2,c,n);
  assert.equal(values.length,2*2*27);
  const first=values.slice(0,27),second=values.slice(27,54);
  close([...first.slice(0,3)],[.8,.3,.1]);
  close([...first.slice(3,6)],[.8,.3,.1]);
  close([...second.slice(6,9)],[.8,.3,.1]);
  assert.deepEqual([...first.slice(18,27)],new Array(9).fill(0),'cross terms stay zero for an axis-aligned normal');
  close([...values.slice(81+3,81+6)],[-.8,-.3,-.1]);
  close(evaluateTreeDiffuseTransfer(first,[1,0,0]),[.8*17/16,.3*17/16,.1*17/16]);
});

test('transfer reduction is a linear mean over source texels',()=>{
  const colour=new Float32Array([
    1,0,0,1, 0,1,0,.5,
    0,0,1,.25, 1,1,1,0,
  ]),data=new Float32Array([
    1,0,0,1, 0,1,0,1,
    0,0,1,1, 0,0,0,0,
  ]);
  const source=createTreeDiffuseTransfer(2,colour,data),reduced=reduceTreeDiffuseTransfer(2,source,2);
  assert.equal(reduced.length,27);
  for(let i=0;i<27;i++)assert.ok(Math.abs(reduced[i]-(source[i]+source[27+i]+source[54+i]+source[81+i])/4)<1e-7);
  const once=reduceTreeDiffuseTransfer(2,source,1);
  assert.deepEqual([...once],[...source]);
});

test('alpha-zero texels contribute zero and RGB remains correlated with its normal',()=>{
  const colour=new Float32Array([1,0,0,1, 0,1,0,0, 0,0,0,0, 0,0,0,0]);
  const data=new Float32Array([1,0,0,1, 0,1,0,1, 0,0,0,0, 0,0,0,0]);
  const values=createTreeDiffuseTransfer(2,colour,data);
  const result=evaluateTreeDiffuseTransfer(values,[1,0,0]);
  assert.ok(result[0]>0);
  assert.equal(result[1],0,'transparent green contributes no transfer');
  const green=[...values.slice(27,54)];assert.ok(green.every(x=>x===0));
});

test('area reduction keeps each channel correlated with its source normal',()=>{
  const colour=new Float32Array([
    1,0,0,1, 0,1,0,1,
    0,0,0,0, 0,0,0,0,
  ]),data=new Float32Array([
    1,0,0,1, -1,0,0,1,
    0,0,0,0, 0,0,0,0,
  ]);
  const reduced=reduceTreeDiffuseTransfer(2,createTreeDiffuseTransfer(2,colour,data),2);
  close(evaluateTreeDiffuseTransfer(reduced,[1,0,0]),[17/64,1/64,0]);
});

test('evaluator clamps only the final result and rejects invalid light directions',()=>{
  const c=new Float32Array([1,1,1,1]),n=new Float32Array([-1,0,0,1]);
  const values=createTreeDiffuseTransfer(1,c,n);
  assert.deepEqual(evaluateTreeDiffuseTransfer(values,[1,0,0]),[1/16,1/16,1/16],'SH truncation leaks a small positive back-lobe');
  const midNormal=createTreeDiffuseTransfer(1,new Float32Array([1,1,1,1]),new Float32Array([Math.sqrt(.75),0,-.5,1]));
  assert.deepEqual(evaluateTreeDiffuseTransfer(midNormal,[0,0,1]),[0,0,0],'negative reconstructed irradiance is clamped only at final evaluation');
  assert.throws(()=>evaluateTreeDiffuseTransfer(values,[2,0,0]),/normalized/);
  assert.throws(()=>evaluateTreeDiffuseTransfer(values,[0,0,0]),/normalized/);
});

test('input validation is bounded and only requires normals for covered texels',()=>{
  const transparent=createTreeDiffuseTransfer(1,new Float32Array([0,0,0,0]),new Float32Array([0,0,0,0]));
  assert.ok([...transparent].every(x=>x===0));
  assert.throws(()=>createTreeDiffuseTransfer(0,new Float32Array(),new Float32Array()),/size/);
  assert.throws(()=>createTreeDiffuseTransfer(1,new Float32Array([0,0,0,2]),new Float32Array([1,0,0,1])),/alpha/);
  assert.throws(()=>createTreeDiffuseTransfer(1,new Float32Array([1,0,0,1]),new Float32Array([0,0,0,1])),/unit/);
  assert.throws(()=>reduceTreeDiffuseTransfer(4,new Float32Array(4*4*27),3),/divides/);
  assert.throws(()=>reduceTreeDiffuseTransfer(1025,new Float32Array(),1),/size/);
  assert.throws(()=>reduceTreeDiffuseTransfer(1,new Float32Array([Number.NaN,...new Array(26).fill(0)]),1),/finite/);
});

after(()=>vite.close());
