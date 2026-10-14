import type {BufferAttribute,Camera,InstancedMesh} from 'three';
import {InstanceUpdateRanges} from './instance-update-ranges.ts';

/** One set of rows, camera prefix and the unchanged camera/shadow union.
 * Visibility must stay enabled when cameraCount is zero: Three visits shadow
 * casters independently and calls onBeforeShadow before reading mesh.count. */
export class TreeInstancePasses {
  private total=0;
  private camera=0;
  private disposed=false;
  private views:readonly Camera[]=[];
  private readonly restore:(()=>void)[]=[];
  private readonly meshes:readonly InstancedMesh[];
  constructor(meshes:readonly InstancedMesh[]){
    this.meshes=meshes;
    for(const mesh of meshes){
      const render=mesh.onBeforeRender,rendered=mesh.onAfterRender,before=mesh.onBeforeShadow,after=mesh.onAfterShadow;
      const onRender:typeof render=function(this:InstancedMesh,...args){
        // Reflection/capture cameras keep the previous full-union submission.
        // An unwired caller is conservative, never silently missing trees.
        const count=owner.views.includes(args[2])?owner.camera:owner.total;
        mesh.count=count;
        try{render.apply(this,args);mesh.count=count;}
        catch(error){mesh.count=owner.camera;throw error;}
      };
      const onRendered:typeof rendered=function(this:InstancedMesh,...args){
        try{rendered.apply(this,args);}finally{mesh.count=owner.camera;}
      };
      const onBefore:typeof before=function(this:InstancedMesh,...args){
        mesh.count=owner.total;
        try{before.apply(this,args);mesh.count=owner.total;}
        catch(error){mesh.count=owner.camera;throw error;}
      };
      const onAfter:typeof after=function(this:InstancedMesh,...args){
        try{after.apply(this,args);}finally{mesh.count=owner.camera;}
      };
      const owner=this;
      mesh.onBeforeRender=onRender;mesh.onAfterRender=onRendered;mesh.onBeforeShadow=onBefore;mesh.onAfterShadow=onAfter;
      this.restore.push(()=>{
        if(mesh.onBeforeRender===onRender)mesh.onBeforeRender=render;
        if(mesh.onAfterRender===onRendered)mesh.onAfterRender=rendered;
        if(mesh.onBeforeShadow===onBefore)mesh.onBeforeShadow=before;
        if(mesh.onAfterShadow===onAfter)mesh.onAfterShadow=after;
      });
    }
  }
  get initializedCount(){return this.total;}
  get cameraCount(){return this.camera;}
  setViewCameras(cameras:readonly Camera[]){if(this.disposed)throw new Error('Tree batch is disposed');this.views=cameras;}
  /** Called only after a fully validated new row has been initialized. */
  grow(count:number){
    if(this.disposed||!Number.isInteger(count)||count<this.total||this.meshes.some(mesh=>count>mesh.instanceMatrix.count))throw new Error('Invalid initialized tree count');
    if(count>this.total){this.total=count;this.setCameraCount(count);}
  }
  setCount(count:number){
    if(this.disposed||!Number.isInteger(count)||count<0||count>this.total)throw new Error('Tree count can only truncate initialized slots');
    this.total=count;this.setCameraCount(count);
  }
  setCameraCount(count:number){
    if(this.disposed||!Number.isInteger(count)||count<0||count>this.total)throw new Error('Invalid tree camera prefix');
    this.camera=count;for(const mesh of this.meshes)mesh.count=count;
  }
  dispose(){if(this.disposed)return;this.disposed=true;for(const restore of this.restore)restore();this.restore.length=0;this.views=[];}
}

/** Exact swaps of every owned per-instance attribute. Shared attributes occur
 * once; source vertex/index arrays are never included. No second row mirror. */
export class TreeInstanceRows {
  private readonly rows:{attribute:BufferAttribute;ranges:InstanceUpdateRanges}[];
  constructor(attributes:readonly BufferAttribute[]){
    if(attributes.some(a=>!(a as BufferAttribute&{isInstancedBufferAttribute?:boolean}).isInstancedBufferAttribute))throw new Error('Expected owned tree instance attributes');
    this.rows=[...new Set(attributes)].map(attribute=>({attribute,ranges:new InstanceUpdateRanges()}));
  }
  swap(a:number,b:number,count:number){
    if(!Number.isInteger(a)||!Number.isInteger(b)||!Number.isInteger(count)||a<0||b<0||a>=count||b>=count||this.rows.some(({attribute})=>count>attribute.count))throw new Error('Invalid tree row swap');
    if(a===b)return;
    for(const {attribute,ranges} of this.rows){
      const values=attribute.array,n=attribute.itemSize;
      for(let k=0;k<n;k++){const value=values[a*n+k];values[a*n+k]=values[b*n+k];values[b*n+k]=value;}
      ranges.include(a,n);ranges.include(b,n);ranges.flush(attribute);
    }
  }
}
