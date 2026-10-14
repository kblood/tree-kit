/** Pure capture/view contract for the authored-tree distance experiment.
 * Coordinates are object-space, right-handed, Y-up. Directions point from the
 * capture centre towards the camera. This module does not render impostors. */
export type TreeViewVector=readonly [number,number,number];
export const TREE_VIEW_VERSION='tree-full-octahedral-1';
export const TREE_VIEW_GRID=9;
const sign=(x:number)=>x<0?-1:1;
function unit(v:TreeViewVector):TreeViewVector {
  if(v.length!==3||v.some(x=>!Number.isFinite(x)))throw new Error('View direction must contain three finite components');
  // Avoid overflow/underflow for otherwise valid nonzero directions.
  const scale=Math.max(...v.map(Math.abs));
  if(scale===0)throw new Error('View direction must be nonzero');
  const a=v.map(x=>x/scale),length=Math.hypot(...a);
  return [a[0]/length,a[1]/length,a[2]/length];
}
export function encodeTreeView(direction:TreeViewVector):readonly [number,number] {
  const [x,y,z]=unit(direction),sum=Math.abs(x)+Math.abs(y)+Math.abs(z);
  const a=x/sum,b=z/sum;
  return y>=0?[(a+1)/2,(b+1)/2]:[((1-Math.abs(b))*sign(a)+1)/2,((1-Math.abs(a))*sign(b)+1)/2];
}
export function decodeTreeView(u:number,v:number):TreeViewVector {
  if(!Number.isFinite(u)||!Number.isFinite(v)||u<0||u>1||v<0||v>1)throw new Error('Octahedral coordinates must lie in [0,1]');
  let x=2*u-1,z=2*v-1;
  const y=1-Math.abs(x)-Math.abs(z),fold=Math.max(0,-y);
  x-=sign(x)*fold;z-=sign(z)*fold;
  return unit([x,y,z]);
}
function checkGrid(grid:number){
  // An odd vertex count places equator folds and axes on cell edges/diagonals.
  if(!Number.isInteger(grid)||grid<3||grid>33||grid%2!==1)throw new Error('Tree view grid must be odd and between 3 and 33');
}
export function treeViewBlend(direction:TreeViewVector,grid=TREE_VIEW_GRID){
  checkGrid(grid);
  const [u,v]=encodeTreeView(direction),n=grid-1;
  const gx=u*n,gy=v*n,x=Math.min(n-1,Math.floor(gx)),y=Math.min(n-1,Math.floor(gy));
  const a=gx-x,b=gy-y;
  const at=(dx:number,dy:number)=>({index:(y+dy)*grid+x+dx,x:x+dx,y:y+dy});
  // Choose diagonals that follow the octahedron's equator folds. A single
  // diagonal orientation throughout the square crosses faces in two quadrants.
  const sameQuadrant=(x<n/2)===(y<n/2);
  const vertices=sameQuadrant
    ? a+b<=1?[at(0,0),at(1,0),at(0,1)]:[at(1,1),at(0,1),at(1,0)]
    : a>=b?[at(0,0),at(1,0),at(1,1)]:[at(0,0),at(1,1),at(0,1)];
  // Barycentric weights are in the unfolded octahedron plane. Reconstructing
  // the original ray requires L1-normalized capture vectors, not unit vectors.
  const weights=sameQuadrant
    ? a+b<=1?[1-a-b,a,b]:[a+b-1,1-a,1-b]
    : a>=b?[1-a,a-b,b]:[1-b,a,b-a];
  return {uv:[u,v] as const,vertices,weights};
}
function cross(a:TreeViewVector,b:TreeViewVector):TreeViewVector {
  return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
}
export function treeCaptureBasis(direction:TreeViewVector){
  const towardCamera=unit(direction);
  const reference:TreeViewVector=Math.abs(towardCamera[1])>.999?[0,0,1]:[0,1,0];
  const right=unit(cross(reference,towardCamera)),up=unit(cross(towardCamera,right));
  // Each view stores its own basis; bases must not be interpolated at runtime.
  return {towardCamera,right,up};
}
export function treeCaptureViews(grid=TREE_VIEW_GRID){
  checkGrid(grid);
  return Array.from({length:grid*grid},(_,index)=>{
    const x=index%grid,y=Math.floor(index/grid),uv=[x/(grid-1),y/(grid-1)] as const;
    return {index,x,y,uv,...treeCaptureBasis(decodeTreeView(...uv))};
  });
}

/** Hemi-octahedral contract for the in-game far atlas. Only the upper
 * hemisphere is captured: forest trees are never seen from below their root
 * plane at far range, so directions below the horizon clamp onto it. Grid
 * index = y*grid+x; x follows u, y follows v. */
export const TREE_HEMI_VIEW_VERSION='tree-hemi-octahedral-1';
export function encodeHemiTreeView(direction:TreeViewVector):readonly [number,number] {
  const [x,y0,z]=unit(direction),y=Math.max(0,y0),sum=Math.abs(x)+y+Math.abs(z);
  if(sum===0)throw new Error('View direction has no hemisphere component');
  const a=x/sum,b=z/sum;
  return [Math.min(1,Math.max(0,(a+b+1)/2)),Math.min(1,Math.max(0,(a-b+1)/2))];
}
export function decodeHemiTreeView(u:number,v:number):TreeViewVector {
  if(!Number.isFinite(u)||!Number.isFinite(v)||u<0||u>1||v<0||v>1)throw new Error('Hemi-octahedral coordinates must lie in [0,1]');
  const e=[2*u-1,2*v-1],x=(e[0]!+e[1]!)/2,z=(e[0]!-e[1]!)/2;
  return unit([x,Math.max(0,1-Math.abs(x)-Math.abs(z)),z]);
}
function checkHemiGrid(grid:number){
  // Odd counts put the zenith on a vertex and both face folds on cell diagonals.
  if(!Number.isInteger(grid)||grid<3||grid>33||grid%2!==1)throw new Error('Hemi view grid must be odd and between 3 and 33');
}
/** Three captured views and barycentric weights (sum 1) for a direction. The
 * octahedron faces meet along the square's diagonals (x=0 and z=0), so each
 * cell is split along the diagonal parallel to the fold it lies on; weights
 * are then exact barycentrics of the L1-normalized octahedron point. */
export function hemiTreeViewBlend(direction:TreeViewVector,grid:number){
  checkHemiGrid(grid);
  const [u,v]=encodeHemiTreeView(direction),n=grid-1,gx=u*n,gy=v*n;
  const x=Math.min(n-1,Math.floor(gx)),y=Math.min(n-1,Math.floor(gy)),a=gx-x,b=gy-y,i=y*grid+x;
  const uv=[u,v] as const;
  if((x<n/2)===(y<n/2))return a>=b?{uv,views:[i,i+1,i+grid+1] as const,weights:[1-a,a-b,b] as const}
    :{uv,views:[i,i+grid+1,i+grid] as const,weights:[1-b,a,b-a] as const};
  return a+b<=1?{uv,views:[i,i+1,i+grid] as const,weights:[1-a-b,a,b] as const}
    :{uv,views:[i+grid+1,i+grid,i+1] as const,weights:[a+b-1,1-a,1-b] as const};
}
export function treeHemiCaptureViews(grid:number){
  checkHemiGrid(grid);
  return Array.from({length:grid*grid},(_,index)=>{
    const x=index%grid,y=Math.floor(index/grid);
    return {index,...treeCaptureBasis(decodeHemiTreeView(x/(grid-1),y/(grid-1)))};
  });
}
/** GLSL copy of the three functions above; tests execute a CPU transliteration. */
export const hemiTreeViewGLSL=`
vec2 treeHemiEncode(vec3 d){
  d=normalize(d);d.y=max(d.y,0.0);d/=max(1e-6,abs(d.x)+d.y+abs(d.z));
  return clamp(vec2(d.x+d.z,d.x-d.z)*0.5+0.5,0.0,1.0);
}
vec3 treeHemiDecode(vec2 e){
  e=e*2.0-1.0;vec2 t=vec2(e.x+e.y,e.x-e.y)*0.5;
  return normalize(vec3(t.x,max(0.0,1.0-abs(t.x)-abs(t.y)),t.y));
}
void treeHemiBlend(vec3 direction,float grid,out vec3 views,out vec3 weights){
  float n=grid-1.0;vec2 g=treeHemiEncode(direction)*n,cell=min(floor(g),vec2(n-1.0)),f=g-cell;
  float i=cell.y*grid+cell.x;
  if((cell.x<n*0.5)==(cell.y<n*0.5)){
    if(f.x>=f.y){views=vec3(i,i+1.0,i+grid+1.0);weights=vec3(1.0-f.x,f.x-f.y,f.y);}
    else{views=vec3(i,i+grid+1.0,i+grid);weights=vec3(1.0-f.y,f.x,f.y-f.x);}
  }else if(f.x+f.y<=1.0){views=vec3(i,i+1.0,i+grid);weights=vec3(1.0-f.x-f.y,f.x,f.y);}
  else{views=vec3(i+grid+1.0,i+grid,i+1.0);weights=vec3(f.x+f.y-1.0,1.0-f.x,1.0-f.y);}
}
// Same basis as treeCaptureBasis: right=normalize(cross(reference,toward)).
void treeHemiBasis(float view,float grid,out vec3 toward,out vec3 right,out vec3 up){
  float y=floor((view+0.5)/grid),x=view-y*grid;
  toward=treeHemiDecode(vec2(x,y)/(grid-1.0));
  vec3 reference=abs(toward.y)>0.999?vec3(0,0,1):vec3(0,1,0);
  right=normalize(cross(reference,toward));up=normalize(cross(toward,right));
}
`;
