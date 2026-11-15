// Discover Earth grass, depth prepass: the same bending and shrinking as `grass.wesl`'s vertex
// stage (keep the two in step), so the clouds, mist and atmosphere, which read the prepass
// depth, see the blades where they are drawn. A mismatch shows: widened blades that were
// missing here came out white.

import bevy_pbr::{
    prepass::io::{Vertex, VertexOutput, decompress_vertex},
    render::{
        mesh_functions,
        view_transformations::position_world_to_clip,
        mesh_view_bindings::view,
    },
};
import bevy_render::globals::Globals;

// The prepass binds the globals (time) at 1, not where the main pass has them.
@group(0) @binding(1) var<uniform> globals: Globals;

struct GrassParams {
    wind: vec4<f32>,
    lod: vec4<f32>,
}

@group(constants::MATERIAL_BIND_GROUP) @binding(100) var<uniform> grass: GrassParams;

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

    let d = length(p.xyz - view.world_position);
    let lod = select(select((grass.lod.x / d) * (grass.lod.x / d), 0.0, d >= grass.lod.y), 1.0, d <= grass.lod.x);
    let grow = select(saturate((lod - keep) / 0.08), 1.0, lod >= 1.0);
    p.y -= up * h * (1.0 - grow);
    let widen = min(inverseSqrt(max(lod, 0.02)), 4.0) - 1.0;
    let to_eye = view.world_position - p.xyz;
    let across = normalize(vec3(-to_eye.z, 0.0, to_eye.x) + vec3(1e-4, 0.0, 0.0));
    p = vec4(p.xyz + across * (0.009 * vertex.uv.x * widen), 1.0);

    let dir = grass.wind.xy;
    let speed = grass.wind.z;
    let along = dot(p.xz, dir);
    let gust = 0.5 + 0.5 * sin(0.3 * (along - speed * t));
    let flutter = 0.15 * sin(t * 6.3 + dot(p.xz, vec2(1.7, 2.3)) * 2.0);
    var stiff = 1.0;
    @if(VERTEX_COLORS)
    stiff = vertex.color.a;
    let bend = stiff * grass.wind.w * (speed / 10.0) * h * up * up * (0.35 + 0.65 * gust + flutter);
    p.x += dir.x * bend;
    p.z += dir.y * bend;
    p.y -= 0.5 * bend * bend / max(h, 0.05) * up;

    out.world_position = p;
    out.position = position_world_to_clip(p.xyz);
    @if(VERTEX_UVS_A)
    out.uv = vertex.uv;
    @if(VERTEX_UVS_B)
    out.uv_b = vertex.uv_b;
    @if(NORMAL_PREPASS_OR_DEFERRED_PREPASS)
    out.world_normal = mesh_functions::mesh_normal_local_to_world(vertex.normal, vertex_in.instance_index);
    @if(VERTEX_COLORS)
    out.color = vertex.color;
    @if(MOTION_VECTOR_PREPASS)
    out.previous_world_position = p;
    @if(VERTEX_OUTPUT_INSTANCE_INDEX)
    out.instance_index = vertex_in.instance_index;
    return out;
}
