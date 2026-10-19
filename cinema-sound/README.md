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

## Headphones or car speakers

The 3D Cinema places the speakers around you with 3D audio (HRTF). That is made for headphones: each ear gets its own signal. Played through a car, the car only receives two channels (left and right) from the phone or browser, and its sound system decides which of its speakers play them. 3D audio doesn't tell it anything about the rear, so the rear speakers get little.

**Car speakers** mixes the same cinema for that. The screen speakers are panned left and right, and the surround speakers are encoded the way Dolby Pro Logic II encodes surround: in both channels, with opposite signs. A car's surround processing recognises this and sends it to the rear speakers. Turn that processing on in the car if it has it (on a Tesla it is **Immersive Sound**, in the audio settings). Without it the song still plays as a wide stereo mix.

Cinema Sound can't drive the car's speakers one by one: over Bluetooth, USB or the car's browser, the car only gets left and right.

## Using it

1. Tap **Songs on this phone** to list the music on your phone and SD card, and tap a song (search by title or artist). The first time, Android asks to allow access to your music. Or tap **Choose a song file** to pick any MP3, M4A, WAV, FLAC or OGG file.
2. Pick **Your seat**: the same four seats as in the 3D Cinema.
3. Pick what you are **Listening on**: **Headphones** (exactly the 3D Cinema) or **Car speakers** (see above).
4. Change **Bass**, **Surround** and **Hall echo** if you like; the middle is the 3D Cinema's own level. Tap play to hear it, and switch between **Cinema** and **Original** to compare.
5. Tap **Convert and save**. The song is saved as a WAV file in **Music/Cinema Sound**, so music players find it.

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
- The preview and the converted file go through the same sound graph, so what you hear is what you save. Converting renders the song faster than real time with an `OfflineAudioContext` and evens the level out to a peak of -1 dB.
- A 5-minute song takes about 50 MB as WAV. Very long tracks (over 15 minutes) may run out of memory on older phones.
