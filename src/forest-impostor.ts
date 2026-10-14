import * as THREE from 'three';
import {LEGACY_TREE_LOBES,LEGACY_TREE_TRUNK,LEGACY_TREE_SHAPE_VERSION,LEGACY_TREE_BOUND} from './tree-shape.ts';
import {forestCoverageGLSL} from './forest-coverage.ts';
import {ForestDirtyBlocks} from './forest-dirty-blocks.ts';
import {forestPresentationGLSL,unpackForestPresentation,FOREST_PRESENTATION_VERSION} from './forest-presentation.ts';
import type {TreeCanopyProfile,TreeCullingBounds,TreeTrunkProfile} from './tree-canopy-profile.ts';
import {deriveFamilyProxyBounds,deriveVariantFamilyProxyBounds} from './tree-canopy-bounds.ts';
import {forestFarAtlasCommonGLSL,forestFarAtlasGLSL,FOREST_FAR_ATLAS_VERSION} from './forest-far-atlas.ts';
import {forestFoliageLobeGLSL,installForestFoliageLobe,FOREST_FOLIAGE_LOBE_VERSION} from './forest-foliage-lobe.ts';
import {forestVariantEnvelope,forestVariantGLSL,forestVariantUniformData,FOREST_VARIANT_COUNT,FOREST_VARIANT_VERSION,type ForestStructuralVariant} from './tree-structural-variant.ts';
import {packTreeAllometryParameter,treeAllometryAtlasStretch,treeAllometryBox,treeAllometryGLSL,unpackTreeAllometryParameter,unpackTreeAllometryRatios,
  TREE_ALLOMETRY_IDENTITY_CODE,TREE_ALLOMETRY_VERSION,TREE_FAMILY_ALLOMETRY_ENVELOPE,TREE_LEGACY_ALLOMETRY_ENVELOPE,type TreeAllometryReference} from './tree-allometry.ts';

export type ForestFamilyPresentation={enabled:boolean;lod1Profile:TreeCanopyProfile;conservativeBounds:TreeCullingBounds;
  barkLinearRgb:[number,number,number];foliageLinearRgb:[number,number,number];
  /** Opaque projected leaf area per band (m²). Absent keeps the solid legacy crowns. */
  foliageProjectedAreaM2?:readonly [number,number,number,number];
  /** Measured trunk at the 16 m reference height; absent keeps the legacy trunk. */
  trunk?:TreeTrunkProfile|null;
  /** Same bounded pool as the detailed batches; absent/empty is authored structure. */
  structuralVariants?:readonly ForestStructuralVariant[];
  /** Reference measurements that map species dimensions onto this family. */
  allometry?:TreeAllometryReference|null};
/** Baked far atlas for one family: two array textures and the capture sphere
 * (centre xyz, radius) divided by the 16 m reference height. */
export type ForestFamilyAtlas={colour:{texture:THREE.Texture};data:{texture:THREE.Texture};sphere:THREE.Vector4};
let emptyAtlas:THREE.DataArrayTexture|null=null;
function emptyAtlasTexture(){
  if(!emptyAtlas){emptyAtlas=new THREE.DataArrayTexture(new Uint8Array(4),1,1,1);emptyAtlas.needsUpdate=true;}
  return emptyAtlas;
}
function validateFamilyPresentation(presentation:ForestFamilyPresentation|null,kind:'branching'|'spire'){
  if(!presentation?.enabled)return null;
  const {lod1Profile:profile,conservativeBounds:bounds,barkLinearRgb,foliageLinearRgb}=presentation;
  if(profile.referenceHeightM!==16||profile.bands.length!==4||!Number.isFinite(bounds.radiusM)||bounds.radiusM<=0||
    ![...barkLinearRgb,...foliageLinearRgb,profile.maxLeafOffsetM].every(x=>Number.isFinite(x)&&x>=0))throw new Error('Invalid distant family presentation');
  for(const band of profile.bands)if(![...band.centerM,band.radiusM,band.halfHeightM].every(Number.isFinite)||band.radiusM<0||band.halfHeightM<0)throw new Error('Invalid distant crown band');
  const area=presentation.foliageProjectedAreaM2;
  if(area!==undefined&&(!Array.isArray(area)||area.length!==4||!area.every(x=>Number.isFinite(x)&&x>=0)))throw new Error('Invalid distant foliage density');
  const variants=presentation.structuralVariants??[],trunk=presentation.trunk??null;
  const envelope=forestVariantEnvelope(variants);
  if(variants.some(v=>v.kind!==kind))throw new Error('Structural variants belong to another family');
  // Variant-free, legacy-trunk presentations keep their previous tight box.
  return !variants.length&&!trunk?deriveFamilyProxyBounds(profile):deriveVariantFamilyProxyBounds(profile,envelope,trunk);
}
const familyUniformGLSL=`uniform vec4 treeFamilyBands[8];uniform vec2 treeFamilyBandExtent[8];
  uniform vec3 treeFamilyBark[2],treeFamilyFoliage[2],treeFamilyCenter[2],treeFamilyExtent[2];
  uniform vec2 treeFamilyBounds,treeFamilyMargin,treeFamilyLean;
  uniform vec4 treeFamilyDensity[2],treeFamilyVariantA[${2*FOREST_VARIANT_COUNT}],treeFamilyVariantB[${2*FOREST_VARIANT_COUNT}];
  uniform vec3 treeFamilyTrunk[2],treeFamilyAllometry[2];uniform vec2 treeFamilyClump;`;
const identityVariants=()=>forestVariantUniformData([]);

const scalar=(x:number)=>Number.isInteger(x)?`${x}.0`:String(x);
const vector=(v:readonly number[])=>`vec3(${v.map(scalar).join(',')})`;
const quaternionGLSL=`
vec3 treeRotate(vec4 q,vec3 v){return v+2.0*cross(q.xyz,cross(q.xyz,v)+q.w*v);}
`;
// Derive convex planes from the same Three geometry as the shipped mesh.
// An enclosing ellipsoid alone changes projected coverage by up to 25%.
function convexShader(name:string,geometry:THREE.BufferGeometry){
  const flat=geometry.index?geometry.toNonIndexed():geometry,position=flat.getAttribute('position');
  const planes:number[][]=[],a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3();
  for(let i=0;i<position.count;i+=3){
    a.fromBufferAttribute(position,i);b.fromBufferAttribute(position,i+1);c.fromBufferAttribute(position,i+2);
    const normal=b.sub(a).cross(c.sub(a)).normalize(),distance=normal.dot(a);
    const plane=[normal.x,normal.y,normal.z,distance];
    if(!planes.some(p=>p.every((x,j)=>Math.abs(x-plane[j])<1e-6)))planes.push(plane);
  }
  flat.dispose();if(flat!==geometry)geometry.dispose();
  // span: (entry ray parameter, in-shape chord) for Beer-Lambert optical depth.
  return `void ${name}Span(vec3 ro,vec3 rd,vec3 centre,vec3 radii,vec3 colour,
    inout float best,inout vec3 hitNormal,inout vec3 hitColour,inout float coverage,out vec2 span){
    span=vec2(0);
    vec3 o=(ro-centre)/radii,d=rd/radii;float enter=-1e20,leave=1e20,parallelOutside=0.0;
    vec3 enterNormal=vec3(0),leaveNormal=vec3(0);
    ${planes.map(p=>`{
      vec3 n=${vector(p.slice(0,3))};float numerator=${scalar(p[3])}-dot(n,o),denominator=dot(n,d);
      if(abs(denominator)<1e-8){if(numerator<0.0)parallelOutside=1.0;}
      else{float t=numerator/denominator;
        if(denominator<0.0){if(t>enter){enter=t;enterNormal=n;}}
        else if(t<leave){leave=t;leaveNormal=n;}
      }
    }`).join('\n')}
    float gap=leave-enter,width=max(1e-7,fwidth(gap));
    float alpha=treeEdgeAA*treeSampleAA>.5?clamp(.5+gap/width,0.0,1.0):step(0.0,gap);
    float t=enter>=0.0?enter:leave;vec3 n=enter>=0.0?enterNormal:leaveNormal;
    if(parallelOutside<.5&&alpha>0.0&&t>=0.0&&dot(n,n)>.5){
      coverage=max(coverage,alpha);span=vec2(max(enter,0.0),max(0.0,leave-max(enter,0.0)));
      if(t<best){best=t;hitNormal=normalize(n/radii);hitColour=colour;}
    }
  }
  void ${name}(vec3 ro,vec3 rd,vec3 centre,vec3 radii,vec3 colour,
    inout float best,inout vec3 hitNormal,inout vec3 hitColour,inout float coverage){
    vec2 span;${name}Span(ro,rd,centre,radii,colour,best,hitNormal,hitColour,coverage,span);
  }`;
}
const facetedGLSL=convexShader('treeCrown',new THREE.IcosahedronGeometry(1,0))+
  convexShader('treeFamilyCone',new THREE.ConeGeometry(1,2,8))+
  convexShader('treeFacetedTrunk',new THREE.CylinderGeometry(LEGACY_TREE_TRUNK.topRadius,LEGACY_TREE_TRUNK.baseRadius,LEGACY_TREE_TRUNK.height,4).translate(0,.32,0));
const intersectGLSL=`
void treeEllipsoidSpan(vec3 ro,vec3 rd,vec3 centre,vec3 radii,vec3 colour,
  inout float best,inout vec3 hitNormal,inout vec3 hitColour,inout float coverage,out vec2 span){
  span=vec2(0);
  vec3 o=(ro-centre)/radii,d=rd/radii;
  float a=dot(d,d),tc=-dot(o,d)/a;vec3 closest=o+tc*d;
  float remaining=1.0-dot(closest,closest),width=max(1e-7,fwidth(remaining));
  float alpha=treeEdgeAA*treeSampleAA>.5?clamp(.5+remaining/width,0.0,1.0):step(0.0,remaining);
  if(alpha<=0.0)return;
  float halfChord=sqrt(max(0.0,remaining)/a),t=tc-halfChord;
  if(t<0.0)t=tc+halfChord;
  if(t>=0.0){coverage=max(coverage,alpha);span=vec2(max(tc-halfChord,0.0),max(0.0,tc+halfChord-max(tc-halfChord,0.0)));
    if(t<best){best=t;hitNormal=normalize((ro+rd*t-centre)/(radii*radii));hitColour=colour;}}
}
void treeEllipsoid(vec3 ro,vec3 rd,vec3 centre,vec3 radii,vec3 colour,
  inout float best,inout vec3 hitNormal,inout vec3 hitColour,inout float coverage){
  vec2 span;treeEllipsoidSpan(ro,rd,centre,radii,colour,best,hitNormal,hitColour,coverage,span);
}
void treeTrunk(vec3 ro,vec3 rd,inout float best,inout vec3 hitNormal,inout vec3 hitColour){
  const float height=${LEGACY_TREE_TRUNK.height},r0=${LEGACY_TREE_TRUNK.baseRadius};
  const float slope=(${LEGACY_TREE_TRUNK.topRadius}-${LEGACY_TREE_TRUNK.baseRadius})/${LEGACY_TREE_TRUNK.height};
  float r=r0+slope*ro.y;
  float a=dot(rd.xz,rd.xz)-slope*slope*rd.y*rd.y;
  float b=dot(ro.xz,rd.xz)-r*slope*rd.y,c=dot(ro.xz,ro.xz)-r*r;
  float discriminant=b*b-a*c;
  if(discriminant>=0.0&&abs(a)>1e-8){
    float root=sqrt(discriminant),t0=(-b-root)/a,t1=(-b+root)/a;
    float nearT=min(t0,t1),farT=max(t0,t1);
    for(int i=0;i<2;i++){
      float t=i==0?nearT:farT,y=ro.y+t*rd.y;
      if(t>=0.0&&t<best&&y>=0.0&&y<=height){vec3 p=ro+rd*t;best=t;hitNormal=normalize(vec3(p.x,-slope*(r0+slope*y),p.z));hitColour=vec3(.25,.17,.10);}
    }
  }else if(abs(a)<=1e-8&&abs(b)>1e-8){
    float t=-c/(2.0*b),y=ro.y+t*rd.y;
    if(t>=0.0&&t<best&&y>=0.0&&y<=height){vec3 p=ro+rd*t;best=t;hitNormal=normalize(vec3(p.x,-slope*(r0+slope*y),p.z));hitColour=vec3(.25,.17,.10);}
  }
  if(abs(rd.y)>1e-8)for(int i=0;i<2;i++){
    float y=float(i)*height,t=(y-ro.y)/rd.y,radius=r0+slope*y;vec3 p=ro+rd*t;
    if(t>=0.0&&t<best&&dot(p.xz,p.xz)<=radius*radius){best=t;hitNormal=vec3(0.0,i==0?-1.0:1.0,0.0);hitColour=vec3(.25,.17,.10);}
  }
}
`;

/** Experimental exact-individual far proxy. Static instance attributes, one
 * draw, analytic hit depth/normals, and no camera-dependent population choices.
 * The desktop host assigns explicit per-tree ownership during LOD handoff.
 * Attribute coordinates are metres in a stable local origin, not planet f32. */
export class ForestImpostors {
  readonly mesh:THREE.Mesh<THREE.InstancedBufferGeometry,THREE.MeshLambertMaterial>;
  readonly uniforms={
    treeCamera:{value:new THREE.Vector3()},treeViewDirection:{value:new THREE.Vector3(0,0,-1)},treeOrthographic:{value:0},
    treeModelView:{value:new THREE.Matrix4()},treeNormalMatrix:{value:new THREE.Matrix3()},treeProjection:{value:new THREE.Matrix4()},
    treeRadiusScale:{value:1},treeBoundInflation:{value:1},treeMaskOnly:{value:0},treeFaceted:{value:1},treeEdgeAA:{value:1},treeSampleAA:{value:0},treePixelScale:{value:0},
    treeRuntime:{value:0},treeDrawRange:{value:new THREE.Vector2(3700,4000)},treeAltitudeCoverage:{value:1},
    treeWater:{value:0},treeHasWater:{value:0},treeClipToLocal:{value:new THREE.Matrix4()},
    treeFamilyBands:{value:Array.from({length:8},()=>new THREE.Vector4(0,0,0,-1))},
    treeFamilyBandExtent:{value:Array.from({length:8},()=>new THREE.Vector2())},
    treeFamilyBark:{value:[new THREE.Vector3(),new THREE.Vector3()]},
    treeFamilyFoliage:{value:[new THREE.Vector3(),new THREE.Vector3()]},treeFamilyBounds:{value:new THREE.Vector2()},
    treeFamilyCenter:{value:[new THREE.Vector3(),new THREE.Vector3()]},
    treeFamilyExtent:{value:[new THREE.Vector3(),new THREE.Vector3()]},treeFamilyMargin:{value:new THREE.Vector2()},
    // Part of the horizontal extent per metre of height contributed by variant lean.
    treeFamilyLean:{value:new THREE.Vector2()},
    // Zero projected area keeps the solid legacy crown; zero trunk height keeps the legacy trunk.
    treeFamilyDensity:{value:[new THREE.Vector4(),new THREE.Vector4()]},
    treeFamilyTrunk:{value:[new THREE.Vector3(),new THREE.Vector3()]},treeFamilyClump:{value:new THREE.Vector2(1,1)},
    // Allometry reference per family (trunk radius, p95 crown radius, card extent; m).
    treeFamilyAllometry:{value:[new THREE.Vector3(),new THREE.Vector3()]},
    // Captured far atlas per family; the analytic bands remain while absent.
    treeAtlasColour0:{value:emptyAtlasTexture() as THREE.Texture},treeAtlasColour1:{value:emptyAtlasTexture() as THREE.Texture},
    treeAtlasData0:{value:emptyAtlasTexture() as THREE.Texture},treeAtlasData1:{value:emptyAtlasTexture() as THREE.Texture},
    treeAtlasSphere:{value:[new THREE.Vector4(),new THREE.Vector4()]},treeAtlasReady:{value:new THREE.Vector2()},
    treeFamilyVariantA:{value:Array.from({length:2*FOREST_VARIANT_COUNT},(_,i)=>new THREE.Vector4().fromArray(identityVariants(),(i%FOREST_VARIANT_COUNT)*8))},
    treeFamilyVariantB:{value:Array.from({length:2*FOREST_VARIANT_COUNT},(_,i)=>new THREE.Vector4().fromArray(identityVariants(),(i%FOREST_VARIANT_COUNT)*8+4))},
  };
  readonly positions:THREE.InstancedBufferAttribute;
  readonly rotations:THREE.InstancedBufferAttribute;
  readonly parameters:THREE.InstancedBufferAttribute;
  readonly ownership:THREE.InstancedBufferAttribute;
  private ownershipBlocks:Uint8Array;
  private ownershipDirty=false;
  private familyAtlases:[ForestFamilyAtlas|null,ForestFamilyAtlas|null]=[null,null];
  private familyPresentations:[ForestFamilyPresentation|null,ForestFamilyPresentation|null]=[null,null];
  private staticDirty:ForestDirtyBlocks[];
  constructor(capacity:number){
    if(!Number.isInteger(capacity)||capacity<1||capacity>229376)throw new Error('Invalid forest impostor capacity');
    this.staticDirty=[new ForestDirtyBlocks(capacity),new ForestDirtyBlocks(capacity),new ForestDirtyBlocks(capacity)];
    const geometry=new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,1,-1,0,1,1,0,-1,1,0],3));
    geometry.setAttribute('normal',new THREE.Float32BufferAttribute([0,0,1,0,0,1,0,0,1,0,0,1],3));
    geometry.setIndex([0,1,2,0,2,3]);geometry.instanceCount=0;
    this.positions=new THREE.InstancedBufferAttribute(new Float32Array(capacity*4),4).setUsage(THREE.StaticDrawUsage);
    this.rotations=new THREE.InstancedBufferAttribute(new Float32Array(capacity*4),4).setUsage(THREE.StaticDrawUsage);
    this.parameters=new THREE.InstancedBufferAttribute(new Float32Array(capacity*4),4).setUsage(THREE.StaticDrawUsage);
    this.ownership=new THREE.InstancedBufferAttribute(new Uint16Array(capacity),1).setUsage(THREE.DynamicDrawUsage);
    this.ownershipBlocks=new Uint8Array(Math.ceil(capacity/256));geometry.setAttribute('treeOwnership',this.ownership);
    geometry.setAttribute('treePositionHeight',this.positions);geometry.setAttribute('treeRotation',this.rotations);geometry.setAttribute('treeParameters',this.parameters);
    const material=new THREE.MeshLambertMaterial({color:0xffffff,alphaToCoverage:true});
    material.onBeforeCompile=(shader,renderer)=>{
      if(renderer.capabilities.reversedDepthBuffer)throw new Error('Forest impostor reversed depth has not been accepted');
      Object.assign(shader.uniforms,this.uniforms);
      shader.vertexShader=`attribute vec4 treePositionHeight,treeRotation,treeParameters;attribute float treeOwnership;
        uniform vec3 treeCamera,treeViewDirection;uniform float treeOrthographic,treeBoundInflation,treeRadiusScale,treePixelScale;
        uniform float treeRuntime,treeAltitudeCoverage,treeWater,treeHasWater;uniform vec2 treeDrawRange;uniform mat4 treeClipToLocal;
        varying vec3 treeRayPoint;flat varying vec4 treeRootHeight,treeQ,treeData;flat varying float treeNearLevel,treeEdgeLevel;
        uniform vec4 treeAtlasSphere[2];uniform vec2 treeAtlasReady;flat varying vec3 treeAtlasViews,treeAtlasWeights;flat varying float treeAtlasLod;
        ${quaternionGLSL}${forestPresentationGLSL}${familyUniformGLSL}${forestFarAtlasCommonGLSL}${treeAllometryGLSL}\n`+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`
        treeRootHeight=treePositionHeight;treeQ=treeRotation;treeData=treeParameters;
        float h=treePositionHeight.w;vec3 root=treePositionHeight.xyz;
        treeNearLevel=treeOwnership;treeEdgeLevel=256.0;
        if(treeRuntime>.5){
          float coverage=treeAltitudeCoverage*(1.0-smoothstep(treeDrawRange.x,treeDrawRange.y,length(treeCamera-root)));
          if(treeHasWater>.5&&treeData.y<=treeWater)coverage=0.0;
          treeEdgeLevel=floor(clamp(coverage,0.0,1.0)*256.0+.5);
        }
        float familyCode=forestFamilyCode(treeData.z);
        float familyBound=familyCode==1.0?treeFamilyBounds.x:(familyCode==2.0?treeFamilyBounds.y:0.0);
        // h is the rendered species height; x carries the crown/trunk ratios.
        vec2 allometry=treeAllometryRatios(treeData.x);
        vec3 boundCentre=${vector(LEGACY_TREE_BOUND.center)}*h;
        vec3 extent=${vector(LEGACY_TREE_BOUND.extent)}*h;
        float boundLean=0.0,boundMargin=0.0,atlasStretch=allometry.x;
        if(familyBound>0.0){int familyIndex=int(familyCode)-1;
          boundCentre=treeFamilyCenter[familyIndex]*h;extent=treeFamilyExtent[familyIndex]*h;
          boundLean=treeFamilyLean[familyIndex]*h;boundMargin=treeFamilyMargin[familyIndex];
          atlasStretch=treeAllometryAtlasStretch(h,allometry,treeFamilyAllometry[familyIndex]);
        }
        // The atlas member is stretched to the detailed crown width, which the
        // scaled cards can put beyond the crown ratio: grow by the larger.
        treeAllometryBox(boundCentre,extent,vec2(max(allometry.x,atlasStretch),allometry.y),boundLean);
        extent+=vec3(boundMargin);
        vec3 centre=root+treeRotate(treeQ,boundCentre);
        vec3 facing=treeOrthographic>.5?-treeViewDirection:normalize(treeCamera-centre);
        vec3 axisX=treeRotate(treeQ,vec3(1,0,0)),axisY=treeRotate(treeQ,vec3(0,1,0)),axisZ=treeRotate(treeQ,vec3(0,0,1));
        vec3 right=cross(axisY,facing);if(dot(right,right)<1e-6)right=cross(axisZ,facing);right=normalize(right);
        vec3 vertical=normalize(cross(facing,right));
        extent*=max(1.0,treeRadiusScale);
        float halfX=dot(abs(vec3(dot(right,axisX),dot(right,axisY),dot(right,axisZ))),extent);
        float halfY=dot(abs(vec3(dot(vertical,axisX),dot(vertical,axisY),dot(vertical,axisZ))),extent);
        float distanceToEye=length(treeCamera-centre),boundRadius=length(extent);
        float pixelMargin=treePixelScale*(treeOrthographic>.5?1.0:distanceToEye);
        halfX+=pixelMargin;halfY+=pixelMargin;
        float perspective=treeOrthographic>.5?1.0:distanceToEye/max(.001,distanceToEye-boundRadius);
        vec3 transformed=centre+(right*position.x*halfX+vertical*position.y*halfY)*perspective*treeBoundInflation;
        // A close fallback must have bounded raster coverage, even when the
        // camera enters its bound. Near-owned instances collapse before drawing.
        if(treeOrthographic<.5&&distanceToEye<=boundRadius*1.1){
          vec4 rayPoint=treeClipToLocal*vec4(position.xy,0.0,1.0);transformed=rayPoint.xyz/rayPoint.w;
        }
        if(h<=0.0||treeEdgeLevel<=treeNearLevel)transformed=root;
        treeRayPoint=transformed;
        // Per-tree view blend and atlas level from the crown centre direction.
        treeAtlasViews=vec3(0);treeAtlasWeights=vec3(0);treeAtlasLod=0.0;
        if(familyBound>0.0){int atlasFamily=int(familyCode)-1;
          if((atlasFamily==0?treeAtlasReady.x:treeAtlasReady.y)>.5){
            // The captured member is stretched horizontally to the detailed crown width.
            vec3 atlasScale=vec3(atlasStretch,1.0,atlasStretch);
            vec4 sphere=treeAtlasSphere[atlasFamily];vec3 atlasCentre=root+treeRotate(treeQ,sphere.xyz*atlasScale*h);
            vec3 toEye=treeOrthographic>.5?-treeViewDirection:treeCamera-atlasCentre;
            treeHemiBlend(treeRotate(vec4(-treeQ.xyz,treeQ.w),toEye)/atlasScale,TREE_ATLAS_GRID,treeAtlasViews,treeAtlasWeights);
            float pixelM=treePixelScale*(treeOrthographic>.5?1.0:length(treeCamera-atlasCentre));
            treeAtlasLod=clamp(log2(max(pixelM*TREE_ATLAS_TILE/(2.0*sphere.w*h),1e-3)),0.0,TREE_ATLAS_MAX_MIP);
          }
        }
      `);
      shader.fragmentShader=`uniform vec3 treeCamera,treeViewDirection;
        uniform float treeOrthographic,treeRadiusScale,treeMaskOnly,treeFaceted,treeEdgeAA,treeSampleAA,treePixelScale;
        uniform mat4 treeModelView,treeProjection;uniform mat3 treeNormalMatrix;
        varying vec3 treeRayPoint;flat varying vec4 treeRootHeight,treeQ,treeData;flat varying float treeNearLevel,treeEdgeLevel;
        uniform sampler2DArray treeAtlasColour0,treeAtlasColour1,treeAtlasData0,treeAtlasData1;uniform vec4 treeAtlasSphere[2];uniform vec2 treeAtlasReady;
        flat varying vec3 treeAtlasViews,treeAtlasWeights;flat varying float treeAtlasLod;
        ${quaternionGLSL}${forestCoverageGLSL}${forestPresentationGLSL}${familyUniformGLSL}${forestVariantGLSL}${intersectGLSL}${facetedGLSL}${forestFarAtlasCommonGLSL}${forestFarAtlasGLSL}${treeAllometryGLSL}${forestFoliageLobeGLSL}\n`+installForestFoliageLobe(shader.fragmentShader);
      if(renderer.capabilities.logarithmicDepthBuffer)shader.fragmentShader='#ifndef USE_LOGARITHMIC_DEPTH_BUFFER\n#error Atlas forest requires the installed logarithmic depth define\n#endif\n'+shader.fragmentShader;
      const lobes=LEGACY_TREE_LOBES.map(([x,y,z,s])=>{
        const args=`ro,rd,treeAllometryPoint(${vector([x,y,z])},${scalar(LEGACY_TREE_TRUNK.baseRadius)},allometry),${vector([s,s*.85,s])}*vec3(allometry.x,1.0,allometry.x)*treeRadiusScale,${vector([.16+y*.06,.29+y*.04,.08])},best,treeHitNormal,treeHitColour`;
        return `if(treeFaceted>.5)treeCrown(${args},treeCoverage);else treeEllipsoid(${args},treeCoverage);`;
      }).join('\n');
      shader.fragmentShader=shader.fragmentShader.replace('#include <logdepthbuf_fragment>',`
        if(treeRootHeight.w<=0.0)discard;
        uint forestHash=atlasForestHash(uint(treeData.w+.5));
        bool treeUnowned=forestHash<uint(treeNearLevel+.5)||forestHash>=uint(treeEdgeLevel+.5);
        vec3 rayOrigin=treeCamera,rayDirection=normalize(treeRayPoint-treeCamera);
        if(treeOrthographic>.5){rayDirection=treeViewDirection;rayOrigin=treeRayPoint+rayDirection*dot(treeCamera-treeRayPoint,rayDirection);}
        vec4 inverseQ=vec4(-treeQ.xyz,treeQ.w);
        vec3 ro=treeRotate(inverseQ,rayOrigin-treeRootHeight.xyz)/treeRootHeight.w;
        vec3 rd=normalize(treeRotate(inverseQ,rayDirection));
        float familyCode=forestFamilyCode(treeData.z);
        float familyBound=familyCode==1.0?treeFamilyBounds.x:(familyCode==2.0?treeFamilyBounds.y:0.0);
        vec2 allometry=treeAllometryRatios(treeData.x);float atlasStretch=allometry.x;
        // Shift the ray close to the tree before small-primitive quadratics.
        // Subtracting huge nearly equal squared camera distances loses leaves.
        vec3 rayBoundCenter=vec3(0,.52,0);float rayBoundRadius=2.0*max(1.0,max(allometry.x,allometry.y));
        if(familyBound>0.0){int familyIndex=int(familyCode)-1;
          atlasStretch=treeAllometryAtlasStretch(treeRootHeight.w,allometry,treeFamilyAllometry[familyIndex]);
          vec3 rayExtent=treeFamilyExtent[familyIndex];rayBoundCenter=treeFamilyCenter[familyIndex];
          treeAllometryBox(rayBoundCenter,rayExtent,vec2(max(allometry.x,atlasStretch),allometry.y),treeFamilyLean[familyIndex]);
          rayBoundRadius=length(rayExtent+vec3(treeFamilyMargin[familyIndex]/treeRootHeight.w));
        }
        ro+=rd*max(0.0,dot(rayBoundCenter-ro,rd)-rayBoundRadius);
        float best=1e20,treeCoverage=0.0;vec3 treeHitNormal=vec3(0,1,0),treeHitColour=vec3(0);
        bool treePorous=false,treeAtlas=false;vec3 treeAtlasAnchor=ro;
        if(familyBound>0.0&&treeAtlasWeights!=vec3(0)){
          // Captured far atlas: three hemi-octahedral views of the same
          // structural member, blended by coverage. It already contains the
          // trunk, so no analytic part is drawn for this tree.
          int familyIndex=int(familyCode)-1;vec2 brightness=forestFamilyBrightness(treeData.z);
          float member=float(clamp(forestFamilyVariant(treeData.z),0,${FOREST_VARIANT_COUNT-1}));
          vec4 sphere=treeAtlasSphere[familyIndex],atlasColour=vec4(0);vec3 atlasNormal=vec3(0);float atlasLeaf=0.0,atlasDistance=0.0;
          // Sample the reference capture in its own frame: the whole member,
          // trunk included, is stretched horizontally to the detailed crown width.
          vec3 atlasScale=vec3(atlasStretch,1.0,atlasStretch),atlasRo=ro/atlasScale,atlasRd=rd/atlasScale;
          if(familyIndex==0){
            treeAtlasView(treeAtlasColour0,treeAtlasData0,treeAtlasViews.x,treeAtlasWeights.x,member,treeAtlasLod,sphere,atlasRo,atlasRd,atlasColour,atlasNormal,atlasLeaf,atlasDistance);
            treeAtlasView(treeAtlasColour0,treeAtlasData0,treeAtlasViews.y,treeAtlasWeights.y,member,treeAtlasLod,sphere,atlasRo,atlasRd,atlasColour,atlasNormal,atlasLeaf,atlasDistance);
            treeAtlasView(treeAtlasColour0,treeAtlasData0,treeAtlasViews.z,treeAtlasWeights.z,member,treeAtlasLod,sphere,atlasRo,atlasRd,atlasColour,atlasNormal,atlasLeaf,atlasDistance);
          }else{
            treeAtlasView(treeAtlasColour1,treeAtlasData1,treeAtlasViews.x,treeAtlasWeights.x,member,treeAtlasLod,sphere,atlasRo,atlasRd,atlasColour,atlasNormal,atlasLeaf,atlasDistance);
            treeAtlasView(treeAtlasColour1,treeAtlasData1,treeAtlasViews.y,treeAtlasWeights.y,member,treeAtlasLod,sphere,atlasRo,atlasRd,atlasColour,atlasNormal,atlasLeaf,atlasDistance);
            treeAtlasView(treeAtlasColour1,treeAtlasData1,treeAtlasViews.z,treeAtlasWeights.z,member,treeAtlasLod,sphere,atlasRo,atlasRd,atlasColour,atlasNormal,atlasLeaf,atlasDistance);
          }
          treeAtlas=true;treePorous=true;treeAtlasAnchor=ro+rd*dot(sphere.xyz*atlasScale-ro,rd);
          if(atlasColour.a>1e-4){
            best=atlasDistance/atlasColour.a;
            float leafFraction=clamp(atlasLeaf/atlasColour.a,0.0,1.0);
            // Leaf texels light as a lobe of card normals, like the detailed crowns.
            treeFoliageLobe=leafFraction;
            // Scaled cards over a crown whose side area scales by h^2 * stretch.
            treeCoverage=treeAtlasLeafCoverage(atlasColour.a,leafFraction,treeAllometryLeafDepthScale(treeRootHeight.w,allometry,treeFamilyAllometry[familyIndex]));
            treeHitColour=atlasColour.rgb/atlasColour.a*mix(brightness.x,brightness.y,leafFraction);
            treeHitNormal=dot(atlasNormal,atlasNormal)>1e-8?normalize(atlasNormal/atlasScale):-rd;
            // Two-sided leaves face the viewer, as in the detailed material.
            if(leafFraction>.5&&dot(treeHitNormal,rd)>0.0)treeHitNormal=-treeHitNormal;
          }
        }else if(familyBound>0.0){
          int familyIndex=int(familyCode)-1;vec2 brightness=forestFamilyBrightness(treeData.z);
          // Same bounded structural member as the detailed batches, evaluated at
          // each band centre: horizontal scale, tier twist and top-weighted lean.
          int variantIndex=familyIndex*${FOREST_VARIANT_COUNT}+clamp(forestFamilyVariant(treeData.z),0,${FOREST_VARIANT_COUNT-1});
          vec4 variantA=treeFamilyVariantA[variantIndex],variantB=treeFamilyVariantB[variantIndex];
          vec4 density=treeFamilyDensity[familyIndex];float heightM=treeRootHeight.w,cardScale=treeAllometryCardScale(heightM,allometry,treeFamilyAllometry[familyIndex]);
          treePorous=dot(density,vec4(1))>0.0;
          // Stable reference-frame clumps fade to their mean once a clump nears pixel size.
          float pixelM=treePixelScale*(treeOrthographic>.5?1.0:length(treeCamera-treeRootHeight.xyz));
          float clumpM=treeFamilyClump[familyIndex],clumpAmplitude=smoothstep(1.5,3.0,clumpM/max(pixelM,1e-6));
          float transmittance=1.0,edgeCoverage=0.0;
          for(int i=0;i<4;i++){
            int bandIndex=familyIndex*4+i;vec4 band=treeFamilyBands[bandIndex];
            if(band.w<0.0)continue;
            vec2 ext=treeFamilyBandExtent[bandIndex];
            // Pivots scale with the skeleton; leaf-card offsets follow the card scale.
            // Cone corners use a split margin to stay inside the same bound.
            float margin=cardScale*ext.y/heightM*(familyCode==2.0?.70710678:1.0);
            // Species allometry first, as in the detailed vertex shader.
            vec3 source=treeAllometryPoint(band.xyz/16.0,treeFamilyTrunk[familyIndex].y,allometry);float level=clamp(source.y,0.0,1.0),theta=variantB.x*level;
            vec2 crownScale=mix(vec2(1.0),variantA.xy,atlasVariantCrownWeight(level));
            vec3 centre=atlasVariantPoint(source,1.0,variantA,variantB);
            vec3 radii=max(vec3(.00001),vec3(band.w/16.0*crownScale.x*allometry.x,ext.x/16.0,band.w/16.0*crownScale.y*allometry.x)+margin);
            vec3 colour=treeFamilyFoliage[familyIndex]*brightness.y;
            vec3 bandRo=atlasVariantRotate(ro-centre,-theta),bandRd=atlasVariantRotate(rd,-theta);
            float bandBest=best,bandCoverage=0.0;vec3 bandNormal=treeHitNormal;vec2 span;
            if(familyCode==2.0)treeFamilyConeSpan(bandRo,bandRd,vec3(0),radii,colour,bandBest,bandNormal,treeHitColour,bandCoverage,span);
            else treeEllipsoidSpan(bandRo,bandRd,vec3(0),radii,colour,bandBest,bandNormal,treeHitColour,bandCoverage,span);
            if(bandBest<best){best=bandBest;treeHitNormal=atlasVariantRotate(bandNormal,theta);}
            edgeCoverage=max(edgeCoverage,bandCoverage);
            if(density[i]>0.0&&bandCoverage>0.0){
              // Beer-Lambert: sigma = opaque projected leaf area / crown volume.
              // Leaf area scales by the card area; the skeleton volume grows with height.
              float volume=(familyCode==2.0?2.0943951:4.1887902)*radii.x*radii.y*radii.z*heightM*heightM*heightM;
              vec3 entryM=(ro+rd*span.x)*heightM;
              uint clumpHash=atlasVariantHash(uvec3(ivec3(floor(entryM/clumpM))+1024),uint(treeData.w+.5)*4u+uint(i)+1u);
              float clump=mix(1.0,.25+1.5*float(clumpHash&65535u)/65535.0,clumpAmplitude);
              transmittance*=1.0-bandCoverage*(1.0-exp(-density[i]*cardScale*cardScale/volume*span.y*heightM*clump));
            }else if(bandCoverage>0.0)transmittance*=1.0-bandCoverage;
          }
          treeCoverage=treePorous?1.0-transmittance:edgeCoverage;
          vec3 trunk=treeFamilyTrunk[familyIndex],trunkRo=ro,trunkRd=rd,trunkRadii=vec3(allometry.y,1.0,allometry.y);
          if(trunk.x>0.0){
            // Measured trunk; its top follows the member lean as a linear shear.
            vec2 shear=variantA.zw*trunk.x;trunkRo.xz-=shear*ro.y;trunkRd.xz-=shear*rd.y;
            trunkRadii=vec3(trunk.y/${LEGACY_TREE_TRUNK.baseRadius}*allometry.y,trunk.x/${LEGACY_TREE_TRUNK.height},trunk.y/${LEGACY_TREE_TRUNK.baseRadius}*allometry.y);
          }
          float trunkBest=best,trunkCoverage=0.0;
          treeFacetedTrunk(trunkRo,trunkRd,vec3(0),trunkRadii,treeFamilyBark[familyIndex]*brightness.x,trunkBest,treeHitNormal,treeHitColour,trunkCoverage);
          best=trunkBest;treeCoverage=max(treeCoverage,trunkCoverage);
        }else{
          ${lobes}
          vec3 trunkScale=vec3(allometry.y,1.0,allometry.y);
          if(treeFaceted>.5)treeFacetedTrunk(ro,rd,vec3(0),trunkScale,vec3(.25,.17,.10),best,treeHitNormal,treeHitColour,treeCoverage);
          else {float trunkBefore=best;treeTrunk(ro/trunkScale,rd/trunkScale,best,treeHitNormal,treeHitColour);
            if(best<trunkBefore)treeHitNormal=normalize(treeHitNormal/trunkScale);treeCoverage=1.0;}
        }
        // Complete derivative-based edge coverage before any per-pixel hash
        // discard. Derivatives in divergent discarded lanes are undefined.
        // Object-space hashed alpha for the atlas; derivatives before discard.
        float treeAtlasThreshold=treeAtlasAlphaThreshold(treeAtlasAnchor*treeRootHeight.w);
        if(best==1e20||treeUnowned)discard;
        // Without MSAA alpha-to-coverage, porous crown coverage becomes a
        // stable hash dither rather than a solid silhouette.
        if(treePorous&&treeSampleAA<.5&&(treeAtlas?treeAtlasThreshold:
          float(atlasVariantHash(uvec3(uvec2(gl_FragCoord.xy),uint(treeData.w+.5)),9u)&65535u)/65536.0)>=treeCoverage)discard;
        vec3 treeHit=treeRootHeight.xyz+treeRotate(treeQ,(ro+rd*best)*treeRootHeight.w);
        vec4 treeHitView=treeModelView*vec4(treeHit,1.0),treeClip=treeProjection*treeHitView;
        if(treeHitView.z>=0.0||treeClip.w<=0.0||treeClip.z < -treeClip.w||treeClip.z > treeClip.w)discard;
        #if defined(USE_LOGARITHMIC_DEPTH_BUFFER)
          gl_FragDepth=treeOrthographic>.5?treeClip.z/treeClip.w*.5+.5:log2(1.0-treeHitView.z)*logDepthBufFC*.5;
        #else
          gl_FragDepth=treeClip.z/treeClip.w*.5+.5;
        #endif
        float treeRoll=treeAllometryRoll(treeData.x);
        diffuseColor.rgb*=treeHitColour*(familyBound>0.0?vec3(1.0):vec3(.8+treeRoll*.2,.85+treeRoll*.15,.75+treeRoll*.25));
        diffuseColor.a*=treeCoverage;
      `);
      shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_begin>',`
        float faceDirection=1.0;
        vec3 normal=normalize(treeNormalMatrix*treeRotate(treeQ,treeHitNormal));
        vec3 nonPerturbedNormal=normal;
      `);
      shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>','if(treeMaskOnly>.5)outgoingLight=vec3(1.0);\n#include <opaque_fragment>');
    };
    material.customProgramCacheKey=()=>`${LEGACY_TREE_SHAPE_VERSION}/analytic-impostor-10/${FOREST_FOLIAGE_LOBE_VERSION}/${FOREST_PRESENTATION_VERSION}/${FOREST_VARIANT_VERSION}/${FOREST_FAR_ATLAS_VERSION}/${TREE_ALLOMETRY_VERSION}`;
    this.mesh=new THREE.Mesh(geometry,material);this.mesh.name='Canonical forest analytic impostors';this.mesh.frustumCulled=false;
    this.mesh.userData.localAerialSurfaceHit={local:'treeHit',view:'treeHitView.xyz'};
    const inverse=new THREE.Matrix4(),localCamera=new THREE.Matrix4(),viewport=new THREE.Vector4();
    let defaultSamples:number|undefined;
    this.mesh.onBeforeRender=(_renderer,_scene,camera)=>{
      inverse.copy(this.mesh.matrixWorld).invert();localCamera.multiplyMatrices(inverse,camera.matrixWorld);
      this.uniforms.treeCamera.value.setFromMatrixPosition(localCamera);
      this.uniforms.treeViewDirection.value.set(0,0,-1).transformDirection(localCamera);
      this.uniforms.treeOrthographic.value=Number((camera as THREE.OrthographicCamera).isOrthographicCamera===true);
      this.uniforms.treeModelView.value.multiplyMatrices(camera.matrixWorldInverse,this.mesh.matrixWorld);
      this.uniforms.treeNormalMatrix.value.getNormalMatrix(this.uniforms.treeModelView.value);
      this.uniforms.treeProjection.value.copy(camera.projectionMatrix);
      this.uniforms.treeClipToLocal.value.multiplyMatrices(localCamera,camera.projectionMatrixInverse);
      _renderer.getCurrentViewport(viewport);
      this.uniforms.treePixelScale.value=2/(Math.abs(camera.projectionMatrix.elements[5])*Math.max(1,viewport.w));
      const target=_renderer.getRenderTarget();
      if(!target&&defaultSamples===undefined){const gl=_renderer.getContext();defaultSamples=gl.getParameter(gl.SAMPLES) as number;}
      this.uniforms.treeSampleAA.value=Number((target?target.samples:defaultSamples!)>1);
    };
  }
  setFamilyPresentation(kind:'branching'|'spire',presentation:ForestFamilyPresentation|null){
    const family=kind==='branching'?0:1,offset=family*4;
    const proxy=validateFamilyPresentation(presentation,kind);
    this.familyPresentations[family]=presentation;
    const enabled=presentation?.enabled?presentation:null,variants=enabled?.structuralVariants??[],trunk=enabled?.trunk??null;
    // Disabled families reset to identity structure, legacy trunk and solid crowns.
    const variantData=forestVariantUniformData(variants);
    for(let i=0;i<FOREST_VARIANT_COUNT;i++){
      this.uniforms.treeFamilyVariantA.value[family*FOREST_VARIANT_COUNT+i].fromArray(variantData,i*8);
      this.uniforms.treeFamilyVariantB.value[family*FOREST_VARIANT_COUNT+i].fromArray(variantData,i*8+4);
    }
    this.uniforms.treeFamilyDensity.value[family].fromArray(enabled?.foliageProjectedAreaM2??[0,0,0,0]);
    this.uniforms.treeFamilyTrunk.value[family].set(...(trunk?[trunk.heightM/16,trunk.baseRadiusM/16,trunk.topRadiusM/16] as const:[0,0,0] as const));
    const reference=enabled?.allometry??null;
    this.uniforms.treeFamilyAllometry.value[family].set(...(reference?[reference.trunkRadiusM,reference.crownRadiusM,reference.cardExtentM] as const:[0,0,0] as const));
    this.uniforms.treeFamilyClump.value.setComponent(family,variants[0]?.clumpRefM??1);
    if(enabled){
      const {lod1Profile:profile,conservativeBounds:bounds,barkLinearRgb,foliageLinearRgb}=enabled;
      // Include the drawn trunk (measured or legacy) as well as the leaf
      // envelopes, at the tallest rendered height and widest trunk ratio.
      const E=TREE_FAMILY_ALLOMETRY_ENVELOPE,maxH=E.heightM[1];
      const trunkRadius=trunk?Math.hypot(trunk.baseRadiusM*E.trunkRatio[1],trunk.heightM)/16:Math.hypot(LEGACY_TREE_TRUNK.baseRadius*E.trunkRatio[1],LEGACY_TREE_TRUNK.height);
      const radius=Math.max(bounds.radiusM,trunkRadius*maxH);
      const centre=new THREE.Vector3().fromArray(proxy!.centerPerHeight),extent=new THREE.Vector3().fromArray(proxy!.extentPerHeight);
      const atlas=this.familyAtlases[family];let boundRadius=radius;
      if(atlas){
        // The captured crown can reach past the band envelope: draw the union.
        const s=atlas.sphere,sphere=new THREE.Vector3(s.x,s.y,s.z);
        const min=centre.clone().sub(extent).min(sphere.clone().subScalar(s.w)),max=centre.clone().add(extent).max(sphere.clone().addScalar(s.w));
        centre.copy(min).add(max).multiplyScalar(.5);extent.copy(max).sub(min).multiplyScalar(.5);
        boundRadius=Math.max(radius,(Math.hypot(s.x*E.crownRatio[1],s.y,s.z*E.crownRatio[1])+s.w*E.crownRatio[1])*maxH);
      }
      this.uniforms.treeFamilyBounds.value.setComponent(family,boundRadius);
      this.uniforms.treeFamilyCenter.value[family].copy(centre);
      this.uniforms.treeFamilyExtent.value[family].copy(extent);
      this.uniforms.treeFamilyMargin.value.setComponent(family,proxy!.metricMarginM);
      this.uniforms.treeFamilyLean.value.setComponent(family,proxy!.leanPerHeight??0);
      this.uniforms.treeFamilyBark.value[family].fromArray(barkLinearRgb);this.uniforms.treeFamilyFoliage.value[family].fromArray(foliageLinearRgb);
      profile.bands.forEach((band,i)=>{
        this.uniforms.treeFamilyBands.value[offset+i].set(...band.centerM,band.populated?band.radiusM:-1);
        this.uniforms.treeFamilyBandExtent.value[offset+i].set(band.halfHeightM,profile.maxLeafOffsetM);
      });
    }else this.uniforms.treeFamilyBounds.value.setComponent(family,0);
  }
  /** Adopt (or clear) a baked far atlas. Crowns fall back to the analytic
   * family bands whenever a family has no ready atlas. */
  /** CPU-only bitsets beside the instance attributes. Typed mesh arrays are
   * counted from `mesh.geometry` by the forest resource ledger. */
  memorySidecarBytes(){return this.ownershipBlocks.byteLength+this.staticDirty.reduce((n,blocks)=>n+blocks.byteLength,0);}
  setFamilyAtlas(kind:'branching'|'spire',atlas:ForestFamilyAtlas|null){
    const family=kind==='branching'?0:1;
    if(atlas&&(![atlas.sphere.x,atlas.sphere.y,atlas.sphere.z,atlas.sphere.w].every(Number.isFinite)||atlas.sphere.w<=0||!atlas.colour?.texture||!atlas.data?.texture))
      throw new Error('Invalid far atlas');
    this.familyAtlases[family]=atlas;
    this.uniforms[family===0?'treeAtlasColour0':'treeAtlasColour1'].value=atlas?atlas.colour.texture:emptyAtlasTexture();
    this.uniforms[family===0?'treeAtlasData0':'treeAtlasData1'].value=atlas?atlas.data.texture:emptyAtlasTexture();
    if(atlas)this.uniforms.treeAtlasSphere.value[family].copy(atlas.sphere);else this.uniforms.treeAtlasSphere.value[family].set(0,0,0,0);
    this.uniforms.treeAtlasReady.value.setComponent(family,atlas?1:0);
    // Re-derive the drawn box for the current presentation.
    this.setFamilyPresentation(kind,this.familyPresentations[family]);
  }
  familyAtlas(kind:'branching'|'spire'){return this.familyAtlases[kind==='branching'?0:1];}
  setFamilyPresentations(families:ReadonlyMap<'branching'|'spire',ForestFamilyPresentation>){
    // Validate the entire replacement before changing either active family.
    for(const kind of ['branching','spire'] as const)validateFamilyPresentation(families.get(kind)??null,kind);
    for(const kind of ['branching','spire'] as const)this.setFamilyPresentation(kind,families.get(kind)??null);
  }
  /** Only the existing parameter channel changes; static roots and ownership survive. */
  setPresentation(index:number,code:number){
    if(!Number.isInteger(index)||index<0||index>=this.parameters.count)throw new Error('Invalid forest presentation slot');
    unpackForestPresentation(code);
    if(this.parameters.getZ(index)===code)return;
    this.parameters.setZ(index,code);this.staticDirty[2].mark(index);
  }
  /** Rendered species height and packed crown/trunk ratios; roots, rotation,
   * ownership and the canonical roll seed are untouched. */
  setAllometry(index:number,heightM:number,ratioCode:number){
    if(!Number.isInteger(index)||index<0||index>=this.positions.count)throw new Error('Invalid forest allometry slot');
    const [minH,maxH]=TREE_LEGACY_ALLOMETRY_ENVELOPE.heightM;
    if(!Number.isFinite(heightM)||heightM<minH||heightM>maxH)throw new Error('Invalid rendered tree height');
    unpackTreeAllometryRatios(ratioCode);
    if(this.positions.getW(index)<=0)throw new Error('Retired forest slots have no allometry');
    const parameter=this.parameters.getW(index)+256*ratioCode,height=Math.fround(heightM);
    if(this.positions.getW(index)!==height){this.positions.setW(index,height);this.staticDirty[0].mark(index);}
    if(this.parameters.getX(index)!==parameter){this.parameters.setX(index,parameter);this.staticDirty[2].mark(index);}
  }
  allometry(index:number){
    if(!Number.isInteger(index)||index<0||index>=this.positions.count)throw new Error('Invalid forest allometry slot');
    return {heightM:this.positions.getW(index),...unpackTreeAllometryParameter(this.parameters.getX(index))};
  }
  familyBoundRadius(index:number){
    const family=this.parameters.getZ(index)%4;
    return family===1?this.uniforms.treeFamilyBounds.value.x:family===2?this.uniforms.treeFamilyBounds.value.y:0;
  }
  /** Same local box as the GPU quad and its full-screen close fallback. */
  proxyBounds(index:number,center:THREE.Vector3,extent:THREE.Vector3){
    const height=this.positions.getW(index),family=this.parameters.getZ(index)%4;
    const {crownRatio,trunkRatio}=unpackTreeAllometryParameter(this.parameters.getX(index));
    let lean=0,margin=0,boxCrown=crownRatio;
    if((family===1||family===2)&&this.uniforms.treeFamilyBounds.value.getComponent(family-1)>0){
      const r=this.uniforms.treeFamilyAllometry.value[family-1]!;
      boxCrown=Math.max(crownRatio,treeAllometryAtlasStretch({trunkRadiusM:r.x,crownRadiusM:r.y,cardExtentM:r.z},height,crownRatio,trunkRatio));
      center.copy(this.uniforms.treeFamilyCenter.value[family-1]).multiplyScalar(height);
      extent.copy(this.uniforms.treeFamilyExtent.value[family-1]).multiplyScalar(height);
      lean=this.uniforms.treeFamilyLean.value.getComponent(family-1)*height;margin=this.uniforms.treeFamilyMargin.value.getComponent(family-1);
    }else{center.fromArray(LEGACY_TREE_BOUND.center).multiplyScalar(height);extent.fromArray(LEGACY_TREE_BOUND.extent).multiplyScalar(height);}
    const box=treeAllometryBox(center.toArray(),extent.toArray(),boxCrown,trunkRatio,lean);
    center.fromArray(box.center);extent.fromArray(box.extent).addScalar(margin);
    extent.multiplyScalar(Math.max(1,this.uniforms.treeRadiusScale.value));
  }
  write(index:number,position:THREE.Vector3,heightM:number,rotation:THREE.Quaternion,roll:number,groundHeightM:number){
    if(!Number.isInteger(index)||index<0||index>=this.positions.count||!Number.isFinite(heightM)||heightM<0||
      ![...position.toArray(),...rotation.toArray(),heightM,roll,groundHeightM].every(v=>Number.isFinite(Math.fround(v)))||
      Math.abs(rotation.lengthSq()-1)>1e-4)throw new Error('Invalid forest impostor instance');
    if(roll<0||roll>=1)throw new Error('Invalid forest impostor roll');
    this.positions.setXYZW(index,position.x,position.y,position.z,heightM);
    this.rotations.setXYZW(index,rotation.x,rotation.y,rotation.z,rotation.w);
    // x: canonical roll seed plus identity allometry until presentation tags it.
    this.parameters.setXYZW(index,packTreeAllometryParameter(roll,TREE_ALLOMETRY_IDENTITY_CODE),groundHeightM,0,Math.min(255,Math.floor(roll*256)));
    this.setOwnership(index,0);
    this.mesh.geometry.instanceCount=Math.max(this.mesh.geometry.instanceCount,index+1);
    for(const dirty of this.staticDirty)dirty.mark(index);
  }
  retire(index:number){
    if(!Number.isInteger(index)||index<0||index>=this.positions.count)throw new Error('Invalid forest retirement');
    this.positions.setW(index,0);this.staticDirty[0].mark(index);this.setOwnership(index,0);
  }
  commit(){
    let bytes=this.commitOwnership();
    bytes+=this.staticDirty[0].flush(this.positions);
    bytes+=this.staticDirty[1].flush(this.rotations);
    bytes+=this.staticDirty[2].flush(this.parameters);return bytes;
  }
  /** Quantized 0..256. A value of 256 also suppresses stale far presence when
   * current near sampling proves absence. Kept apart from static transforms. */
  setOwnership(index:number,level:number){
    if(!Number.isInteger(index)||index<0||index>=this.ownership.count||!Number.isInteger(level)||level<0||level>256)throw new Error('Invalid forest ownership');
    if(this.ownership.array[index]===level)return;
    this.ownership.array[index]=level;this.ownershipBlocks[Math.floor(index/256)]=1;this.ownershipDirty=true;
  }
  private commitOwnership(){
    if(!this.ownershipDirty)return 0;
    // Pending driver uploads survive culled/hidden frames. Bound dirty tracking
    // by capacity; one block is 256 slots / 512 bytes, independent of write count.
    for(const range of this.ownership.updateRanges)for(let b=Math.floor(range.start/256);b<Math.ceil((range.start+range.count)/256);b++)this.ownershipBlocks[b]=1;
    this.ownership.clearUpdateRanges();let start=-1,bytes=0;
    for(let b=0;b<=this.ownershipBlocks.length;b++){
      if(b<this.ownershipBlocks.length&&this.ownershipBlocks[b]){if(start<0)start=b;this.ownershipBlocks[b]=0;}
      else if(start>=0){const first=start*256,count=Math.min(b*256,this.ownership.count)-first;this.ownership.addUpdateRange(first,count);bytes+=count*2;start=-1;}
    }
    this.ownership.needsUpdate=true;this.ownershipDirty=false;return bytes;
  }
  /** The caller prepares a complete alternate origin in bounded slices, then
   * changes the object origin and this attribute together before rendering. */
  replacePositions(prepared:Float32Array){
    if(prepared.length!==this.positions.array.length)throw new Error('Invalid forest rebase buffer');
    this.positions.array.set(prepared);this.positions.clearUpdateRanges();this.positions.addUpdateRange(0,prepared.length);this.positions.needsUpdate=true;
    this.staticDirty[0].clear();
    return prepared.byteLength;
  }
  dispose(){this.mesh.geometry.dispose();this.mesh.material.dispose();this.mesh.removeFromParent();}
}
