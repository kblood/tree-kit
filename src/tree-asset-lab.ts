import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {loadTreeAssetFamily,type TreeAssetFamily,type TreeAssetOptions} from '#tree-kit/v1/assets';
import {ForestTreeFamilyLibrary,type ForestTreeFamilyInput} from '#tree-kit/v1/instances';
import {ForestFarAtlas,ForestImpostors,type ForestFamilyPresentation} from '#tree-kit/v1/impostors';
import {packForestPresentation} from '#tree-kit/v1/instances';
import {RenderProfile} from './render-profile.ts';

const $=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.toneMapping=THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure=1.2;renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;
renderer.info.autoReset=false; // Explicit frame reset includes both shadow and main draws.
const profile=new RenderProfile(renderer.getContext() as WebGL2RenderingContext);profile.setEnabled(true);
$('viewport').append(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color('#a6bfd0');
const camera=new THREE.PerspectiveCamera(50,1,.1,700);camera.position.set(40,22,64);
const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,9,0);controls.update();
const sun=new THREE.DirectionalLight(0xfff6e5,3);sun.position.set(-30,55,25);sun.castShadow=true;
sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-45,right:45,top:35,bottom:-35,near:1,far:140});
// A signed authored-normal offset can push a backlit two-sided card into its
// own shadow. Use the same depth bias for off/transmission lab comparisons.
sun.shadow.normalBias=0;sun.shadow.bias=-.0001;scene.add(sun);
scene.add(new THREE.HemisphereLight(0xc4dcf0,0x41472c,1));
const ground=new THREE.Mesh(new THREE.PlaneGeometry(800,800),new THREE.MeshStandardMaterial({color:0x72765b,roughness:1}));ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;scene.add(ground);
const grid=new THREE.GridHelper(400,40,0x465246,0x697463);grid.position.y=.01;scene.add(grid);
let family:TreeAssetFamily|undefined,batches:ReturnType<TreeAssetFamily['createBatch']>[]=[];
let familyEntries:{kind:'branching'|'spire';batches:ReturnType<TreeAssetFamily['createBatch']>[];family:TreeAssetFamily}[]=[];
let familyLibrary:ForestTreeFamilyLibrary<number,number>|undefined,familyRoot:THREE.Group|undefined;
let farRenderer:ForestImpostors|undefined,farAtlases=new Map<'branching'|'spire',ForestFarAtlas>();
let date=0n,lod:0|1=0,loading=false,loadError='',frames=0,last=performance.now(),renderCPUms=0;
let population=3,mixedLOD=false,nearCount=32,middleCount=128,farCount=0,farUploaded=false;
let shareBarkTextures=true,currentInputs:readonly ForestTreeFamilyInput[]=[],currentOptions:TreeAssetOptions={};
let foliageCoverage:'mask'|'hash'='mask';
function setLOD(value:0|1){lod=value;mixedLOD=false;$<HTMLInputElement>('mixed-lod').checked=false;$<HTMLSelectElement>('lod').disabled=false;$<HTMLSelectElement>('population').disabled=false;$<HTMLSelectElement>('lod').value=String(lod);for(const entry of familyEntries)entry.batches.forEach((batch,i)=>batch.group.visible=i===lod);}
function setDate(value:bigint){date=value;familyLibrary?.setDate(date);if(!familyLibrary)family?.setDate(date);if(document.activeElement!==$('date'))$<HTMLInputElement>('date').value=String(date);}
function diagnostics(){return {ready:!!family,loading,error:loadError,lod,date:String(date),foliageCoverage,specimenSkeletonHeightsM:[10,16,22],
  familyLibrary:familyLibrary?{families:[...familyLibrary.entries.keys()],revision:familyLibrary.revision,shareBarkTextures,sharedBarkTextures:familyLibrary.barkTextureDiagnostics()}:null,
  farPresentation:{requested:farCount,ready:[...farAtlases.values()].map(atlas=>atlas.diagnostics()),renderer:!!farRenderer},
  textures:family?.textures.size??0,
  leafTransmission:family?.leafTransmission?{factor:family.leafTransmission.factor,tint:family.leafTransmission.tint}:null,
  coverageMaterials:family?{color:family.lods[0].map(m=>({name:m.material.name,alphaTest:m.material.alphaTest,alphaHash:m.material.alphaHash})),shadows:batches.map(b=>b.meshes.map(m=>({depth:{alphaTest:m.customDepthMaterial!.alphaTest,alphaHash:m.customDepthMaterial!.alphaHash},distance:{alphaTest:m.customDistanceMaterial!.alphaTest,alphaHash:m.customDistanceMaterial!.alphaHash}})))}:null,
  materials:family?new Set(family.lods.flat().map(m=>m.material)).size:0,shadowMaterials:batches.length*4,sharedMaterials:family?.lods[0].every((m,i)=>m.material===family!.lods[1][i].material)??false,
  texturePNGContainerBytes:family?.embeddedTextureBytes??0,textureRGBA8MipBytesEstimate:family?[...family.textures].reduce((sum,t)=>{const image=t.image as {width:number;height:number};let w=image.width,h=image.height,total=0;while(true){total+=w*h*4;if(!t.generateMipmaps||w===1&&h===1)break;w=Math.max(1,Math.floor(w/2));h=Math.max(1,Math.floor(h/2));}return sum+total;},0):0,
  renderer:{calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,textures:renderer.info.memory.textures,geometries:renderer.info.memory.geometries},renderCPUSubmissionMs:renderCPUms,
  counterMeaning:'Draws include main and shadow passes; renderer textures include shadow targets; geometry counts track uploaded objects. Shared materials count PBR objects only; resource identity is not a measured GPU saving.',
  population,profile:profile.diagnostics(),lighting:'ACES exposure 1.2, sun 3, hemisphere 1; lab lighting, not whole-game acceptance',wind:'rigid leaf rotation only; branch wind pending'};}
function populateBatch(batch:typeof batches[number],count:number,kind:'branching'|'spire',band:'single'|'near'|'middle'){
    for(let i=0;i<count;i++){
      const x=band==='single'&&count===3?(i-1)*22:(i%16-7.5)*8+(kind==='branching'?-10:10),
        z=band==='near'?0:band==='middle'?-110:count===3?0:(Math.floor(i/16)-Math.ceil(count/16)/2)*8;
      batch.setInstance(i,new THREE.Matrix4().makeRotationY(i*2.399963).setPosition(x,0,z),count===3?[10,16,22][i]:10+(i*7%13),i*.7);
    }
    batch.setCount(count);
}
function populate(target:{kind:'branching'|'spire';batches:typeof batches}[],count:number){
  let remaining=count,nearRemaining=nearCount,middleRemaining=middleCount;
  for(const [index,entry] of target.entries()){
    const familyCount=Math.ceil(remaining/(target.length-index));remaining-=familyCount;
    if(mixedLOD){
      const near=Math.ceil(nearRemaining/(target.length-index)),middle=Math.ceil(middleRemaining/(target.length-index));
      nearRemaining-=near;middleRemaining-=middle;
      populateBatch(entry.batches[0],near,entry.kind,'near');populateBatch(entry.batches[1],middle,entry.kind,'middle');
    }else for(const batch of entry.batches)populateBatch(batch,familyCount,entry.kind,'single');
  }
}
function setPopulation(count:number){
  if(![3,64,192].includes(count))throw new Error('Unsupported lab population');
  population=count;populate(familyEntries,count);$<HTMLSelectElement>('population').value=String(count);profile.clear();
}
function setFarPopulation(count:number){
  if(!Number.isInteger(count)||count<0||count>256)throw new Error('Far population must be between 0 and 256');
  farCount=count;if(!farRenderer)return;
  const active=familyEntries.filter(entry=>farAtlases.has(entry.kind));let remaining=count,index=0;
  for(const entry of active){const n=Math.ceil(remaining/(active.length-index));remaining-=n;
    const code=packForestPresentation(entry.kind,1,1,0);
    for(let i=0;i<n;i++){
      const x=(i%16-7.5)*12+(entry.kind==='branching'?-12:12),z=-280-Math.floor(i/16)*12;
      const rotation=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),i*2.399963);
      farRenderer.write(index,new THREE.Vector3(x,0,z),10+(i*7%13),rotation,(i%255)/255,0);
      farRenderer.setPresentation(index,code);index++;
    }
  }
  for(let i=index;i<farRenderer.positions.count;i++)farRenderer.retire(i);
  farRenderer.mesh.geometry.instanceCount=index;farRenderer.commit();farRenderer.mesh.visible=index>0&&active.length>0;farUploaded=true;
  $('status').textContent=JSON.stringify(diagnostics(),null,2);
}
function bakeFarAtlases(){
  if(!farRenderer)throw new Error('Load at least one family before baking far representations');
  const nextAtlases=new Map<'branching'|'spire',ForestFarAtlas>();
  try{
  for(const entry of familyEntries){
    const p=entry.family.canopyPresentation;if(!p?.enabled)continue;
    const atlas=new ForestFarAtlas({kind:entry.kind,geometries:entry.family.lods[1].map(mesh=>mesh.geometry),
      variants:p.structuralVariants,cardScale:p.lod1CardScale,createCaptureBatch:(level,count)=>entry.family.createCaptureBatch(level,count)});
    nextAtlases.set(entry.kind,atlas);
  }
  if(!nextAtlases.size)throw new Error('Far atlas capture requires a valid foliage mip manifest and payload for a family');
  }catch(error){for(const atlas of nextAtlases.values())atlas.dispose();throw error;}
  for(const [kind,atlas] of farAtlases){farRenderer.setFamilyAtlas(kind,null);atlas.dispose();}
  farAtlases=nextAtlases;farUploaded=false;
  farRenderer.setFamilyPresentations(new Map(familyEntries.map(entry=>[entry.kind,entry.family.canopyPresentation as ForestFamilyPresentation])));
  farRenderer.mesh.visible=false;$('status').textContent=`Baking ${farAtlases.size} family atlas set(s), 81 views per family…`;
}
function setMixedLOD(enabled:boolean){mixedLOD=enabled;$<HTMLInputElement>('mixed-lod').checked=enabled;
  $<HTMLSelectElement>('lod').disabled=enabled;$<HTMLSelectElement>('population').disabled=enabled;
  for(const entry of familyEntries)entry.batches.forEach((batch,i)=>batch.group.visible=enabled||i===lod);
  populate(familyEntries,population);profile.clear();}
async function load(inputs:readonly ForestTreeFamilyInput[],options:TreeAssetOptions={},shareBark=shareBarkTextures){
  if(loading)throw new Error('Tree load already in progress');loading=true;loadError='';$('status').textContent='Loading and checking texture identity…';
  let next:TreeAssetFamily|undefined,nextLibrary:ForestTreeFamilyLibrary<number,number>|undefined,nextRoot:THREE.Group|undefined,nextFarRenderer:ForestImpostors|undefined;
  let nextEntries:typeof familyEntries=[];
  try{
    nextRoot=new THREE.Group();nextRoot.name='Tree Kit family library';scene.add(nextRoot);
    nextLibrary=new ForestTreeFamilyLibrary<number,number>(nextRoot,loadTreeAssetFamily,String,[192,192],{shareBarkTextures:shareBark});
    await nextLibrary.replace(inputs,options);
    nextEntries=[...nextLibrary.entries.values()].map(entry=>({kind:entry.kind,batches:entry.batches,family:entry.family}));
    if(!nextEntries.length)throw new Error('Tree Kit family library did not adopt any tree families');
    next=nextEntries[0].family;
    populate(nextEntries,population);
    nextLibrary.setDate(date);for(const entry of nextEntries)entry.batches.forEach((batch,i)=>batch.group.visible=mixedLOD||i===lod);
    nextFarRenderer=new ForestImpostors(256);nextFarRenderer.mesh.visible=false;nextFarRenderer.mesh.position.set(0,0,0);scene.add(nextFarRenderer.mesh);
  }catch(error){nextFarRenderer?.dispose();nextLibrary?.dispose();nextRoot?.removeFromParent();loadError=String(error);throw error;}
  finally{loading=false;}
  // Commit only after all fallible preparation/scene attachment succeeded.
  const oldLibrary=familyLibrary,oldRoot=familyRoot,oldFarRenderer=farRenderer,oldAtlases=farAtlases;
  for(const atlas of oldAtlases.values())atlas.dispose();oldFarRenderer?.dispose();
  family=next;familyLibrary=nextLibrary;familyRoot=nextRoot;familyEntries=nextEntries;farRenderer=nextFarRenderer;farAtlases=new Map();farCount=0;farUploaded=false;
  shareBarkTextures=shareBark;currentInputs=inputs.map(input=>({...input}));currentOptions={...options};$<HTMLInputElement>('share-bark').checked=shareBark;
  batches=nextEntries.flatMap(entry=>entry.batches);foliageCoverage=options.foliageCoverage??'mask';$<HTMLSelectElement>('coverage').value=foliageCoverage;
  $<HTMLSelectElement>('transmission').value=family.leafTransmission?String(family.leafTransmission.factor):'off';
  oldLibrary?.dispose();oldRoot?.removeFromParent();profile.clear();
}
$('load-assets').onclick=async()=>{
  const inputs:ForestTreeFamilyInput[]=[];
  for(const [kind,prefix] of [['branching','branch'],['spire','spire']] as const){
    const lod0=$<HTMLInputElement>(`${prefix}-lod0`).files?.[0],lod1=$<HTMLInputElement>(`${prefix}-lod1`).files?.[0];
    const manifest=$<HTMLInputElement>(`${prefix}-mip-manifest`).files?.[0],payload=$<HTMLInputElement>(`${prefix}-mip-payload`).files?.[0];
    if(!!lod0!==!!lod1){$('status').textContent=`Select both ${kind} LOD files or leave that family empty.`;return;}
    if(!!manifest!==!!payload){$('status').textContent=`Select both ${kind} mip sidecar files or leave them empty.`;return;}
    if(!lod0||!lod1)continue;
    inputs.push({kind,lod0:await lod0.arrayBuffer(),lod1:await lod1.arrayBuffer(),
      ...(manifest&&payload?{foliageMipSidecar:{manifest:JSON.parse(await manifest.text()),data:await payload.arrayBuffer()}}:{})});
  }
  if(!inputs.length){$('status').textContent='Select LOD0 and LOD1 for at least one family.';return;}
  const transmission=$<HTMLSelectElement>('transmission').value;
  try{await load(inputs,{foliageCoverage:$<HTMLSelectElement>('coverage').value as 'mask'|'hash',...(transmission==='off'?{}:{leafTransmission:{factor:Number(transmission)}})},$<HTMLInputElement>('share-bark').checked);}
  catch(error){$('status').textContent=String(error);}
};
$<HTMLSelectElement>('lod').onchange=()=>setLOD($<HTMLSelectElement>('lod').value==='1'?1:0);
$<HTMLSelectElement>('population').onchange=()=>setPopulation(Number($<HTMLSelectElement>('population').value));
$<HTMLInputElement>('mixed-lod').onchange=()=>setMixedLOD($<HTMLInputElement>('mixed-lod').checked);
$<HTMLInputElement>('near-count').onchange=()=>{nearCount=Math.max(0,Math.min(192,Math.floor(Number($<HTMLInputElement>('near-count').value)||0)));populate(familyEntries,population);profile.clear();};
$<HTMLInputElement>('middle-count').onchange=()=>{middleCount=Math.max(0,Math.min(192,Math.floor(Number($<HTMLInputElement>('middle-count').value)||0)));populate(familyEntries,population);profile.clear();};
$<HTMLInputElement>('far-count').onchange=()=>{try{setFarPopulation(Math.max(0,Math.min(256,Math.floor(Number($<HTMLInputElement>('far-count').value)||0))));}catch(error){$('status').textContent=String(error);}};
$<HTMLButtonElement>('bake-atlas').onclick=()=>{try{bakeFarAtlases();}catch(error){$('status').textContent=String(error);}};
$<HTMLInputElement>('share-bark').onchange=()=>{if(currentInputs.length)load(currentInputs,currentOptions,$<HTMLInputElement>('share-bark').checked).catch(error=>{$('status').textContent=String(error);});};
$<HTMLInputElement>('date').onchange=()=>{try{setDate(BigInt($<HTMLInputElement>('date').value));loadError='';}catch{loadError='Enter an integer nanosecond date.';}};
function resize(){renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();}
addEventListener('resize',resize);resize();
renderer.setAnimationLoop(()=>{
  const now=performance.now(),delta=now-last;last=now;
  if($<HTMLInputElement>('animate').checked)setDate(date+BigInt(Math.round(delta*1e6)));
  for(const [kind,atlas] of farAtlases)if(atlas.state==='baking'&&atlas.step(renderer,2))farRenderer?.setFamilyAtlas(kind,{colour:atlas.colour,data:atlas.data,sphere:atlas.sphere});
  if(farRenderer&&farAtlases.size&&[...farAtlases.values()].every(atlas=>atlas.ready)&&farCount>0&&!farUploaded)setFarPopulation(farCount);
  profile.beginFrame(delta);renderer.info.reset();const start=performance.now();profile.pass('trees-and-ground',()=>renderer.render(scene,camera));renderCPUms=performance.now()-start;
  profile.endFrame(renderer.info.render.calls,renderer.info.render.triangles);
  if(++frames%30===0&&(family||loadError))$('status').textContent=JSON.stringify(diagnostics(),null,2);
});
Object.assign(window,{__treeAssetLab:{load:(buffers:[ArrayBuffer,ArrayBuffer],options:TreeAssetOptions={})=>load([{kind:'branching',lod0:buffers[0],lod1:buffers[1]}],options),setDate,setLOD,setPopulation,setMixedLOD,setFarPopulation,setShareBarkTextures:(enabled:boolean)=>load(currentInputs,currentOptions,enabled),bakeFarAtlases,diagnostics,renderer,scene,camera,profile,sun,ground,grid,controls,get family(){return family;},get families(){return familyEntries;},get batches(){return batches;},get farAtlases(){return farAtlases;},get farRenderer(){return farRenderer;}}});
