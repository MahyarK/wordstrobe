// Placeholder settings window: Permissions section only (PLAN §8).
import { invoke } from "@tauri-apps/api/core";

const dot = document.getElementById("dot")!;
const state = document.getElementById("state")!;

async function refresh(): Promise<void> {
  const granted = await invoke<boolean>("permission_status");
  dot.dataset.ok = String(granted);
  state.textContent = granted ? "Granted" : "Not granted";
}

document.getElementById("request")!.addEventListener("click", async () => {
  await invoke("request_permission");
  await refresh();
});
document.getElementById("open")!.addEventListener("click", () => void invoke("open_privacy_settings"));
document.getElementById("relaunch")!.addEventListener("click", () => void invoke("relaunch"));

// Poll while the window is showing, so the dot flips right after the user grants it in System Settings.
setInterval(() => {
  if (!document.hidden) void refresh();
}, 2000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});
void refresh();
