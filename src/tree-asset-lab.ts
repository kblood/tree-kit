import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {loadTreeAssetFamily,type TreeAssetFamily,type TreeAssetOptions} from '#tree-kit/v1/assets';
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
const camera=new THREE.PerspectiveCamera(50,1,.1,400);camera.position.set(40,22,64);
const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,9,0);controls.update();
const sun=new THREE.DirectionalLight(0xfff6e5,3);sun.position.set(-30,55,25);sun.castShadow=true;
sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-45,right:45,top:35,bottom:-35,near:1,far:140});
// A signed authored-normal offset can push a backlit two-sided card into its
// own shadow. Use the same depth bias for off/transmission lab comparisons.
sun.shadow.normalBias=0;sun.shadow.bias=-.0001;scene.add(sun);
scene.add(new THREE.HemisphereLight(0xc4dcf0,0x41472c,1));
const ground=new THREE.Mesh(new THREE.PlaneGeometry(180,180),new THREE.MeshStandardMaterial({color:0x72765b,roughness:1}));ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;scene.add(ground);
const grid=new THREE.GridHelper(100,20,0x465246,0x697463);grid.position.y=.01;scene.add(grid);
let family:TreeAssetFamily|undefined,batches:ReturnType<TreeAssetFamily['createBatch']>[]=[];
let date=0n,lod:0|1=0,loading=false,loadError='',frames=0,last=performance.now(),renderCPUms=0;
let population=3;
let foliageCoverage:'mask'|'hash'='mask';
function setLOD(value:0|1){lod=value;$<HTMLSelectElement>('lod').value=String(lod);batches.forEach((batch,i)=>batch.group.visible=i===lod);}
function setDate(value:bigint){date=value;family?.setDate(date);if(document.activeElement!==$('date'))$<HTMLInputElement>('date').value=String(date);}
function diagnostics(){return {ready:!!family,loading,error:loadError,lod,date:String(date),foliageCoverage,specimenSkeletonHeightsM:[10,16,22],textures:family?.textures.size??0,
  leafTransmission:family?.leafTransmission?{factor:family.leafTransmission.factor,tint:family.leafTransmission.tint}:null,
  coverageMaterials:family?{color:family.lods[0].map(m=>({name:m.material.name,alphaTest:m.material.alphaTest,alphaHash:m.material.alphaHash})),shadows:batches.map(b=>b.meshes.map(m=>({depth:{alphaTest:m.customDepthMaterial!.alphaTest,alphaHash:m.customDepthMaterial!.alphaHash},distance:{alphaTest:m.customDistanceMaterial!.alphaTest,alphaHash:m.customDistanceMaterial!.alphaHash}})))}:null,
  materials:family?new Set(family.lods.flat().map(m=>m.material)).size:0,shadowMaterials:batches.length*4,sharedMaterials:family?.lods[0].every((m,i)=>m.material===family!.lods[1][i].material)??false,
  texturePNGContainerBytes:family?.embeddedTextureBytes??0,textureRGBA8MipBytesEstimate:family?[...family.textures].reduce((sum,t)=>{const image=t.image as {width:number;height:number};let w=image.width,h=image.height,total=0;while(true){total+=w*h*4;if(!t.generateMipmaps||w===1&&h===1)break;w=Math.max(1,Math.floor(w/2));h=Math.max(1,Math.floor(h/2));}return sum+total;},0):0,
  renderer:{calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,textures:renderer.info.memory.textures,geometries:renderer.info.memory.geometries},renderCPUSubmissionMs:renderCPUms,
  counterMeaning:'Draws include main and shadow passes; renderer textures include shadow targets; geometry counts track uploaded objects. Shared materials count PBR objects only; resource identity is not a measured GPU saving.',
  population,profile:profile.diagnostics(),lighting:'ACES exposure 1.2, sun 3, hemisphere 1; lab lighting, not whole-game acceptance',wind:'rigid leaf rotation only; branch wind pending'};}
function populate(target:typeof batches,count:number){
  for(const batch of target){
    for(let i=0;i<count;i++){
      const x=count===3?(i-1)*22:(i%16-7.5)*8,z=count===3?0:(Math.floor(i/16)-Math.ceil(count/16)/2)*8;
      batch.setInstance(i,new THREE.Matrix4().makeRotationY(i*2.399963).setPosition(x,0,z),count===3?[10,16,22][i]:10+(i*7%13),i*.7);
    }
    batch.setCount(count);
  }
}
function setPopulation(count:number){
  if(![3,64,192].includes(count))throw new Error('Unsupported lab population');
  population=count;populate(batches,count);$<HTMLSelectElement>('population').value=String(count);profile.clear();
}
async function load(buffers:[ArrayBuffer,ArrayBuffer],options:TreeAssetOptions={}){
  if(loading)throw new Error('Tree load already in progress');loading=true;loadError='';$('status').textContent='Loading and checking texture identity…';
  let next:TreeAssetFamily|undefined;const nextBatches:typeof batches=[];
  try{
    next=await loadTreeAssetFamily(...buffers,options);
    for(const level of [0,1] as const){
      const batch=next.createBatch(level,192);nextBatches.push(batch);
    }
    populate(nextBatches,population);
    next.setDate(date);nextBatches.forEach((batch,i)=>{batch.group.visible=i===lod;scene.add(batch.group);});
  }catch(error){for(const batch of nextBatches)batch.dispose();next?.dispose();loadError=String(error);throw error;}
  finally{loading=false;}
  // Commit only after all fallible preparation/scene attachment succeeded.
  const oldFamily=family,oldBatches=batches;family=next;batches=nextBatches;foliageCoverage=options.foliageCoverage??'mask';$<HTMLSelectElement>('coverage').value=foliageCoverage;
  $<HTMLSelectElement>('transmission').value=family.leafTransmission?String(family.leafTransmission.factor):'off';
  for(const batch of oldBatches)batch.dispose();oldFamily?.dispose();profile.clear();
}
$('load-assets').onclick=async()=>{
  const a=$<HTMLInputElement>('lod0-file').files?.[0],b=$<HTMLInputElement>('lod1-file').files?.[0];
  if(!a||!b){$('status').textContent='Select both exported GLBs.';return;}
  const transmission=$<HTMLSelectElement>('transmission').value;
  try{await load([await a.arrayBuffer(),await b.arrayBuffer()],{foliageCoverage:$<HTMLSelectElement>('coverage').value as 'mask'|'hash',...(transmission==='off'?{}:{leafTransmission:{factor:Number(transmission)}})});}catch(error){$('status').textContent=String(error);}
};
$<HTMLSelectElement>('lod').onchange=()=>setLOD($<HTMLSelectElement>('lod').value==='1'?1:0);
$<HTMLSelectElement>('population').onchange=()=>setPopulation(Number($<HTMLSelectElement>('population').value));
$<HTMLInputElement>('date').onchange=()=>{try{setDate(BigInt($<HTMLInputElement>('date').value));loadError='';}catch{loadError='Enter an integer nanosecond date.';}};
function resize(){renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();}
addEventListener('resize',resize);resize();
renderer.setAnimationLoop(()=>{
  const now=performance.now(),delta=now-last;last=now;
  if($<HTMLInputElement>('animate').checked)setDate(date+BigInt(Math.round(delta*1e6)));
  profile.beginFrame(delta);renderer.info.reset();const start=performance.now();profile.pass('trees-and-ground',()=>renderer.render(scene,camera));renderCPUms=performance.now()-start;
  profile.endFrame(renderer.info.render.calls,renderer.info.render.triangles);
  if(++frames%30===0&&(family||loadError))$('status').textContent=JSON.stringify(diagnostics(),null,2);
});
Object.assign(window,{__treeAssetLab:{load,setDate,setLOD,setPopulation,diagnostics,renderer,scene,camera,profile,sun,ground,grid,controls,get family(){return family;},get batches(){return batches;}}});
