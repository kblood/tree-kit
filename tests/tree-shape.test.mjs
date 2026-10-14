import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {createLegacyTreeGeometry,treeQuaternion,LEGACY_TREE_LOBES,LEGACY_TREE_BOUND} from '../src/tree-shape.ts';

test('shared shape preserves every shipped near/far geometry attribute byte',()=>{
  const expected=[
    ['903b3bb00dc2f8714e0dcea7e9afa1b45e87a3eace3f1bc208cbec6a2338a99f','ee28813d24c6467a7ea57b4376b366243ea92ee955d92c0aad30fa374cad8b14','5a23cb08b4bc20aa2e5bedb31bb4beaeae208eae9c9981dce07aa2a170e574b0'],
    ['d0a215e4b75bfd21bfc040d3f255f3c752e63ed84d740371a2c6fcc419563a0a','aed8eb227fe2f9afbaf7591d03be25352381f5c20b15b949db85c25710ace479','30e1178bdd2fd39016271f41f8de45a632e0ba04d1b0fc3e7729c0a7e328fc20'],
  ];
  for(const detail of [0,1]){const g=createLegacyTreeGeometry(detail);
    try{assert.deepEqual(['position','normal','color'].map(key=>{const a=g.attributes[key].array;return createHash('sha256').update(Buffer.from(a.buffer,a.byteOffset,a.byteLength)).digest('hex');}),expected[detail]);}
    finally{g.dispose();}
  }
  assert.throws(()=>{LEGACY_TREE_LOBES[0][0]=99;});
});
test('shared tree basis equals the shipped up-align then world-axis yaw, including poles',()=>{
  const up=new THREE.Vector3(0,1,0),scratch=new THREE.Quaternion();
  for(const xyz of [[0,1,0],[0,-1,0],[1e-12,-1,0],[1,1,1],[0,0,1]])for(const yaw of [0,.2,Math.PI,6.1]){
    const d=new THREE.Vector3(...xyz).normalize(),expected=new THREE.Quaternion().setFromUnitVectors(up,d);
    expected.premultiply(new THREE.Quaternion().setFromAxisAngle(d,yaw));
    assert.deepEqual(treeQuaternion(d,yaw,new THREE.Quaternion(),scratch).toArray(),expected.toArray());
  }
});
test('both normalized tree LODs fit the shared conservative bound',()=>{
  for(const detail of [0,1]){
  const geometry=createLegacyTreeGeometry(detail),position=geometry.getAttribute('position');
  try{
    assert.ok(position.count>0);
    for(let i=0;i<position.count;i++)for(let axis=0;axis<3;axis++){
      const value=position.getComponent(i,axis),center=LEGACY_TREE_BOUND.center[axis],extent=LEGACY_TREE_BOUND.extent[axis];
      assert.ok(value>=center-extent-1e-6&&value<=center+extent+1e-6,
        `vertex ${i} axis ${axis}: ${value} outside [${center-extent}, ${center+extent}]`);
    }
  }finally{geometry.dispose();}
  }
});
