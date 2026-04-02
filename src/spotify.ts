const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_URL = "https://api.spotify.com/v1";
const SCOPES = "user-read-currently-playing user-read-playback-state user-modify-playback-state streaming";

// Shared debug logger — matches App.tsx's dbg()
function dbg(msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`🎵 [${ts}] ${msg}`);
  const el = document.getElementById("spotify-debug");
  if (el) {
    el.textContent += `\n[${ts}] ${msg}`;
    const lines = el.textContent!.split("\n");
    if (lines.length > 50) el.textContent = lines.slice(-50).join("\n");
  }
}

// In-memory token store (fallback when localStorage is blocked in iframes)
const memStore: { accessToken: string | null; refreshToken: string | null; expiry: number } = {
  accessToken: null,
  refreshToken: null,
  expiry: 0,
};

function storageSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* blocked in third-party iframe */ }
}

function storageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storageRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* blocked */ }
}

function getRedirectUri(): string {
  return window.location.origin + window.location.pathname;
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => chars[byte % chars.length]).join("");
}

async function sha256(plain: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  return crypto.subtle.digest("SHA-256", encoder.encode(plain));
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function redirectToSpotifyAuth(clientId: string): Promise<void> {
  const codeVerifier = generateRandomString(64);
  const hashed = await sha256(codeVerifier);
  const codeChallenge = base64UrlEncode(hashed);

  storageSet("spotify_code_verifier", codeVerifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
    redirect_uri: getRedirectUri(),
  });

  window.location.href = `${SPOTIFY_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForToken(
  clientId: string,
  code: string
): Promise<TokenResponse> {
  const codeVerifier = storageGet("spotify_code_verifier");
  if (!codeVerifier) throw new Error("Missing code verifier");

  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: getRedirectUri(),
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) throw new Error("Token exchange failed");

  const data = await response.json();
  saveTokens(data);
  storageRemove("spotify_code_verifier");

  window.history.replaceState({}, document.title, window.location.pathname);

  return data;
}

// Mutex to prevent concurrent refresh calls
let refreshPromise: Promise<TokenResponse> | null = null;

export async function refreshAccessToken(clientId: string): Promise<TokenResponse> {
  // If a refresh is already in progress, wait for it instead of firing another
  if (refreshPromise) {
    dbg("refreshAccessToken: waiting for existing refresh...");
    return refreshPromise;
  }

  const refreshToken = memStore.refreshToken ?? storageGet("spotify_refresh_token");
  dbg(`refreshAccessToken: refreshToken=${refreshToken ? `found(len=${refreshToken.length},src=${memStore.refreshToken ? "mem" : "ls"})` : "MISSING"}`);
  if (!refreshToken) throw new Error("No refresh token");

  refreshPromise = (async () => {
    try {
      const response = await fetch(SPOTIFY_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });

      if (!response.ok) {
        memStore.accessToken = null;
        memStore.expiry = 0;
        storageRemove("spotify_access_token");
        storageRemove("spotify_token_expiry");
        throw new Error(`Token refresh failed: ${response.status}`);
      }

      const data = await response.json();
      saveTokens(data);
      return data;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

function saveTokens(data: TokenResponse): void {
  memStore.accessToken = data.access_token;
  if (data.refresh_token) {
    memStore.refreshToken = data.refresh_token;
  }
  memStore.expiry = Date.now() + data.expires_in * 1000;
  dbg(`saveTokens: expires_in=${data.expires_in}s, new_refresh=${!!data.refresh_token}`);

  storageSet("spotify_access_token", data.access_token);
  if (data.refresh_token) {
    storageSet("spotify_refresh_token", data.refresh_token);
  }
  storageSet("spotify_token_expiry", memStore.expiry.toString());
}

export async function getValidAccessToken(clientId: string): Promise<string | null> {
  const token = memStore.accessToken ?? storageGet("spotify_access_token");
  const expiry = memStore.expiry || parseInt(storageGet("spotify_token_expiry") ?? "0");

  dbg(`getValidAccessToken: token=${token ? "OK" : "NULL"}(src=${memStore.accessToken ? "mem" : "ls"}), expiry=${expiry ? `${Math.round((expiry - Date.now()) / 1000)}s` : "NONE"}`);

  if (!token || !expiry) {
    dbg("getValidAccessToken: returning null (no token or expiry)");
    return null;
  }

  if (Date.now() > expiry - 60_000) {
    dbg("getValidAccessToken: token expired/expiring, refreshing...");
    try {
      const data = await refreshAccessToken(clientId);
      return data.access_token;
    } catch (e) {
      dbg(`getValidAccessToken: refresh failed: ${e}`);
      return null;
    }
  }

  return token;
}

/**
 * Returns the cached access token synchronously (no refresh).
 * Used by the SDK's getOAuthToken callback to avoid async timing issues.
 */
export function getCachedAccessToken(): string | null {
  return memStore.accessToken ?? storageGet("spotify_access_token") ?? null;
}

export function setRefreshToken(token: string): void {
  memStore.refreshToken = token;
  storageSet("spotify_refresh_token", token);
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  refresh_token?: string;
}

export interface SpotifyImage {
  url: string;
  height: number;
  width: number;
}

export interface NowPlaying {
  isPlaying: boolean;
  trackName: string;
  artistName: string;
  albumName: string;
  albumArt: string;
  progressMs: number;
  durationMs: number;
  trackUrl: string;
}

export async function getCurrentlyPlaying(
  accessToken: string
): Promise<NowPlaying | null> {
  const response = await fetch(`${SPOTIFY_API_URL}/me/player/currently-playing`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.status === 204 || response.status === 202) return null;
  if (!response.ok) throw new Error(`API error: ${response.status}`);

  const data = await response.json();

  if (!data.item || data.currently_playing_type !== "track") return null;

  return {
    isPlaying: data.is_playing,
    trackName: data.item.name,
    artistName: data.item.artists.map((a: { name: string }) => a.name).join(", "),
    albumName: data.item.album.name,
    albumArt: data.item.album.images[0]?.url ?? "",
    progressMs: data.progress_ms ?? 0,
    durationMs: data.item.duration_ms,
    trackUrl: data.item.external_urls?.spotify ?? "",
  };
}

export function isAuthenticated(): boolean {
  return !!(memStore.accessToken ?? storageGet("spotify_access_token"));
}

export function logout(): void {
  memStore.accessToken = null;
  memStore.refreshToken = null;
  memStore.expiry = 0;
  storageRemove("spotify_access_token");
  storageRemove("spotify_refresh_token");
  storageRemove("spotify_token_expiry");
  storageRemove("spotify_code_verifier");
}

// ─── Web Playback SDK ───

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady: () => void;
    Spotify: {
      Player: new (options: {
        name: string;
        getOAuthToken: (cb: (token: string) => void) => void;
        volume: number;
      }) => SpotifyPlayer;
    };
  }
}

export interface SpotifyPlayer {
  connect: () => Promise<boolean>;
  disconnect: () => void;
  addListener: (event: string, cb: (state: PlayerState | WebPlaybackError | { device_id: string }) => void) => void;
  removeListener: (event: string) => void;
  getCurrentState: () => Promise<PlayerState | null>;
  togglePlay: () => Promise<void>;
  nextTrack: () => Promise<void>;
  previousTrack: () => Promise<void>;
  seek: (positionMs: number) => Promise<void>;
  setVolume: (volume: number) => Promise<void>;
}

export interface PlayerState {
  paused: boolean;
  position: number;
  duration: number;
  track_window: {
    current_track: {
      name: string;
      artists: { name: string }[];
      album: {
        name: string;
        images: { url: string }[];
      };
    };
  };
}

interface WebPlaybackError {
  message: string;
}

let sdkLoaded = false;

function loadPlaybackSDK(): Promise<void> {
  if (sdkLoaded || document.getElementById("spotify-sdk")) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.id = "spotify-sdk";
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    document.body.appendChild(script);

    window.onSpotifyWebPlaybackSDKReady = () => {
      sdkLoaded = true;
      resolve();
    };
  });
}

export async function createPlayer(
  clientId: string,
  name: string,
  volume: number,
  onReady: (deviceId: string) => void,
  onStateChange: (state: PlayerState | null) => void,
  onError: (msg: string) => void
): Promise<SpotifyPlayer> {
  await loadPlaybackSDK();

  const player = new window.Spotify.Player({
    name,
    getOAuthToken: (cb) => {
      // CRITICAL: provide token synchronously first from cache,
      // then kick off async refresh in background if needed.
      // Some browsers/SDK versions don't wait for async callbacks.
      const cached = getCachedAccessToken();
      const expiry = memStore.expiry || parseInt(storageGet("spotify_token_expiry") ?? "0");
      const expiresIn = Math.round((expiry - Date.now()) / 1000);

      dbg(`SDK getOAuthToken: cached=${cached ? "OK" : "NULL"}, expires in ${expiresIn}s`);

      if (cached && expiresIn > 120) {
        // Token is valid and not expiring soon — use it immediately
        cb(cached);
        return;
      }

      if (cached && expiresIn > 0) {
        // Token still valid but expiring soon — use it now, refresh in background
        cb(cached);
        dbg("SDK getOAuthToken: refreshing in background...");
        refreshAccessToken(clientId).catch((e) => dbg(`Background refresh failed: ${e}`));
        return;
      }

      // Token expired or missing — must refresh before calling cb
      dbg("SDK getOAuthToken: token expired, refreshing...");
      refreshAccessToken(clientId)
        .then((data) => {
          dbg("SDK getOAuthToken: refresh done, calling cb");
          cb(data.access_token);
        })
        .catch((e) => {
          dbg(`SDK getOAuthToken: refresh FAILED: ${e} — SDK will likely disconnect`);
          // Still try to pass the expired token — SDK might accept it briefly
          if (cached) cb(cached);
        });
    },
    volume,
  });

  player.addListener("ready", (data) => {
    const { device_id } = data as { device_id: string };
    dbg(`SDK ready: device_id=${device_id.slice(0,8)}...`);
    onReady(device_id);
  });

  player.addListener("not_ready", () => {
    dbg("SDK event: not_ready (device went offline)");
    onError("Device went offline");
  });

  player.addListener("player_state_changed", (state) => {
    onStateChange(state as PlayerState | null);
  });

  player.addListener("initialization_error", (e) => {
    dbg(`SDK initialization_error: ${(e as WebPlaybackError).message}`);
    onError((e as WebPlaybackError).message);
  });
  player.addListener("authentication_error", (e) => {
    dbg(`SDK authentication_error: ${(e as WebPlaybackError).message}`);
    onError((e as WebPlaybackError).message);
  });
  player.addListener("account_error", (e) => {
    dbg(`SDK account_error: ${(e as WebPlaybackError).message}`);
    onError((e as WebPlaybackError).message);
  });

  dbg("Calling player.connect()...");
  const connected = await player.connect();
  dbg(`player.connect() returned: ${connected}`);
  if (!connected) throw new Error("Failed to connect player");

  return player;
}

export async function transferPlayback(accessToken: string, deviceId: string): Promise<void> {
  const resp = await fetch(`${SPOTIFY_API_URL}/me/player`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ device_ids: [deviceId], play: true }),
  });
  dbg(`transferPlayback: status=${resp.status}`);
}
