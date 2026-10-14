import type {BufferGeometry,BufferAttribute,InterleavedBufferAttribute} from 'three';

/** Reference skeleton height used by the detailed tree vertex shader. */
export const TREE_CANOPY_REFERENCE_HEIGHT_M = 16;
export const TREE_CANOPY_WIND_MAX_ANGLE_RAD = 0.12;
/** Rendered family heights supported by the detailed skeleton (tree-allometry
 * envelope; v2 lowered 8 m to 4 m so small dated species keep their family).
 * Canonical population heights are separate and never read here. */
export const TREE_CANOPY_HEIGHT_RANGE_M = [4, 24] as const;
const LEAF_BRANCH_LEVEL = 3.5;
const BAND_COUNT = 4;

export type CrownBand = {
  /** Mean attachment pivot in the 16 m reference skeleton, in metres. */
  centerM: [number, number, number];
  /** Populated bands expose their actual reference-space vertical extent. */
  minY_M: number;
  maxY_M: number;
  halfHeightM: number;
  populated: boolean;
  /** 90th-percentile pivot radius in XZ at reference scale; visual shape only. */
  radiusM: number;
  count: number;
  /** One-sided leaf-card area whose attachment pivot lies in this band, in metres². */
  leafAreaM2?: number;
};
export type TreeTrunkProfile = {
  /** Reference-skeleton trunk (branch level 0) extent at 16 m, in metres. */
  heightM: number; baseRadiusM: number; topRadiusM: number;
};
export type TreeCanopyProfile = {
  referenceHeightM: 16;
  bands: [CrownBand, CrownBand, CrownBand, CrownBand];
  /** Maximum source vertex offset from its attachment pivot, kept in metres. */
  maxLeafOffsetM: number;
  /** 75th-percentile leaf vertex offset: representative metric card extent. */
  cardExtentM?: number;
  trunk?: TreeTrunkProfile | null;
  /** 95th-percentile horizontal foliage-pivot distance from the trunk axis. */
  crownRadiusM?: number;
  /** Maximum horizontal distance and |y| of any bark vertex or foliage pivot. */
  skeleton?: {radiusM: number; heightM: number};
  radiusStatistic: 'p90-visual-only';
};
export type TreeCullingBounds = {
  /** Origin-centred sphere enclosing all supported scaled and wind-deformed vertices. */
  centerM: [0, 0, 0];
  radiusM: number;
  heightRangeM: [4, 24];
  maxWindAngleRad: number;
};
export type TreeCanopyMetadata = {profile: TreeCanopyProfile; cullingBounds: TreeCullingBounds};

type FloatAttribute=BufferAttribute|InterleavedBufferAttribute;
type Attributes = {position: FloatAttribute; pivot: FloatAttribute; branch: FloatAttribute; wind: FloatAttribute};

function readAttributes(geometries: readonly BufferGeometry[]): Attributes[] {
  if (!Array.isArray(geometries) || geometries.length === 0) throw new Error('At least one tree geometry is required');
  return geometries.map((geometry, index) => {
    if (!geometry || typeof geometry.getAttribute !== 'function') throw new Error(`Invalid tree geometry ${index}`);
    const position = geometry.getAttribute('position'), pivot = geometry.getAttribute('_leaf_pivot');
    const branch = geometry.getAttribute('_branch_level'), wind = geometry.getAttribute('_wind');
    if (!position || position.itemSize !== 3 || !pivot || pivot.itemSize !== 3 || !branch || branch.itemSize !== 1 || !wind || wind.itemSize !== 1 ||
      position.count < 1 || pivot.count !== position.count || branch.count !== position.count || wind.count !== position.count ||
      ![position, pivot, branch, wind].every(a => a.array instanceof Float32Array)) throw new Error(`Tree geometry ${index} is missing valid float vertex attributes`);
    return {position,pivot,branch,wind};
  });
}

const finite = (x: number) => Number.isFinite(x);
function percentile(values: number[], q: number): number {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[Math.max(0, Math.ceil(q * values.length) - 1)];
}
function maxNormAtAngle(px: number, py: number, pz: number, ox: number, oy: number, oz: number, s: number, angle: number): number {
  const c = Math.cos(angle), sn = Math.sin(angle);
  const x = px * s + ox * c - oy * sn;
  const y = py * s + ox * sn + oy * c;
  const z = pz * s + oz;
  return Math.hypot(x, y, z);
}
function maxDeformedVertexRadius(px: number, py: number, pz: number, qx: number, qy: number, qz: number,
  leaf: boolean, wind: number): number {
  if (!leaf) return Math.hypot(px, py, pz) * TREE_CANOPY_HEIGHT_RANGE_M[1] / TREE_CANOPY_REFERENCE_HEIGHT_M;
  const ox = px - qx, oy = py - qy, oz = pz - qz, maxAngle = TREE_CANOPY_WIND_MAX_ANGLE_RAD * wind;
  let maximum = 0;
  // For fixed angle, squared distance is convex in uniform skeleton scale, so
  // its maximum over the supported height range is at an endpoint. Angular maxima occur at the
  // interval ends or where A cos(theta)+B sin(theta) has a stationary point.
  const A = qx * ox + qy * oy, B = -qx * oy + qy * ox;
  const candidates = [-maxAngle, maxAngle];
  const stationary = Math.atan2(B, A);
  for (let k = -2; k <= 2; k++) {
    const a = stationary + k * Math.PI;
    if (a >= -maxAngle && a <= maxAngle) candidates.push(a);
  }
  for (const height of TREE_CANOPY_HEIGHT_RANGE_M) {
    const s = height / TREE_CANOPY_REFERENCE_HEIGHT_M;
    for (const angle of candidates) maximum = Math.max(maximum, maxNormAtAngle(qx, qy, qz, ox, oy, oz, s, angle));
  }
  return maximum;
}

/** Derive separate shape and culling data from the exact loaded vertex contract.
 * The p90 crown radii are deliberately visual representatives, never bounds. */
export function deriveTreeCanopyMetadata(geometries: readonly BufferGeometry[]): TreeCanopyMetadata {
  const sources = readAttributes(geometries);
  const samples: {x: number; y: number; z: number; band: number}[] = [];
  const leafOffsets: number[] = [], trunk: {y: number; r: number}[] = [], crownRadii: number[] = [];
  const bandArea = [0, 0, 0, 0];
  let maxLeafOffsetM = 0, cullingRadiusM = 0, skeletonRadiusM = 0, skeletonHeightM = 0;
  const bandOf = (y: number) => Math.max(0, Math.min(BAND_COUNT - 1, Math.floor(y / TREE_CANOPY_REFERENCE_HEIGHT_M * BAND_COUNT)));
  for (const [sourceIndex, source] of sources.entries()) {
    // Leaf-card area is metric: cards keep their size at every tree height.
    const index = geometries[sourceIndex].index, triangles = Math.floor((index ? index.count : source.position.count) / 3);
    const vertex = (t: number) => index ? index.getX(t) : t;
    for (let t = 0; t < triangles; t++) {
      const a = vertex(t * 3), b = vertex(t * 3 + 1), c = vertex(t * 3 + 2);
      if (source.branch.getX(a) <= LEAF_BRANCH_LEVEL || source.branch.getX(b) <= LEAF_BRANCH_LEVEL || source.branch.getX(c) <= LEAF_BRANCH_LEVEL) continue;
      const ux = source.position.getX(b) - source.position.getX(a), uy = source.position.getY(b) - source.position.getY(a), uz = source.position.getZ(b) - source.position.getZ(a);
      const vx = source.position.getX(c) - source.position.getX(a), vy = source.position.getY(c) - source.position.getY(a), vz = source.position.getZ(c) - source.position.getZ(a);
      const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
      if (finite(area)) bandArea[bandOf(source.pivot.getY(a))] += area;
    }
  }
  for (const source of sources) {
    for (let i = 0; i < source.branch.count; i++) {
      // GLTFLoader may share an interleaved buffer across attributes. Accessors
      // honor its stride and offset; the raw arrays are not tightly packed.
      const px = source.position.getX(i), py = source.position.getY(i), pz = source.position.getZ(i);
      const qx = source.pivot.getX(i), qy = source.pivot.getY(i), qz = source.pivot.getZ(i);
      const branch = source.branch.getX(i), wind = source.wind.getX(i);
      if (![px, py, pz, qx, qy, qz, branch, wind].every(finite) || wind < 0 || wind > 1) throw new Error('Tree vertex contains non-finite data or wind outside [0,1]');
      const leaf = branch > LEAF_BRANCH_LEVEL;
      cullingRadiusM = Math.max(cullingRadiusM, maxDeformedVertexRadius(px, py, pz, qx, qy, qz, leaf, wind));
      if (!leaf) {
        skeletonRadiusM = Math.max(skeletonRadiusM, Math.hypot(px, pz)); skeletonHeightM = Math.max(skeletonHeightM, Math.abs(py));
        if (branch < .5) trunk.push({y: py, r: Math.hypot(px, pz)});
        continue;
      }
      const x = qx, y = qy, z = qz;
      samples.push({x, y, z, band: bandOf(y)});
      crownRadii.push(Math.hypot(qx, qz));
      skeletonRadiusM = Math.max(skeletonRadiusM, Math.hypot(qx, qz)); skeletonHeightM = Math.max(skeletonHeightM, Math.abs(qy));
      const offset = Math.hypot(px - qx, py - qy, pz - qz);
      leafOffsets.push(offset);
      maxLeafOffsetM = Math.max(maxLeafOffsetM, offset);
    }
  }
  if (!samples.length) throw new Error('Tree family contains no foliage pivots');
  const bands = Array.from({length: BAND_COUNT}, (_, i): CrownBand => {
    const members = samples.filter(sample => sample.band === i);
    const centerM: [number, number, number] = members.length
      ? [members.reduce((n, x) => n + x.x, 0) / members.length,
        members.reduce((n, x) => n + x.y, 0) / members.length,
        members.reduce((n, x) => n + x.z, 0) / members.length]
      : [0, (i + .5) * TREE_CANOPY_REFERENCE_HEIGHT_M / BAND_COUNT, 0];
    const radii = members.map(sample => Math.hypot(sample.x - centerM[0], sample.z - centerM[2]));
    const minY_M = members.length ? Math.min(...members.map(sample => sample.y)) : 0;
    const maxY_M = members.length ? Math.max(...members.map(sample => sample.y)) : 0;
    const halfHeightM = members.length ? (maxY_M - minY_M) / 2 : 0;
    if (members.length) centerM[1] = minY_M + halfHeightM;
    return {centerM, minY_M, maxY_M, halfHeightM,
      populated: members.length > 0, radiusM: percentile(radii, .9), count: members.length, leafAreaM2: bandArea[i]};
  }) as [CrownBand, CrownBand, CrownBand, CrownBand];
  // Enclose the visible band envelopes too. Each is bounded by a horizontal
  // disk and vertical half-height around its center. Both profile dimensions
  // scale with the skeleton; card offsets remain metric and are added unchanged.
  for (const band of bands) {
    if (!band.populated) continue;
    const scale = TREE_CANOPY_HEIGHT_RANGE_M[1] / TREE_CANOPY_REFERENCE_HEIGHT_M;
    const envelope = Math.hypot(...band.centerM) * scale +
      Math.hypot(band.radiusM, band.halfHeightM) * scale + maxLeafOffsetM;
    cullingRadiusM = Math.max(cullingRadiusM, envelope);
  }
  if (!finite(cullingRadiusM) || cullingRadiusM <= 0 || !finite(maxLeafOffsetM)) throw new Error('Invalid derived tree bounds');
  // Trunk: branch level 0. Radii are p90 horizontal distances near its ends.
  let trunkProfile: TreeTrunkProfile | null = null;
  if (trunk.length) {
    const heightM = trunk.reduce((n, v) => Math.max(n, v.y), 0);
    const base = trunk.filter(v => v.y <= heightM * .08).map(v => v.r), top = trunk.filter(v => v.y >= heightM * .85).map(v => v.r);
    const baseRadiusM = percentile(base, .9), topRadiusM = percentile(top, .9);
    if (heightM > 0 && baseRadiusM > 0 && [heightM, baseRadiusM, topRadiusM].every(finite)) trunkProfile = {heightM, baseRadiusM, topRadiusM: Math.min(topRadiusM, baseRadiusM)};
  }
  return {
    profile: {referenceHeightM: 16, bands, maxLeafOffsetM, cardExtentM: percentile(leafOffsets, .75), trunk: trunkProfile,
      crownRadiusM: percentile(crownRadii, .95), skeleton: {radiusM: skeletonRadiusM, heightM: skeletonHeightM}, radiusStatistic: 'p90-visual-only'},
    cullingBounds: {centerM: [0, 0, 0], radiusM: cullingRadiusM, heightRangeM: [TREE_CANOPY_HEIGHT_RANGE_M[0], TREE_CANOPY_HEIGHT_RANGE_M[1]], maxWindAngleRad: TREE_CANOPY_WIND_MAX_ANGLE_RAD},
  };
}

const srgbLinearLut = Float64Array.from({length: 256}, (_, byte) => {
  const v = byte / 255;
  return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
});

/** Alpha-weighted mean of straight-alpha sRGB RGBA byte pixels, returned in linear RGB. */
export function alphaWeightedLinearRgbMean(rgba: ArrayLike<number>): {linearRgb: [number, number, number]; alphaWeight: number; pixelCount: number} {
  if (!rgba || !Number.isSafeInteger(rgba.length) || rgba.length === 0 || rgba.length % 4 !== 0) throw new Error('Expected non-empty straight sRGB RGBA pixels');
  let weight = 0, r = 0, g = 0, b = 0;
  const byteArray = rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray;
  for (let i = 0; i < rgba.length; i += 4) {
    const red = rgba[i], green = rgba[i + 1], blue = rgba[i + 2], alpha = rgba[i + 3];
    if (!byteArray && (!Number.isInteger(red) || red < 0 || red > 255 || !Number.isInteger(green) || green < 0 || green > 255 ||
      !Number.isInteger(blue) || blue < 0 || blue > 255 || !Number.isInteger(alpha) || alpha < 0 || alpha > 255)) throw new Error('RGBA values must be integer bytes');
    const a = alpha / 255;
    weight += a; r += srgbLinearLut[red] * a; g += srgbLinearLut[green] * a; b += srgbLinearLut[blue] * a;
  }
  if (weight <= 0) throw new Error('RGBA pixels have no alpha weight');
  return {linearRgb: [r / weight, g / weight, b / weight], alphaWeight: weight, pixelCount: rgba.length / 4};
}

/** Texture-space color summary. `baseColorFactor` is already linear, matching
 * Three's material color; alpha cutoff coverage measures pixels, never canopy area. */
export function deriveTreeBaseColorStatistics(rgba: ArrayLike<number>,
  baseColorFactor: readonly [number, number, number, number], alphaCutoff: number) {
  if (!Array.isArray(baseColorFactor) || baseColorFactor.length !== 4 ||
    !baseColorFactor.every(x => Number.isFinite(x) && x >= 0 && x <= 1) ||
    !Number.isFinite(alphaCutoff) || alphaCutoff < 0 || alphaCutoff > 1) throw new Error('Invalid glTF base color factor or alpha cutoff');
  const mean = alphaWeightedLinearRgbMean(rgba);
  let covered = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    const alpha = rgba[i];
    if (!(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) &&
      (!Number.isInteger(alpha) || alpha < 0 || alpha > 255)) throw new Error('RGBA values must be integer bytes');
    if (alpha / 255 * baseColorFactor[3] >= alphaCutoff) covered++;
  }
  return {
    linearRgb: [mean.linearRgb[0] * baseColorFactor[0], mean.linearRgb[1] * baseColorFactor[1], mean.linearRgb[2] * baseColorFactor[2]] as [number, number, number],
    baseCoverage: covered / mean.pixelCount,
    pixelCount: mean.pixelCount,
    alphaWeight: mean.alphaWeight,
  };
}
