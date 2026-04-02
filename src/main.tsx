import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// Safe localStorage helpers (blocked in third-party iframes)
function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* blocked */ }
}

// In-memory fallback for client_id
let memClientId: string | null = null;

const params = new URLSearchParams(window.location.search);
const clientIdParam = params.get("client_id");
if (clientIdParam) {
  memClientId = clientIdParam;
  safeSet("spotify_client_id", clientIdParam);
}
const clientId = clientIdParam ?? memClientId ?? safeGet("spotify_client_id") ?? "";

// Volume: 0-100 from URL param, default 50
const volumeParam = params.get("volume");
const volume = Math.max(0, Math.min(100, parseInt(volumeParam ?? "50", 10))) / 100;

// Playback controls via URL params (toggled from Pogly variables)
const playPause = params.get("play_pause") === "true";
const skip = params.get("skip") === "true";
const prev = params.get("prev") === "true";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App clientId={clientId} volume={volume} playPause={playPause} skip={skip} prev={prev} />
  </StrictMode>
);
