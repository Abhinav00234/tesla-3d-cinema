# Cinema Sound for Android

Make any song sound like a movie in a cinema hall.

Cinema Sound plays your song through the sound engine of the 3D cinema player in this repository, the same one you hear when you watch a movie there. Nothing is changed (except that a mono song plays on both front speakers, where the 3D Cinema would use the left one only): the same six virtual speakers, in the same places, at the same levels, heard from the same seats:

| Speaker | What it plays | Where it is |
|---|---|---|
| Front left and right | The song's left and right | At the edges of the screen |
| Centre | The centre channel of 5.1 files (silent for songs, as in the cinema) | Behind the screen |
| Subwoofer | The bass below 120 Hz | Under the screen |
| Surround left and right | A quiet copy of left and right, 45 ms late (plus the surround channels of 5.1 files) | High on the side walls |

On top of that comes the hall's reverb (3.5 seconds) and the cinema's compressor. With the sliders in the middle, the result is the same as the 3D Cinema to within rounding: `tools/compare.js` renders a song through both engines and checks it.

## 3D Cinema or Movie theatre

The **Sound** setting picks the cinema:

- **3D Cinema**: exactly the 3D Cinema app, as above.
- **Movie theatre**: the same room set up like a real cinema:
  - surround speakers all along the side walls and on the back wall (8 instead of 2), each a few milliseconds later than the one before it, so the sound wraps around the room
  - a stronger subwoofer that plays only the deep bass (a steeper filter at 120 Hz)
  - a short, natural echo (1.2 seconds) with reflections off the walls, instead of the 3D Cinema's long 3.5 seconds; real cinemas are acoustically damped
  - the gentle treble roll-off cinemas are tuned to (the SMPTE X-curve)

## Headphones or car speakers

The 3D Cinema places the speakers around you with 3D audio (HRTF). That is made for headphones: each ear gets its own signal. Played through a car, the car only receives two channels (left and right) from the phone or browser, and its sound system decides which of its speakers play them. 3D audio doesn't tell it anything about the rear, so the rear speakers get little.

**Car speakers** mixes the same cinema for that. The screen speakers are panned left and right, and the surround speakers are encoded the way Dolby Pro Logic II encodes surround: in both channels, with opposite signs. A car's surround processing recognises this and sends it to the rear speakers. Turn that processing on in the car if it has it (on a Tesla it is **Immersive Sound**, in the audio settings). Without it the song still plays as a wide stereo mix.

Cinema Sound can't drive the car's speakers one by one: over Bluetooth, USB or the car's browser, the car only gets left and right.

## 5.1 files for a home theatre

**5.1 system** saves a 6-channel file (front left, front right, centre, LFE, surround left, surround right) instead of 3D audio. Each speaker of the cinema goes to its channel, at the level you would hear it from your seat, and the hall's echo also goes to the surround channels. Play it on a home theatre, or with a player that handles 5.1, such as VLC or Kodi.

- The LFE channel is stored 10 dB down, as 5.1 players expect (they turn it up by 10 dB).
- The centre channel is silent for a stereo song, as in the cinema. It plays the centre of 5.1 songs.
- The preview on the phone plays the file folded down to stereo.
- A 5.1 file is three times the size of a stereo one: about 150 MB for 5 minutes.

## Using it

1. Tap **Songs on this phone** to list the music on your phone and SD card, and tap a song (search by title or artist). The first time, Android asks to allow access to your music. Or tap **Choose a song file** to pick any MP3, M4A, WAV, FLAC or OGG file.
2. Pick the **Sound**: **3D Cinema** or **Movie theatre** (see above).
3. Pick **Your seat**: the same four seats as in the 3D Cinema.
4. Pick what you are **Listening on**: **Headphones** (3D sound), **Car speakers** or **5.1 system** (see above).
5. Change **Bass**, **Surround** and **Hall echo** if you like; the middle is the cinema's own level. Tap play to hear it, and switch between **Cinema** and **Original** to compare.
6. Tap **Convert and save**. The song is saved as a WAV file in **Music/Cinema Sound**, so music players find it.

Everything happens on the phone. Songs are not uploaded anywhere and the app needs no internet.

## Getting the app

**[Download CinemaSound.apk](https://github.com/Abhinav00234/tesla-3d-cinema/releases/download/cinema-sound/CinemaSound.apk)** and open it on your phone (Android 8 or newer). Android asks you to allow installing apps from your browser or file manager the first time.

GitHub Actions builds the APK on every change to this folder and puts the newest one on that link. Each build is signed with the same key (`android/cinema-sound.keystore`), so a new APK installs as an update over the old one.

To build it yourself you need JDK 17 and the Android SDK (Android Studio has both):

```bash
cd cinema-sound/android
./gradlew assembleDebug
# app/build/outputs/apk/debug/app-debug.apk
```

## How it is built

- `web/` is the whole app: `js/engine.js` is the sound engine (Web Audio API), `js/app.js` the screen. Open `web/index.html` in a desktop browser to try it; saving then downloads the file.
- `android/` is a small Java app that shows `web/` in a WebView, lists the phone's songs from the Android music library, opens the file picker and saves converted songs through MediaStore. It uses no libraries beyond Android itself.
- `tools/compare.js` checks the engine against the 3D Cinema's three.js code (see the top of the file for how to run it).
- The preview and the converted file go through the same sound graph, so what you hear is what you save. Converting renders the song faster than real time with an `OfflineAudioContext`, in 30-second pieces that are written to the file one by one, so the converted song is never held in memory whole. Each piece starts 4 seconds early so the echo and compressor carry over. The level is evened out to a peak of -1 dB.
- A 5-minute song takes about 50 MB as a stereo WAV, 150 MB as 5.1. Very long tracks (over 20 minutes) may still run out of memory on older phones when they are opened.
