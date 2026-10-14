import type {Texture} from 'three';
import type {InstalledTreeFoliageMipChain,TreeFoliageMipLevelReport} from './tree-foliage-mips.ts';

export type TreeFoliageMipSidecar={manifest:unknown;data:ArrayBuffer};
type Level={level:number;width:number;height:number;offset:number;byteLength:number;sha256:string};
const installed=new WeakSet<Texture>();
const hashPattern=/^[0-9a-f]{64}$/;
const sha256=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))))
  .map(x=>x.toString(16).padStart(2,'0')).join('');
const fraction=(x:unknown):x is number=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=1;

/** Validate before allocating image sources or mutating a shared GLB texture.
 * Version 1 intentionally accepts only the current 2048px, 4x4 Atlas contract. */
export async function decodeTreeFoliageSidecar(sidecar:TreeFoliageMipSidecar,basePng:Uint8Array,alphaCutoff:number){
  const m=sidecar?.manifest as any,data=sidecar?.data;
  if(!m||typeof m!=='object'||m.schemaVersion!==1||m.operation!=='atlas-tree-foliage-coverage-mips-1'||
    m.algorithm!=='tree-foliage-coverage-mips-1'||m.width!==2048||m.height!==2048||m.columns!==4||m.rows!==4||
    m.format!=='RGBA8-straight-sRGB'||m.alphaCutoff!==.5||alphaCutoff!==m.alphaCutoff||
    !Number.isInteger(m.maxLevel)||m.maxLevel<1||m.maxLevel>11||!(data instanceof ArrayBuffer)||
    data.byteLength>5592404||m.payloadBytes!==data.byteLength||!hashPattern.test(m.basePngSha256)||!hashPattern.test(m.payloadSha256))
    throw new Error('Invalid foliage mip sidecar contract');
  const levels=m.sidecar?.levels as Level[];
  if(!Array.isArray(levels)||levels.length!==m.maxLevel||m.sidecar?.bytes!==m.payloadBytes||m.sidecar?.sha256!==m.payloadSha256)
    throw new Error('Invalid foliage mip sidecar level table');
  let offset=0;
  for(let i=0;i<levels.length;i++){
    const level=levels[i],size=2048>>(i+1);
    if(!level||level.level!==i+1||level.width!==size||level.height!==size||level.offset!==offset||level.byteLength!==size*size*4||
      !hashPattern.test(level.sha256)||level.offset+level.byteLength>data.byteLength)
      throw new Error('Invalid foliage mip sidecar layout');
    offset+=level.byteLength;
  }
  if(offset!==data.byteLength)throw new Error('Foliage mip sidecar has trailing or missing bytes');
  const reports=m.coverage as TreeFoliageMipLevelReport[];
  if(!Array.isArray(reports)||reports.length!==levels.length+1||!fraction(m.policy?.baseCoverage)||
    !Array.isArray(m.policy?.baseCellCoverage)||m.policy.baseCellCoverage.length!==16||!m.policy.baseCellCoverage.every(fraction))
    throw new Error('Invalid foliage mip coverage metadata');
  for(let i=0;i<reports.length;i++){
    const report=reports[i],size=2048>>i;
    if(!report||report.level!==i||report.width!==size||report.height!==size||!fraction(report.coverage)||
      !fraction(report.targetCoverage)||!Number.isFinite(report.coverageError)||
      !['per-cell','global-tail'].includes(report.mode)||!Array.isArray(report.perCellCoverage)||report.perCellCoverage.length!==16||
      !report.perCellCoverage.every(x=>x===null||fraction(x)))throw new Error('Invalid foliage mip coverage report');
  }
  if(await sha256(basePng)!==m.basePngSha256)throw new Error('Foliage mip sidecar does not match the source PNG');
  const pixels=new Uint8Array(data);
  if(await sha256(pixels)!==m.payloadSha256)throw new Error('Foliage mip sidecar payload hash mismatch');
  for(const level of levels)if(await sha256(pixels.subarray(level.offset,level.offset+level.byteLength))!==level.sha256)
    throw new Error('Foliage mip sidecar level hash mismatch');
  return {levels:levels.map(level=>({width:level.width,height:level.height,data:new Uint8ClampedArray(data,level.offset,level.byteLength)})),
    report:reports,baseCoverage:m.policy.baseCoverage as number,baseCellCoverage:m.policy.baseCellCoverage as number[],
    cellGrid:[4,4] as [number,number],alphaCutoff:m.alphaCutoff as number,payloadBytes:data.byteLength,maxLevel:m.maxLevel as number};
}

/** ImageData uploads preserve straight RGBA bytes without a canvas conversion.
 * This deliberately installs a regular Texture's explicit mip image sources;
 * the pinned WebGL2 renderer allocates exactly this many immutable levels.
 * Install before the texture's first GPU upload, as the family loader does;
 * changing storage size on an already-uploaded texture needs reallocation. */
export async function installTreeFoliageSidecar(texture:Texture,sidecar:TreeFoliageMipSidecar,basePng:Uint8Array,alphaCutoff:number):Promise<InstalledTreeFoliageMipChain&{payloadBytes:number;maxLevel:number}>{
  if(installed.has(texture))throw new Error('Foliage sidecar is already installed');
  const image=texture.image as {width?:number;height?:number}|undefined;
  if(image?.width!==2048||image?.height!==2048)throw new Error('Foliage sidecar requires the original 2048px image');
  const chain=await decodeTreeFoliageSidecar(sidecar,basePng,alphaCutoff);
  if(installed.has(texture))throw new Error('Foliage sidecar was concurrently installed');
  if(typeof ImageData==='undefined')throw new Error('Foliage sidecar upload requires ImageData');
  const mipmaps=[image,...chain.levels.map(level=>new ImageData(new Uint8ClampedArray(level.data),level.width,level.height))];
  const oldMipmaps=texture.mipmaps,oldGenerate=texture.generateMipmaps;
  texture.mipmaps=mipmaps as unknown as typeof texture.mipmaps;texture.generateMipmaps=false;texture.needsUpdate=true;
  installed.add(texture);let disposed=false;
  return {levels:chain.levels.map(level=>({width:level.width,height:level.height,data:level.data})),report:chain.report,baseCoverage:chain.baseCoverage,baseCellCoverage:chain.baseCellCoverage,cellGrid:chain.cellGrid,
    alphaCutoff:chain.alphaCutoff,payloadBytes:chain.payloadBytes,maxLevel:chain.maxLevel,
    dispose(){if(disposed)return;disposed=true;
      if(texture.mipmaps===mipmaps){texture.mipmaps=oldMipmaps;texture.generateMipmaps=oldGenerate;texture.needsUpdate=true;}
      installed.delete(texture);mipmaps.length=0;
    }};
}
