import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

const params = new URLSearchParams(window.location.search);
const clientIdParam = params.get("client_id");
if (clientIdParam) {
  localStorage.setItem("spotify_client_id", clientIdParam);
}
const clientId = clientIdParam ?? localStorage.getItem("spotify_client_id") ?? "";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App clientId={clientId} />
  </StrictMode>
);
