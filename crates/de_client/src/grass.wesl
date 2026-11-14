// Discover Earth grass: blades bent by the wind, shrunk away with distance.
//
// Per vertex: uv.x across the blade (-1..1), uv.y up it (0 root, 1 tip); uv_b.x the blade's
// height in metres, uv_b.y its tuft's `keep` (see de_world::grass). The fragment stage is
// Bevy's own PBR, lit with the ground's normal that every blade carries.
//
// Wind: gusts are waves of bending that run across the meadow at the wind's speed (what you
// see roll over a field), plus a quick flutter. Time is game time, so captures repeat exactly.

import bevy_pbr::render::{
    forward_io::{Vertex, VertexOutput, decompress_vertex},
    mesh_functions,
    view_transformations::position_world_to_clip,
    mesh_view_bindings::{view, globals},
};

struct GrassParams {
    // Wind direction (x, z), speed m/s, sway.
    wind: vec4<f32>,
    // Level of detail: near_m, far_m.
    lod: vec4<f32>,
}

@group(constants::MATERIAL_BIND_GROUP) @binding(100) var<uniform> grass: GrassParams;

// A blade's typical half width in metres (see grass.rs).
const BLADE_HALF_WIDTH: f32 = 0.009;

@vertex
fn vertex(vertex_in: Vertex) -> VertexOutput {
    let vertex = decompress_vertex(vertex_in, vertex_in.instance_index);
    var out: VertexOutput;
    let world_from_local = mesh_functions::get_world_from_local(vertex_in.instance_index);
    var p = mesh_functions::mesh_position_local_to_world(world_from_local, vec4<f32>(vertex.position, 1.0));
    let up = vertex.uv.y;
    let h = vertex.uv_b.x;
    let keep = vertex.uv_b.y;
    let t = globals.time;

    // Level of detail: 1 near, (near / d)^2 further, 0 past far. A tuft sinks into the ground
    // as the level falls through its `keep`.
    let d = length(p.xyz - view.world_position);
    let lod = select(select((grass.lod.x / d) * (grass.lod.x / d), 0.0, d >= grass.lod.y), 1.0, d <= grass.lod.x);
    let grow = select(saturate((lod - keep) / 0.08), 1.0, lod >= 1.0);
    p.y -= up * h * (1.0 - grow);
    // Far away fewer tufts are drawn; widen their blades (across the view, so the depth
    // prepass can do the same without tangents) so the meadow keeps its cover.
    let widen = min(inverseSqrt(max(lod, 0.02)), 4.0) - 1.0;
    let to_eye = view.world_position - p.xyz;
    let across = normalize(vec3(-to_eye.z, 0.0, to_eye.x) + vec3(1e-4, 0.0, 0.0));
    p = vec4(p.xyz + across * (BLADE_HALF_WIDTH * vertex.uv.x * widen), 1.0);

    // Wind.
    let dir = grass.wind.xy;
    let speed = grass.wind.z;
    let along = dot(p.xz, dir);
    let gust = 0.5 + 0.5 * sin(0.3 * (along - speed * t));
    let flutter = 0.15 * sin(t * 6.3 + dot(p.xz, vec2(1.7, 2.3)) * 2.0);
    let bend = grass.wind.w * (speed / 10.0) * h * up * up * (0.35 + 0.65 * gust + flutter);
    p.x += dir.x * bend;
    p.z += dir.y * bend;
    p.y -= 0.5 * bend * bend / max(h, 0.05) * up;

    out.world_position = p;
    out.position = position_world_to_clip(p.xyz);
    out.world_normal = mesh_functions::mesh_normal_local_to_world(vertex.normal, vertex_in.instance_index);
    @if(VERTEX_UVS_A)
    out.uv = vertex.uv;
    @if(VERTEX_UVS_B)
    out.uv_b = vertex.uv_b;
    @if(VERTEX_COLORS)
    // Darker at the root, where the blades shade each other; lighter tips, where light comes through.
    out.color = vec4(vertex.color.rgb * mix(0.6, 1.25, up), 1.0);
    @if(VERTEX_OUTPUT_INSTANCE_INDEX)
    out.instance_index = vertex_in.instance_index;
    return out;
}
