// One-time OAuth (Authorization Code + PKCE) to get and save a refresh token.
// Run: bun run auth

import { randomBytes, createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".config", "spotify-keys");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const TOKEN_PATH = join(CONFIG_DIR, "token.json");

const SCOPES = [
  "user-library-modify",
  "playlist-modify-private",
  "playlist-modify-public",
].join(" ");

type Config = {
  client_id: string;
  redirect_uri: string;
  coding_playlist_id: string;
};

type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
};

async function loadConfig(): Promise<Config> {
  const file = Bun.file(CONFIG_PATH);
  if (!(await file.exists())) {
    throw new Error(`Missing ${CONFIG_PATH}. Copy config.example.json there and fill it in.`);
  }
  return file.json();
}

// PKCE: a random secret (verifier) and its SHA-256 hash (challenge).
// The challenge goes in the /authorize URL; the verifier goes in the /api/token POST.
function createPkce() {
  const verifier = randomBytes(64).toString("base64url"); // 86 chars
  const challenge = createHash("sha256").update(verifier).digest("base64url"); // 43 chars, no padding
  return { verifier, challenge };
}

function buildAuthorizeUrl(config: Config, challenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: config.client_id,
    response_type: "code",
    redirect_uri: config.redirect_uri,
    code_challenge_method: "S256",
    code_challenge: challenge,
    scope: SCOPES,
    state,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

// Start a local server on the redirect URI's port and resolve with the ?code= Spotify sends back.
function waitForCode(redirectUri: string, expectedState: string): Promise<string> {
  const { port, pathname } = new URL(redirectUri);

  return new Promise((resolve, reject) => {
    const server = Bun.serve({
      port: Number(port),
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== pathname) return new Response("Not found", { status: 404 });

        const finish = (body: string, status: number) => {
          setTimeout(() => server.stop(), 100); // let the response reach the browser first
          return new Response(body, { status });
        };

        const error = url.searchParams.get("error");
        if (error) {
          reject(new Error(`Spotify returned error: ${error}`));
          return finish(`Login failed: ${error}`, 400);
        }
        if (url.searchParams.get("state") !== expectedState) {
          reject(new Error("State mismatch: the callback didn't come from this login."));
          return finish("State mismatch.", 400);
        }
        const code = url.searchParams.get("code");
        if (!code) {
          reject(new Error("Callback had no code."));
          return finish("No code.", 400);
        }

        resolve(code);
        return finish("Logged in. You can close this tab.", 200);
      },
    });
  });
}

async function exchangeCode(config: Config, code: string, verifier: string): Promise<TokenResponse> {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirect_uri,
      client_id: config.client_id,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<TokenResponse>;
}

async function saveTokens(tokens: TokenResponse) {
  await mkdir(CONFIG_DIR, { recursive: true });
  const data = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
    scope: tokens.scope,
  };
  await Bun.write(TOKEN_PATH, JSON.stringify(data, null, 2));
  await chmod(TOKEN_PATH, 0o600);
}

async function main() {
  const config = await loadConfig();
  const { verifier, challenge } = createPkce();
  const state = randomBytes(16).toString("base64url");

  const codePromise = waitForCode(config.redirect_uri, state); // listen before opening the browser
  const authorizeUrl = buildAuthorizeUrl(config, challenge, state);

  console.log("Opening Spotify login. If the browser doesn't open, visit:\n" + authorizeUrl);
  Bun.spawn(["xdg-open", authorizeUrl], { stdout: "ignore", stderr: "ignore" });

  const code = await codePromise;
  const tokens = await exchangeCode(config, code, verifier);
  await saveTokens(tokens);

  console.log(`Saved tokens to ${TOKEN_PATH} (scopes: ${tokens.scope})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
