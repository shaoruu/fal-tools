# @fal-tools/audio

Objective audio processing and QA for `fal-tools`. The package invokes
user-installed `ffmpeg` and `ffprobe` from `PATH`; it never bundles FFmpeg.
Checks cover decode, duration, peak, clipping, tail energy, seam delta, and
quarter energy.
