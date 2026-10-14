import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TREE_VIEW_GRID,TREE_VIEW_VERSION,decodeTreeView,encodeTreeView,
  treeCaptureBasis,treeCaptureViews,treeViewBlend,
} from '../src/tree-impostor-views.ts';

const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const length=v=>Math.hypot(...v);
const normalize=v=>{const n=length(v);return v.map(x=>x/n);};
const close=(actual,expected,tolerance,message)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${message}: ${actual} vs ${expected}`);
function fibonacciSphere(count){
  const golden=Math.PI*(3-Math.sqrt(5));
  return Array.from({length:count},(_,i)=>{const y=1-2*(i+.5)/count,r=Math.sqrt(Math.max(0,1-y*y)),angle=golden*i;return [r*Math.cos(angle),y,r*Math.sin(angle)];});
}
function verifyBlend(direction,grid){
  const result=treeViewBlend(direction,grid),unitDirection=normalize(direction);
  assert.equal(result.vertices.length,3,'every direction selects exactly three capture views');
  assert.equal(new Set(result.vertices.map(v=>v.index)).size,3,'triangle vertices are distinct grid indices');
  assert.ok(result.weights.every(w=>Number.isFinite(w)&&w>=-1e-12&&w<=1+1e-12),'blend weights are finite and nonnegative');
  close(result.weights.reduce((a,b)=>a+b,0),1,1e-12,'blend weights sum to one');
  for(const vertex of result.vertices){
    assert.ok(Number.isInteger(vertex.index)&&vertex.index>=0&&vertex.index<grid*grid);
    assert.ok(vertex.x>=0&&vertex.x<grid&&vertex.y>=0&&vertex.y<grid);
    assert.equal(vertex.index,vertex.y*grid+vertex.x,'view index agrees with grid coordinates');
  }
  const ray=[0,0,0],uvPoint=[0,0];
  for(let i=0;i<3;i++){
    const vertex=result.vertices[i],capture=decodeTreeView(vertex.x/(grid-1),vertex.y/(grid-1));
    // `weights` interpolate octahedral UV. Convert each unit capture vector
    // back to its L1-normalized octahedron surface point before reconstructing
    // the ray; direct interpolation of unit vectors is not the module contract.
    const l1=Math.abs(capture[0])+Math.abs(capture[1])+Math.abs(capture[2]);
    for(let axis=0;axis<3;axis++){
      ray[axis]+=result.weights[i]*capture[axis]/l1;
    }
    uvPoint[0]+=result.weights[i]*vertex.x/(grid-1);uvPoint[1]+=result.weights[i]*vertex.y/(grid-1);
  }
  assert.ok(length(ray)>1e-8,'weighted enclosing triangle does not collapse to zero');
  close(dot(normalize(ray),unitDirection),1,2e-12,`three-view cone reconstruction points back to direction ${JSON.stringify(direction)} on grid ${grid} with ${JSON.stringify(result)}`);
  close(uvPoint[0],result.uv[0],2e-12,'selected triangle barycentrics contain the encoded U');close(uvPoint[1],result.uv[1],2e-12,'selected triangle barycentrics contain the encoded V');
  const encoded=encodeTreeView(direction);
  close(result.uv[0],encoded[0],0,'blend reports the encoded U');close(result.uv[1],encoded[1],0,'blend reports the encoded V');
}

test('octahedral encoding round-trips axes, poles, fold seams and extreme finite magnitudes',()=>{
  assert.equal(TREE_VIEW_VERSION,'tree-full-octahedral-1');assert.equal(TREE_VIEW_GRID,9);
  const directions=[
    [1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0],[0,-1,0],
    [1,1,1],[1,1,-1],[-1,1,1],[-1,1,-1],[1,-1,1],[1,-1,-1],[-1,-1,1],[-1,-1,-1],
    [Number.MIN_VALUE,1,0],[1e200,-1e200,1e200],[-1e-250,1e-250,1e-250],
    [1,.0000001,1],[1,-.0000001,1],[1,0,-1],[-1,0,-1],
  ];
  directions.push(...fibonacciSphere(4096));
  for(const direction of directions){
    const uv=encodeTreeView(direction),decoded=decodeTreeView(...uv),unit=normalize(direction);
    assert.ok(uv.every(v=>Number.isFinite(v)&&v>=0&&v<=1),'encoded coordinates stay within the full square');
    close(length(decoded),1,2e-15,'decoded direction is unit length');
    close(dot(decoded,unit),1,2e-12,'encode/decode preserves the full-sphere direction');
    const scaled=direction.map(v=>v*1e80),scaledUv=encodeTreeView(scaled);
    close(scaledUv[0],uv[0],2e-15,'encoding is scale invariant in U');close(scaledUv[1],uv[1],2e-15,'encoding is scale invariant in V');
  }
  for(const uv of [[0,0],[0,1],[1,0],[1,1],[.5,.5],[.5,0],[.5,1],[0,.5],[1,.5]]){
    const direction=decodeTreeView(...uv),roundtrip=encodeTreeView(direction),decoded=decodeTreeView(...roundtrip);
    close(dot(direction,decoded),1,2e-12,`octahedral corner/fold ${uv} round-trips`);
  }
  for(const bad of [[0,0,0],[NaN,0,1],[Infinity,1,0],[1,2],[1,2,3,4]])assert.throws(()=>encodeTreeView(bad),/View direction/);
  for(const bad of [[-1,0],[1.01,.5],[NaN,.5],[.5,Infinity]])assert.throws(()=>decodeTreeView(...bad),/Octahedral coordinates/);
});

test('odd capture grids provide three-view enclosing cones over every cell, fold, pole and sampled sphere direction',()=>{
  for(const grid of [3,5,9,33]){
    const captures=treeCaptureViews(grid);assert.equal(captures.length,grid*grid);
    for(let index=0;index<captures.length;index++){
      const capture=captures[index];assert.equal(capture.index,index);assert.equal(capture.x,index%grid);assert.equal(capture.y,Math.floor(index/grid));
      assert.deepEqual(capture.uv,[capture.x/(grid-1),capture.y/(grid-1)]);
      verifyBlend(decodeTreeView(...capture.uv),grid);
    }
    const n=grid-1,local=[.125,.5,.875];
    for(let y=0;y<n;y++)for(let x=0;x<n;x++)for(const a of local)for(const b of local)verifyBlend(decodeTreeView((x+a)/n,(y+b)/n),grid);
    for(const direction of fibonacciSphere(grid===33?2500:1000))verifyBlend(direction,grid);
  }
});

test('view builders reject invalid grids without mutating direction inputs or emitting inverted UV triangles',()=>{
  for(const grid of [2,4,34,NaN,3.5]){
    assert.throws(()=>treeCaptureViews(grid),/Tree view grid/);
    assert.throws(()=>treeViewBlend([.3,-.4,.8],grid),/Tree view grid/);
  }
  const direction=[.314159,-.271828,.57721],before=[...direction];
  treeViewBlend(direction,9);treeCaptureBasis(direction);encodeTreeView(direction);
  assert.deepEqual(direction,before,'direction helpers do not mutate caller-owned arrays');
  for(const grid of [3,5,9,33])for(const view of treeCaptureViews(grid)){
    const blend=treeViewBlend(view.towardCamera,grid),uv=blend.vertices.map(v=>[v.x/(grid-1),v.y/(grid-1)]);
    const area=(uv[1][0]-uv[0][0])*(uv[2][1]-uv[0][1])-(uv[1][1]-uv[0][1])*(uv[2][0]-uv[0][0]);
    assert.ok(area>0,`selected UV triangle has positive signed area for grid ${grid}, view ${view.index}`);
  }
});

test('duplicated octahedral corner captures for the south pole have identical bases',()=>{
  const corners=[[0,0],[0,1],[1,0],[1,1]],captures=corners.map(([u,v])=>treeCaptureBasis(decodeTreeView(u,v)));
  for(const basis of captures)assert.deepEqual(basis,treeCaptureBasis([0,-1,0]));
  for(let i=1;i<captures.length;i++)assert.deepEqual(captures[i],captures[0],'duplicate corner direction has a bit-identical capture basis');
});

test('seam and pole neighborhoods remain covered without imposing cross-threshold basis continuity',()=>{
  const epsilon=1e-10,folds=[
    [1,0,0],[-1,0,0],[0,0,1],[0,0,-1],
    [1,1,0],[1,-1,0],[-1,1,0],[-1,-1,0],
    [0,1,1],[0,1,-1],[0,-1,1],[0,-1,-1],
    [1,0,1],[1,0,-1],[-1,0,1],[-1,0,-1],
    [0,1,0],[0,-1,0],
  ];
  for(const fold of folds){
    const center=normalize(fold);verifyBlend(center,9);
    const perturbations=[[epsilon,0,0],[-epsilon,0,0],[0,epsilon,0],[0,-epsilon,0],[0,0,epsilon],[0,0,-epsilon]];
    for(const delta of perturbations){const near=center.map((x,i)=>x+delta[i]);verifyBlend(near,9);}
  }
  const north=treeCaptureBasis([0,1,0]),northNear=treeCaptureBasis([1e-5,.999999,0]);
  const south=treeCaptureBasis([0,-1,0]),southNear=treeCaptureBasis([1e-5,-.999999,0]);
  for(const basis of [north,northNear,south,southNear])assertBasis(basis);
});

test('stored capture bases are deterministic, finite, orthonormal and right-handed, including fallback poles',()=>{
  const directions=[...fibonacciSphere(300),[0,1,0],[0,-1,0],[1e-12,.999999999999,0],[1e-12,-.999999999999,0],[0,.999,1],[0,.9991,1],[0,-.999,1],[0,-.9991,1]];
  for(const direction of directions){
    const basis=treeCaptureBasis(direction),repeat=treeCaptureBasis(direction);assert.deepEqual(repeat,basis,'basis is deterministic for the same direction');assertBasis(basis);
    const scaled=treeCaptureBasis(direction.map(v=>v*3.5));
    for(const axis of ['towardCamera','right','up'])for(let i=0;i<3;i++)close(scaled[axis][i],basis[axis][i],2e-15,`${axis} is scale invariant`);
  }
  assert.throws(()=>treeCaptureBasis([0,0,0]),/View direction/);assert.throws(()=>treeCaptureBasis([0,Infinity,1]),/View direction/);
});

function assertBasis({towardCamera,right,up}){
  for(const vector of [towardCamera,right,up])assert.ok(vector.every(Number.isFinite),'basis vectors are finite');
  close(length(towardCamera),1,2e-15,'camera direction is unit');close(length(right),1,2e-15,'camera right is unit');close(length(up),1,2e-15,'camera up is unit');
  close(dot(towardCamera,right),0,2e-15,'camera direction and right are orthogonal');
  close(dot(towardCamera,up),0,2e-15,'camera direction and up are orthogonal');
  close(dot(right,up),0,2e-15,'camera right and up are orthogonal');
  const cross=[right[1]*up[2]-right[2]*up[1],right[2]*up[0]-right[0]*up[2],right[0]*up[1]-right[1]*up[0]];
  close(dot(cross,towardCamera),1,3e-15,'camera frame is right-handed');
}
