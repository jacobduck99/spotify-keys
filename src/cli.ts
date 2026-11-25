// spot <cmd> — called by i3 keybindings.
// Commands: toggle | next | prev | like | add
//
// toggle/next/prev go through playerctl (D-Bus, no network).
// like/add go through the Spotify Web API using the tokens saved by `bun run auth`.

import { chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".config", "spotify-keys");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const TOKEN_PATH = join(CONFIG_DIR, "token.json");
const API = "https://api.spotify.com/v1";

type Config = {
  client_id: string;
  redirect_uri: string;
  coding_playlist_id: string;
};

type Tokens = {
  access_token: string;
  refresh_token: string;
  expires_at: number; // ms since epoch
  scope?: string;
};

type Track = { id: string; uri: string; title: string; artist: string };

// ---------- helpers ----------

function notify(summary: string, body = "", urgency: "low" | "normal" | "critical" = "low") {
  console.log(body ? `${summary}: ${body}` : summary);
  try {
    Bun.spawn(["notify-send", "-a", "spotify-keys", "-u", urgency, summary, body], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // notify-send not installed; the console.log above is enough
  }
}

async function readJson<T>(path: string, hint: string): Promise<T> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`Missing ${path}. ${hint}`);
  return file.json() as Promise<T>;
}

async function playerctl(...args: string[]): Promise<string> {
  let proc;
  try {
    proc = Bun.spawn(["playerctl", "-p", "spotify", ...args], { stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new Error("playerctl is not installed (sudo apt install playerctl)");
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(err.trim() || "Spotify isn't running");
  return out.trim();
}

// Spotify reports the track id as either "spotify:track:ID" or "/com/spotify/track/ID".
async function currentTrack(): Promise<Track> {
  const raw = await playerctl("metadata", "--format", "{{mpris:trackid}}\t{{title}}\t{{artist}}");
  const [trackid = "", title = "", artist = ""] = raw.split("\t");
  const match = trackid.match(/track[:/]([A-Za-z0-9]+)$/);
  if (!match) throw new Error(`Not a song (${trackid || "nothing playing"})`);
  const id = match[1]!;
  return { id, uri: `spotify:track:${id}`, title, artist };
}

// ---------- tokens ----------

async function saveTokens(tokens: Tokens) {
  await Bun.write(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  await chmod(TOKEN_PATH, 0o600);
}

async function refresh(config: Config, tokens: Tokens): Promise<Tokens> {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: config.client_id,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}): ${await res.text()}. Run \`bun run auth\` again.`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string; scope?: string };
  const updated: Tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? tokens.refresh_token, // Spotify may rotate it
    expires_at: Date.now() + data.expires_in * 1000,
    scope: data.scope ?? tokens.scope,
  };
  await saveTokens(updated);
  return updated;
}

// Call the Web API; refresh the token if it's (nearly) expired, and retry once on 401.
async function api(config: Config, method: string, path: string, body?: unknown): Promise<Response> {
  let tokens = await readJson<Tokens>(TOKEN_PATH, "Run `bun run auth` first.");
  if (Date.now() > tokens.expires_at - 60_000) tokens = await refresh(config, tokens);

  const send = (token: string) =>
    fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  let res = await send(tokens.access_token);
  if (res.status === 401) {
    tokens = await refresh(config, tokens);
    res = await send(tokens.access_token);
  }
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${await res.text()}`);
  return res;
}

// ---------- commands ----------

async function like() {
  const config = await readJson<Config>(CONFIG_PATH, "Copy config.example.json there and fill it in.");
  const track = await currentTrack();
  await api(config, "PUT", `/me/tracks?ids=${track.id}`);
  notify("♥ Liked", `${track.title} — ${track.artist}`);
}

async function add() {
  const config = await readJson<Config>(CONFIG_PATH, "Copy config.example.json there and fill it in.");
  const track = await currentTrack();
  await api(config, "POST", `/playlists/${config.coding_playlist_id}/tracks`, { uris: [track.uri] });
  notify("+ Coding", `${track.title} — ${track.artist}`);
}

const commands: Record<string, () => Promise<unknown>> = {
  toggle: () => playerctl("play-pause"),
  next: () => playerctl("next"),
  prev: () => playerctl("previous"),
  like,
  add,
};

async function main() {
  const cmd = process.argv[2] ?? "";
  const run = commands[cmd];
  if (!run) {
    console.error(`usage: spot <${Object.keys(commands).join("|")}>`);
    process.exit(2);
  }
  await run();
}

main().catch((err) => {
  notify("spotify-keys", err instanceof Error ? err.message : String(err), "critical");
  process.exit(1);
});
