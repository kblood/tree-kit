/** Silhouette-matched card scale for the reduced foliage LOD.
 *
 * Scaling LOD1 cards until their summed leaf area equals LOD0 over-inflates
 * the crown: fewer, larger cards overlap less than the dense LOD0 set, so the
 * projected opaque area grows by 35-50% at the 110 m handoff. This module
 * rasterizes both actual LOD meshes on the CPU (orthographic, rest wind,
 * authored member, 16 m reference, foliage atlas MASK) and picks the card
 * scale whose projected opaque area matches LOD0 over a fixed view set. */
export const TREE_LOD_COVERAGE_VERSION='tree-lod-coverage-1';

export type TreeCoveragePart={position:ArrayLike<number>;uv:ArrayLike<number>|null;pivot:ArrayLike<number>|null;
  level:ArrayLike<number>|null;index:ArrayLike<number>|null};
export type TreeCoverageMesh={bark:TreeCoveragePart;foliage:TreeCoveragePart};
export type TreeCoverageAlpha={width:number;height:number;rgba:ArrayLike<number>;cutoffByte:number};
export type TreeLodCoverageCalibration={version:string;cardScale:number;lod0AreaM2:number;lod1AreaM2:number;
  areaRatio:number;evaluations:number;setupMs:number};

/** Directions to the eye: two lateral azimuths and two raised views. */
export const TREE_LOD_COVERAGE_VIEWS:readonly (readonly [number,number,number])[]=Object.freeze([
  [1,0,0],[0,0,1],[Math.cos(Math.PI/6),Math.sin(Math.PI/6),0],[0,Math.sin(Math.PI/3),Math.cos(Math.PI/3)]].map(v=>Object.freeze(v as [number,number,number])));

function basis(direction:readonly [number,number,number]){
  const l=Math.hypot(...direction),f=direction.map(v=>v/l);
  let right=[f[2]!,0,-f[0]!];const rl=Math.hypot(...right);right=rl>1e-6?right.map(v=>v/rl):[1,0,0];
  const up=[f[1]!*right[2]!-f[2]!*right[1]!,f[2]!*right[0]!-f[0]!*right[2]!,f[0]!*right[1]!-f[1]!*right[0]!];
  return {right,up};
}
/** Projected opaque area (m²) of one mesh from one direction. Depth is not
 * needed: coverage is the union of bark and alpha-tested foliage samples. */
export function treeProjectedAreaM2(mesh:TreeCoverageMesh,alpha:TreeCoverageAlpha,cardScale:number,
  direction:readonly [number,number,number],size=96,halfSizeM=12,centreHeightM=9){
  if(!Number.isInteger(size)||size<8||size>1024||!(halfSizeM>0)||!(cardScale>0))throw new Error('Invalid tree coverage raster');
  const {right,up}=basis(direction),covered=new Uint8Array(size*size),scale=size/(2*halfSizeM);
  for(const [leafPart,part] of [[false,mesh.bark],[true,mesh.foliage]] as const){
    const n=part.position.length/3,sx=new Float32Array(n),sy=new Float32Array(n);
    for(let i=0;i<n;i++){
      let x=part.position[i*3]!,y=part.position[i*3+1]!,z=part.position[i*3+2]!;
      if(leafPart&&part.pivot&&part.level&&part.level[i]!>3.5){
        const px=part.pivot[i*3]!,py=part.pivot[i*3+1]!,pz=part.pivot[i*3+2]!;
        x=px+(x-px)*cardScale;y=py+(y-py)*cardScale;z=pz+(z-pz)*cardScale;
      }
      y-=centreHeightM;
      sx[i]=(x*right[0]!+y*right[1]!+z*right[2]!)*scale+size/2;sy[i]=size/2-(x*up[0]!+y*up[1]!+z*up[2]!)*scale;
    }
    const index=part.index,count=index?index.length:n,uv=part.uv;
    for(let t=0;t+2<count;t+=3){
      const a=index?index[t]!:t,b=index?index[t+1]!:t+1,c=index?index[t+2]!:t+2;
      const area=(sx[b]!-sx[a]!)*(sy[c]!-sy[a]!)-(sx[c]!-sx[a]!)*(sy[b]!-sy[a]!);if(Math.abs(area)<1e-9)continue;
      const x0=Math.max(0,Math.floor(Math.min(sx[a]!,sx[b]!,sx[c]!))),x1=Math.min(size-1,Math.ceil(Math.max(sx[a]!,sx[b]!,sx[c]!)));
      const y0=Math.max(0,Math.floor(Math.min(sy[a]!,sy[b]!,sy[c]!))),y1=Math.min(size-1,Math.ceil(Math.max(sy[a]!,sy[b]!,sy[c]!)));
      for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
        const o=y*size+x;if(covered[o])continue;
        const qx=x+.5,qy=y+.5;
        const w0=((sx[b]!-qx)*(sy[c]!-qy)-(sx[c]!-qx)*(sy[b]!-qy))/area,w1=((sx[c]!-qx)*(sy[a]!-qy)-(sx[a]!-qx)*(sy[c]!-qy))/area,w2=1-w0-w1;
        if(w0<0||w1<0||w2<0)continue;
        if(leafPart&&uv){
          const u=w0*uv[a*2]!+w1*uv[b*2]!+w2*uv[c*2]!,v=w0*uv[a*2+1]!+w1*uv[b*2+1]!+w2*uv[c*2+1]!;
          const tx=Math.min(alpha.width-1,Math.max(0,Math.floor((u-Math.floor(u))*alpha.width)));
          const ty=Math.min(alpha.height-1,Math.max(0,Math.floor((v-Math.floor(v))*alpha.height)));
          if(alpha.rgba[(ty*alpha.width+tx)*4+3]!<alpha.cutoffByte)continue;
        }
        covered[o]=1;
      }
    }
  }
  let n=0;for(const v of covered)n+=v;
  return n/(scale*scale);
}
const totalArea=(mesh:TreeCoverageMesh,alpha:TreeCoverageAlpha,cardScale:number)=>
  TREE_LOD_COVERAGE_VIEWS.reduce((sum,view)=>sum+treeProjectedAreaM2(mesh,alpha,cardScale,view),0);

/** Card scale in [1,maxScale] whose mean projected area matches LOD0. Area is
 * monotone in card scale; a bracketed secant/bisection settles in <=6 rasters. */
export function calibrateTreeLodCardScale(lod0:TreeCoverageMesh,lod1:TreeCoverageMesh,alpha:TreeCoverageAlpha,maxScale:number):TreeLodCoverageCalibration{
  if(!Number.isFinite(maxScale)||maxScale<1||maxScale>3)throw new Error('Invalid LOD card scale limit');
  const started=typeof performance!=='undefined'?performance.now():Date.now();
  const target=totalArea(lod0,alpha,1);let evaluations=0;
  const measured=new Map<number,number>();
  const evaluate=(s:number)=>{let f=measured.get(s);if(f===undefined){evaluations++;f=totalArea(lod1,alpha,s)-target;measured.set(s,f);}return f;};
  let lo=1,flo=evaluate(1),hi=maxScale,fhi=maxScale>1?evaluate(maxScale):flo,scale:number;
  if(!(target>0))scale=1;
  else if(flo>=0)scale=1;
  else if(fhi<=0)scale=maxScale;
  else{
    scale=lo;
    for(let step=0;step<4;step++){
      // Secant inside the bracket, pulled toward the midpoint for robustness.
      const secant=lo-flo*(hi-lo)/(fhi-flo);scale=.8*secant+.2*(lo+hi)/2;
      const f=evaluate(scale);
      if(Math.abs(f)<=.01*target)break;
      if(f<0){lo=scale;flo=f;}else{hi=scale;fhi=f;}
    }
  }
  const lod1Area=evaluate(scale)+target,views=TREE_LOD_COVERAGE_VIEWS.length;
  const finished=typeof performance!=='undefined'?performance.now():Date.now();
  return {version:TREE_LOD_COVERAGE_VERSION,cardScale:scale,lod0AreaM2:target/views,lod1AreaM2:lod1Area/views,
    areaRatio:target>0?lod1Area/target:1,evaluations,setupMs:finished-started};
}
