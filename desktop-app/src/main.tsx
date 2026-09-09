import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { StudioProvider } from "./state/StudioContext";
import "./style.css";
import { applyTheme, readTheme } from "./lib/theme";
applyTheme(readTheme());
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StudioProvider>
      <App />
    </StudioProvider>
  </React.StrictMode>,
);
