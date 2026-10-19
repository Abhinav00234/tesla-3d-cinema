# Cinema Sound for Android

Make any song sound like a movie in a cinema hall.

Cinema Sound uses the sound engine of the 3D cinema player in this repository. The player places the 5.1 channels of a movie on speakers in a 3D theatre, adds the reverb of the hall and sends the bass to a subwoofer. A song only has two channels, so Cinema Sound first splits it into cinema channels, the way a cinema sound processor does, and then plays them in the same theatre:

| Channel | What goes there | Where it plays |
|---|---|---|
| Left and right | The song's own sides | Behind the screen, left and right |
| Centre | What both sides share (mostly the voice) | Behind the middle of the screen |
| Subwoofer | The shared bass below 110 Hz | Under the screen |
| Surround | What differs between the sides (the room and the ambience), slightly delayed | Side walls and back wall |

You hear it all from the seat you pick, with the delay and loudness that distance gives each speaker, and the echo of the hall.

## Using it

1. Tap **Choose a song** and pick an MP3, M4A, WAV, FLAC or OGG file.
2. Pick the **Hall** (screening room, cinema or IMAX) and **Your seat** (front, middle or back row).
3. Pick what you are **Listening on**:
   - **Headphones**: 3D sound placed all around you, also behind. Use this with headphones or earbuds.
   - **Speakers**: a wide cinema sound for phone, car or room speakers.
4. Set **Bass**, **Surround** and **Hall echo**, and tap play to hear it. Switch between **Cinema** and **Original** to compare.
5. Tap **Convert and save**. The song is saved as a WAV file in **Music/Cinema Sound**, so music players find it.

Everything happens on the phone. Songs are not uploaded anywhere and the app needs no internet.

## Getting the app

The APK is built by GitHub Actions on every change to this folder: open the **Actions** tab, pick the latest **Cinema Sound APK** run and download `cinema-sound-apk`. Unzip it and open `app-debug.apk` on the phone (Android 8 or newer). Android asks you to allow installing apps from your browser or file manager the first time.

To build it yourself you need JDK 17 and the Android SDK (Android Studio has both):

```bash
cd cinema-sound/android
./gradlew assembleDebug
# app/build/outputs/apk/debug/app-debug.apk
```

## How it is built

- `web/` is the whole app: `js/engine.js` is the sound engine (Web Audio API), `js/app.js` the screen. Open `web/index.html` in a desktop browser to try it; saving then downloads the file.
- `android/` is a small Java app that shows `web/` in a WebView, opens the Android file picker and saves converted songs through MediaStore. It uses no libraries beyond Android itself.
- The preview and the converted file go through the same sound graph, so what you hear is what you save. Converting renders the song faster than real time with an `OfflineAudioContext` and evens the level out to a peak of -1 dB.
- A 5-minute song takes about 50 MB as WAV. Very long tracks (over 15 minutes) may run out of memory on older phones.
