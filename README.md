# spotify-keys

Control Spotify from i3 hotkeys without leaving the editor: play/pause, skip, like, and add to my coding playlist.

Built with Bun + TypeScript. No runtime dependencies (uses built-in `fetch`, `node:crypto`, `node:http`).

## Setup
```
sudo apt install playerctl libnotify-bin
bun install
mkdir -p ~/.config/spotify-keys
cp config.example.json ~/.config/spotify-keys/config.json   # fill in values
bun run auth                                                 # one-time login
```
Then add `i3.conf.example` to your i3 config.
