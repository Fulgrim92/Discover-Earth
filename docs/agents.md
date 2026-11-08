# Seeing what you changed

An agent cannot watch the game, so everything it needs to judge a change comes out as files or JSON.

## Captures (`de-shot`)

```
cargo run -q -p de_client --bin de-shot -- content/shots/smoke.json out/shots
```

Plays a step list against the real client drawn offscreen (software Vulkan without a GPU; on Linux install
`mesa-vulkan-drivers`). Every frame is exactly 1/60 s of game time and pipelines compile before the first frame, so
the same list gives the same pixels on every run on one machine. Steps (`de schema steps`):

| Step | Does |
| --- | --- |
| `{"view": "valley"}` | jump to a named view of the island |
| `{"camera": {"pos": [x,y,z], "look_at": [x,y,z]}}` | place the camera anywhere |
| `{"wait": 30}` | let frames pass |
| `{"shot": "name"}` | save `out/name.png` |
| `{"fly": {"name": "clip", "to": "lagoon", "frames": 90}}` | fly to a view, saving every frame and `out/clip.mp4` |
| `{"drone": {"frames": 240, "mode": "cine", "sticks": {"pitch": 1, "yaw": -0.25}, "clip": "name"}}` | fly the drone with sticks held, like a pilot; `clip` saves frames and an mp4 |
| `"state"` | print camera, drone (mode, speed, heading, gimbal), ground height and altitude as one JSON line |

`content/shots/drone.json` flies the valley in cine and sport mode. To judge how flying feels, read the `state`
lines (speed, braking, altitude) and watch the clips. The flight model is `de_world::drone`, tested without a GPU.

On a software renderer a 1280x720 shot takes well under a second and a 90-frame clip about 40 s.

## The live game (Bevy Remote Protocol)

`discover-earth` listens on `http://127.0.0.1:15702` (JSON-RPC). Find the camera and read where it is:

```
curl -s -X POST http://127.0.0.1:15702 -d '{"jsonrpc":"2.0","id":1,"method":"world.query","params":{
  "data":{"option":["bevy_transform::components::transform::Transform"]},
  "filter":{"with":["de_client::scene::CameraRig"]}}}'
```

`world.list_components`, `world.get_components`, `world.insert_components` and `world.mutate_components` work the same
way on any reflected component (`rpc.discover` lists every method). Entities carry a `Name` (`terrain`, `sea`, `sky`,
`sun`, `camera`).
