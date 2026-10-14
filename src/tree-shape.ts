import * as THREE from 'three';
type V3=readonly [number,number,number];

export const LEGACY_TREE_SHAPE_VERSION='legacy-tree-shape-1';
/** Shared source for the shipped meshes and the analytic far proxy.
 * Offsets/radii are scaled by the individual's canonical nominal height. */
export const LEGACY_TREE_LOBES:readonly (readonly [number,number,number,number])[]=Object.freeze([
  Object.freeze([-.13,.65,.02,.23] as const),Object.freeze([.13,.72,.03,.24] as const),
  Object.freeze([0,.81,-.10,.23] as const),Object.freeze([.015,.89,.035,.16] as const),
]);
export const LEGACY_TREE_TRUNK=Object.freeze({topRadius:.018,baseRadius:.031,height:.64});
export const LEGACY_TREE_BOUND=Object.freeze({center:Object.freeze([.005,.52,-.03]),extent:Object.freeze([.38,.54,.31])});
const up=new THREE.Vector3(0,1,0);
export function treeQuaternion(direction:THREE.Vector3,yaw:number,target:THREE.Quaternion,scratch:THREE.Quaternion){
  target.setFromUnitVectors(up,direction);scratch.setFromAxisAngle(direction,yaw);return target.premultiply(scratch);
}

/** Matched metre-normalized silhouettes for near branches and distant crowns.
 * All geometry is authored here; no textures or external generated assets. */
export function createLegacyTreeGeometry(detail:number){
  const positions:number[]=[],normals:number[]=[],colors:number[]=[];
  const add=(g:THREE.BufferGeometry,scale:V3,position:V3,color:V3)=>{
    g.scale(...scale);g.translate(...position);
    const flat=g.index?g.toNonIndexed():g;
    positions.push(...flat.attributes.position.array);normals.push(...flat.attributes.normal.array);
    for(let i=0;i<flat.attributes.position.count;i++)colors.push(...color);
    flat.dispose();if(flat!==g)g.dispose();
  };
  add(new THREE.CylinderGeometry(LEGACY_TREE_TRUNK.topRadius,LEGACY_TREE_TRUNK.baseRadius,LEGACY_TREE_TRUNK.height,detail?7:4),[1,1,1],[0,.32,0],[.25,.17,.10]);
  if(detail)for(const side of [-1,1]){
    const branch=new THREE.CylinderGeometry(.005,.012,.30,6);branch.rotateZ(side*.7);
    add(branch,[1,1,1],[side*.075,.55,.02],[.25,.17,.10]);
  }
  for(const [x,y,z,s] of LEGACY_TREE_LOBES){
    add(new THREE.IcosahedronGeometry(1,detail),[s,s*.85,s],[x,y,z],[.16+y*.06,.29+y*.04,.08]);
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  geometry.computeBoundingSphere();return geometry;
}

