#!/data/data/com.termux/files/usr/bin/bash
# One-step setup for Termux on Android. Run it again any time to start fresh.
# It removes the old ~/tesla-3d-cinema folder (never your movies) and sets everything up again.
set -e

REPO="https://github.com/Abhinav00234/tesla-3d-cinema.git"
APP="$HOME/tesla-3d-cinema"

say() { printf '\n\033[1;34m== %s\033[0m\n' "$1"; }

if [ -z "$PREFIX" ] || [ ! -d /data/data/com.termux ]; then
  echo "Run this inside the Termux app on an Android phone."
  exit 1
fi

say "Installing Node.js, git and FFmpeg (this takes a few minutes)"
pkg update -y
pkg upgrade -y -o Dpkg::Options::=--force-confnew
pkg install -y nodejs-lts git ffmpeg

say "Storage permission"
if [ ! -d "$HOME/storage/shared" ]; then
  echo "Tap Allow in the box that appears."
  termux-setup-storage
  for i in $(seq 1 60); do [ -d "$HOME/storage/shared" ] && break; sleep 1; done
fi
if [ ! -d "$HOME/storage/shared" ]; then
  echo "No storage permission. Run termux-setup-storage, tap Allow, then run this setup again."
  exit 1
fi

say "Removing any old setup"
cd "$HOME"
rm -rf "$APP"

say "Downloading Cinema 3D"
git clone --depth 1 "$REPO" "$APP"
cd "$APP"
npm install --no-fund --no-audit

say "Finding your movies"
# A USB stick or SD card shows up as /storage/XXXX-XXXX. Use its Movies folder if it has one.
MOVIES="$HOME/storage/shared/Movies"
for vol in $(df 2>/dev/null | awk '$NF ~ /^\/storage\/[0-9A-F]{4}-[0-9A-F]{4}$/ {print $NF}'); do
  if [ -d "$vol/Movies" ]; then MOVIES="$vol/Movies"; break; fi
done
mkdir -p "$MOVIES" 2>/dev/null || true
cat > config.json <<EOF
{
  "port": 3000,
  "moviesDir": "$MOVIES",
  "thumbnailsDir": "thumbnails",
  "pin": ""
}
EOF
echo "Movies folder: $MOVIES"

say "Adding the cinema command"
cat > "$PREFIX/bin/cinema" <<EOF
#!$PREFIX/bin/bash
cd "$APP" || { echo "Cinema 3D is not installed. Run the setup again."; exit 1; }
termux-wake-lock 2>/dev/null || true
exec npm start
EOF
chmod +x "$PREFIX/bin/cinema"

say "Done"
echo "Put your movies in: $MOVIES"
echo "Then turn on your hotspot and type:  cinema"
echo "Open the 'Same WiFi/hotspot' address it shows in the car's browser."
