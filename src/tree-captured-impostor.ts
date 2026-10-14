import * as THREE from 'three';
import {treeCaptureViews,treeViewBlend} from './tree-impostor-views.ts';
import {packTreeCaptureLayer} from './tree-impostor-filter.ts';
import {treeDiffuseTransferGLSL,patchTreeDiffuseTransferPhysical} from './tree-diffuse-transfer-shader.ts';

export type TreeCaptureFiltering='legacy-unassociated'|'coverage-weighted';
export type TreeCaptureLoadOptions={filtering?:TreeCaptureFiltering};

/** Development representation for one exact captured height/variant. No forest
 * residency, instancing, shadow casting or game handoff is installed here. */
export async function loadTreeCapture(manifest:any,read:(path:string)=>Promise<ArrayBuffer>,options:TreeCaptureLoadOptions={}){
  const filtering=options.filtering??'legacy-unassociated';
  if(!['legacy-unassociated','coverage-weighted'].includes(filtering))throw new Error('Unsupported tree capture filtering mode');
  if(!manifest||manifest.schemaVersion!==2||![3,9,17].includes(manifest.options?.grid)||manifest.rowOrder!=='bottom-to-top'||manifest.colour!=='linear-unassociated-rgb-area-coverage'||manifest.data!=='object-normal-xyz-normalized-frontmost-depth'||manifest.classification!=='leaf-fraction'||!Array.isArray(manifest.artifacts))throw new Error('Unsupported tree capture contract');
  const {grid,size,heightM}=manifest.options??{},views=treeCaptureViews(grid);
  const hasTransfer=manifest.options.diffuseTransfer===true;
  if(hasTransfer&&(manifest.diffuseTransfer!=='area-associated-linear-rgb-moments-1'||JSON.stringify(manifest.diffuseTransferOrder)!==JSON.stringify(['A','Nx','Ny','Nz','Qxx','Qyy','Qxy','Qxz','Qyz'])))throw new Error('Unsupported diffuse transfer contract');
  if(!hasTransfer&&manifest.diffuseTransfer)throw new Error('Undeclared diffuse transfer attachment');
  if(hasTransfer&&views.length*(4*size*size-1)/3*72>32*1024*1024)throw new Error('Diffuse transfer experiment exceeds 32 MiB texture budget');
  if(manifest.operation!=='atlas-tree-impostor-capture-2'||manifest.version!=='tree-material-capture-2'||![32,64,128].includes(size)||!Number.isFinite(heightM)||heightM<10||heightM>22||!Number.isFinite(manifest.radius)||manifest.radius<=0||manifest.radius>100||!Array.isArray(manifest.center)||manifest.center.length!==3||manifest.center.some((x:number)=>!Number.isFinite(x)||Math.abs(x)>100))throw new Error('Invalid tree capture manifest');
  if(JSON.stringify(manifest.views)!==JSON.stringify(views))throw new Error('Capture view bases do not match the declared contract');
  const records=new Map<string,any>(manifest.artifacts.map((r:any)=>[r.path,r]));
  if(records.size!==manifest.artifacts.length)throw new Error('Duplicate capture attachment');
  const colours:{data:Uint8Array;width:number;height:number}[]=[],classes:typeof colours=[],data:{data:Uint16Array;width:number;height:number}[]=[];
  const transferMips:{data:Uint16Array;width:number;height:number}[][]=Array.from({length:hasTransfer?7:0},()=>[]);
  async function readAttachment(viewIndex:number,mip:number,width:number,channel:'colour'|'data'|'classification'|'diffuse-transfer'){
    const channels=channel==='classification'?1:channel==='diffuse-transfer'?27:4,channelCount=width*width*channels;
    const path=`view-${String(viewIndex).padStart(3,'0')}/mip-${mip}.${channel}.f32`,record=records.get(path);
    if(!record||record.bytes!==channelCount*4)throw new Error('Capture attachment length is invalid');
    const payload=await read(path);
    if(payload.byteLength!==channelCount*4)throw new Error('Truncated capture attachment');
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',payload)),v=>v.toString(16).padStart(2,'0')).join('');
    if(hash!==record.sha256)throw new Error('Capture attachment hash mismatch');
    return new Float32Array(payload);
  }
  let bytes=0;
  for(let mip=0,width=size;width>=1;mip++,width/=2){
    const count=width*width*4,colour=new Uint8Array(count*views.length),values=new Uint16Array(colour.length),classification=new Uint8Array(colour.length);
    const transfer=transferMips.map(()=>new Uint16Array(count*views.length));
    for(const view of views){
      const [colourFloats,dataFloats,classFloats]=await Promise.all([
        readAttachment(view.index,mip,width,'colour'),readAttachment(view.index,mip,width,'data'),readAttachment(view.index,mip,width,'classification'),
      ]);
      const layerOffset=view.index*count;
      if(hasTransfer){
        const coefficients=await readAttachment(view.index,mip,width,'diffuse-transfer');
        for(let pixel=0;pixel<width*width;pixel++)for(let component=0;component<27;component++){
          const value=coefficients[pixel*27+component],channel=component%3,A=coefficients[pixel*27+channel];
          if(!Number.isFinite(value)||Math.abs(value)>1.00001||A<0||A>1.00001||Math.abs(value)>A+1e-5)throw new Error('Diffuse transfer coefficient outside its physical range');
          if(component<3&&Math.abs(A-colourFloats[pixel*4+channel]*colourFloats[pixel*4+3])>2e-5)throw new Error('Diffuse transfer albedo/coverage mismatch');
          transfer[Math.floor(component/4)][layerOffset+pixel*4+component%4]=THREE.DataUtils.toHalfFloat(value);
        }
      }
      if(filtering==='coverage-weighted'){
        const packed=packTreeCaptureLayer(colourFloats,dataFloats,classFloats);
        colour.set(packed.colour,layerOffset);values.set(packed.data,layerOffset);classification.set(packed.classification,layerOffset);
        continue;
      }
      for(let i=0;i<count;i++){
        const value=colourFloats[i],offset=layerOffset+i;
        if(!Number.isFinite(value)||value<0||value>1.001)throw new Error('Capture channel is outside its range');
        const encoded=i%4===3?value:value<=.0031308?12.92*value:1.055*value**(1/2.4)-.055;
        colour[offset]=Math.round(Math.max(0,Math.min(1,encoded))*255);
      }
      for(let i=0;i<count;i++){
        const value=dataFloats[i],offset=layerOffset+i;
        if(!Number.isFinite(value)||value < -1.001||value>1.001)throw new Error('Capture channel is outside its range');
        values[offset]=THREE.DataUtils.toHalfFloat(value);
      }
      for(let i=0;i<width*width;i++){
        const value=classFloats[i],offset=layerOffset+i*4;
        if(!Number.isFinite(value)||value<0||value>1.001)throw new Error('Capture channel is outside its range');
        classification[offset]=Math.round(Math.max(0,Math.min(1,value))*255);
      }
    }
    colours.push({data:colour,width,height:width});data.push({data:values,width,height:width});classes.push({data:classification,width,height:width});bytes+=colour.byteLength+values.byteLength+classification.byteLength;
    transfer.forEach((values,index)=>{transferMips[index].push({data:values,width,height:width});bytes+=values.byteLength;});
  }
  // The installed Three DataArrayTexture upload path only uploads level zero.
  // Its CompressedArrayTexture path supports explicit RGBA mip data as well:
  // RGBAFormat selects texSubImage3D, without block compression.
  // @types excludes the installed renderer's explicit uncompressed RGBA path.
  const rgba=THREE.RGBAFormat as unknown as THREE.CompressedPixelFormat;
  const colourTexture=new THREE.CompressedArrayTexture(colours,size,size,views.length,rgba);
  colourTexture.colorSpace=THREE.SRGBColorSpace;
  const dataTexture=new THREE.CompressedArrayTexture(data,size,size,views.length,rgba,THREE.HalfFloatType);
  dataTexture.colorSpace=THREE.NoColorSpace;
  // RGBA class storage uses the installed explicit-mip array path. Three spare
  // channels are a measured prototype cost; this is not yet an R8 upload path.
  const classTexture=new THREE.CompressedArrayTexture(classes,size,size,views.length,rgba);
  const transferTextures=transferMips.map(mips=>new THREE.CompressedArrayTexture(mips,size,size,views.length,rgba,THREE.HalfFloatType));
  for(const texture of [colourTexture,dataTexture,classTexture,...transferTextures]){
    if(Number(texture.format)!==THREE.RGBAFormat)throw new Error('Installed array texture default no longer supports RGBA mip uploads');
    texture.minFilter=THREE.LinearMipmapLinearFilter;texture.magFilter=THREE.LinearFilter;
    texture.generateMipmaps=false;texture.flipY=false;texture.needsUpdate=true;
  }
  return {manifest,views,colourTexture,dataTexture,classTexture,transferTextures,bytes,filtering,
    dispose(){colourTexture.dispose();dataTexture.dispose();classTexture.dispose();for(const texture of transferTextures)texture.dispose();}};
}
export type TreeCapture=Awaited<ReturnType<typeof loadTreeCapture>>;

const sampleGLSL=`
precision highp sampler2DArray;
${treeDiffuseTransferGLSL}
uniform sampler2DArray captureColour,captureData,captureClass;
uniform vec3 captureCenter,captureEye,captureDirection;
uniform float captureRadius,captureOrtho,captureMip,captureMask,captureParallax,captureHash,captureCoverageWeighted,captureStableReconstruction,captureRelightViews;
uniform vec3 captureWeights;
uniform ivec3 captureLayers;
uniform mat3 captureBasis0,captureBasis1,captureBasis2,captureNormalMatrix;
uniform mat4 captureModelView,captureProjection;
uniform vec2 captureRoughness,captureSpecular;
varying vec3 captureRayPoint;
vec2 captureUV(vec3 p,mat3 basis){vec3 d=p-captureCenter;return vec2(dot(d,basis[0]),dot(d,basis[1]))/(2.*captureRadius)+.5;}
void captureSample(int layer,mat3 basis,vec3 ro,vec3 rd,float viewWeight,out vec4 colour,out vec3 normal,out float t,out float leaf){
  colour=vec4(0);normal=vec3(0,1,0);t=1e20;leaf=0.;
  float denominator=dot(rd,basis[2]);if(abs(denominator)<.01)return;
  float plane=dot(captureCenter-ro,basis[2]);t=plane/denominator;
  vec2 uv=captureUV(ro+rd*t,basis);
  for(int step=0;step<2;step++){
    vec4 data=textureLod(captureData,vec3(clamp(uv,0.,1.),float(layer)),captureMip);
    if(captureCoverageWeighted>.5){float alpha=textureLod(captureColour,vec3(clamp(uv,0.,1.),float(layer)),captureMip).a;data/=max(alpha,1e-6);}
    t=(plane+data.w*captureRadius*captureParallax)/denominator;uv=captureUV(ro+rd*t,basis);
  }
  if(any(lessThan(uv,vec2(0)))||any(greaterThan(uv,vec2(1)))||t<0.)return;
  colour=textureLod(captureColour,vec3(uv,float(layer)),captureMip);
  #ifdef CAPTURE_DIFFUSE_TRANSFER
    accumulateTransfer(uv,layer,captureMip,viewWeight);
  #endif
  vec4 data=textureLod(captureData,vec3(uv,float(layer)),captureMip);
  float alpha=max(colour.a,1e-6);vec4 classification=textureLod(captureClass,vec3(uv,float(layer)),captureMip);
  if(captureCoverageWeighted>.5){colour.rgb/=alpha;data/=alpha;classification.r/=alpha;}
  normal=dot(data.xyz,data.xyz)>1e-8?normalize(data.xyz):basis[2];leaf=classification.r;
  // Captured leaf normals face their capture camera. Reorient a two-sided
  // leaf toward this ray before combining views from different directions.
  if(captureStableReconstruction>.5&&leaf>.5&&dot(normal,rd)>0.)normal=-normal;
  t=(plane+data.w*captureRadius)/denominator;
}
float captureNoise(vec2 p){return fract(52.9829189*fract(dot(floor(p),vec2(.06711056,.00583715))));}
`;

export class TreeCapturedImpostor {
  readonly mesh:THREE.Mesh<THREE.PlaneGeometry,THREE.MeshPhysicalMaterial>;
  readonly uniforms;
  readonly capture:TreeCapture;
  constructor(capture:TreeCapture,sourceMaterials:readonly THREE.MeshStandardMaterial[]){
    this.capture=capture;
    if(sourceMaterials.length!==2||sourceMaterials.some(m=>m.metalness!==0)||sourceMaterials[0].name!=='MAT_AtlasBark'||sourceMaterials[1].name!=='MAT_AtlasFoliage')throw new Error('Impostor requires its bark/foliage source materials');
    const specular=sourceMaterials.map(m=>(m as THREE.MeshPhysicalMaterial).specularIntensity??1);
    const u=this.uniforms={
      captureColour:{value:capture.colourTexture},captureData:{value:capture.dataTexture},captureClass:{value:capture.classTexture},
      captureCenter:{value:new THREE.Vector3(...capture.manifest.center as [number,number,number])},captureRadius:{value:capture.manifest.radius},
      captureEye:{value:new THREE.Vector3()},captureDirection:{value:new THREE.Vector3()},captureOrtho:{value:0},captureMip:{value:0},captureMask:{value:0},
      captureParallax:{value:1},captureHash:{value:0},captureCoverageWeighted:{value:Number(capture.filtering==='coverage-weighted')},captureStableReconstruction:{value:1},captureRelightViews:{value:0},
      captureWeights:{value:new THREE.Vector3()},captureLayers:{value:new Int32Array(3)},
      captureBasis0:{value:new THREE.Matrix3()},captureBasis1:{value:new THREE.Matrix3()},captureBasis2:{value:new THREE.Matrix3()},
      captureBillboardRight:{value:new THREE.Vector3()},captureBillboardUp:{value:new THREE.Vector3()},captureBillboardScale:{value:1},
      captureNormalMatrix:{value:new THREE.Matrix3()},captureModelView:{value:new THREE.Matrix4()},captureProjection:{value:new THREE.Matrix4()},
      captureRoughness:{value:new THREE.Vector2(sourceMaterials[0].roughness,sourceMaterials[1].roughness)},captureSpecular:{value:new THREE.Vector2(specular[0],specular[1])},
      captureDiffuseTransfer:{value:0},captureViewToObject:{value:new THREE.Matrix3()},
    };
    const material=new THREE.MeshPhysicalMaterial({roughness:1,metalness:0,alphaHash:true});material.fog=false;
    if(capture.transferTextures.length){
      capture.transferTextures.forEach((texture,index)=>Object.assign(u,{[`captureTransfer${index}`]:{value:texture}}));
    }
    material.onBeforeCompile=shader=>{
      Object.assign(shader.uniforms,u);
      shader.vertexShader=`uniform vec3 captureCenter,captureBillboardRight,captureBillboardUp;
uniform float captureRadius,captureBillboardScale;varying vec3 captureRayPoint;\n`+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`vec3 transformed=captureCenter+captureRadius*captureBillboardScale*(position.x*captureBillboardRight+position.y*captureBillboardUp);captureRayPoint=transformed;`);
      shader.fragmentShader=(capture.transferTextures.length?'#define CAPTURE_DIFFUSE_TRANSFER\n':'')+sampleGLSL+shader.fragmentShader;
      shader.fragmentShader=shader.fragmentShader.replace('#include <logdepthbuf_fragment>',`
vec3 ro=captureEye,rd=normalize(captureRayPoint-captureEye);
if(captureOrtho>.5){rd=captureDirection;ro=captureRayPoint+rd*dot(captureEye-captureRayPoint,rd);}
vec4 c0,c1,c2;vec3 n0,n1,n2;float t0,t1,t2,l0,l1,l2;
captureSample(captureLayers.x,captureBasis0,ro,rd,captureWeights.x,c0,n0,t0,l0);
captureSample(captureLayers.y,captureBasis1,ro,rd,captureWeights.y,c1,n1,t1,l1);
captureSample(captureLayers.z,captureBasis2,ro,rd,captureWeights.z,c2,n2,t2,l2);
vec3 weights=captureWeights*vec3(c0.a,c1.a,c2.a);float captureCoverage=dot(weights,vec3(1));
if(captureCoverage<=.00001)discard;
#ifdef CAPTURE_DIFFUSE_TRANSFER
normalizeTransfer(captureCoverage);
#endif
weights/=captureCoverage;
float hitDistance=min(weights.x>.001?t0:1e20,min(weights.y>.001?t1:1e20,weights.z>.001?t2:1e20));
// A tiny newly visible contribution must not select the depth of the entire
// pixel. Use the same continuous coverage weights as colour and normals.
if(captureStableReconstruction>.5)hitDistance=dot(weights,vec3(t0,t1,t2));
vec3 captureHit=ro+rd*hitDistance;vec4 hitView=captureModelView*vec4(captureHit,1),clip=captureProjection*hitView;
if(hitView.z>=0.||clip.w<=0.||clip.z < -clip.w||clip.z > clip.w)discard;
#if defined(USE_LOGARITHMIC_DEPTH_BUFFER)
gl_FragDepth=captureOrtho>.5?clip.z/clip.w*.5+.5:log2(1.-hitView.z)*logDepthBufFC*.5;
#else
gl_FragDepth=clip.z/clip.w*.5+.5;
#endif
if(captureMask<.5){
  float threshold=captureHash>.5?getAlphaHashThreshold(captureHit):captureNoise(gl_FragCoord.xy);
  if(threshold>=captureCoverage)discard;
}
diffuseColor.rgb=c0.rgb*weights.x+c1.rgb*weights.y+c2.rgb*weights.z;
vec3 captureObjectNormal=n0*weights.x+n1*weights.y+n2*weights.z;
if(dot(captureObjectNormal,captureObjectNormal)<1e-8)captureObjectNormal=n0;
float captureLeaf=dot(vec3(l0,l1,l2),weights);
`);
      // Coverage was resolved against the reconstructed surface above; the
      // built-in chunk would test the proxy plane a second time.
      shader.fragmentShader=shader.fragmentShader.replace('#include <alphahash_fragment>','');
      shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_begin>',`float faceDirection=1.;vec3 normal=normalize(captureNormalMatrix*captureObjectNormal);vec3 nonPerturbedNormal=normal;`);
      shader.fragmentShader=shader.fragmentShader.replace('#include <roughnessmap_fragment>',`float roughnessFactor=mix(captureRoughness.x,captureRoughness.y,captureLeaf);`);
      shader.fragmentShader=shader.fragmentShader.replace('#include <lights_physical_fragment>',`#include <lights_physical_fragment>
float capturedSpecular=mix(captureSpecular.x,captureSpecular.y,captureLeaf);material.specularColor=vec3(.04)*capturedSpecular;material.specularF90=capturedSpecular;`);
      if(capture.transferTextures.length)shader.fragmentShader=shader.fragmentShader.replace('#include <lights_physical_pars_fragment>',`
#if defined(USE_ENVMAP) || defined(USE_LIGHT_PROBES) || NUM_RECT_AREA_LIGHTS > 0
#error Captured diffuse transfer supports only punctual ambient and hemisphere lab lighting
#endif
${patchTreeDiffuseTransferPhysical(THREE.ShaderChunk.lights_physical_pars_fragment)}`);
      // Keep the original single-pass lighting as the default. The optional
      // comparison evaluates Three's same PBR chunks at each reconstructed
      // view surface before blending their reflected-light terms.
      const physicalChunk=THREE.ShaderChunk.lights_physical_fragment,
        lightBegin=THREE.ShaderChunk.lights_fragment_begin,
        lightMaps=THREE.ShaderChunk.lights_fragment_maps,
        lightEnd=THREE.ShaderChunk.lights_fragment_end;
      if(!physicalChunk.includes('PhysicalMaterial material;')||!lightBegin.includes('vec3 geometryPosition = - vViewPosition;')||
        !lightBegin.includes('getPointLightInfo( pointLight, geometryPosition, directLight )')||!lightMaps.includes('getIBLIrradiance( geometryNormal )')||
        !lightEnd.includes('RE_IndirectDiffuse('))throw new Error('Installed Three PBR lighting chunks have changed; per-view relighting was not installed');
      const baseLightBegin=lightBegin.replaceAll('vViewPosition','(-hitView.xyz)');
      const perViewLighting=(index:0|1|2)=>{
        const suffix=String(index),hit=`captureViewHit${suffix}`,sample=`${suffix}`,begin=lightBegin.replaceAll('vViewPosition',`(-${hit}.xyz)`);
        return `{
vec4 diffuseColor=vec4(c${sample}.rgb,1.);
vec3 normal=normalize(captureNormalMatrix*n${sample}),nonPerturbedNormal=normal;
float roughnessFactor=mix(captureRoughness.x,captureRoughness.y,l${sample});
ReflectedLight reflectedLight=ReflectedLight(vec3(0),vec3(0),vec3(0),vec3(0));
${physicalChunk}
float capturedSpecular=mix(captureSpecular.x,captureSpecular.y,l${sample});material.specularColor=vec3(.04)*capturedSpecular;material.specularF90=capturedSpecular;
${begin}
${lightMaps}
${lightEnd}
capturePerViewDirectDiffuse${suffix}=reflectedLight.directDiffuse;capturePerViewIndirectDiffuse${suffix}=reflectedLight.indirectDiffuse;
capturePerViewDirectSpecular${suffix}=reflectedLight.directSpecular;capturePerViewIndirectSpecular${suffix}=reflectedLight.indirectSpecular;
}`;
      };
      const lightingBlock=`if(captureRelightViews>.5){
vec4 captureViewHit0=captureModelView*vec4(ro+rd*(weights.x>.00001?t0:hitDistance),1.);
vec4 captureViewHit1=captureModelView*vec4(ro+rd*(weights.y>.00001?t1:hitDistance),1.);
vec4 captureViewHit2=captureModelView*vec4(ro+rd*(weights.z>.00001?t2:hitDistance),1.);
vec3 capturePerViewDirectDiffuse0=vec3(0),capturePerViewIndirectDiffuse0=vec3(0),capturePerViewDirectSpecular0=vec3(0),capturePerViewIndirectSpecular0=vec3(0);
vec3 capturePerViewDirectDiffuse1=vec3(0),capturePerViewIndirectDiffuse1=vec3(0),capturePerViewDirectSpecular1=vec3(0),capturePerViewIndirectSpecular1=vec3(0);
vec3 capturePerViewDirectDiffuse2=vec3(0),capturePerViewIndirectDiffuse2=vec3(0),capturePerViewDirectSpecular2=vec3(0),capturePerViewIndirectSpecular2=vec3(0);
${perViewLighting(0)}${perViewLighting(1)}${perViewLighting(2)}
reflectedLight.directDiffuse=capturePerViewDirectDiffuse0*weights.x+capturePerViewDirectDiffuse1*weights.y+capturePerViewDirectDiffuse2*weights.z;
reflectedLight.indirectDiffuse=capturePerViewIndirectDiffuse0*weights.x+capturePerViewIndirectDiffuse1*weights.y+capturePerViewIndirectDiffuse2*weights.z;
reflectedLight.directSpecular=capturePerViewDirectSpecular0*weights.x+capturePerViewDirectSpecular1*weights.y+capturePerViewDirectSpecular2*weights.z;
reflectedLight.indirectSpecular=capturePerViewIndirectSpecular0*weights.x+capturePerViewIndirectSpecular1*weights.y+capturePerViewIndirectSpecular2*weights.z;
diffuseColor.rgb=c0.rgb*weights.x+c1.rgb*weights.y+c2.rgb*weights.z;
}else{
${baseLightBegin}
${lightMaps}
${lightEnd}
}`;
      const lightIncludes=/#include <lights_fragment_begin>\s*#include <lights_fragment_maps>\s*#include <lights_fragment_end>/g;
      const includeMatches=shader.fragmentShader.match(lightIncludes);
      if(!includeMatches||includeMatches.length!==1)throw new Error('Installed physical shader lighting include sequence has changed');
      shader.fragmentShader=shader.fragmentShader.replace(lightIncludes,lightingBlock);
      shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',`#include <opaque_fragment>
if(captureMask>.5&&captureMask<2.5)gl_FragColor=vec4(vec3(1),captureCoverage);`);
      // Diagnostic passes write after display transforms. Depth is metres
      // along camera forward, matching the source mesh's vViewPosition.z.
      shader.fragmentShader=shader.fragmentShader.replace('#include <dithering_fragment>',`#include <dithering_fragment>
if(captureMask>1.5&&captureMask<2.5)gl_FragColor=vec4(vec3(-hitView.z),captureCoverage);
else if(captureMask>2.5)gl_FragColor.a=captureCoverage;`);
    };
    material.customProgramCacheKey=()=> `atlas-captured-tree-lab-4-${capture.filtering}-${capture.transferTextures.length}`;
    this.mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),material);this.mesh.frustumCulled=false;
    this.mesh.name='Authored tree capture reconstruction (development)';
    const inverse=new THREE.Matrix4(),localCamera=new THREE.Matrix4(),viewport=new THREE.Vector4();
    this.mesh.onBeforeRender=(renderer,_scene,camera)=>{
      const gl=renderer.getContext() as WebGL2RenderingContext;if(capture.views.length>gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS))throw new Error('Capture exceeds texture array layer limit');
      inverse.copy(this.mesh.matrixWorld).invert();localCamera.multiplyMatrices(inverse,camera.matrixWorld);
      u.captureEye.value.setFromMatrixPosition(localCamera);u.captureDirection.value.set(0,0,-1).transformDirection(localCamera);
      u.captureOrtho.value=Number((camera as THREE.OrthographicCamera).isOrthographicCamera===true);
      const toCamera=u.captureOrtho.value?u.captureDirection.value.clone().negate():u.captureEye.value.clone().sub(u.captureCenter.value).normalize();
      const blend=treeViewBlend(toCamera.toArray() as [number,number,number],capture.manifest.options.grid);
      u.captureWeights.value.fromArray(blend.weights);
      const matrices=[u.captureBasis0,u.captureBasis1,u.captureBasis2];
      blend.vertices.forEach((v,i)=>{
        u.captureLayers.value[i]=v.index;const basis=capture.views[v.index];
        matrices[i].value.setFromMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(...basis.right),new THREE.Vector3(...basis.up),new THREE.Vector3(...basis.towardCamera)));
      });
      u.captureBillboardRight.value.set(1,0,0).transformDirection(localCamera);u.captureBillboardUp.value.set(0,1,0).transformDirection(localCamera);
      const distance=u.captureEye.value.distanceTo(u.captureCenter.value),radius=u.captureRadius.value;
      // Tangent cone of the bounding sphere, projected onto its centre plane.
      // The old d/(d-r) expression needlessly enlarged the shaded quad.
      u.captureBillboardScale.value=u.captureOrtho.value?1:u.captureStableReconstruction.value>.5
        ?distance/Math.sqrt(Math.max(.0001,distance*distance-radius*radius))
        :distance/Math.max(.01,distance-radius);
      u.captureModelView.value.multiplyMatrices(camera.matrixWorldInverse,this.mesh.matrixWorld);
      u.captureNormalMatrix.value.getNormalMatrix(u.captureModelView.value);u.captureProjection.value.copy(camera.projectionMatrix);
      u.captureViewToObject.value.copy(u.captureNormalMatrix.value).invert();
      renderer.getCurrentViewport(viewport);
      const pixels=radius*Math.abs(camera.projectionMatrix.elements[5])*viewport.w/(u.captureOrtho.value?1:distance);
      u.captureMip.value=Math.max(0,Math.min(Math.log2(capture.manifest.options.size),Math.log2(capture.manifest.options.size/Math.max(1,pixels))));
    };
  }
  dispose(){this.mesh.geometry.dispose();this.mesh.material.dispose();this.mesh.removeFromParent();}
}
