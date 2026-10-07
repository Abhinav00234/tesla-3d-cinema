# Project notes

What this project is, how it is put together, what changed from the original, and what has and hasn't been tested. Written October 2026.

## The idea

Car browsers are ordinary web browsers on a big touchscreen. A page served from your own computer or phone can therefore be a movie player. The original 3D Web Cinema Player by Amit Sikdar already rendered a cinema hall and streamed local files, but only on the computer that ran it. This edition makes it usable from a car.

## How it is built

```
Browser (car, laptop, phone)                 Server (your computer or phone)
----------------------------                 -------------------------------
index.html + js/ + css/        <---------    static files (only these folders are served)
library.js   -- GET /api/movies ------->     reads the movies folder, probes each file
ui.js        -- GET /stream/<file> ---->     sends the video file, with byte ranges
audioManager -- GET /audio/<file>/<n> ->     FFmpeg turns one sound track into Opus, live
videoManager -- GET /subtitles/... ---->     FFmpeg turns one subtitle track into WebVTT
library.js   -- POST /api/convert/... ->     FFmpeg makes Name.car.mp4 (H.264 + AAC)
```

Front end files:

| File | Job |
|---|---|
| `js/main.js` | Sets up three.js, the render loop and the picture quality modes |
| `js/ui.js` | Player controls, gestures, option panels, opening and closing a movie |
| `js/library.js` | Library screen, dialogs, converting, help |
| `js/videoManager.js` | The video element, loading, subtitles, screen glow |
| `js/audioManager.js` | Surround sound, separate sound tracks, keeping sound in step |
| `js/store.js` | Settings and watch progress in the browser's storage |
| `js/api.js` | Requests to the server |
| `js/room.js`, `screen.js`, `seats.js`, `stage.js`, `lighting.js` | The 3D cinema (original project) |

## What changed from the original, and why

1. **It could not work from another device.** Every request went to `http://localhost:3000`, which in a car means the car itself. All requests are now relative to the page's own address.
2. **three.js came from a CDN.** A car on a phone hotspot may have no internet. three.js is now an npm dependency served by the server, and web fonts were removed.
3. **The whole project folder was served as web pages**, including the server code and anything else in it. Only `css`, `js`, `assets` and three.js are served now. Movie names are checked so a request can't reach files outside the movies folder.
4. **No access control.** Added an optional PIN with a signed cookie and a limit on wrong tries.
5. **Format support.** Car browsers generally can't play HEVC. The library asks the browser what it can play, marks the rest "Needs Converting", and the server can make an H.264 copy. HDR sources are tone mapped when the FFmpeg build supports it.
6. **Sound started late.** Separate sound tracks come from a live FFmpeg stream that needs a moment to start, so sound lagged behind the picture. The picture is now held until the sound is ready, and a drift check restarts the sound if it slips (at most 3 times in a row, so it can't loop).
7. **Volume and speed did nothing** when a separate sound track was playing. They now act on the whole mix.
8. **Touch.** The controls were small mouse controls. Everything is at least 56px tall, with tap, double-tap and drag gestures, and each gesture also has a button.
9. **Weak graphics chips.** Added the Smooth quality mode (no bloom, no anti-aliasing, 1x resolution) and a flat view with no 3D. The 3D room is not drawn while the library covers it.
10. **Frame rate.** The room had 31 lights, and three.js shades every visible light on every pixel, even at brightness 0. The step, exit and LED lights are now glowing shapes only, the house lights are hidden while off, the seats use a cheaper material, the glow effect runs at half resolution, and only Best uses the costly area light for the screen glow (the others use a spotlight matched to it). On a laptop's Intel graphics at 1920x1080, Auto went from 23 to 60 fps. The glow pipeline also ignored the sharpness setting; it now follows it.
11. **Android.** The bundled FFmpeg doesn't exist for Android, which made `npm install` fail. It is optional now and the server falls back to the system FFmpeg.

## Design

The interface follows `DESIGN.md`, a Tesla-inspired system from the awesome-design-md collection, in its dark form: one blue accent for the main action, flat surfaces with no shadows or gradients, two font weights, 4px controls and 12px cards. Two deliberate differences: controls are 56px tall instead of 40px because they are pressed with a finger at arm's length, and the bars over the movie are semi-transparent so the controls stay readable on any picture.

The page was also checked against Vercel's Web Interface Guidelines. That led to: labels on icon buttons, live regions for messages, hidden controls taken out of the keyboard order, focus kept inside dialogs, a visible focus ring on the seek bar, reduced-motion support, animating only transform and opacity, safe-area padding and image sizes that prevent layout jumps.

## What was tested

- `npm test`: 8 server tests (library, file safety, static files, byte ranges, subtitles and audio output, PIN flow, lockout, converting).
- A scripted run in desktop Chrome with a real graphics card: open the library, play an H.264 movie, turn on subtitles, seek by double-tap, change seat and lights, switch to the flat view, pause, return to the library, convert an HEVC movie, play the copy, switch sound track. Sound stayed within 0.02 seconds of the picture in that run.
- That Chrome has no HEVC support, so it behaves like a car browser for the "Needs Converting" path.
- The Termux guide on an Android 14 emulator: install, library, byte ranges, a separate sound track and converting a short HEVC clip. It also read movies straight from an SD card. This found a crash on start: `ffprobe-static` calls `process.exit()` on Android, so the bundled FFmpeg packages are now skipped there.

## What was not tested

- A real car. Frame rate in the 3D view, the full screen workaround and the exact formats the car's browser supports are unknown until someone tries.
- A real Android phone, its hotspot, and USB sticks through OTG (the emulator used an SD card).
- The Docker files (Docker was not available where this was written).
- A full-length conversion. The conversion was tested with short clips.
- Slow or lossy connections.

## Ideas for later

- Live transcoding, so a movie can be watched without converting first.
- Folders and series in the library.
- Per-person watch progress stored on the server.
- A built-in, safe way to reach the server over the internet.
