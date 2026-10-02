# Credits

## The original project

This is a fork of the **3D Web Cinema Player** by Amit Sikdar.

- Author: Amit Sikdar, https://github.com/amitsikdar37
- Source: https://github.com/amitsikdar37/am1t_builds (folder `3D Theater Webplayer`)
- Setup video by the author: https://youtu.be/c6N1C23bfd8

His work, kept in this edition: the 3D cinema room (walls, seats, stage, curtains, lighting), the curved screen with masking for wide films, subtitles drawn on the screen, the 5.1 surround sound engine with speakers placed in the room, the screen glow that follows the picture, and the server idea of streaming the file and transcoding audio and subtitles with FFmpeg.

The git history of this repository keeps his commits, so each of his changes is still credited to him.

**About the licence.** The original project's `package.json` declares the ISC licence, and this edition is published under the same licence on that basis. The original repository has no separate licence file. If you are the original author and want this handled differently, open an issue and it will be changed.

## Changes in this edition

By Abhinav Sharma (https://github.com/Abhinav00234):

- The page talks to whatever address it was opened from, so it works from another device (the original only worked on the computer running the server).
- Touch interface: library, Continue Watching, option panels, gestures, flat view, picture quality modes.
- Converting movies to a format car browsers can play.
- PIN lock, safe file handling, and only the needed folders are served.
- Sound and picture start together, the volume and speed controls work with separate sound tracks, and drifting sound is corrected.
- Settings file, system FFmpeg fallback (for Android), tests, Docker files, documentation.

## Third-party material

| What | Licence | Used for |
|---|---|---|
| [three.js](https://threejs.org/) | MIT | 3D rendering |
| [Express](https://expressjs.com/) | MIT | Web server |
| [fluent-ffmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg) | MIT | Running FFmpeg |
| [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | GPL-3.0-or-later | Optional bundled FFmpeg program, downloaded at install. It runs as a separate program and is not part of this code |
| [ffprobe-static](https://github.com/joshwnj/ffprobe-static) | MIT | Optional bundled FFprobe program |
| Material Design icons | Apache-2.0 | Control icons |
| `DESIGN.md` from [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) | MIT | The visual rules the interface follows. It is a description of a design style, written by that project, and is not an official Tesla document |

Tesla is a trademark of Tesla, Inc. This project is not affiliated with or endorsed by Tesla, Inc.
