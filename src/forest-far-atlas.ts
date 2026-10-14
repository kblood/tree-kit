import * as THREE from 'three';
import {hemiTreeViewGLSL,treeHemiCaptureViews,TREE_HEMI_VIEW_VERSION} from './tree-impostor-views.ts';
import {forestVariantPoint,forestVariantRemovesLeaf,forestVariantTwist,FOREST_VARIANT_COUNT,type ForestStructuralVariant} from './tree-structural-variant.ts';
import {forestMeshBufferFootprint} from './forest-resource-accounting.ts';

/** Captured far representation for the canonical Oak/Pine forest.
 *
 * Each family's actual reduced (LOD1) geometry, with the detailed batches'
 * deform shader, silhouette-matched card scale and all eight structural
 * members, is rendered at rest wind from a hemi-octahedral 9x9 view set. The
 * 4x supersampled capture keeps binary coverage and linear albedo, so hardware
 * box mips are exactly coverage-weighted; each atlas level is copied from the
 * matching scratch level. Far instances sample three views per tree and
 * reproduce fractional coverage with alpha-to-coverage (MSAA) or object-space
 * hashed alpha, never a fixed threshold that would turn crowns into discs. */
// 2: captures use the mip-aware foliage cutoff (tree-foliage-lod-cutoff-1).
export const FOREST_FAR_ATLAS_VERSION='forest-far-atlas-2';
export const FOREST_FAR_ATLAS_LAYOUT=Object.freeze({grid:9,tile:64,columns:4,rows:2,supersample:4,maxMip:6,
  captureLod:1 as 0|1,referenceHeightM:16,viewVersion:TREE_HEMI_VIEW_VERSION});
const L=FOREST_FAR_ATLAS_LAYOUT;
export const FOREST_FAR_ATLAS_WIDTH=L.tile*L.columns,FOREST_FAR_ATLAS_HEIGHT=L.tile*L.rows,FOREST_FAR_ATLAS_VIEWS=L.grid*L.grid;
/** Full chain to 1x1; the shader never samples past maxMip (one texel per tile). */
export const FOREST_FAR_ATLAS_LEVELS=Math.log2(Math.max(FOREST_FAR_ATLAS_WIDTH,FOREST_FAR_ATLAS_HEIGHT))+1;
if(L.columns*L.rows!==FOREST_VARIANT_COUNT)throw new Error('Far atlas tiles must hold every structural member');

/** Bytes for two RGBA8 array textures with a complete mip chain. */
export function forestFarAtlasBytes(){
  let texels=0;for(let l=0;l<FOREST_FAR_ATLAS_LEVELS;l++)texels+=Math.max(1,FOREST_FAR_ATLAS_WIDTH>>l)*Math.max(1,FOREST_FAR_ATLAS_HEIGHT>>l);
  return 2*4*texels*FOREST_FAR_ATLAS_VIEWS;
}
/** Temporary scratch: two RGBA16F targets with mips plus one depth buffer. */
export function forestFarAtlasScratchBytes(){
  const w=FOREST_FAR_ATLAS_WIDTH*L.supersample,h=FOREST_FAR_ATLAS_HEIGHT*L.supersample;
  return Math.round(2*8*w*h*4/3+4*w*h);
}

export type ForestFarAtlasSphere={centerM:[number,number,number];radiusM:number};
type CaptureAttributes={position:THREE.BufferAttribute|THREE.InterleavedBufferAttribute;pivot?:THREE.BufferAttribute|THREE.InterleavedBufferAttribute;
  level?:THREE.BufferAttribute|THREE.InterleavedBufferAttribute};

/** Reference-height sphere enclosing every member's rest-pose vertices with
 * the capture card scale. Mirrors the detailed vertex transform. */
export function forestFarAtlasSphere(geometries:readonly THREE.BufferGeometry[],variants:readonly ForestStructuralVariant[],
  cardScale:number,marginM=.05):ForestFarAtlasSphere{
  if(!(cardScale>=1)||!Number.isFinite(cardScale))throw new Error('Invalid capture card scale');
  const H=L.referenceHeightM,members:(ForestStructuralVariant|null)[]=variants.length?[...variants]:[null];
  const sources:CaptureAttributes[]=geometries.map(g=>({position:g.getAttribute('position'),pivot:g.getAttribute('_leaf_pivot'),level:g.getAttribute('_branch_level')}));
  const points:number[]=[];const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(const variant of members)for(const s of sources){
    if(!s.position)throw new Error('Capture geometry has no positions');
    for(let i=0;i<s.position.count;i++){
      const p:[number,number,number]=[s.position.getX(i),s.position.getY(i),s.position.getZ(i)];let r:[number,number,number];
      if(s.level&&s.pivot&&s.level.getX(i)>3.5){
        const q:[number,number,number]=[s.pivot.getX(i),s.pivot.getY(i),s.pivot.getZ(i)];
        if(forestVariantRemovesLeaf(variant,q))r=forestVariantPoint(variant,q,H);
        else{
          const pivot=forestVariantPoint(variant,q,H),theta=forestVariantTwist(variant,q[1],H),c=Math.cos(theta),sn=Math.sin(theta);
          const o=[p[0]-q[0],p[1]-q[1],p[2]-q[2]];
          r=[pivot[0]+(c*o[0]!+sn*o[2]!)*cardScale,pivot[1]+o[1]!*cardScale,pivot[2]+(-sn*o[0]!+c*o[2]!)*cardScale];
        }
      }else r=forestVariantPoint(variant,p,H);
      points.push(...r);for(let k=0;k<3;k++){min[k]=Math.min(min[k]!,r[k]!);max[k]=Math.max(max[k]!,r[k]!);}
    }
  }
  if(!points.length)throw new Error('Capture geometry is empty');
  // Crowns are drawn around a vertical axis: keep the centre on the trunk so
  // yaw about the root never moves the capture centre.
  const centerM:[number,number,number]=[0,(min[1]!+max[1]!)/2,0];let radiusM=0;
  for(let i=0;i<points.length;i+=3)radiusM=Math.max(radiusM,Math.hypot(points[i]!,points[i+1]!-centerM[1],points[i+2]!));
  return {centerM,radiusM:radiusM+marginM};
}

/** Tile centre of pool member `k` in the capture plane, in capture radii along
 * (right, up). Columns follow u and rows follow v of the atlas layer. */
export function forestFarAtlasTileOffset(member:number):[number,number]{
  if(!Number.isInteger(member)||member<0||member>=FOREST_VARIANT_COUNT)throw new Error('Invalid far atlas member');
  const column=member%L.columns,row=Math.floor(member/L.columns);
  return [(column-(L.columns-1)/2)*2,(row-(L.rows-1)/2)*2];
}

/** Capture fragment outputs, replacing the terminal colour. Pass 0: linear
 * albedo with unit coverage. Pass 1: capture-view normal xy, front depth and
 * leaf flag. Installed Three writes `vViewPosition=-mvPosition.xyz`, so its z
 * is positive distance; with `frame=(r+1,r)` the front of the capture sphere
 * (towards the camera) stores 1 and the back stores 0. `treeAtlasView`
 * decodes `d*2-1` as the offset along the view's `toward` axis. */
export function forestFarAtlasCaptureFragment(leaf:boolean){
  return `
    if(atlasCapturePass==0)gl_FragColor=vec4(diffuseColor.rgb,1.0);
    else{
      vec3 captureNormal=normalize(normal);if(captureNormal.z<0.0)captureNormal=-captureNormal;
      gl_FragColor=vec4(captureNormal.xy*0.5+0.5,clamp((atlasCaptureFrame.x-vViewPosition.z)/atlasCaptureFrame.y*0.5+0.5,0.0,1.0),${leaf?'1.0':'0.0'});
    }`;
}
/** Patch an already-built physical fragment shader for capture. Strips output
 * transforms (tone mapping, colour space, fog, premultiply, dithering). */
export function installForestFarAtlasCapture(fragmentShader:string,leaf:boolean){
  if(!fragmentShader.includes('#include <opaque_fragment>'))throw new Error('Capture shader terminal hook is missing');
  let source='uniform int atlasCapturePass;\nuniform vec2 atlasCaptureFrame;\n'+fragmentShader.replace('#include <opaque_fragment>',forestFarAtlasCaptureFragment(leaf));
  for(const chunk of ['tonemapping','colorspace','fog','premultiplied_alpha','dithering'])source=source.replace(`#include <${chunk}_fragment>`,'');
  return source;
}

type CaptureBatch={group:THREE.Group;meshes?:THREE.InstancedMesh[];pass:{value:number};frame:{value:THREE.Vector2};count:number;
  setMember(index:number,matrix:THREE.Matrix4,member:number):void;dispose():void};
export type ForestFarAtlasSource={kind:'branching'|'spire';geometries:readonly THREE.BufferGeometry[];
  variants:readonly ForestStructuralVariant[];cardScale:number;createCaptureBatch(lod:0|1,count:number):CaptureBatch};
export type ForestFarAtlasState='baking'|'ready'|'failed'|'disposed';

const copyVertex=`void main(){gl_Position=vec4(position.xy,0.0,1.0);}`;
const copyFragment=`uniform sampler2D atlasSource;uniform float atlasSourceLevel;uniform vec2 atlasTargetSize;
void main(){gl_FragColor=textureLod(atlasSource,gl_FragCoord.xy/atlasTargetSize,atlasSourceLevel);}`;

/** Incremental GPU bake for one family. `step` renders a bounded number of
 * views into the family's two array targets and must run outside XR frames. */
export class ForestFarAtlas{
  readonly kind:'branching'|'spire';
  readonly colour:THREE.WebGLArrayRenderTarget;
  readonly data:THREE.WebGLArrayRenderTarget;
  /** Capture sphere divided by the 16 m reference height (far shader units). */
  readonly sphere:THREE.Vector4;
  readonly sphereM:ForestFarAtlasSphere;
  readonly bytes=forestFarAtlasBytes();
  readonly scratchBytes=forestFarAtlasScratchBytes();
  private captureBatchCpuBytes=0;
  private captureBatchGpuEstimateBytes=0;
  private buildScratchPeakGpuBytes=0;
  state:ForestFarAtlasState='baking';
  error='';nextView=0;bakeMs=0;steps=0;
  private batch:CaptureBatch|null;
  private scratch:[THREE.WebGLRenderTarget,THREE.WebGLRenderTarget]|null;
  private scene=new THREE.Scene();private camera:THREE.OrthographicCamera;
  private copy:{scene:THREE.Scene;camera:THREE.Camera;material:THREE.ShaderMaterial;mesh:THREE.Mesh}|null;
  private views=treeHemiCaptureViews(L.grid);
  private members:number;
  constructor(source:ForestFarAtlasSource){
    this.kind=source.kind;this.members=source.variants.length;
    this.sphereM=forestFarAtlasSphere(source.geometries,source.variants,source.cardScale);
    const H=L.referenceHeightM;
    this.sphere=new THREE.Vector4(this.sphereM.centerM[0]/H,this.sphereM.centerM[1]/H,this.sphereM.centerM[2]/H,this.sphereM.radiusM/H);
    const array=(colorSpace:THREE.ColorSpace)=>{
      const target=new THREE.WebGLArrayRenderTarget(FOREST_FAR_ATLAS_WIDTH,FOREST_FAR_ATLAS_HEIGHT,FOREST_FAR_ATLAS_VIEWS,
        {type:THREE.UnsignedByteType,format:THREE.RGBAFormat,depthBuffer:false,stencilBuffer:false,generateMipmaps:false,
          minFilter:THREE.LinearMipmapLinearFilter,magFilter:THREE.LinearFilter});
      target.texture.colorSpace=colorSpace;target.texture.generateMipmaps=false;
      // Non-empty mipmaps make Three allocate every level and a framebuffer per level.
      target.texture.mipmaps=Array.from({length:FOREST_FAR_ATLAS_LEVELS},(_,l)=>({width:Math.max(1,FOREST_FAR_ATLAS_WIDTH>>l),height:Math.max(1,FOREST_FAR_ATLAS_HEIGHT>>l),data:null})) as unknown as typeof target.texture.mipmaps;
      return target;
    };
    // Premultiplied linear albedo in sRGB storage; hardware filters in linear.
    this.colour=array(THREE.SRGBColorSpace);this.data=array(THREE.NoColorSpace);
    const w=FOREST_FAR_ATLAS_WIDTH*L.supersample,h=FOREST_FAR_ATLAS_HEIGHT*L.supersample;
    const scratch=(depthBuffer:boolean)=>{
      const target=new THREE.WebGLRenderTarget(w,h,{type:THREE.HalfFloatType,format:THREE.RGBAFormat,depthBuffer,stencilBuffer:false,
        generateMipmaps:true,minFilter:THREE.LinearMipmapLinearFilter,magFilter:THREE.LinearFilter});
      target.texture.colorSpace=THREE.NoColorSpace;return target;
    };
    this.scratch=[scratch(true),scratch(true)];
    const r=this.sphereM.radiusM,distance=r+1;
    this.camera=new THREE.OrthographicCamera(-L.columns*r,L.columns*r,L.rows*r,-L.rows*r,.5,2*r+1.5);
    this.batch=source.createCaptureBatch(L.captureLod,FOREST_VARIANT_COUNT);
    const captureBuffers=this.batch.meshes?forestMeshBufferFootprint(this.batch.meshes):
      {totalBytes:0,geometryGpuEstimateBytes:0,instanceGpuEstimateBytes:0};
    this.captureBatchCpuBytes=captureBuffers.totalBytes;
    this.captureBatchGpuEstimateBytes=captureBuffers.geometryGpuEstimateBytes+captureBuffers.instanceGpuEstimateBytes;
    this.buildScratchPeakGpuBytes=this.scratchBytes+this.captureBatchGpuEstimateBytes;
    this.batch.frame.value.set(distance,r);this.scene.add(this.batch.group);
    const material=new THREE.ShaderMaterial({vertexShader:copyVertex,fragmentShader:copyFragment,depthTest:false,depthWrite:false,blending:THREE.NoBlending,
      uniforms:{atlasSource:{value:null},atlasSourceLevel:{value:0},atlasTargetSize:{value:new THREE.Vector2()}}});
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
    const mesh=new THREE.Mesh(geometry,material);mesh.frustumCulled=false;
    const copyScene=new THREE.Scene();copyScene.add(mesh);
    this.copy={scene:copyScene,camera:new THREE.Camera(),material,mesh};
  }
  get ready(){return this.state==='ready';}
  /** Bake up to `maxViews` views. Returns true once every view is complete. */
  step(renderer:THREE.WebGLRenderer,maxViews=3){
    if(this.state!=='baking')return this.state==='ready';
    const started=performance.now();
    const previousTarget=renderer.getRenderTarget(),previousFace=renderer.getActiveCubeFace(),previousLevel=renderer.getActiveMipmapLevel();
    const previousAutoClear=renderer.autoClear,previousClear=renderer.getClearColor(new THREE.Color()),previousAlpha=renderer.getClearAlpha();
    const previousXr=renderer.xr.enabled,previousShadow=renderer.shadowMap.autoUpdate;
    try{
      renderer.xr.enabled=false;renderer.shadowMap.autoUpdate=false;renderer.autoClear=false;renderer.setClearColor(0x000000,0);
      for(let n=0;n<maxViews&&this.nextView<this.views.length;n++)this.bakeView(renderer,this.views[this.nextView++]!);
      if(this.nextView>=this.views.length){this.state='ready';this.releaseBakeResources();}
    }catch(error){this.state='failed';this.error=String(error);this.releaseBakeResources();}
    finally{
      renderer.setRenderTarget(previousTarget,previousFace,previousLevel);renderer.autoClear=previousAutoClear;
      renderer.setClearColor(previousClear,previousAlpha);renderer.xr.enabled=previousXr;renderer.shadowMap.autoUpdate=previousShadow;
      this.bakeMs+=performance.now()-started;this.steps++;
    }
    return this.state==='ready';
  }
  private bakeView(renderer:THREE.WebGLRenderer,view:ReturnType<typeof treeHemiCaptureViews>[number]){
    const batch=this.batch!,scratch=this.scratch!,copy=this.copy!,r=this.sphereM.radiusM,c=this.sphereM.centerM;
    const toward=new THREE.Vector3(...view.towardCamera),right=new THREE.Vector3(...view.right),up=new THREE.Vector3(...view.up);
    this.camera.position.copy(toward).multiplyScalar(r+1);
    this.camera.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right,up,toward));this.camera.updateMatrixWorld(true);
    const matrix=new THREE.Matrix4(),root=new THREE.Vector3();
    for(let k=0;k<FOREST_VARIANT_COUNT;k++){
      const [x,y]=forestFarAtlasTileOffset(k);
      // Tile centres lie in the capture plane through the world origin.
      root.copy(right).multiplyScalar(x*r).addScaledVector(up,y*r).sub(new THREE.Vector3(...c));
      matrix.makeTranslation(root.x,root.y,root.z);batch.setMember(k,matrix,this.members?k+1:0);
    }
    for(const pass of [0,1]){
      batch.pass.value=pass;renderer.setRenderTarget(scratch[pass]!);renderer.clear(true,true,false);renderer.render(this.scene,this.camera);
    }
    // Scratch level l+log2(supersample) has exactly the atlas level-l size.
    const offset=Math.log2(L.supersample);
    for(const [pass,target] of [[0,this.colour],[1,this.data]] as const){
      copy.material.uniforms.atlasSource!.value=scratch[pass]!.texture;
      for(let level=0;level<FOREST_FAR_ATLAS_LEVELS;level++){
        const w=Math.max(1,FOREST_FAR_ATLAS_WIDTH>>level),h=Math.max(1,FOREST_FAR_ATLAS_HEIGHT>>level);
        target.viewport.set(0,0,w,h);target.scissor.set(0,0,w,h);
        copy.material.uniforms.atlasSourceLevel!.value=level+offset;copy.material.uniforms.atlasTargetSize!.value.set(w,h);
        renderer.setRenderTarget(target,view.index,level);renderer.render(copy.scene,copy.camera);
      }
      target.viewport.set(0,0,FOREST_FAR_ATLAS_WIDTH,FOREST_FAR_ATLAS_HEIGHT);target.scissor.set(0,0,FOREST_FAR_ATLAS_WIDTH,FOREST_FAR_ATLAS_HEIGHT);
    }
  }
  private releaseBakeResources(){
    this.batch?.dispose();this.batch=null;
    for(const target of this.scratch??[])target.dispose();this.scratch=null;
    if(this.copy){this.copy.mesh.geometry.dispose();this.copy.material.dispose();this.copy=null;}
  }
  diagnostics(){
    return {kind:this.kind,version:FOREST_FAR_ATLAS_VERSION,state:this.state,error:this.error,views:this.nextView,viewCount:FOREST_FAR_ATLAS_VIEWS,
      members:FOREST_VARIANT_COUNT,tilePx:L.tile,captureLod:L.captureLod,bytes:this.bytes,scratchBytes:this.state==='baking'?this.scratchBytes:0,
      captureBatchCpuBytes:this.state==='baking'?this.captureBatchCpuBytes:0,
      captureBatchGpuEstimateBytes:this.state==='baking'?this.captureBatchGpuEstimateBytes:0,
      buildScratchPeakGpuBytes:this.buildScratchPeakGpuBytes,
      bakeCpuMs:Math.round(this.bakeMs*10)/10,steps:this.steps,sphereM:this.sphereM};
  }
  dispose(){
    if(this.state==='disposed')return;
    this.releaseBakeResources();this.colour.dispose();this.data.dispose();this.state='disposed';
  }
}

/** CPU twin of `treeAtlasLeafCoverage`. `leafDepthScale` is the drawn
 * member's leaf optical depth relative to its 16 m capture
 * (`treeAllometryLeafDepthScale`: card area over drawn side area). */
export function forestFarAtlasLeafCoverage(coverage:number,leafFraction:number,leafDepthScale:number){
  if(![coverage,leafFraction,leafDepthScale].every(Number.isFinite)||leafDepthScale<=0)throw new Error('Invalid far atlas coverage input');
  const f=Math.min(1,Math.max(0,leafFraction)),k=1+f*(leafDepthScale-1);
  return 1-Math.min(1,Math.max(0,1-coverage))**k;
}

/** Far-shader constants and view selection (vertex and fragment). Sampling:
 * `ro`/`rd` are tree-local, divided by tree height
 * (the 16 m reference captures at unit scale). Returns premultiplied albedo
 * and coverage; normal/leaf/hit distance are coverage-weighted. */
export const forestFarAtlasCommonGLSL=`
${hemiTreeViewGLSL}
const float TREE_ATLAS_GRID=${L.grid}.0,TREE_ATLAS_TILE=${L.tile}.0,TREE_ATLAS_COLUMNS=${L.columns}.0,TREE_ATLAS_ROWS=${L.rows}.0,TREE_ATLAS_MAX_MIP=${L.maxMip}.0;
`;
/** Fragment-only functions; requires forestFarAtlasCommonGLSL first. */
export const forestFarAtlasGLSL=`
precision highp sampler2DArray;
bool treeAtlasTile(vec2 uv,float member,float view,float lod,out vec3 coordinate){
  coordinate=vec3(0);
  if(any(lessThan(uv,vec2(0)))||any(greaterThan(uv,vec2(1))))return false;
  // Keep bilinear taps inside this member's tile at both trilinear levels.
  float margin=0.5*exp2(ceil(lod))/TREE_ATLAS_TILE;uv=clamp(uv,vec2(margin),vec2(1.0-margin));
  vec2 tile=vec2(mod(member,TREE_ATLAS_COLUMNS),floor(member/TREE_ATLAS_COLUMNS));
  coordinate=vec3((tile+uv)/vec2(TREE_ATLAS_COLUMNS,TREE_ATLAS_ROWS),view);return true;
}
void treeAtlasView(sampler2DArray colourMap,sampler2DArray dataMap,float view,float weight,float member,float lod,vec4 sphere,vec3 ro,vec3 rd,
  inout vec4 colour,inout vec3 surfaceNormal,inout float leaf,inout float hitDistance){
  vec3 toward,right,up;treeHemiBasis(view,TREE_ATLAS_GRID,toward,right,up);
  float denominator=dot(rd,toward);if(weight<=0.0||abs(denominator)<1e-4)return;
  float plane=dot(sphere.xyz-ro,toward),t=plane/denominator;
  vec3 coordinate;vec3 p=ro+rd*t-sphere.xyz;
  if(!treeAtlasTile(vec2(dot(p,right),dot(p,up))/(2.0*sphere.w)+0.5,member,view,lod,coordinate))return;
  // One parallax step onto the captured front surface of this view.
  vec4 c=textureLod(colourMap,coordinate,lod),d=textureLod(dataMap,coordinate,lod);
  if(c.a>1e-4){
    t=(plane+(d.z/c.a*2.0-1.0)*sphere.w)/denominator;p=ro+rd*t-sphere.xyz;
    if(!treeAtlasTile(vec2(dot(p,right),dot(p,up))/(2.0*sphere.w)+0.5,member,view,lod,coordinate))return;
    c=textureLod(colourMap,coordinate,lod);d=textureLod(dataMap,coordinate,lod);
  }
  if(c.a<=1e-4)return;
  vec2 n=d.xy/c.a*2.0-1.0;
  vec3 local=right*n.x+up*n.y+toward*sqrt(max(0.0,1.0-dot(n,n)));
  colour+=c*weight;surfaceNormal+=local*(c.a*weight);leaf+=d.w*weight;hitDistance+=t*c.a*weight;
}
// Captured at the 16 m reference with unit cards. A drawn member's leaf area
// per side area differs by leafDepthScale (card area over drawn side area,
// treeAllometryLeafDepthScale): scale the optical depth of the leaf share.
// Bark scales with the skeleton.
float treeAtlasLeafCoverage(float coverage,float leafFraction,float leafDepthScale){
  float k=mix(1.0,leafDepthScale,clamp(leafFraction,0.0,1.0));
  return 1.0-pow(clamp(1.0-coverage,0.0,1.0),k);
}
// Object-space hashed alpha (Wyman & McGuire 2017), stable under motion.
float treeAtlasHash2(vec2 v){return fract(1.0e4*sin(17.0*v.x+0.1*v.y)*(0.1+abs(sin(13.0*v.y+v.x))));}
float treeAtlasHash3(vec3 v){return treeAtlasHash2(vec2(treeAtlasHash2(v.xy),v.z));}
float treeAtlasAlphaThreshold(vec3 p){
  float maxDeriv=max(length(dFdx(p)),length(dFdy(p))),pixScale=1.0/max(1e-12,maxDeriv);
  vec2 pixScales=vec2(exp2(floor(log2(pixScale))),exp2(ceil(log2(pixScale))));
  vec2 alpha=vec2(treeAtlasHash3(floor(pixScales.x*p)),treeAtlasHash3(floor(pixScales.y*p)));
  float lerpFactor=fract(log2(pixScale)),x=(1.0-lerpFactor)*alpha.x+lerpFactor*alpha.y,a=min(lerpFactor,1.0-lerpFactor);
  vec3 cases=vec3(x*x/(2.0*a*(1.0-a)),(x-0.5*a)/(1.0-a),1.0-((1.0-x)*(1.0-x)/(2.0*a*(1.0-a))));
  return clamp(x<(1.0-a)?(x<a?cases.x:cases.y):cases.z,1.0e-6,1.0);
}
`;
