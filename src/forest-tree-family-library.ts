import type {Group} from 'three';
import type {TreeFamilyKind} from './tree-species-recipe.ts';
import {TreeBarkTexturePool} from './tree-bark-texture-pool.ts';
import type {TreeAssetFamily,TreeAssetOptions} from './tree-asset.ts';
import {CompactInstanceSlots} from './compact-instance-slots.ts';
import {forestStructuralVariants} from './tree-structural-variant.ts';

/** Cards narrower than about three pixels lose MASK coverage; grow them by at
 * most 35% so the middle band keeps its measured leaf area on screen. */
export const FOREST_CARD_COMPENSATION=Object.freeze({targetPixels:3,maxScale:1.35});

/** Atlas-facing compatibility alias; the family identity belongs to Tree Kit. */
export type ForestTreeKind=TreeFamilyKind;
export type ForestTreeFamilyInput={kind:ForestTreeKind;lod0:ArrayBuffer;lod1:ArrayBuffer;foliageMipSidecar?:TreeAssetOptions['foliageMipSidecar']};
export type ForestTreeLoader=(a:ArrayBuffer,b:ArrayBuffer,options:TreeAssetOptions)=>Promise<TreeAssetFamily>;
type Batch=ReturnType<TreeAssetFamily['createBatch']>;
/** Resources derived from an adopted family (e.g. its far atlas bake). They are
 * released before the family's own batches, so none outlives its geometry. */
export type ForestTreeFamilyAttachment={dispose():void};
export type ForestTreeFamilyEntry<T,S>={kind:ForestTreeKind;family:TreeAssetFamily;batches:Batch[];
  pools:CompactInstanceSlots<T,S>[];wanted:T[][];coverage:Map<string,number>[];attachments:ForestTreeFamilyAttachment[]};

/** Atomically replace a bounded family set; loading never owns population IDs.
 * Every family's LOD draws have independent compact slots. Aggregate selection
 * capacities are enforced upstream before residents are assigned to families. */
export class ForestTreeFamilyLibrary<T,S>{
  entries=new Map<ForestTreeKind,ForestTreeFamilyEntry<T,S>>();
  /** Families still being staged during an atomic replacement. They are
   * separately owned until adoption or rollback, and belong in peak-memory
   * diagnostics even though they are not drawable yet. */
  readonly pendingEntries=new Set<ForestTreeFamilyEntry<T,S>>();
  get ownedEntries(){return [...this.entries.values(),...this.pendingEntries];}
  loading=false;error='';maxRadiusM=0;
  /** Changes only when the adopted presentation changes, not when a request
   * starts or fails. Near/far pairing can key against this stable revision. */
  revision=0;
  private request=0;private disposed=false;private date=0n;
  private parent:Group;private loader:ForestTreeLoader;private key:(item:T)=>string;
  private capacities:readonly[number,number];
  private readonly sharedBarkTextures:TreeBarkTexturePool|undefined;
  barkTextureDiagnostics(){return this.sharedBarkTextures?.diagnostics()??null;}
  constructor(parent:Group,loader:ForestTreeLoader,key:(item:T)=>string,capacities:readonly[number,number],options:{shareBarkTextures?:boolean}={}){
    if(options.shareBarkTextures!==undefined&&typeof options.shareBarkTextures!=='boolean')throw new Error('Invalid bark sharing option');
    this.sharedBarkTextures=options.shareBarkTextures?new TreeBarkTexturePool():undefined;
    this.parent=parent;this.loader=loader;this.key=key;this.capacities=capacities;
  }
  setDate(date:bigint){this.date=date;for(const entry of this.entries.values())entry.family.setDate(date);}
  private release(entries:Iterable<ForestTreeFamilyEntry<T,S>>){
    for(const entry of entries){
      this.pendingEntries.delete(entry);
      for(const attachment of entry.attachments.splice(0))attachment.dispose();
      for(const batch of entry.batches)batch.dispose();entry.family.dispose();
    }
  }
  async replace(inputs:readonly ForestTreeFamilyInput[],options:TreeAssetOptions={}):Promise<boolean>{
    if(this.disposed)throw new Error('Forest is disposed');
    if(inputs.length<1||inputs.length>2||new Set(inputs.map(x=>x.kind)).size!==inputs.length||
      inputs.some(x=>x.kind!=='branching'&&x.kind!=='spire'))throw new Error('Expected unique branching/spire families');
    const request=++this.request;this.loading=true;this.error='';
    const pending:ForestTreeFamilyEntry<T,S>[]=[];let adopted=false;
    try{
      for(const input of inputs){
        // The game library always supplies the bounded per-family pool and the
        // silhouette-matched reduced foliage LOD; standalone labs opt in explicitly.
        const sidecar=input.foliageMipSidecar??options.foliageMipSidecar;
        const family=await this.loader(input.lod0,input.lod1,{...options,
          foliageMipSidecar:sidecar,forestCoverage:true,sharedBarkTextures:this.sharedBarkTextures,
          // Mip-aware cutoff keeps LOD1 crowns (and the atlas they are captured
          // into) at base coverage; it needs the MASK sidecar chain.
          foliageLodCutoff:options.foliageLodCutoff??(!!sidecar&&options.foliageCoverage!=='hash'),
          structuralVariants:forestStructuralVariants(input.kind),areaPreservingLod:true,silhouetteMatchedLod:true,
          cardCompensation:options.cardCompensation??FOREST_CARD_COMPENSATION});
        const entry:ForestTreeFamilyEntry<T,S>={kind:input.kind,family,batches:[],pools:[],wanted:[[],[]],coverage:[new Map(),new Map()],attachments:[]};
        pending.push(entry);this.pendingEntries.add(entry);
        if(this.disposed||request!==this.request)return false;
        if(!family.forestCoverage||!Number.isFinite(family.maxRadiusM)||family.maxRadiusM<=0)
          throw new Error('Tree family lacks forest coverage or conservative bounds');
        for(const lod of [0,1] as const){
          const batch=family.createBatch(lod,this.capacities[lod]);batch.group.visible=false;entry.batches.push(batch);
          entry.pools.push(new CompactInstanceSlots<T,S>(this.capacities[lod],this.key));
        }
      }
      for(const entry of pending){entry.family.setDate(this.date);for(const batch of entry.batches)this.parent.add(batch.group);}
      this.release(this.entries.values());
      this.entries=new Map(pending.map(entry=>[entry.kind,entry]));
      for(const entry of pending)this.pendingEntries.delete(entry);
      this.maxRadiusM=Math.max(...pending.map(entry=>entry.family.maxRadiusM));this.revision++;adopted=true;
      return true;
    }catch(error){if(request===this.request)this.error=String(error);throw error;}
    finally{if(!adopted)this.release(pending);if(request===this.request)this.loading=false;}
  }
  clear(){this.request++;this.loading=false;this.error='';if(this.entries.size)this.revision++;this.release(this.entries.values());this.entries.clear();this.maxRadiusM=0;}
  dispose(){if(this.disposed)return;this.disposed=true;this.clear();}
}
