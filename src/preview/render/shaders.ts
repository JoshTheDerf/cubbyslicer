/**
 * GLSL 3 (WebGL2) shaders for the G-code preview.
 *
 * Extrusions are drawn as screen-space capsule impostors: one instanced quad
 * (4 vertices, 2 triangles) per segment, expanded in the vertex shader around
 * the projected segment by the projected extrusion radius, with round caps
 * and a cylinder normal reconstructed in the fragment shader. This keeps the
 * vertex cost at 4 per segment (millions of segments stay interactive) while
 * giving a rounded-bead look from every angle — including end-on, where the
 * capsule degenerates to a disc just like a real bead.
 *
 * Visibility (layer range + move clip) is one global segment-index interval:
 * idx = uBase + gl_InstanceID; features are masked by uFeatVis[feature].
 */

const COMMON = /* glsl */ `
uniform int uBase;
uniform int uRangeMin;
uniform int uRangeMax;
uniform float uFeatVis[32];
uniform vec4 uSection;     // Orca 2.5 section view: cut where dot(xyz, p) > w (by segment centre, as desktop's markers)
`;

export const EXTRUSION_VERT = /* glsl */ `
${COMMON}
uniform vec3 uFeatColor[32];
uniform vec4 uToolColor[32]; // rgb + opacity (Orca 2.5 translucent filaments)
uniform int uScheme;        // 0 feature, 1 tool, 2 numeric
uniform float uTranslucentOn; // 1: filament opacity applies (Filament scheme only, as in Orca)
uniform int uPass;          // 0 opaque instances, 1 translucent instances (per material)
uniform float uVMin;
uniform float uVMax;
uniform vec3 uRamp[11];
uniform vec2 uViewport;     // drawing-buffer pixels
uniform float uMinPx;       // min on-screen radius (px)
uniform float uNear;
uniform int uTopStart;      // first segment of the top visible layer
uniform float uDimBelow;    // 0..1 darken layers below the top one (0 = off)

in vec3 aStart;
in vec3 aEnd;
in vec2 aWH;    // micrometres
in vec4 aMeta;  // feature, tool, -, -
in float aValue;

out vec4 vQ;            // (along, across, 0, 1) * clip.w  → screen-linear after divide
flat out vec4 vCap;     // start radius px, end radius px, length px, -
flat out vec2 vT;       // screen-space direction
flat out vec3 vColor;
flat out float vAlpha;
#ifdef CLEAR
// Translucent pass only (chunks.ts ensureClear): the path's points before and after the segment,
// and whether it meets an extrusion there (x start, y end), for the joint cut below.
in vec3 aPrev;
in vec3 aNext;
in vec2 aJoint;
flat out vec4 vCut;     // the joint cut lines in the segment's (along, across) frame: start normal, end normal
#endif

// Constant-index form (unrolled) — avoids dynamic uniform-array indexing.
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0) * 10.0;
  vec3 c = uRamp[0];
  for (int k = 0; k < 10; k++) c = mix(c, uRamp[k + 1], clamp(t - float(k), 0.0, 1.0));
  return c;
}

void hide() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vQ = vec4(0.0); vCap = vec4(0.0); vT = vec2(1.0, 0.0); vColor = vec3(0.0); vAlpha = 0.0;
#ifdef CLEAR
  vCut = vec4(0.0);
#endif
}
#ifdef CLEAR
// Orca 2.5 (libvgcode Segments_Fragment_Shader beyond_joint): two segments of a path overlap at
// their joint, which blending would draw twice, so each is cut at the bisector of the joint. Here
// in screen space, where the capsules are: the normal of the line through the joint at screen
// point p between the path's directions into and out of it, or zero (no cut) where there is no
// joint, the neighbour lies behind the camera or the path doubles back on itself.
vec2 jointNormal(float joint, vec3 other, vec2 p, vec2 dir, bool atEnd, vec2 half_) {
  if (joint < 0.5) return vec2(0.0);
  vec4 c = projectionMatrix * viewMatrix * modelMatrix * vec4(other, 1.0);
  if (c.w <= 1e-6) return vec2(0.0);
  vec2 d = (c.xy / c.w * half_ - p) * (atEnd ? 1.0 : -1.0);
  float l = length(d);
  if (l < 1e-3) return vec2(0.0);
  vec2 n = d / l + dir;
  return dot(n, n) > 1e-4 ? normalize(n) : vec2(0.0);
}
#endif

void main() {
  int idx = uBase + gl_InstanceID;
  int feat = int(aMeta.x + 0.5);
  if (idx < uRangeMin || idx > uRangeMax || uFeatVis[feat] < 0.5 || aWH.x <= 0.0) { hide(); return; }
  // Each instance is drawn in exactly one pass: translucent filament colours in pass 1.
  vec4 toolCol = uToolColor[int(aMeta.y + 0.5) & 31];
  float alpha = uScheme == 1 && uTranslucentOn > 0.5 ? toolCol.a : 1.0;
  if ((uPass == 1) != (alpha < 0.999)) { hide(); return; }

  // World space: copies (IDEX/IQEX carriages) and the belt designed view draw the same buffers under a model matrix.
  vec3 wS = (modelMatrix * vec4(aStart, 1.0)).xyz;
  vec3 wE = (modelMatrix * vec4(aEnd, 1.0)).xyz;
  vec3 d = wE - wS;
  float len = length(d);
  vec3 dir = len > 1e-6 ? d / len : vec3(1.0, 0.0, 0.0);
  vec3 mid = 0.5 * (wS + wE);
  if (dot(uSection.xyz, mid) > uSection.w) { hide(); return; }
  vec3 viewDir = isOrthographic
    ? -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2])
    : normalize(mid - cameraPosition);

  // Silhouette radius of the elliptical bead (w/2 horizontal, h/2 vertical)
  // perpendicular to both the segment and the view ray.
  vec3 hp = cross(dir, vec3(0.0, 0.0, 1.0));
  float hl = length(hp);
  hp = hl > 1e-4 ? hp / hl : vec3(1.0, 0.0, 0.0);
  vec3 upp = cross(hp, dir);
  vec3 p = cross(dir, viewDir);
  float pl = length(p);
  p = pl > 1e-5 ? p / pl : upp;
  float hw = aWH.x * 0.0005, hh = max(aWH.y, 1.0) * 0.0005;
  float R = max(length(vec2(hw * dot(p, hp), hh * dot(p, upp))), 0.005);

  vec4 vs = viewMatrix * vec4(wS, 1.0);
  vec4 ve = viewMatrix * vec4(wE, 1.0);
  float zc = -uNear * 1.001;
  if (vs.z > zc && ve.z > zc) { hide(); return; }
#ifdef CLEAR
  bool clipped = vs.z > zc || ve.z > zc;
#endif
  if (vs.z > zc) vs = mix(vs, ve, (vs.z - zc) / (vs.z - ve.z));
  else if (ve.z > zc) ve = mix(ve, vs, (ve.z - zc) / (ve.z - vs.z));

  vec4 cs = projectionMatrix * vs;
  vec4 ce = projectionMatrix * ve;
  vec2 half_ = 0.5 * uViewport;
  vec2 ss = cs.xy / cs.w * half_;
  vec2 se = ce.xy / ce.w * half_;
  vec2 sd = se - ss;
  float L = length(sd);
  vec2 t = L > 1e-4 ? sd / L : vec2(1.0, 0.0);
  vec2 n2 = vec2(-t.y, t.x);
  float pxScale = projectionMatrix[1][1] * half_.y;
  float rS = max(R * pxScale / cs.w, uMinPx);
  float rE = max(R * pxScale / ce.w, uMinPx);

  bool atEnd = position.x > 0.5;
  float r = atEnd ? rE : rS;
  vec4 c = atEnd ? ce : cs;
  vec2 P = (atEnd ? se : ss) + t * (atEnd ? r : -r) + n2 * (position.y * r);
  gl_Position = vec4(P / half_ * c.w, c.z, c.w);

  float along = atEnd ? L + r : -r;
  vQ = vec4(along, position.y * r, 0.0, 1.0) * c.w;
  vCap = vec4(rS, rE, L, 0.0);
  vT = t;
#ifdef CLEAR
  // The cut lines, in the (along, across) frame the fragment shader reads (start at 0, end at L).
  vec2 cs2 = clipped ? vec2(0.0) : jointNormal(aJoint.x, aPrev, ss, t, false, half_);
  vec2 ce2 = clipped ? vec2(0.0) : jointNormal(aJoint.y, aNext, se, t, true, half_);
  vCut = vec4(dot(cs2, t), dot(cs2, n2), dot(ce2, t), dot(ce2, n2));
#endif

  vec3 col;
  if (uScheme == 0) col = uFeatColor[feat];
  else if (uScheme == 1) col = toolCol.rgb;
  else col = ramp((aValue - uVMin) / max(uVMax - uVMin, 1e-9));
  if (uDimBelow > 0.0 && idx < uTopStart) col *= 1.0 - uDimBelow;
  vColor = col;
#ifdef CLEAR
  // Orca 2.5: a clear filament keeps the least opacity that still shows it (3DScene.cpp
  // adjust_color_for_rendering, 0.1), and a filament's opacity is that of 0.4 mm of it
  // (Shaders.hpp REFERENCE_THICKNESS), scaled to the path of the view ray through the
  // extrusion's height × width diamond; kept below 1, which would read as opaque.
  float a0 = max(alpha, 0.1);
  float path = 1.0 / max(abs(dot(viewDir, upp)) / (hh * 2.0) + abs(dot(viewDir, hp)) / (hw * 2.0), 1e-3);
  vAlpha = min(1.0 - pow(1.0 - a0, min(path / 0.4, 16.0)), 0.999);
#else
  // Never fully invisible: Orca keeps a clear filament faintly visible.
  vAlpha = max(alpha, 0.12);
#endif
}
`;

export const EXTRUSION_FRAG = /* glsl */ `
layout(location = 0) out highp vec4 outColor;
in vec4 vQ;
flat in vec4 vCap;
flat in vec2 vT;
flat in vec3 vColor;
flat in float vAlpha;

void main() {
  vec2 q = vQ.xy / vQ.w;
  float L = vCap.z;
  vec2 rel;
  float r;
  if (q.x < 0.0) { rel = q; r = vCap.x; }
  else if (q.x > L) { rel = vec2(q.x - L, q.y); r = vCap.y; }
  else { r = mix(vCap.x, vCap.y, L > 0.0 ? q.x / L : 0.0); rel = vec2(0.0, q.y); }
  float d2 = dot(rel, rel) / (r * r);
  if (d2 > 1.0) discard;
  // Shade caps like the cylinder body (across-only normal) unless the
  // segment is (nearly) end-on, so consecutive segments join seamlessly.
  vec2 nd = rel / r;
  if (L > 0.5 * r) nd.x = 0.0;
  float nz2 = max(1.0 - dot(nd, nd), 0.0);
  vec2 n2 = vec2(-vT.y, vT.x);
  vec3 N = normalize(vec3(vT * nd.x + n2 * nd.y, sqrt(nz2)));
  vec3 L1 = normalize(vec3(-0.35, 0.55, 0.75));
  float diff = max(dot(N, L1), 0.0);
  vec3 H = normalize(L1 + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(N, H), 0.0), 28.0) * 0.18;
  vec3 col = vColor * (0.28 + 0.52 * diff + 0.28 * N.z) + vec3(spec);
  outColor = vec4(col, vAlpha);
}
`;

/**
 * Translucent filaments (pass 1 materials only). Orca 2.5's order independent transparency
 * (libvgcode `ViewerImpl::render_translucent_segments`, Shaders.hpp `Segments_Fragment_Shader`):
 * uOitPass 1 keeps the depth of the nearest translucent surface (the depth buffer of oit.ts's
 * front target), 2 sets that surface apart (outFront) and adds up the others weighted by depth
 * (outColor, McGuire and Bavoil 2013) with their coverage (outReveal, −log(1 − α)); oit.ts
 * composites them over the scene. Both discard what the opaque scene hides. uOitPass 0 is the
 * plain blended pass (no float colour targets: Orca's OpenGL ES path). Every pass cuts the
 * segments at their joints (vCut) and uses the opacity of the path through the extrusion (vAlpha),
 * both from the vertex shader's CLEAR parts.
 */
export const EXTRUSION_FRAG_CLEAR = /* glsl */ `
layout(location = 0) out highp vec4 outColor;
layout(location = 1) out highp vec4 outReveal;
layout(location = 2) out highp vec4 outFront;
uniform int uOitPass;
uniform highp sampler2D uOpaqueDepth;
uniform highp sampler2D uFrontDepth;
uniform vec2 uOitDepthRange;  // view depth of the extrusions' box, near / far
uniform float uNear;
uniform float uFar;
in vec4 vQ;
flat in vec4 vCap;
flat in vec2 vT;
flat in vec3 vColor;
flat in float vAlpha;
flat in vec4 vCut;

void main() {
  vec2 q = vQ.xy / vQ.w;
  float L = vCap.z;
  vec2 rel;
  float r;
  if (q.x < 0.0) { rel = q; r = vCap.x; }
  else if (q.x > L) { rel = vec2(q.x - L, q.y); r = vCap.y; }
  else { r = mix(vCap.x, vCap.y, L > 0.0 ? q.x / L : 0.0); rel = vec2(0.0, q.y); }
  float d2 = dot(rel, rel) / (r * r);
  if (d2 > 1.0) discard;
  // Cut at the joints (vertex shader): what lies past the line through a joint is the neighbour's.
  // Both neighbours compute the same line; the 0.05 px overlap only absorbs rounding.
  if (dot(vCut.xy, q) < -0.05 || dot(vCut.zw, q - vec2(L, 0.0)) > 0.05) discard;
  outReveal = vec4(0.0);
  outFront = vec4(0.0);
  ivec2 px = ivec2(gl_FragCoord.xy);
  // The opaque scene hides what lies behind it.
  if (uOitPass != 0 && gl_FragCoord.z > texelFetch(uOpaqueDepth, px, 0).r) discard;
  if (uOitPass == 1) { outColor = vec4(0.0); return; }
  vec2 nd = rel / r;
  if (L > 0.5 * r) nd.x = 0.0;
  float nz2 = max(1.0 - dot(nd, nd), 0.0);
  vec2 n2 = vec2(-vT.y, vT.x);
  vec3 N = normalize(vec3(vT * nd.x + n2 * nd.y, sqrt(nz2)));
  vec3 L1 = normalize(vec3(-0.35, 0.55, 0.75));
  float diff = max(dot(N, L1), 0.0);
  vec3 H = normalize(L1 + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(N, H), 0.0), 28.0) * 0.18;
  vec3 col = vColor * (0.28 + 0.52 * diff + 0.28 * N.z) + vec3(spec);
  if (uOitPass == 0) { outColor = vec4(col, vAlpha); return; }
  // Premultiplied; the nearest surface apart, the others weighted by their depth across the print.
  vec4 c = vec4(clamp(col, 0.0, 1.0) * vAlpha, vAlpha);
  if (gl_FragCoord.z <= texelFetch(uFrontDepth, px, 0).r) { outFront = c; outColor = vec4(0.0); return; }
  float zv = 2.0 * uNear * uFar / (uFar + uNear - (2.0 * gl_FragCoord.z - 1.0) * (uFar - uNear));
  float z = clamp((zv - uOitDepthRange.x) / (uOitDepthRange.y - uOitDepthRange.x), 0.0, 1.0);
  outColor = c * vAlpha * max(pow(1.0 - z, 3.0), 1e-2);
  outReveal = vec4(-log(1.0 - min(vAlpha, 0.999)));
}
`;

/** Orca's `Translucent_Composite_Fragment_Shader`: the nearest translucent surface over the weighted mean of the others. */
export const OIT_COMPOSITE_VERT = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
export const OIT_COMPOSITE_FRAG = /* glsl */ `
layout(location = 0) out highp vec4 outColor;
uniform highp sampler2D uAccum;
uniform highp sampler2D uReveal;
uniform highp sampler2D uFront;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 front = texelFetch(uFront, px, 0);
  vec4 accum = texelFetch(uAccum, px, 0);
  if (front.a <= 0.0 && accum.a <= 0.0) discard;
  float coverage = accum.a > 0.0 ? 1.0 - exp(-texelFetch(uReveal, px, 0).r) : 0.0;
  vec3 behind = accum.a > 0.0 ? accum.rgb / accum.a * coverage : vec3(0.0);
  float fa = min(front.a, 1.0);
  outColor = vec4(front.rgb + (1.0 - fa) * behind, 1.0 - (1.0 - fa) * (1.0 - coverage));
}
`;

/** Travel / wipe lines (non-instanced LineSegments, per-vertex segment index). */
export const LINE_VERT = /* glsl */ `
${COMMON}
uniform vec3 uTravelColor;
uniform vec3 uWipeColor;
in float aSeg;   // chunk-local segment index
in float aFeat;
out vec3 vColor;
void main() {
  int idx = uBase + int(aSeg + 0.5);
  int feat = int(aFeat + 0.5);
  if (idx < uRangeMin || idx > uRangeMax || uFeatVis[feat] < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vColor = vec3(0.0); return; }
  vColor = feat == 19 ? uWipeColor : uTravelColor;
  if (dot(uSection.xyz, (modelMatrix * vec4(position, 1.0)).xyz) > uSection.w) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const LINE_FRAG = /* glsl */ `
layout(location = 0) out highp vec4 outColor;
in vec3 vColor;
void main() { outColor = vec4(vColor, 1.0); }
`;

/** Retract / unretract / seam markers as round points. */
export const POINT_VERT = /* glsl */ `
${COMMON}
uniform vec3 uKindColor[3];
uniform float uKindVis[3];
uniform float uPointPx;
in float aSeg;
in float aKind;
out vec3 vColor;
void main() {
  int idx = uBase + int(aSeg + 0.5);
  int k = int(aKind + 0.5);
  if (idx < uRangeMin || idx > uRangeMax || uKindVis[k] < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); return; }
  vColor = uKindColor[k];
  if (dot(uSection.xyz, (modelMatrix * vec4(position, 1.0)).xyz) > uSection.w) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z -= 0.0005 * gl_Position.w; // stay on top of the bead it sits on
  gl_PointSize = uPointPx;
}
`;

export const POINT_FRAG = /* glsl */ `
layout(location = 0) out highp vec4 outColor;
in vec3 vColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  outColor = vec4(vColor * (0.75 + 0.25 * (1.0 - d)), 1.0);
}
`;
