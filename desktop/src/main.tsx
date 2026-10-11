import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "./slides.css";
import { applyMode, applyTheme, savedMode, savedTheme } from "./lib/uitheme";
import { installErrorLog } from "./lib/log";

installErrorLog();

// Apply the saved look before the first paint.
applyMode(savedMode());
applyTheme(savedTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
