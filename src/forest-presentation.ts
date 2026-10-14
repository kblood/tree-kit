import type {ForestTreeKind} from './forest-tree-family-library.ts';

export const FOREST_PRESENTATION_VERSION='forest-presentation-3';
const LOW=.8,RANGE=.4,VARIANT_STRIDE=262144,VARIANTS=8;
/** Shared eligibility for detailed and family-aware distant presentation.
 * The caller supplies the one allometry decision for the individual (from its
 * dated binding); height limits live in that decision, never here. */
export function forestPresentationFamily(dimensions:{representation:'family'|'legacy';kind:ForestTreeKind|null}|null,
  available:{has:(kind:ForestTreeKind)=>boolean}):ForestTreeKind|null{
  if(!dimensions||dimensions.representation!=='family'||!dimensions.kind)return null;
  return available.has(dimensions.kind)?dimensions.kind:null;
}

/** Fits family, two bounded brightness values and the bounded structural
 * variant into the unused float channel of the existing far instance buffer.
 * Every encoded integer is below 2^21 and exact in f32. Code zero retains the
 * legacy shape/roll tint. No identity or date is encoded. */
export function packForestPresentation(kind:ForestTreeKind,bark:number,foliage:number,variant=0){
  if(!['branching','spire'].includes(kind)||![bark,foliage].every(x=>Number.isFinite(x)&&x>=LOW&&x<=LOW+RANGE)||
    !Number.isInteger(variant)||variant<0||variant>=VARIANTS)
    throw new Error('Invalid forest family presentation');
  const quantize=(x:number)=>Math.round((x-LOW)*255/RANGE);
  return (kind==='branching'?1:2)+4*quantize(foliage)+1024*quantize(bark)+VARIANT_STRIDE*variant;
}
export function unpackForestPresentation(code:number){
  if(!Number.isSafeInteger(code)||code<0||code>=VARIANT_STRIDE*VARIANTS||code!==0&&![1,2].includes(code%4))
    throw new Error('Invalid packed forest presentation');
  if(code===0)return {kind:null,bark:1,foliage:1,variant:0};
  return {kind:(code%4===1?'branching':'spire') as ForestTreeKind,
    foliage:LOW+(Math.floor(code/4)%256)*RANGE/255,bark:LOW+(Math.floor(code/1024)%256)*RANGE/255,
    variant:Math.floor(code/VARIANT_STRIDE)};
}

export const forestPresentationGLSL=`
float forestFamilyCode(float packed){return mod(packed,4.0);}
vec2 forestFamilyBrightness(float packed){
  return vec2(.8)+vec2(mod(floor(packed/1024.0),256.0),mod(floor(packed/4.0),256.0))*(.4/255.0);
}
int forestFamilyVariant(float packed){return int(floor(packed/${VARIANT_STRIDE}.0));}
`;
