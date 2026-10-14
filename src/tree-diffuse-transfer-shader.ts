/** Experimental diffuse-only transfer. Signed RGB moments retain correlation
 * between albedo and normals through filtering. Specular uses the existing PBR
 * path. This deliberately supports the lab's ambient + hemisphere + punctual
 * lights, not environment maps, probes or area lights. */
export const treeDiffuseTransferGLSL=`
#ifdef CAPTURE_DIFFUSE_TRANSFER
uniform sampler2DArray captureTransfer0,captureTransfer1,captureTransfer2,captureTransfer3,captureTransfer4,captureTransfer5,captureTransfer6;
uniform mat3 captureViewToObject;
uniform float captureDiffuseTransfer;
vec3 transferA=vec3(0),transferNx=vec3(0),transferNy=vec3(0),transferNz=vec3(0);
vec3 transferQxx=vec3(0),transferQyy=vec3(0),transferQxy=vec3(0),transferQxz=vec3(0),transferQyz=vec3(0);
void accumulateTransfer(vec2 uv,int layer,float mip,float viewWeight){
  if(captureDiffuseTransfer<.5)return;
  vec3 p=vec3(uv,float(layer));
  vec4 a=textureLod(captureTransfer0,p,mip),b=textureLod(captureTransfer1,p,mip),c=textureLod(captureTransfer2,p,mip);
  vec4 d=textureLod(captureTransfer3,p,mip),e=textureLod(captureTransfer4,p,mip),f=textureLod(captureTransfer5,p,mip),g=textureLod(captureTransfer6,p,mip);
  transferA+=a.xyz*viewWeight;transferNx+=vec3(a.w,b.xy)*viewWeight;
  transferNy+=vec3(b.zw,c.x)*viewWeight;transferNz+=c.yzw*viewWeight;
  transferQxx+=d.xyz*viewWeight;transferQyy+=vec3(d.w,e.xy)*viewWeight;
  transferQxy+=vec3(e.zw,f.x)*viewWeight;transferQxz+=f.yzw*viewWeight;transferQyz+=g.xyz*viewWeight;
}
void normalizeTransfer(float coverage){
  transferA/=coverage;transferNx/=coverage;transferNy/=coverage;transferNz/=coverage;
  transferQxx/=coverage;transferQyy/=coverage;transferQxy/=coverage;transferQxz/=coverage;transferQyz/=coverage;
}
vec3 evaluateTransfer(vec3 viewDirection){
  vec3 l=normalize(captureViewToObject*viewDirection);
  vec3 value=(3./32.+15./32.*l.z*l.z)*transferA
    +.5*(l.x*transferNx+l.y*transferNy+l.z*transferNz)
    +15./32.*((l.x*l.x-l.z*l.z)*transferQxx+(l.y*l.y-l.z*l.z)*transferQyy
      +2.*(l.x*l.y*transferQxy+l.x*l.z*transferQxz+l.y*l.z*transferQyz));
  return max(value,vec3(0));
}
vec3 evaluateTransferHemisphere(vec3 viewDirection,vec3 sky,vec3 ground){
  vec3 l=normalize(captureViewToObject*viewDirection);
  // Hemisphere irradiance is linear in the original normals, so their first
  // moments are sufficient and must not be normalized after filtering.
  return .5*((sky+ground)*transferA+(sky-ground)*(l.x*transferNx+l.y*transferNy+l.z*transferNz));
}
#endif
`;

/** Patch only the two Lambert diffuse terms. The original code remains the
 * default branch and all specular/Fresnel calculations stay in Three. */
export function patchTreeDiffuseTransferPhysical(chunk:string){
  const direct='reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );';
  const indirect='reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );';
  for(const hook of [direct,indirect])if(chunk.split(hook).length!==2)throw new Error('Diffuse transfer PBR hook changed');
  return chunk.replace(direct,`#ifdef CAPTURE_DIFFUSE_TRANSFER
if(captureDiffuseTransfer>.5)reflectedLight.directDiffuse+=directLight.color*evaluateTransfer(directLight.direction)*RECIPROCAL_PI;
else
#endif
${direct}`).replace(indirect,`#ifdef CAPTURE_DIFFUSE_TRANSFER
if(captureDiffuseTransfer>.5){
  vec3 transferIrradiance=ambientLightColor*transferA;
  #if NUM_HEMI_LIGHTS > 0
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
      transferIrradiance+=evaluateTransferHemisphere(hemisphereLights[ i ].direction,hemisphereLights[ i ].skyColor,hemisphereLights[ i ].groundColor);
    }
    #pragma unroll_loop_end
  #endif
  reflectedLight.indirectDiffuse+=max(transferIrradiance,vec3(0))*RECIPROCAL_PI;
}else
#endif
${indirect}`);
}
