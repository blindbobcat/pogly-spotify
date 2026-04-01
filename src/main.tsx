import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

const params = new URLSearchParams(window.location.search);
const clientId = params.get("client_id") ?? "";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App clientId={clientId} />
  </StrictMode>
);
