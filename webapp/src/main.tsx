import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { loadPlaces } from "./lib/ref";
import { applyScheme, initTelegram } from "./lib/tg";
import "./styles/app.css";

initTelegram();
applyScheme();

loadPlaces().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
