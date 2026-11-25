# spotify-keys

Control Spotify from i3 hotkeys without leaving the editor: play/pause, skip, like, and add to my coding playlist.

## Setup
```
sudo apt install playerctl libnotify-bin
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp config.example.json ~/.config/spotify-keys/config.json   # fill in values
.venv/bin/python -m spotify_keys.auth                        # one-time login
```
Then add `i3.conf.example` to your i3 config.
