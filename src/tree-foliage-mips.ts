import type {Texture} from 'three';

/** Experimental CPU-built mip chain for a 4x4 Atlas foliage texture atlas.
 * The GLB image and level-zero pixels are never changed. This helper is opt-in,
 * performs its CPU work synchronously, and does not change alpha hash/A2C or
 * custom depth/distance material policy. Cells are filtered independently
 * while each has texels; smaller tail levels can preserve only global coverage. */
export const TREE_FOLIAGE_MIPS_VERSION='tree-foliage-coverage-mips-1';
export const TREE_FOLIAGE_ALPHA_CUTOFF=.5;
export const TREE_FOLIAGE_ATLAS_COLUMNS=4;
export const TREE_FOLIAGE_ATLAS_ROWS=4;
const LINEAR_SRGB=Float32Array.from({length:256},(_,byte)=>{
	const c=byte/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;
});
const INSTALLED=new WeakMap<Texture,InstalledTreeFoliageMipChain>();

export type TreeFoliageMipOptions={alphaCutoff?:number;cellColumns?:number;cellRows?:number};
export type TreeFoliageMipPixels={width:number;height:number;data:Uint8ClampedArray};
export type TreeFoliageMipLevelReport={
  level:number;width:number;height:number;mode:'per-cell'|'global-tail';
  targetCoverage:number;coverage:number;coverageError:number;perCellCoverage:(number|null)[];
};
export type TreeFoliageMipPixelChain={levels:TreeFoliageMipPixels[];report:TreeFoliageMipLevelReport[];
  baseCoverage:number;baseCellCoverage:number[];cellGrid:[number,number];alphaCutoff:number};
export type InstalledTreeFoliageMipChain={report:TreeFoliageMipLevelReport[];baseCoverage:number;baseCellCoverage:number[];
  cellGrid:[number,number];alphaCutoff:number;dispose():void;
  /** Installed levels 1..n as uploaded, for load-time calibration; the owner may drop it afterwards. */
  levels?:TreeFoliageMipPixels[]};

function assertOptions(width:number,height:number,options:TreeFoliageMipOptions){
  const columns=options.cellColumns??TREE_FOLIAGE_ATLAS_COLUMNS,rows=options.cellRows??TREE_FOLIAGE_ATLAS_ROWS;
  const cutoff=options.alphaCutoff??TREE_FOLIAGE_ALPHA_CUTOFF;
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width!==height||width<4||
    (width&(width-1))!==0||width%columns!==0||height%rows!==0||
    !Number.isInteger(columns)||!Number.isInteger(rows)||columns<1||rows<1||
    !Number.isFinite(cutoff)||cutoff<=0||cutoff>=1)
    throw new Error('Foliage mip input must be a square power-of-two 4x4-cell atlas with cutoff in (0,1)');
  return {columns,rows,cutoff};
}
function checkPixels(width:number,height:number,data:Uint8Array|Uint8ClampedArray){
	if(!(data instanceof Uint8Array)&&!(data instanceof Uint8ClampedArray)||data.length!==width*height*4)throw new Error('Foliage mip pixels must be RGBA8');
}
function linearToSrgbByte(value:number){
  const c=Math.max(0,Math.min(1,value));const encoded=c<=.0031308?12.92*c:1.055*c**(1/2.4)-.055;
  return Math.max(0,Math.min(255,Math.round(encoded*255)));
}
function coverage(data:Uint8ClampedArray,width:number,height:number,x0=0,y0=0,regionWidth=width,regionHeight=height,cutoffByte=128){
  let count=0;for(let y=y0;y<y0+regionHeight;y++)for(let x=x0;x<x0+regionWidth;x++)if(data[(y*width+x)*4+3]!>=cutoffByte)count++;
  return count/(regionWidth*regionHeight);
}
function remapAlpha(source:Uint8ClampedArray,destination:Uint8ClampedArray,width:number,x0:number,y0:number,w:number,h:number,target:number,cutoffByte:number){
  const histogram=new Uint32Array(256),length=w*h;
  for(let y=y0;y<y0+h;y++)for(let x=x0;x<x0+w;x++)histogram[source[(y*width+x)*4+3]!]++;
	const targetCount=target*length;let cumulative=0,bestBin=0,bestCount=0,bestError=Infinity;
  for(let bin=255;bin>=1;bin--){
    cumulative+=histogram[bin]!;
    const error=Math.abs(cumulative-targetCount);
    // Prefer undercoverage on an exact tie so correction never grows the
    // silhouette when this small cell cannot represent its base fraction.
    if(error<bestError||(error===bestError&&cumulative<bestCount)){bestError=error;bestCount=cumulative;bestBin=bin;}
  }
	// A tiny upward bias avoids floating-point products just below x.5, which
	// round down and can move the selected histogram bin back under the cutoff.
	const scale=bestCount===0?(cutoffByte-1)/255:((cutoffByte-.5)/bestBin)+1e-7;
  for(let y=y0;y<y0+h;y++)for(let x=x0;x<x0+w;x++){
    const p=(y*width+x)*4,a=source[p+3]!;
    destination[p+3]=Math.max(0,Math.min(255,Math.round(a*scale)));
  }
}
function downsampleRegion(source:Uint8ClampedArray,srcWidth:number,srcHeight:number,destination:Uint8ClampedArray,dstWidth:number,
  x0:number,y0:number,dstRegionWidth:number,dstRegionHeight:number){
  for(let y=0;y<dstRegionHeight;y++)for(let x=0;x<dstRegionWidth;x++){
    const sx=(x0+x)*2,sy=(y0+y)*2,out=((y0+y)*dstWidth+x0+x)*4;
    let alpha=0,pr=0,pg=0,pb=0,ur=0,ug=0,ub=0;
    for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){
      const p=((sy+dy)*srcWidth+sx+dx)*4,a=source[p+3]!/255;
		const r=LINEAR_SRGB[source[p]!]!,g=LINEAR_SRGB[source[p+1]!]!,b=LINEAR_SRGB[source[p+2]!]!;
      alpha+=a;pr+=r*a;pg+=g*a;pb+=b*a;ur+=r;ug+=g;ub+=b;
    }
    alpha*=.25;const divisor=alpha>0?alpha*4:4;
    destination[out]=linearToSrgbByte(alpha>0?pr/(alpha*4):ur/divisor);
    destination[out+1]=linearToSrgbByte(alpha>0?pg/(alpha*4):ug/divisor);
    destination[out+2]=linearToSrgbByte(alpha>0?pb/(alpha*4):ub/divisor);
    destination[out+3]=Math.round(alpha*255);
  }
}

/** Build an explicit chain from decoded sRGB RGBA pixels. Each atlas cell is
 * downsampled independently while it still occupies at least one texel.
 * Smaller tail levels necessarily combine cells and preserve only atlas-wide
 * coverage. Source pixels are copied and never mutated. */
export function buildTreeFoliageMipPixels(width:number,height:number,rgba:Uint8Array|Uint8ClampedArray,
  options:TreeFoliageMipOptions={}):TreeFoliageMipPixelChain{
  const {columns,rows,cutoff}=assertOptions(width,height,options);checkPixels(width,height,rgba);
  const source=new Uint8ClampedArray(rgba),levels:TreeFoliageMipPixels[]=[{width,height,data:new Uint8ClampedArray(source)}];
  const cutoffByte=Math.ceil(cutoff*255),baseCoverage=coverage(source,width,height,0,0,width,height,cutoffByte);
  const cellWidth=width/columns,cellHeight=height/rows,baseCellCoverage:number[]=[];
  for(let cy=0;cy<rows;cy++)for(let cx=0;cx<columns;cx++)baseCellCoverage.push(coverage(source,width,height,cx*cellWidth,cy*cellHeight,cellWidth,cellHeight,cutoffByte));
  const report:TreeFoliageMipLevelReport[]=[{level:0,width,height,mode:'per-cell',targetCoverage:baseCoverage,coverage:baseCoverage,coverageError:0,
    perCellCoverage:baseCellCoverage.slice()}];
  let filterSource=source,srcWidth=width,srcHeight=height,level=0;
  while(srcWidth>1||srcHeight>1){
    const dstWidth=Math.max(1,srcWidth>>1),dstHeight=Math.max(1,srcHeight>>1),filtered=new Uint8ClampedArray(dstWidth*dstHeight*4);
    const perCell=dstWidth>=columns&&dstHeight>=rows;
    if(perCell){
      const dstCellWidth=dstWidth/columns,dstCellHeight=dstHeight/rows,srcCellWidth=srcWidth/columns,srcCellHeight=srcHeight/rows;
      for(let cy=0;cy<rows;cy++)for(let cx=0;cx<columns;cx++){
        const x=cx*dstCellWidth,y=cy*dstCellHeight;
        downsampleRegion(filterSource,srcWidth,srcHeight,filtered,dstWidth,x,y,dstCellWidth,dstCellHeight);
      }
      // Continue filtering the uncorrected averaged alpha; coverage remapping
      // changes only the uploaded copy and cannot bias later RGB mips.
      const uploaded=new Uint8ClampedArray(filtered),cellCoverage:number[]=[];
      for(let cy=0;cy<rows;cy++)for(let cx=0;cx<columns;cx++){
        const x=cx*dstCellWidth,y=cy*dstCellHeight,target=baseCellCoverage[cy*columns+cx]!;
        remapAlpha(filtered,uploaded,dstWidth,x,y,dstCellWidth,dstCellHeight,target,cutoffByte);
        cellCoverage.push(coverage(uploaded,dstWidth,dstHeight,x,y,dstCellWidth,dstCellHeight,cutoffByte));
      }
      levels.push({width:dstWidth,height:dstHeight,data:uploaded});
      const current=coverage(uploaded,dstWidth,dstHeight,0,0,dstWidth,dstHeight,cutoffByte);
      report.push({level:++level,width:dstWidth,height:dstHeight,mode:'per-cell',targetCoverage:baseCoverage,coverage:current,
        coverageError:current-baseCoverage,perCellCoverage:cellCoverage});
    }else{
      downsampleRegion(filterSource,srcWidth,srcHeight,filtered,dstWidth,0,0,dstWidth,dstHeight);
      const uploaded=new Uint8ClampedArray(filtered);
      remapAlpha(filtered,uploaded,dstWidth,0,0,dstWidth,dstHeight,baseCoverage,cutoffByte);
      levels.push({width:dstWidth,height:dstHeight,data:uploaded});
      const current=coverage(uploaded,dstWidth,dstHeight,0,0,dstWidth,dstHeight,cutoffByte);
      report.push({level:++level,width:dstWidth,height:dstHeight,mode:'global-tail',targetCoverage:baseCoverage,coverage:current,
        coverageError:current-baseCoverage,perCellCoverage:Array(columns*rows).fill(null)});
    }
    filterSource=filtered;srcWidth=dstWidth;srcHeight=dstHeight;
  }
  return {levels,report,baseCoverage,baseCellCoverage,cellGrid:[columns,rows],alphaCutoff:cutoff};
}

type CanvasMip=HTMLCanvasElement|OffscreenCanvas;
function dimensions(image:CanvasImageSource){
  const value=image as CanvasImageSource&{width?:number;height?:number;videoWidth?:number;videoHeight?:number;naturalWidth?:number;naturalHeight?:number};
  return {width:value.width??value.videoWidth??value.naturalWidth??0,height:value.height??value.videoHeight??value.naturalHeight??0};
}
function makeCanvas(width:number,height:number):CanvasMip{
  if(typeof OffscreenCanvas!=='undefined')return new OffscreenCanvas(width,height);
  if(typeof document!=='undefined'){const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;return canvas;}
  throw new Error('Coverage mip upload needs OffscreenCanvas or a document canvas');
}
function context2D(canvas:CanvasMip):CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D{
  const context=canvas.getContext('2d',{willReadFrequently:true} as CanvasRenderingContext2DSettings);
  if(!context)throw new Error('Unable to create 2D canvas for foliage mip generation');
  return context as CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D;
}

/** Install regular Texture mip image sources without cloning its decoded GLB
 * image or texture. LODs, colour/depth/distance passes can continue sharing the
 * same map. The caller must ensure all users agree on this texture's mip policy.
 * Call the returned dispose() when the owning tree family is released. */
export async function installTreeFoliageCoverageMipmaps(texture:Texture,options:TreeFoliageMipOptions={}):Promise<InstalledTreeFoliageMipChain>{
	if(INSTALLED.has(texture))throw new Error('Coverage-preserving foliage mipmaps are already installed on this texture');
	const image=texture.image as CanvasImageSource|undefined;if(!image)throw new Error('Foliage texture has no decoded image');
	const {width,height}=dimensions(image);assertOptions(width,height,options);
	const canvas=makeCanvas(width,height),ctx=context2D(canvas),generated:CanvasMip[]=[];
  try{
    ctx.drawImage(image,0,0,width,height);
    const pixels=ctx.getImageData(0,0,width,height).data;
    const chain=buildTreeFoliageMipPixels(width,height,pixels,options),mipmaps:CanvasImageSource[]=[image];
		for(let i=1;i<chain.levels.length;i++){
			const level=chain.levels[i]!,levelCanvas=makeCanvas(level.width,level.height);generated.push(levelCanvas);
			const levelContext=context2D(levelCanvas);
			const imageData=levelContext.createImageData(level.width,level.height);imageData.data.set(level.data);levelContext.putImageData(imageData,0,0);
			mipmaps.push(levelCanvas);
    }
    const oldMipmaps=texture.mipmaps,oldGenerateMipmaps=texture.generateMipmaps;
    texture.mipmaps=mipmaps as unknown as typeof texture.mipmaps;texture.generateMipmaps=false;texture.needsUpdate=true;
    let disposed=false;
		const installed:InstalledTreeFoliageMipChain={levels:chain.levels.slice(1),report:chain.report,baseCoverage:chain.baseCoverage,baseCellCoverage:chain.baseCellCoverage,cellGrid:chain.cellGrid,alphaCutoff:chain.alphaCutoff,
			dispose(){
				if(disposed)return;disposed=true;
				if(texture.mipmaps===mipmaps){texture.mipmaps=oldMipmaps;texture.generateMipmaps=oldGenerateMipmaps;texture.needsUpdate=true;}
				if(INSTALLED.get(texture)===installed)INSTALLED.delete(texture);
				for(const item of generated){item.width=0;item.height=0;}
			}};
		INSTALLED.set(texture,installed);return installed;
  }catch(error){
    for(const item of generated){item.width=0;item.height=0;}
    throw error;
  }finally{canvas.width=0;canvas.height=0;}
}
