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
`;

export const EXTRUSION_VERT = /* glsl */ `
${COMMON}
uniform vec3 uFeatColor[32];
uniform vec3 uToolColor[16];
uniform int uScheme;        // 0 feature, 1 tool, 2 numeric
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

// Constant-index form (unrolled) — avoids dynamic uniform-array indexing.
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0) * 10.0;
  vec3 c = uRamp[0];
  for (int k = 0; k < 10; k++) c = mix(c, uRamp[k + 1], clamp(t - float(k), 0.0, 1.0));
  return c;
}

void hide() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vQ = vec4(0.0); vCap = vec4(0.0); vT = vec2(1.0, 0.0); vColor = vec3(0.0);
}

void main() {
  int idx = uBase + gl_InstanceID;
  int feat = int(aMeta.x + 0.5);
  if (idx < uRangeMin || idx > uRangeMax || uFeatVis[feat] < 0.5 || aWH.x <= 0.0) { hide(); return; }

  vec3 d = aEnd - aStart;
  float len = length(d);
  vec3 dir = len > 1e-6 ? d / len : vec3(1.0, 0.0, 0.0);
  vec3 mid = 0.5 * (aStart + aEnd);
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

  vec4 vs = modelViewMatrix * vec4(aStart, 1.0);
  vec4 ve = modelViewMatrix * vec4(aEnd, 1.0);
  float zc = -uNear * 1.001;
  if (vs.z > zc && ve.z > zc) { hide(); return; }
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

  vec3 col;
  if (uScheme == 0) col = uFeatColor[feat];
  else if (uScheme == 1) col = uToolColor[int(aMeta.y + 0.5) & 15];
  else col = ramp((aValue - uVMin) / max(uVMax - uVMin, 1e-9));
  if (uDimBelow > 0.0 && idx < uTopStart) col *= 1.0 - uDimBelow;
  vColor = col;
}
`;

export const EXTRUSION_FRAG = /* glsl */ `
layout(location = 0) out highp vec4 outColor;
in vec4 vQ;
flat in vec4 vCap;
flat in vec2 vT;
flat in vec3 vColor;

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
  outColor = vec4(col, 1.0);
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
