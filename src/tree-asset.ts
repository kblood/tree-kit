import * as THREE from 'three';
import {TreeInstancePasses,TreeInstanceRows} from './tree-instance-passes.ts';
import type {TreeBarkTexturePool,TreeBarkTextureLease} from './tree-bark-texture-pool.ts';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {installLeafTransmission,type LeafTransmissionOptions} from './tree-leaf-transmission.ts';
import {InstanceUpdateRanges} from './instance-update-ranges.ts';
import {installTreeForestCoverage} from './tree-forest-coverage.ts';
import {quantizeForestCoverage} from './forest-coverage.ts';
import {installTreeFoliageCoverageMipmaps,type InstalledTreeFoliageMipChain} from './tree-foliage-mips.ts';
import {installTreeFoliageSidecar,type TreeFoliageMipSidecar} from './tree-foliage-sidecar.ts';
import {calibrateTreeFoliageLodCutoffs,installTreeFoliageLodCutoff,type TreeFoliageLodCutoffs} from './tree-foliage-cutoff.ts';
import {calibrateTreeLodCardScale,type TreeCoverageMesh,type TreeLodCoverageCalibration} from './tree-lod-coverage.ts';
import {deriveTreeBaseColorStatistics,deriveTreeCanopyMetadata,type TreeCanopyProfile,type TreeCullingBounds,type TreeTrunkProfile} from './tree-canopy-profile.ts';
import {forestVariantEnvelope,forestVariantGLSL,forestVariantRadiusBound,forestVariantUniformData,FOREST_VARIANT_COUNT,type ForestStructuralVariant} from './tree-structural-variant.ts';
import {installForestFarAtlasCapture,FOREST_FAR_ATLAS_VERSION} from './forest-far-atlas.ts';
import {forestFamilyEnvelopeRadius,treeAllometryCardScale,treeAllometryGLSL,treeAllometryRadial,treeAllometryReference,
  TREE_ALLOMETRY_VERSION,TREE_FAMILY_ALLOMETRY_ENVELOPE,type TreeAllometryReference} from './tree-allometry.ts';

/** Experimental author-6 adapter. Assets are supplied explicitly; this does not
 * replace the canonical forest or invent a second species catalogue. */
export const TREE_REFERENCE_HEIGHT_M=16;
export const TREE_WIND_PERIOD_NS=7_000_000_000n;
/** Resolve a BigInt date directly into the deterministic tree animation cycle.
 * This mirrors the Kit's own period contract and does not depend on the Atlas
 * world-time adapter. */
export function treeWindPhase(dateNs:bigint){
  const remainder=((dateNs%TREE_WIND_PERIOD_NS)+TREE_WIND_PERIOD_NS)%TREE_WIND_PERIOD_NS;
  return Number(remainder)/Number(TREE_WIND_PERIOD_NS)*(2*Math.PI);
}

type GLBDocument={json:any;binary:Uint8Array};
function readGLB(buffer:ArrayBuffer):GLBDocument {
  const view=new DataView(buffer);
  if(buffer.byteLength<28||view.getUint32(0,true)!==0x46546c67||view.getUint32(4,true)!==2||view.getUint32(8,true)!==buffer.byteLength)throw new Error('Expected a complete glTF 2 GLB');
  const length=view.getUint32(12,true),start=20+length;
  if(view.getUint32(16,true)!==0x4e4f534a||start+8>buffer.byteLength||view.getUint32(start+4,true)!==0x004e4942||start+8+view.getUint32(start,true)!==buffer.byteLength)throw new Error('Expected JSON and embedded binary chunks');
  const json=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,length)));
  if(json.buffers?.length!==1||json.buffers[0].uri||json.extensionsRequired?.length)throw new Error('Only self-contained author-6 GLBs are supported');
  if(json.nodes?.length!==1||json.nodes[0].mesh!==0||['matrix','translation','rotation','scale'].some(k=>json.nodes[0][k])||json.meshes?.length!==1||json.meshes[0].primitives?.length!==2)throw new Error('Expected one untransformed two-material tree');
  if(json.materials?.length!==2||json.materials[0].name!=='MAT_AtlasBark'||json.materials[1].name!=='MAT_AtlasFoliage'||json.images?.length!==4)throw new Error('Expected author-6 bark and foliage');
  if((json.materials[0].alphaMode??'OPAQUE')!=='OPAQUE'||json.materials[1].alphaMode!=='MASK'||(json.materials[1].alphaCutoff??.5)<=0)throw new Error('Tree foliage requires alpha MASK with a positive cutoff');
  const formats:Record<string,string>={_WIND:'SCALAR',_BRANCH_LEVEL:'SCALAR',_LEAF_CENTER:'VEC3',_LEAF_PIVOT:'VEC3',POSITION:'VEC3',NORMAL:'VEC3',TEXCOORD_0:'VEC2',TANGENT:'VEC4'};
  for(const [index,p] of json.meshes[0].primitives.entries()){
    if(p.material!==index||p.mode!==undefined&&p.mode!==4||p.targets||Object.keys(p.attributes??{}).length!==8||!Object.keys(formats).every(k=>Number.isInteger(p.attributes?.[k])))throw new Error('Incomplete tree vertex contract');
    const count=json.accessors[p.attributes.POSITION]?.count;
    for(const [name,type] of Object.entries(formats)){
      const a=json.accessors[p.attributes[name]];
      if(!a||a.type!==type||a.componentType!==5126||a.normalized||a.sparse||!Number.isInteger(count)||count<1||a.count!==count)throw new Error(`Invalid tree accessor ${name}`);
    }
  }
  return {json,binary:new Uint8Array(buffer,start+8,view.getUint32(start,true))};
}
function imageBytes(doc:GLBDocument,index:number){
  const image=doc.json.images[index],view=doc.json.bufferViews[image.bufferView];
  if(image.uri||image.mimeType!=='image/png'||!view||view.buffer!==0||!Number.isInteger(view.byteLength)||view.byteLength<=0)throw new Error('Expected an embedded PNG');
  const start=view.byteOffset??0,end=start+view.byteLength;
  if(start<0||end>doc.binary.length)throw new Error('Image outside GLB binary');
  return doc.binary.subarray(start,end);
}
function bytesEqual(a:Uint8Array,b:Uint8Array){
  if(a.length!==b.length)return false;
  for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;
  return true;
}
/** Remove only a verified zero-padded suffix made exclusively from embedded
 * image bufferViews. Any interleaving or non-image bufferView uses the legacy
 * full binary path, keeping this a safe optional reduction. */
function compactTrailingImageViews(json:any,binary:Uint8Array){
  const views=json.bufferViews as Array<{buffer?:number;byteOffset?:number;byteLength:number}>|undefined;
  const images=json.images as Array<{bufferView?:number;uri?:string}>|undefined;
  if(!views?.length||!images?.length||json.buffers?.length!==1)return null;
  if(images.some(image=>image.uri||!Number.isInteger(image.bufferView)))return null;
  const imageIndices=new Set(images.map(image=>image.bufferView as number));
  if(imageIndices.size===0||[...imageIndices].some(index=>index<0||index>=views.length))return null;
  if(views.some(view=>view.buffer!==0||!Number.isInteger(view.byteLength)||view.byteLength<=0||
    view.byteOffset!==undefined&&(!Number.isInteger(view.byteOffset)||view.byteOffset<0)))return null;
  const endOf=(view:{byteOffset?:number;byteLength:number})=>(view.byteOffset??0)+view.byteLength;
  const geometryEnd=Math.max(0,...views.flatMap((view,index)=>imageIndices.has(index)?[]:[endOf(view)]));
  if(!Number.isInteger(geometryEnd)||geometryEnd<0||geometryEnd>binary.length)return null;
  const imageRanges=[...imageIndices].map(index=>{
    const view=views[index];
    return {index,start:view.byteOffset??0,end:endOf(view)};
  }).sort((a,b)=>a.start-b.start);
  if(imageRanges.some(range=>!Number.isInteger(range.start)||!Number.isInteger(range.end)||range.start<geometryEnd||range.end>binary.length))return null;
  let cursor=geometryEnd;
  for(const range of imageRanges){
    if(range.start<cursor||binary.subarray(cursor,range.start).some(byte=>byte!==0))return null;
    cursor=range.end;
  }
  if(binary.subarray(cursor).some(byte=>byte!==0))return null;
  const parserBinaryLength=(geometryEnd+3)&~3;
  if(parserBinaryLength>binary.length||binary.subarray(geometryEnd,parserBinaryLength).some(byte=>byte!==0))return null;
  const remap=new Map<number,number>();let next=0;
  for(let index=0;index<views.length;index++)if(!imageIndices.has(index))remap.set(index,next++);
  const compactJson=structuredClone(json);
  delete compactJson.images;delete compactJson.textures;delete compactJson.samplers;
  compactJson.bufferViews=compactJson.bufferViews.filter((_:unknown,index:number)=>!imageIndices.has(index));
  let validReferences=true;
  const updateReferences=(value:any):void=>{
    if(!validReferences||!value||typeof value!=='object')return;
    if(Array.isArray(value)){for(const item of value)updateReferences(item);return;}
    if(Number.isInteger(value.bufferView)){
      const mapped=remap.get(value.bufferView);
      if(mapped===undefined){validReferences=false;return;}
      value.bufferView=mapped;
    }
    for(const item of Object.values(value))updateReferences(item);
  };
  updateReferences(compactJson);
  if(!validReferences)return null;
  compactJson.buffers[0].byteLength=parserBinaryLength;
  return {json:compactJson,binaryLength:parserBinaryLength};
}
/** Check byte identity before sharing materials. LOD1 images are never decoded:
 * its parser receives texture-free material placeholders with stable indices. */
export function prepareTreeLODPair(lod0:ArrayBuffer,lod1:ArrayBuffer){
  const a=readGLB(lod0),b=readGLB(lod1);
  for(const key of ['materials','textures','samplers'])if(JSON.stringify(a.json[key])!==JSON.stringify(b.json[key]))throw new Error(`Tree LOD ${key} differ`);
  let embeddedTextureBytes=0;
  for(let i=0;i<4;i++){
    const x=imageBytes(a,i),y=imageBytes(b,i);embeddedTextureBytes+=x.length;
    if(!bytesEqual(x,y))throw new Error(`Tree LOD image ${i} differs`);
  }
  const compacted=compactTrailingImageViews(b.json,b.binary);
  const json=compacted?.json??structuredClone(b.json);
  json.materials=json.materials.map((m:any)=>({name:m.name}));delete json.images;delete json.textures;delete json.samplers;
  const parserBinaryLength=compacted?.binaryLength??b.binary.length;
  const text=new TextEncoder().encode(JSON.stringify(json)),length=(text.length+3)&~3;
  const buffer=new ArrayBuffer(28+length+parserBinaryLength),view=new DataView(buffer),bytes=new Uint8Array(buffer);
  view.setUint32(0,0x46546c67,true);view.setUint32(4,2,true);view.setUint32(8,buffer.byteLength,true);
  view.setUint32(12,length,true);view.setUint32(16,0x4e4f534a,true);bytes.fill(32,20,20+length);bytes.set(text,20);
  view.setUint32(20+length,parserBinaryLength,true);view.setUint32(24+length,0x004e4942,true);bytes.set(b.binary.subarray(0,parserBinaryLength),28+length);
  const foliageTexture=a.json.materials[1].pbrMetallicRoughness?.baseColorTexture?.index;
  const foliageImage=a.json.textures?.[foliageTexture]?.source;
  if(!Number.isInteger(foliageImage)||foliageImage<0||foliageImage>=4)throw new Error('Expected embedded foliage base-color image');
  const bark=a.json.materials[0],baseIndex=a.json.textures?.[bark.pbrMetallicRoughness?.baseColorTexture?.index]?.source,normalIndex=a.json.textures?.[bark.normalTexture?.index]?.source;
  return {lod1GeometryBuffer:buffer,embeddedTextureBytes,foliagePng:imageBytes(a,foliageImage),barkBasePng:Number.isInteger(baseIndex)?imageBytes(a,baseIndex):undefined,barkNormalPng:Number.isInteger(normalIndex)?imageBytes(a,normalIndex):undefined};
}

export type TreeInstanceAllometry={crownRatio:number;trunkRatio:number};
/** Family reference for the CPU oracle; without crown/card radii cards keep their authored size. */
type TreeOracleAllometry=TreeInstanceAllometry&{trunkRadiusM:number;crownRadiusM?:number;cardExtentM?:number};
const IDENTITY_ALLOMETRY:TreeInstanceAllometry=Object.freeze({crownRatio:1,trunkRatio:1});
function validInstanceAllometry(a:TreeInstanceAllometry){
  const E=TREE_FAMILY_ALLOMETRY_ENVELOPE;
  return !!a&&Number.isFinite(a.crownRatio)&&Number.isFinite(a.trunkRatio)&&a.crownRatio>=E.crownRatio[0]&&a.crownRatio<=E.crownRatio[1]&&
    a.trunkRatio>=E.trunkRatio[0]&&a.trunkRatio<=E.trunkRatio[1];
}
/** CPU reference for shader audits. Map skeleton/attachment coordinates through
 * the species allometry (radial trunk/crown ratios, then height scale), scale
 * every offset within a leaf card by the allometry card scale, then rotate rigidly. */
export function treeVertexMeters(position:THREE.Vector3,pivot:THREE.Vector3,leaf:boolean,heightM:number,windWeight:number,phase:number,instancePhase=0,
  allometry:TreeOracleAllometry={...IDENTITY_ALLOMETRY,trunkRadiusM:0}){
  const [minH,maxH]=TREE_FAMILY_ALLOMETRY_ENVELOPE.heightM;
  if(!Number.isFinite(heightM)||heightM<minH||heightM>maxH)throw new Error(`Detailed trees support rendered heights ${minH}–${maxH} m`);
  if(!validInstanceAllometry(allometry)||!Number.isFinite(allometry.trunkRadiusM)||allometry.trunkRadiusM<0)throw new Error('Invalid tree allometry');
  const s=heightM/TREE_REFERENCE_HEIGHT_M;
  const map=(p:THREE.Vector3)=>{const [x,z]=treeAllometryRadial(p.x,p.z,allometry.trunkRadiusM,allometry.crownRatio,allometry.trunkRatio);return new THREE.Vector3(x*s,p.y*s,z*s);};
  if(!leaf)return map(position);
  const reference=allometry.crownRadiusM!==undefined&&allometry.cardExtentM!==undefined?
    {trunkRadiusM:allometry.trunkRadiusM,crownRadiusM:allometry.crownRadiusM,cardExtentM:allometry.cardExtentM}:null;
  return position.clone().sub(pivot).multiplyScalar(treeAllometryCardScale(reference,heightM,allometry.crownRatio,allometry.trunkRatio))
    .applyAxisAngle(new THREE.Vector3(0,0,1),Math.sin(phase+instancePhase)*.12*windWeight).add(map(pivot));
}

const declarations=`
attribute float _wind, _branch_level;
attribute vec3 _leaf_pivot;
// x: rendered height / 16 m, y: wind phase, z/w: crown and trunk ratios.
attribute vec4 instanceTree;
// x: 0 = authored structure, k = bounded variant k-1. y: static LOD card scale.
attribute vec2 instanceTreeShape;
uniform float atlasTreePhase;
uniform vec4 atlasTreeVariantA[${FOREST_VARIANT_COUNT}],atlasTreeVariantB[${FOREST_VARIANT_COUNT}];
// Main-camera position in the batch frame and pixels per radian (0 disables).
uniform vec4 atlasTreeView;
// Representative card extent (m), target projected size (px), maximum scale.
uniform vec3 atlasTreeCards;
// Reference-skeleton trunk base radius separating trunk and crown ratios.
uniform float atlasTreeTrunkRadius;
// Allometry reference: trunk radius, p95 crown radius, card extent (m); zero keeps authored cards.
uniform vec3 atlasTreeAllometry;
${forestVariantGLSL}
${treeAllometryGLSL}
mat3 atlasLeafRotation(){
  float angle=sin(atlasTreePhase+instanceTree.y)*.12*_wind;
  float c=cos(angle),s=sin(angle);
  return mat3(c,s,0.,-s,c,0.,0.,0.,1.);
}
vec4 atlasTreeVariantParameterA(){int i=int(instanceTreeShape.x-.5);return instanceTreeShape.x>.5?atlasTreeVariantA[i]:vec4(1,1,0,0);}
vec4 atlasTreeVariantParameterB(){int i=int(instanceTreeShape.x-.5);return instanceTreeShape.x>.5?atlasTreeVariantB[i]:vec4(0,0,1,0);}
// Tier rotation follows the reference skeleton height, so normals and leaves
// turn with the branch that carries them.
float atlasTreeTwist(){return atlasTreeVariantParameterB().x*clamp((_branch_level>3.5?_leaf_pivot.y:position.y)/${TREE_REFERENCE_HEIGHT_M}.0,0.0,1.0);}
// LOD card scale, allometry card scale (foliage clumps follow the crown's side
// area) and bounded distance compensation for sub-pixel cards.
float atlasTreeCardScale(){
  float allometryCard=treeAllometryCardScale(instanceTree.x*${TREE_REFERENCE_HEIGHT_M}.0,instanceTree.zw,atlasTreeAllometry);
  float s=max(1.0,instanceTreeShape.y);
  if(atlasTreeView.w>0.0&&atlasTreeCards.z>1.0){
    #ifdef USE_INSTANCING
      vec3 root=instanceMatrix[3].xyz;float unitsPerMetre=length(instanceMatrix[0].xyz);
    #else
      vec3 root=vec3(0);float unitsPerMetre=1.0;
    #endif
    float distanceM=length(atlasTreeView.xyz-root)/max(unitsPerMetre,1e-30);
    float pixels=atlasTreeCards.x*allometryCard*s*atlasTreeView.w/max(distanceM,1e-3);
    s*=clamp(sqrt(atlasTreeCards.y/max(pixels,1e-3)),1.0,atlasTreeCards.z);
  }
  return s*allometryCard;
}
`;
type TreeShaderState={phase:{value:number};trunkRadius:{value:number};allometry:{value:THREE.Vector3};variantA:{value:THREE.Vector4[]};variantB:{value:THREE.Vector4[]};view:{value:THREE.Vector4};cards:{value:THREE.Vector3}};
function deform(material:THREE.Material,state:TreeShaderState){
  material.onBeforeCompile=shader=>{
    Object.assign(shader.uniforms,{atlasTreePhase:state.phase,atlasTreeTrunkRadius:state.trunkRadius,atlasTreeAllometry:state.allometry,atlasTreeVariantA:state.variantA,atlasTreeVariantB:state.variantB,atlasTreeView:state.view,atlasTreeCards:state.cards});
    shader.vertexShader=declarations+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <beginnormal_vertex>',`#include <beginnormal_vertex>
      if(_branch_level<=3.5){
        // Bark follows the horizontal allometry; rigid leaf cards do not.
        float allometryK=treeAllometryHorizontalRatio(position.xz,atlasTreeTrunkRadius,instanceTree.zw);
        objectNormal=normalize(vec3(objectNormal.x/allometryK,objectNormal.y,objectNormal.z/allometryK));
        #ifdef USE_TANGENT
        objectTangent.xyz=normalize(vec3(objectTangent.x*allometryK,objectTangent.y,objectTangent.z*allometryK));
        #endif
      }
      if(_branch_level>3.5){objectNormal=atlasLeafRotation()*objectNormal;
        #ifdef USE_TANGENT
        objectTangent=atlasLeafRotation()*objectTangent;
        #endif
      }
      objectNormal=atlasVariantRotate(objectNormal,atlasTreeTwist());
      #ifdef USE_TANGENT
      objectTangent.xyz=atlasVariantRotate(objectTangent.xyz,atlasTreeTwist());
      #endif`);
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
      {
        vec4 variantA=atlasTreeVariantParameterA(),variantB=atlasTreeVariantParameterB();
        float treeHeightM=instanceTree.x*${TREE_REFERENCE_HEIGHT_M}.0;
        if(_branch_level>3.5){
          // Card offsets follow the allometry card scale; removed clumps collapse in every pass.
          float cardScale=atlasVariantRemovesLeaf(_leaf_pivot,instanceTreeShape.x,variantB)?0.0:atlasTreeCardScale();
          transformed=atlasVariantPoint(treeAllometryPoint(_leaf_pivot,atlasTreeTrunkRadius,instanceTree.zw)*instanceTree.x,treeHeightM,variantA,variantB)+
            atlasVariantRotate(atlasLeafRotation()*(position-_leaf_pivot),atlasTreeTwist())*cardScale;
        }else transformed=atlasVariantPoint(treeAllometryPoint(position,atlasTreeTrunkRadius,instanceTree.zw)*instanceTree.x,treeHeightM,variantA,variantB);
      }`);
  };
  material.customProgramCacheKey=()=>`atlas-tree-physical-3/${TREE_ALLOMETRY_VERSION}`;
}
export type TreeAssetFamily=Awaited<ReturnType<typeof loadTreeAssetFamily>>;
export type TreeCanopyPresentation={
  /** Eligible only when the caller supplied the validated offline foliage sidecar. */
  enabled:boolean;
  lod0Profile:TreeCanopyProfile;
  lod1Profile:TreeCanopyProfile;
  /** Origin-centred conservative union for both actual LOD vertex sets. */
  conservativeBounds:TreeCullingBounds;
  barkLinearRgb:[number,number,number];
  foliageLinearRgb:[number,number,number];
  alphaCutoff:number;
  /** Fraction of foliage texture pixels meeting cutoff; not whole-crown opacity. */
  baseCoverage:number;
  /** Mean opaque projected leaf area per LOD0 band (0.5 × one-sided card area × texture coverage), m². */
  foliageProjectedAreaM2:[number,number,number,number];
  /** Measured branch-level-0 trunk at the 16 m reference height, or null. */
  trunk:TreeTrunkProfile|null;
  /** The bounded pool also used by the detailed batches; empty for authored structure only. */
  structuralVariants:readonly ForestStructuralVariant[];
  /** Card scale applied to the reduced LOD1 foliage (area-preserving or silhouette-matched). */
  lod1CardScale:number;
  /** Reference measurements for species allometry; null keeps the family out of rendering. */
  allometry:TreeAllometryReference|null;
};
export type TreeCardCompensation={targetPixels:number;maxScale:number};
export type TreeAssetOptions={sharedBarkTextures?:TreeBarkTexturePool;foliageCoverage?:'mask'|'hash';foliageMipmaps?:boolean;foliageMipSidecar?:TreeFoliageMipSidecar;leafTransmission?:LeafTransmissionOptions;forestCoverage?:boolean;
  /** Atlas atmosphere adapter; the Kit never resolves planetary scene state. */
  attachLocalAerial?:(mesh:THREE.Mesh)=>void;
  /** Bounded structural pool for this family. Batches select a member per slot. */
  structuralVariants?:readonly ForestStructuralVariant[];
  /** Enlarge reduced LOD1 cards so its total leaf area matches LOD0. */
  areaPreservingLod?:boolean;
  /** Instead match LOD0's measured projected opaque area, bounded above by the
   * leaf-area scale. Requires areaPreservingLod. */
  silhouetteMatchedLod?:boolean;
  /** Distance-driven card growth when cards approach pixel size. */
  cardCompensation?:TreeCardCompensation;
  /** Replace the fixed MASK cutoff by a per-mip-level cutoff that keeps the
   * base level's coverage under trilinear filtering (colour, shadow and far
   * atlas capture passes alike). Requires coverage mips and MASK foliage. */
  foliageLodCutoff?:boolean};

/** Area-preserving scale for the reduced foliage LOD. Cards are metric, so the
 * leaf-area ratio of the two actual LOD meshes fixes it; bounded to [1,3]. */
export function treeLodCardScale(lod0:TreeCanopyProfile,lod1:TreeCanopyProfile){
  const area=(profile:TreeCanopyProfile)=>profile.bands.reduce((n,band)=>n+(band.leafAreaM2??0),0);
  const a0=area(lod0),a1=area(lod1);
  if(!Number.isFinite(a0)||!Number.isFinite(a1)||a0<=0||a1<=0)return 1;
  return Math.min(3,Math.max(1,Math.sqrt(a0/a1)));
}
export async function loadTreeAssetFamily(lod0:ArrayBuffer,lod1:ArrayBuffer,options:TreeAssetOptions={}){
  if(options.foliageCoverage!==undefined&&!['mask','hash'].includes(options.foliageCoverage))throw new Error('Unsupported foliage coverage mode');
  if(options.forestCoverage!==undefined&&typeof options.forestCoverage!=='boolean')throw new Error('Invalid forest coverage option');
  if(options.foliageMipmaps!==undefined&&typeof options.foliageMipmaps!=='boolean')throw new Error('Invalid foliage mip option');
  if(options.foliageMipmaps&&options.foliageMipSidecar)throw new Error('Choose offline or runtime foliage mips, not both');
  if(options.silhouetteMatchedLod&&!options.areaPreservingLod)throw new Error('Silhouette-matched LOD requires the area-preserving bound');
  if(options.foliageLodCutoff!==undefined&&typeof options.foliageLodCutoff!=='boolean')throw new Error('Invalid foliage LOD cutoff option');
  if(options.foliageLodCutoff&&(!(options.foliageMipmaps||options.foliageMipSidecar)||options.foliageCoverage==='hash'))
    throw new Error('Foliage LOD cutoff requires coverage mips and MASK foliage');
  const cards=options.cardCompensation;
  if(cards!==undefined&&(!cards||!Number.isFinite(cards.targetPixels)||cards.targetPixels<=0||cards.targetPixels>64||!Number.isFinite(cards.maxScale)||cards.maxScale<1||cards.maxScale>2))
    throw new Error('Invalid tree card compensation');
  const variants=options.structuralVariants??[];
  const variantData=forestVariantUniformData(variants);
  const prepared=prepareTreeLODPair(lod0,lod1),loader=new GLTFLoader();
  const loaded:THREE.Group[]=[];
  const textures=new Set<THREE.Texture>(),materials=new Set<THREE.Material>(),geometries=new Set<THREE.BufferGeometry>();
  const barkLeases:TreeBarkTextureLease[]=[],leasedTextures=new Set<THREE.Texture>();
  let foliageMipChain:InstalledTreeFoliageMipChain|null=null,foliageMipSetupMs=0,foliageMipPayloadBytes=0;
  function collect(group:THREE.Group){group.traverse(o=>{
    if(!(o instanceof THREE.Mesh))return;
    geometries.add(o.geometry);
    for(const m of Array.isArray(o.material)?o.material:[o.material]){
      materials.add(m);for(const value of Object.values(m))if(value instanceof THREE.Texture)textures.add(value);
    }
  });}
  function dispose(){foliageMipChain?.dispose();for(const g of geometries)g.dispose();for(const m of materials)m.dispose();for(const lease of barkLeases.splice(0))lease.release();for(const t of textures){if(leasedTextures.has(t))continue;t.dispose();if(typeof ImageBitmap!=='undefined'&&t.image instanceof ImageBitmap)t.image.close();}}
  function texturePixels(texture:THREE.Texture):Uint8ClampedArray{
    const image=texture.image as CanvasImageSource&{width?:number;height?:number};
    const width=image?.width,height=image?.height;
    if(!Number.isInteger(width)||!Number.isInteger(height)||width!<=0||height!<=0)throw new Error('Tree base-color image has invalid dimensions');
    let canvas:OffscreenCanvas|HTMLCanvasElement,context:OffscreenCanvasRenderingContext2D|CanvasRenderingContext2D|null;
    if(typeof OffscreenCanvas!=='undefined'){
      canvas=new OffscreenCanvas(width!,height!);context=canvas.getContext('2d',{willReadFrequently:true});
    }else if(typeof document!=='undefined'){
      const element=document.createElement('canvas');element.width=width!;element.height=height!;canvas=element;
      context=element.getContext('2d',{willReadFrequently:true});
    }else throw new Error('Tree base-color statistics require a 2D canvas');
    if(!context)throw new Error('Could not create tree base-color statistics canvas');
    context.drawImage(image,0,0,width!,height!);
    // getImageData returns straight-alpha sRGB bytes in pixel row order. This
    // temporary CPU copy is only used for once-per-load statistics.
    return context.getImageData(0,0,width!,height!).data;
  }
  function textureStatistics(material:THREE.MeshStandardMaterial,cutoff:number,pixels?:Uint8ClampedArray){
    if(!material.map)throw new Error(`Tree material ${material.name} has no base-color texture`);
    return deriveTreeBaseColorStatistics(pixels??texturePixels(material.map),[material.color.r,material.color.g,material.color.b,material.opacity],cutoff);
  }
  function coverageMesh(meshes:THREE.Mesh[]):TreeCoverageMesh{
    const part=(geometry:THREE.BufferGeometry)=>{
      const copy=(name:string,size:number)=>{
        const a=geometry.getAttribute(name);if(!a)return null;
        const out=new Float32Array(a.count*size);
        for(let i=0;i<a.count;i++)for(let c=0;c<size;c++)out[i*size+c]=a.getComponent(i,c);
        return out;
      };
      const position=copy('position',3);if(!position)throw new Error('Tree geometry has no positions');
      return {position,uv:copy('uv',2),pivot:copy('_leaf_pivot',3),level:copy('_branch_level',1),index:geometry.index?geometry.index.array:null};
    };
    return {bark:part(meshes[0]!.geometry),foliage:part(meshes[1]!.geometry)};
  }
  try {
    for(const bytes of [lod0,prepared.lod1GeometryBuffer]){const gltf=await loader.parseAsync(bytes,'');loaded.push(gltf.scene);collect(gltf.scene);}
    const lods=loaded.map(group=>{
      const meshes:THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>[]=[];
      group.traverse(o=>{if(o instanceof THREE.Mesh)meshes.push(o as THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>);});
      if(meshes.length!==2||meshes.some(m=>Array.isArray(m.material)))throw new Error('Expected two tree primitives');
      return meshes.sort((a,b)=>a.material.name.localeCompare(b.material.name));
    });
    for(let i=0;i<2;i++){lods[1][i].material.dispose();materials.delete(lods[1][i].material);lods[1][i].material=lods[0][i].material;}
    if(options.sharedBarkTextures){
      const bark=lods[0][0].material;
      for(const [property,png,role] of [['map',prepared.barkBasePng,'bark-base-color'],['normalMap',prepared.barkNormalPng,'bark-normal']] as const){
        const original=bark[property];if(!original||!png)throw new Error('Shared bark requires both authored maps');
        const lease=await options.sharedBarkTextures.acquire(original,png,role);barkLeases.push(lease);textures.delete(original);bark[property]=lease.texture;textures.add(lease.texture);leasedTextures.add(lease.texture);
      }
    }
    if(options.foliageMipmaps||options.foliageMipSidecar){
      const foliage=lods[0][1].material;
      if(!foliage.map)throw new Error('Foliage coverage mips require a base-color map');
      const started=performance.now();
      if(options.foliageMipSidecar){
        const installed=await installTreeFoliageSidecar(foliage.map,options.foliageMipSidecar,prepared.foliagePng,foliage.alphaTest);
        foliageMipChain=installed;foliageMipPayloadBytes=installed.payloadBytes;
      }else foliageMipChain=await installTreeFoliageCoverageMipmaps(foliage.map,{alphaCutoff:foliage.alphaTest});
      foliageMipSetupMs=performance.now()-started;
    }
    const alphaCutoff=lods[0][1].material.alphaTest;
    // Explicit experiment: hashing samples fractional mip coverage instead of
    // discarding every leaf texel below the GLB's fixed MASK cutoff. Preserve
    // the imported MASK path by default, including historical captures.
    if(options.foliageCoverage==='hash'){
      lods[0][1].material.alphaTest=0;lods[0][1].material.alphaHash=true;
    }
    // Calibrate once against the uploaded chain, then drop the level copies.
    let foliageLodCutoff:(TreeFoliageLodCutoffs&{setupMs:number})|null=null;
    let basePixels:Uint8ClampedArray|null=null;
    if(options.foliageLodCutoff){
      const levels=foliageMipChain?.levels,map=lods[0][1].material.map!;
      if(!levels||!foliageMipChain)throw new Error('Foliage LOD cutoff needs the installed mip levels');
      const started=performance.now(),image=map.image as {width:number;height:number};
      basePixels=texturePixels(map);
      foliageLodCutoff={...calibrateTreeFoliageLodCutoffs([{width:image.width,height:image.height,data:basePixels},...levels],
        foliageMipChain.baseCoverage,alphaCutoff),setupMs:0};
      foliageLodCutoff.setupMs=performance.now()-started;
    }
    if(foliageMipChain)delete foliageMipChain.levels;
    const phase={value:0};
    const vectors=(offset:number)=>Array.from({length:FOREST_VARIANT_COUNT},(_,i)=>new THREE.Vector4().fromArray(variantData,i*8+offset));
    const shaderState:TreeShaderState={phase,trunkRadius:{value:0},allometry:{value:new THREE.Vector3()},variantA:{value:vectors(0)},variantB:{value:vectors(4)},
      view:{value:new THREE.Vector4()},cards:{value:new THREE.Vector3(1,1,1)}};
    const viewEye=new THREE.Vector3(),viewInverse=new THREE.Matrix4(),viewport=new THREE.Vector4();
    for(const material of materials)deform(material,shaderState);
    if(options.forestCoverage)for(const material of materials)installTreeForestCoverage(material);
    if(foliageLodCutoff)installTreeFoliageLodCutoff(lods[0][1].material,foliageLodCutoff);
    if(options.attachLocalAerial){
      // Both LOD batches have identity transforms in the forest's retained
      // frame. Their shared materials therefore use identical air uniforms.
      // Install before transmission, which guards the final material hook.
      for(const mesh of lods[0])options.attachLocalAerial(mesh);
    }
    // Keep LOD profile samples separate so the far representation follows the
    // actual reduced geometry rather than a merged near/far percentile.
    const lod0Metadata=deriveTreeCanopyMetadata(lods[0].map(mesh=>mesh.geometry));
    const lod1Metadata=deriveTreeCanopyMetadata(lods[1].map(mesh=>mesh.geometry));
    const foliage=lods[0][1].material;
    if(!foliage.map)throw new Error('Tree foliage has no base-color texture');
    const foliagePixels=basePixels??texturePixels(foliage.map);
    const areaCardScale=options.areaPreservingLod?treeLodCardScale(lod0Metadata.profile,lod1Metadata.profile):1;
    // Leaf-area equality over-inflates the reduced crown; measure silhouettes.
    let lodCoverage:TreeLodCoverageCalibration|null=null;
    if(options.silhouetteMatchedLod){
      const image=foliage.map.image as {width:number;height:number};
      lodCoverage=calibrateTreeLodCardScale(coverageMesh(lods[0]),coverageMesh(lods[1]),
        {width:image.width,height:image.height,rgba:foliagePixels,cutoffByte:Math.ceil(alphaCutoff*255)},areaCardScale);
    }
    const lod1CardScale=lodCoverage?lodCoverage.cardScale:areaCardScale;
    const compensationMax=cards?.maxScale??1;
    if(cards)shaderState.cards.value.set(lod0Metadata.profile.cardExtentM??lod0Metadata.profile.maxLeafOffsetM,cards.targetPixels,cards.maxScale);
    const authoredRadius=Math.max(lod0Metadata.cullingBounds.radiusM,lod1Metadata.cullingBounds.radiusM);
    const maxLeafOffsetM=Math.max(lod0Metadata.profile.maxLeafOffsetM,lod1Metadata.profile.maxLeafOffsetM);
    // Variants, LOD card scale and distance growth all enlarge the vertex set.
    const cardScaleMax=Math.max(1,lod1CardScale)*compensationMax;
    // A family without measured trunk/crown references cannot map species
    // dimensions; it stays loaded but every tree records a legacy fallback.
    const envelope=forestVariantEnvelope(variants);
    let allometry:TreeAllometryReference|null=null;
    try{allometry=treeAllometryReference(lod0Metadata.profile,lod1Metadata.profile,{variantScale:envelope.scale,variantLeanFraction:envelope.leanFraction,cardScaleMax});}
    catch{allometry=null;}
    shaderState.trunkRadius.value=allometry?.trunkRadiusM??0;
    shaderState.allometry.value.set(allometry?.trunkRadiusM??0,allometry?.crownRadiusM??0,allometry?.cardExtentM??0);
    const identityRadius=variants.length||cardScaleMax>1?forestVariantRadiusBound(variants,authoredRadius,maxLeafOffsetM,cardScaleMax):authoredRadius;
    // Encloses every rendered height, crown/trunk ratio, variant and card scale.
    const conservativeBounds:TreeCullingBounds={...lod0Metadata.cullingBounds,
      radiusM:Math.max(identityRadius,allometry?forestFamilyEnvelopeRadius(allometry):0)};
    const barkStatistics=textureStatistics(lods[0][0].material,0);
    const foliageStatistics=textureStatistics(foliage,alphaCutoff,foliagePixels);
    // Beer-Lambert reference density for distant crowns: randomly oriented
    // cards project half their one-sided area; the atlas cutoff removes gaps.
    const foliageProjectedAreaM2=lod0Metadata.profile.bands.map(band=>.5*(band.leafAreaM2??0)*foliageStatistics.baseCoverage) as [number,number,number,number];
    const canopyPresentation:TreeCanopyPresentation={enabled:!!options.foliageMipSidecar,
      lod0Profile:lod0Metadata.profile,lod1Profile:lod1Metadata.profile,conservativeBounds,
      barkLinearRgb:barkStatistics.linearRgb,foliageLinearRgb:foliageStatistics.linearRgb,
      alphaCutoff,baseCoverage:foliageStatistics.baseCoverage,foliageProjectedAreaM2,
      trunk:lod0Metadata.profile.trunk??null,structuralVariants:variants,lod1CardScale,allometry};
    const maxRadiusM=conservativeBounds.radiusM;
    // Compose only after wind. Both LODs share this one foliage material;
    // bark and all custom shadow materials retain their previous lighting.
    const leafTransmission=options.leafTransmission===undefined?null:installLeafTransmission(lods[0][1].material,options.leafTransmission);
    let disposed=false,activeBatches=0;
    return {
      lods,textures,leafTransmission,maxRadiusM,canopyPresentation,forestCoverage:!!options.forestCoverage,embeddedTextureBytes:prepared.embeddedTextureBytes,
      foliageMipmaps:foliageMipChain?{source:options.foliageMipSidecar?'offline-sidecar':'runtime-build',payloadBytes:foliageMipPayloadBytes,
        setupMs:foliageMipSetupMs,levels:foliageMipChain.report,baseCoverage:foliageMipChain.baseCoverage}:null,
      structuralVariantCount:variants.length,lod1CardScale,lodCoverage,foliageLodCutoff,cardCompensation:cards?{...cards,cardExtentM:shaderState.cards.value.x}:null,
      setDate(date:bigint){leafTransmission?.assertInstalled();phase.value=treeWindPhase(date);},
      /** Last main-camera state used by distance card growth; shadow passes reuse it. */
      viewState(){return shaderState.view.value.clone();},
      createBatch(lod:0|1,capacity:number){
        if(disposed)throw new Error('Tree family is disposed');
        if(!Number.isInteger(capacity)||capacity<1||capacity>4096)throw new Error('Invalid tree capacity');
        const treeData=new Float32Array(capacity*4);
        for(let i=0;i<capacity;i++)treeData.set([1,0,1,1],i*4);
        const group=new THREE.Group(),tree=new THREE.InstancedBufferAttribute(treeData,4).setUsage(THREE.DynamicDrawUsage);
        // Three clears ranges after bufferSubData, but not initial bufferData.
        // Clear only once the GPU has consumed this owned attribute, including
        // its first upload; hidden batches keep their pending ranges intact.
        tree.onUpload(()=>tree.clearUpdateRanges());
        const treeUpdates=new InstanceUpdateRanges();
        // Variant code per slot plus this LOD's constant area-preserving card scale.
        const lodScale=lod===1?lod1CardScale:1,shapeData=new Float32Array(capacity*2);
        for(let i=0;i<capacity;i++)shapeData[i*2+1]=lodScale;
        const shape=new THREE.InstancedBufferAttribute(shapeData,2).setUsage(THREE.DynamicDrawUsage);
        shape.onUpload(()=>shape.clearUpdateRanges());
        const shapeUpdates=new InstanceUpdateRanges();
        const forest=options.forestCoverage?new THREE.InstancedBufferAttribute(new Float32Array(capacity*2),2).setUsage(THREE.DynamicDrawUsage):null;
        const forestUpdates=new InstanceUpdateRanges();
        if(forest){
          for(let i=0;i<capacity;i++)forest.setXY(i,1,0);
          forest.onUpload(()=>forest.clearUpdateRanges());
        }
        const matrixUpdates=[new InstanceUpdateRanges(),new InstanceUpdateRanges()];
        const colorUpdates=[new InstanceUpdateRanges(),new InstanceUpdateRanges()];
        const meshes=lods[lod].map((source,part)=>{
          const geometry=source.geometry.clone();geometry.setAttribute('instanceTree',tree);geometry.setAttribute('instanceTreeShape',shape);
          if(forest)geometry.setAttribute('instanceForest',forest);
          const mesh=new THREE.InstancedMesh(geometry,source.material,capacity);mesh.count=0;
          const inherited=options.attachLocalAerial?lods[0][part].onBeforeRender:mesh.onBeforeRender;
          mesh.onBeforeRender=(renderer,scene,camera,geometry,material,group)=>{
            inherited.call(mesh,renderer,scene,camera,geometry,material,group);
            // Every batch of a family shares one frame, so any submitted batch
            // can publish the camera for the shared card-growth uniform.
            // Shadow passes call this with the light camera; they reuse the main
            // camera's state so casters match the cards they shadow.
            if(!cards||material===mesh.customDepthMaterial||material===mesh.customDistanceMaterial)return;
            const view=shaderState.view.value;
            viewEye.setFromMatrixPosition(camera.matrixWorld);viewInverse.copy(mesh.matrixWorld).invert();viewEye.applyMatrix4(viewInverse);
            renderer.getCurrentViewport(viewport);
            const perspective=(camera as THREE.PerspectiveCamera).isPerspectiveCamera===true;
            view.set(viewEye.x,viewEye.y,viewEye.z,perspective?Math.abs(camera.projectionMatrix.elements[5])*viewport.w/2:0);
          };
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.castShadow=true;mesh.receiveShadow=true;
          mesh.instanceColor=new THREE.InstancedBufferAttribute(new Float32Array(capacity*3).fill(1),3).setUsage(THREE.DynamicDrawUsage);
          mesh.instanceMatrix.onUpload(()=>mesh.instanceMatrix.clearUpdateRanges());
          mesh.instanceColor.onUpload(()=>mesh.instanceColor!.clearUpdateRanges());
          // Caller can install conservative curved-world bounds after integration.
          // Shader scale/wind invalidates Three's unmodified geometry bounds.
          mesh.frustumCulled=false;
          const common={map:source.material.map,alphaTest:source.material.alphaTest,alphaHash:source.material.alphaHash,side:source.material.side};
          mesh.customDepthMaterial=new THREE.MeshDepthMaterial({...common,depthPacking:THREE.RGBADepthPacking});
          mesh.customDistanceMaterial=new THREE.MeshDistanceMaterial(common);
          deform(mesh.customDepthMaterial,shaderState);deform(mesh.customDistanceMaterial,shaderState);
          if(options.forestCoverage){installTreeForestCoverage(mesh.customDepthMaterial);installTreeForestCoverage(mesh.customDistanceMaterial);}
          if(foliageLodCutoff&&part===1){installTreeFoliageLodCutoff(mesh.customDepthMaterial,foliageLodCutoff);installTreeFoliageLodCutoff(mesh.customDistanceMaterial,foliageLodCutoff);}
          group.add(mesh);return mesh;
        });
        const passes=new TreeInstancePasses(meshes);
        const rows=new TreeInstanceRows([tree,shape,...(forest?[forest]:[]),...meshes.flatMap(mesh=>[mesh.instanceMatrix,mesh.instanceColor!])]);
        activeBatches++;let batchDisposed=false;
        return {group,meshes,
          setCount(count:number){
            passes.setCount(count);
          },
          setCameraCount(count:number){passes.setCameraCount(count);},
          setViewCameras(cameras:readonly THREE.Camera[]){passes.setViewCameras(cameras);},
          passCounts(){return {camera:passes.cameraCount,shadow:passes.initializedCount};},
          swapInstances(a:number,b:number){if(batchDisposed)throw new Error('Tree batch is disposed');rows.swap(a,b,passes.initializedCount);},
          /** Matrix contains yaw/translation and metres-to-scene-units only.
           * Rendered height and crown/trunk ratios are applied in the shader so
           * leaves retain their size. `variant` 0 keeps the authored structure;
           * k selects pool member k-1. */
          setInstance(index:number,matrix:THREE.Matrix4,heightM:number,phaseOffset=0,variant=0,allometry:TreeInstanceAllometry=IDENTITY_ALLOMETRY){
            const [minH,maxH]=TREE_FAMILY_ALLOMETRY_ENVELOPE.heightM;
            if(batchDisposed||!Number.isInteger(index)||index<0||index>=capacity||index>passes.initializedCount||!Number.isFinite(heightM)||heightM<minH||heightM>maxH||!Number.isFinite(phaseOffset)||matrix.elements.some(x=>!Number.isFinite(x)))throw new Error('Invalid tree instance or gap in initialized slots');
            if(!validInstanceAllometry(allometry)||!canopyPresentation.allometry&&(allometry.crownRatio!==1||allometry.trunkRatio!==1))throw new Error('Tree allometry is outside the family envelope');
            if(!Number.isInteger(variant)||variant<0||variant>variants.length)throw new Error('Tree structural variant is outside the loaded pool');
            const e=matrix.elements,a=new THREE.Vector3(e[0],e[1],e[2]),b=new THREE.Vector3(e[4],e[5],e[6]),c=new THREE.Vector3(e[8],e[9],e[10]);
            const scale2=a.lengthSq(),tolerance=scale2*1e-6;
            if(!Number.isFinite(scale2)||scale2<=0||Math.abs(b.lengthSq()-scale2)>tolerance||Math.abs(c.lengthSq()-scale2)>tolerance||Math.abs(a.dot(b))>tolerance||Math.abs(a.dot(c))>tolerance||Math.abs(b.dot(c))>tolerance||matrix.determinant()<=0||e[3]!==0||e[7]!==0||e[11]!==0||e[15]!==1)throw new Error('Tree matrix requires rotation and positive uniform scene-unit scale');
            // Phase stays representable as Float32 even for a caller's very
            // large finite offset; the absolute universe date stays BigInt.
            const tau=2*Math.PI;phaseOffset=((phaseOffset%tau)+tau)%tau;
            const scale=Math.fround(heightM/TREE_REFERENCE_HEIGHT_M),offset=Math.fround(phaseOffset);
            const crown=Math.fround(allometry.crownRatio),trunk=Math.fround(allometry.trunkRatio);
            const newSlot=index===passes.initializedCount;
            if(newSlot&&forest&&(forest.getX(index)!==1||forest.getY(index)!==0)){
              forest.setXY(index,1,0);forestUpdates.include(index,2);forestUpdates.flush(forest);
            }
            if(tree.getX(index)!==scale||tree.getY(index)!==offset||tree.getZ(index)!==crown||tree.getW(index)!==trunk){
              tree.setXYZW(index,scale,offset,crown,trunk);treeUpdates.include(index,4);treeUpdates.flush(tree);
            }
            if(shape.getX(index)!==variant){shape.setX(index,variant);shapeUpdates.include(index,2);shapeUpdates.flush(shape);}
            for(const [part,mesh] of meshes.entries()){
              const color=mesh.instanceColor!;
              if(newSlot&&(color.getX(index)!==1||color.getY(index)!==1||color.getZ(index)!==1)){
                color.setXYZ(index,1,1,1);colorUpdates[part].include(index,3);colorUpdates[part].flush(color);
              }
              const base=index*16,values=mesh.instanceMatrix.array;
              if(matrix.elements.some((value,component)=>values[base+component]!==Math.fround(value))){
                mesh.setMatrixAt(index,matrix);matrixUpdates[part].include(index,16);matrixUpdates[part].flush(mesh.instanceMatrix);
              }
            }
            passes.grow(Math.max(passes.initializedCount,index+1));
          },
          /** Linear RGB multipliers over the authored bark and leaf textures.
           * Each part keeps its shared material; only this slot's color changes.
           * Fresh or re-grown slots are white. Call when a retained slot changes tree identity;
           * transform/rebase updates deliberately retain its current colors. */
          setAppearance(index:number,bark:readonly[number,number,number],foliage:readonly[number,number,number]){
            const colors=[bark,foliage];
            if(batchDisposed||!Number.isInteger(index)||index<0||index>=passes.initializedCount||colors.some(color=>!Array.isArray(color)||color.length!==3||[0,1,2].some(i=>!Number.isFinite(color[i])||color[i]<0||color[i]>2)))throw new Error('Tree appearance requires an initialized slot and linear RGB multipliers in [0,2]');
            for(const [part,mesh] of meshes.entries()){
              const attribute=mesh.instanceColor!,color=colors[part],base=index*3;
              if(color.some((value,component)=>attribute.array[base+component]!==Math.fround(value))){
                attribute.setXYZ(index,...color);colorUpdates[part].include(index,3);colorUpdates[part].flush(attribute);
              }
            }
          },
          setCoverage(index:number,coverage:number,seed:number){
            if(batchDisposed||!forest||!Number.isInteger(index)||index<0||index>=passes.initializedCount||!Number.isFinite(coverage)||coverage<0||coverage>1||!Number.isInteger(seed)||seed<0||seed>255)throw new Error('Invalid canonical forest coverage');
            const value=quantizeForestCoverage(coverage)/256;
            if(forest.getX(index)!==value||forest.getY(index)!==seed){forest.setXY(index,value,seed);forestUpdates.include(index,2);forestUpdates.flush(forest);}
          },
          dispose(){if(batchDisposed)return;batchDisposed=true;passes.dispose();activeBatches--;for(const mesh of meshes){mesh.geometry.dispose();mesh.customDepthMaterial?.dispose();mesh.customDistanceMaterial?.dispose();mesh.dispose();}group.clear();group.removeFromParent();},
        };
      },
      /** Capture-only batch for the far atlas. Cloned materials share this
       * family's textures and variant pool and run the same deform transform
       * at rest wind with distance card growth disabled. Pass 0 writes linear
       * albedo with unit coverage; pass 1 writes the capture-view normal xy,
       * depth from the capture plane (in radii) and the leaf fraction. */
      createCaptureBatch(lod:0|1,count:number){
        if(disposed)throw new Error('Tree family is disposed');
        if(!Number.isInteger(count)||count<1||count>64)throw new Error('Invalid capture batch size');
        const pass={value:0},frame={value:new THREE.Vector2(1,1)};
        const state:TreeShaderState={phase:{value:0},trunkRadius:shaderState.trunkRadius,allometry:shaderState.allometry,variantA:shaderState.variantA,variantB:shaderState.variantB,
          view:{value:new THREE.Vector4()},cards:shaderState.cards};
        // Atlas members are captured at the 16 m reference with authored proportions.
        const tree=new THREE.InstancedBufferAttribute(new Float32Array(count*4),4),shape=new THREE.InstancedBufferAttribute(new Float32Array(count*2),2);
        for(let i=0;i<count;i++){tree.setXYZW(i,1,0,1,1);shape.setXY(i,0,lod===1?lod1CardScale:1);}
        const group=new THREE.Group(),captureMaterials:THREE.Material[]=[];
        const meshes=lods[lod].map(source=>{
          const material=source.material.clone();material.toneMapped=false;material.fog=false;material.dithering=false;
          material.transparent=false;material.blending=THREE.NoBlending;material.alphaToCoverage=false;captureMaterials.push(material);
          // Capture binary MASK coverage; the far shader reproduces fractions.
          if(source.material.name==='MAT_AtlasFoliage'){material.alphaHash=false;material.alphaTest=alphaCutoff;}
          deform(material,state);
          if(foliageLodCutoff&&source.material.name==='MAT_AtlasFoliage')installTreeFoliageLodCutoff(material,foliageLodCutoff);
          const compile=material.onBeforeCompile,key=material.customProgramCacheKey(),leaf=source.material.name==='MAT_AtlasFoliage';
          material.onBeforeCompile=(shader,renderer)=>{
            compile.call(material,shader,renderer);
            Object.assign(shader.uniforms,{atlasCapturePass:pass,atlasCaptureFrame:frame});
            shader.fragmentShader=installForestFarAtlasCapture(shader.fragmentShader,leaf);
          };
          material.customProgramCacheKey=()=>`${key}/${FOREST_FAR_ATLAS_VERSION}/capture/${material.name}`;
          const geometry=source.geometry.clone();geometry.setAttribute('instanceTree',tree);geometry.setAttribute('instanceTreeShape',shape);
          const mesh=new THREE.InstancedMesh(geometry,material,count);mesh.frustumCulled=false;mesh.castShadow=false;mesh.receiveShadow=false;
          group.add(mesh);return mesh;
        });
        activeBatches++;let batchDisposed=false;
        return {group,meshes,pass,frame,count,
          /** `member` 0 keeps the authored structure; k selects pool member k-1. */
          setMember(index:number,matrix:THREE.Matrix4,member:number){
            if(batchDisposed||!Number.isInteger(index)||index<0||index>=count||!Number.isInteger(member)||member<0||member>variants.length)throw new Error('Invalid capture member');
            shape.setX(index,member);shape.needsUpdate=true;
            for(const mesh of meshes){mesh.setMatrixAt(index,matrix);mesh.instanceMatrix.needsUpdate=true;}
          },
          dispose(){if(batchDisposed)return;batchDisposed=true;activeBatches--;
            for(const mesh of meshes){mesh.geometry.dispose();mesh.dispose();}for(const material of captureMaterials)material.dispose();group.clear();group.removeFromParent();},
        };
      },
      dispose(){if(disposed)return;if(activeBatches)throw new Error('Dispose tree batches before their family');disposed=true;dispose();},
    };
  }catch(error){dispose();throw error;}
}
