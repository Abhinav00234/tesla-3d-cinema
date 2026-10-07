# Running the server on an Android phone (Termux)

The phone holds the movies and runs the server. The car connects to the phone's WiFi hotspot and opens the phone's address. Nothing goes over mobile data.

These steps were tested on an Android 14 emulator with Termux 0.118.3 from F-Droid: install, library, streaming, separate sound tracks and converting all worked. They have not been tried on a real phone yet. The server uses Termux's own FFmpeg because the bundled one doesn't exist for Android.

## 1. Install Termux

Get Termux from **F-Droid**, not the Play Store (that version is outdated): https://f-droid.org/packages/com.termux/

## 2. Install the tools

```bash
pkg update && pkg upgrade
pkg install nodejs-lts git ffmpeg
termux-setup-storage   # tap "Allow"
```

`termux-setup-storage` creates `~/storage/shared`, which is the phone's normal storage (Downloads, Movies and so on).

## 3. Get the project

```bash
cd ~
git clone https://github.com/Abhinav00234/tesla-3d-cinema.git
cd tesla-3d-cinema
npm install
```

If `npm install` prints warnings about `ffmpeg-static`, that is expected on a phone. Those parts are optional and the server uses the FFmpeg from step 2.

## 4. Point it at your movies

Put your movies in the phone's `Movies` folder, then:

```bash
cp config.example.json config.json
```

Open `config.json` (for example with `nano config.json`) and set:

```json
"moviesDir": "~/storage/shared/Movies"
```

### Movies on a USB stick or SD card

Movies can stay on a USB stick (through a USB-C OTG adapter) or an SD card. Plug it in, then find its name:

```bash
df -h | grep storage
```

It shows up as something like `/storage/293D-1B0F`. Use that path in `config.json`:

```json
"moviesDir": "/storage/293D-1B0F/Movies"
```

Type the full path. `ls /storage` gives "Permission denied" in Termux, but the stick's own folder can still be read. The name changes if the stick is formatted again. Some phones don't let apps read USB sticks at all; if the library stays empty, copy the movies to the phone instead.

## 5. Start it

```bash
cd ~/tesla-3d-cinema
termux-wake-lock     # stops Android from putting Termux to sleep
npm start
```

You should see the `Same WiFi/hotspot` address, for example `http://192.168.43.1:3000`.

## 6. Connect the car

1. Turn on the phone's hotspot.
2. On the car's screen go to **Controls > WiFi**, pick the hotspot and save it. The car reconnects by itself next time.
3. Open the car's browser and type the address from step 5. It can change when the hotspot is restarted, so check Termux if it stops working.

## Good to know

- Also set **Settings > Apps > Termux > Battery** to **Unrestricted**.
- A phone is slow at converting movies. Convert them on a computer first: run the server there, tap the movie, and copy the finished `Name.car.mp4` to the phone.
- The car and the phone have to stay on the same hotspot.
