import type {Texture} from 'three';

export type TreeBarkTextureRole='bark-base-color'|'bark-normal';
export interface TreeBarkTextureLease {readonly texture:Texture;readonly key:string;release():void}
type Entry={texture:Texture;image:object;refs:number;state:string};
/** Forest-library scope only. Call before first upload, with the decoded GLTF
 * texture and its exact embedded PNG. Materials/uniforms remain family-owned.
 * Shared texture state is immutable until its final lease is released. */
export class TreeBarkTexturePool {
  private entries=new Map<string,Entry>();private images=new Map<object,number>();
  private leases=0;private duplicates=0;
  readonly maxEntries:number;readonly maxLeases:number;
  constructor(maxEntries=8,maxLeases=16){
    this.maxEntries=maxEntries;this.maxLeases=maxLeases;
    if(!Number.isInteger(maxEntries)||maxEntries<2||maxEntries>8||!Number.isInteger(maxLeases)||maxLeases<4||maxLeases>16)throw new Error('Bounded bark texture pool required');
  }
  private state(t:Texture){
    const image=t.image as {width?:number;height?:number};
    if(t.mipmaps.length)throw new Error('Shared bark requires the unchanged automatic mip policy');
    return JSON.stringify([t.mapping,t.channel,t.wrapS,t.wrapT,t.magFilter,t.minFilter,t.anisotropy,t.format,t.internalFormat,t.type,t.colorSpace,t.flipY,t.premultiplyAlpha,t.unpackAlignment,t.generateMipmaps,
      t.offset.toArray(),t.repeat.toArray(),t.center.toArray(),t.rotation,t.matrixAutoUpdate,t.matrix.toArray(),image?.width,image?.height]);
  }
  private closeImage(image:object){const close=(image as {close?:()=>void}).close;if(typeof close==='function')close.call(image);}
  async acquire(texture:Texture,png:Uint8Array,role:TreeBarkTextureRole):Promise<TreeBarkTextureLease>{
    if(!['bark-base-color','bark-normal'].includes(role)||!(png instanceof Uint8Array)||png.byteLength<24||png.byteLength>2*1024*1024||
      ![137,80,78,71,13,10,26,10].every((b,i)=>png[i]===b))throw new Error('Verified embedded bark PNG required');
    const view=new DataView(png.buffer,png.byteOffset,png.byteLength),w=view.getUint32(16),h=view.getUint32(20);
    const image=texture.image as {width?:number;height?:number};
    if(w!==1024||h!==1024||image?.width!==w||image?.height!==h)throw new Error('Shared bark is bounded to decoded 1024px images');
    const state=this.state(texture),sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(png))),b=>b.toString(16).padStart(2,'0')).join('');
    if(texture.image!==image||this.state(texture)!==state)throw new Error('Bark texture changed during verification');
    const key=JSON.stringify([role,sha,state]);let entry=this.entries.get(key);
    if(this.leases>=this.maxLeases)throw new Error('Bark texture lease capacity exceeded');
    if(entry){
      if(entry.texture.image!==entry.image||this.state(entry.texture)!==entry.state)throw new Error('Leased bark texture state changed');
      if(texture!==entry.texture){texture.dispose();if(texture.image!==entry.texture.image&&!this.images.has(texture.image as object))this.closeImage(texture.image as object);this.duplicates++;}
    }else{
      if(this.entries.size>=this.maxEntries)throw new Error('Bark texture entry capacity exceeded');
      if([...this.entries.values()].some(e=>e.texture===texture))throw new Error('One texture cannot acquire conflicting bark roles/state');
      entry={texture,image:texture.image as object,refs:0,state};this.entries.set(key,entry);const image=texture.image as object;this.images.set(image,(this.images.get(image)??0)+1);
    }
    entry.refs++;this.leases++;const owned=entry;let released=false;
    return {texture:entry.texture,key,release:()=>{
      if(released)return;released=true;owned.refs--;this.leases--;if(owned.refs)return;
      this.entries.delete(key);owned.texture.dispose();const image=owned.image,refs=this.images.get(image)!-1;
      if(refs)this.images.set(image,refs);else{this.images.delete(image);this.closeImage(image);}
    }};
  }
  diagnostics(){return {entries:this.entries.size,leases:this.leases,imageSources:this.images.size,duplicatesDisposed:this.duplicates,maxEntries:this.maxEntries,maxLeases:this.maxLeases};}
}
