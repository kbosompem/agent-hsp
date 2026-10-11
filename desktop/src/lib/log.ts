// Sends the console's errors to the app's log file (src-tauri/src/log.rs):
// uncaught exceptions, unhandled promise rejections, and every error toast,
// since most failures reach the operator as a toast.

import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

export function logEvent(level: "error" | "warn" | "info", message: string) {
  void invoke("log_event", { level, message }).catch(() => {
    /* no log is better than a loop of failing logs */
  });
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message + (e.stack ? "\n" + e.stack : "");
  return typeof e === "string" ? e : JSON.stringify(e);
}

export function installErrorLog() {
  window.addEventListener("error", (e) => logEvent("error", describe(e.error ?? e.message) + " (" + e.filename + ":" + e.lineno + ")"));
  window.addEventListener("unhandledrejection", (e) => logEvent("error", "unhandled: " + describe(e.reason)));
  const error = toast.error;
  toast.error = ((msg, data) => {
    logEvent("error", String(msg));
    return error(msg, data);
  }) as typeof toast.error;
  const warning = toast.warning;
  toast.warning = ((msg, data) => {
    logEvent("warn", String(msg));
    return warning(msg, data);
  }) as typeof toast.warning;
}
