# Example animations

These silent GIFs illustrate the bundled examples. They reuse the public scene
model in `web/walkthrough-data.js` and the Console's dark palette. They contain
simulated business data, not production recordings or runtime configuration.
When you run an example in the Console, its live animation uses saved execution
state instead of this illustrative timeline.

To rebuild, install Python 3 with Pillow and FFmpeg, then run from the repo root:

```sh
python3 scripts/render-readme.py
```

`--stills` produces review frames without encoding GIFs. Temporary frames are
stored under Git-ignored `.local/readme-animations/`. Outputs are 1080 × 720,
12 fps, looped, with five seconds per stage. The renderer checks clipping,
frame counts and random-access determinism. Pillow 12.3.0 was used for these
renders. It uses system Arial or DejaVu Sans; custom regular and bold font paths
can be supplied with `TISONA_ANIMATION_FONT` and `TISONA_ANIMATION_BOLD_FONT`.
Reproducing identical pixels requires the same font files and renderer versions.

The scene model, render code and generated artwork follow this repository's
Apache-2.0 license. System font files are not distributed. There is no external
footage or audio. Visual direction follows Siddon Visual Engineering v2;
the Dark Tech Keynote grammar was consulted at lemo-opuscar revision
`ded40b25679fe5d5dcfc07a282a25da1ceee3be1`. No demo plot or assets were copied.
