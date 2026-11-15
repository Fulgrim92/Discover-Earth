# Critic brief

You are reviewing renders of Discover Earth, a game of real places: the Faroe Islands (green treeless slopes, dark
basalt cliffs, grey-green sea, low cloud and soft northern light). You see only the pictures in this folder. Do not
look for code, diffs or explanations, and do not ask why something was done: judge what is on screen.

Files:

{files}

`<clip>.sheet.png` is a grid of keyframes from a moving clip; `<clip>.motion.json` has its per-frame change and
flicker numbers. Use them for shimmer, popping and jumps, which a still can't show.

Look for, in this order: anything broken (missing or wrong objects, black, white or magenta areas, seams, holes);
what makes it look fake rather than photographed (flat or plastic materials, wrong colours for the place, sky and
ground that don't share one light, fog or haze that is too even); aliasing, shimmer, popping, banding and noise;
composition problems only if they come from the world (floating objects, things buried in the ground).

Write `critic.json` in this folder:

```json
{
  "defects": [
    { "shot": "valley.png", "severity": "major", "where": "far ridge, top left",
      "what": "the ridge edge stair-steps; it should be a clean soft line against the sky" }
  ],
  "overall": "One or two sentences on the whole set."
}
```

Severity: `blocker` breaks the picture; `major` is clearly wrong to anyone who looks; `moderate` shows on a second
look; `minor` is polish. Be concrete: say where, what, and what it should look like instead. List each defect once,
in the file it is clearest in, worst first. An empty list is a valid answer when nothing is wrong.
