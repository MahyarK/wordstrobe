// Placeholder reader (wave 2 replaces it with the RSVP player): shows status and the OCR text.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

type Status = { state: "ocr" | "error"; message?: string };
type Load = { paragraphs?: string[]; lines?: { t: string }[]; lang: string; source: string; ms?: number };

const statusEl = document.getElementById("status")!;
const textEl = document.getElementById("text")!;
const win = getCurrentWebviewWindow();

function setStatus(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

// Registered before anything else awaits: events sent while the page loads are lost.
void win.listen<Status>("reader:status", ({ payload }) => {
  textEl.replaceChildren();
  if (payload.state === "ocr") setStatus("Reading…");
  else setStatus(payload.message ?? "Something went wrong", true);
});

void win.listen<Load>("reader:load", ({ payload }) => {
  const paragraphs = payload.paragraphs ?? [(payload.lines ?? []).map((l) => l.t).join("\n")];
  const shown = paragraphs.filter((p) => p.trim() !== "");
  setStatus(shown.length ? "" : "No text found");
  // textContent only: OCR output is untrusted text, never markup.
  textEl.replaceChildren(
    ...shown.map((text) => {
      const p = document.createElement("p");
      p.textContent = text;
      p.dataset.tauriDragRegion = "";
      return p;
    }),
  );
});

addEventListener("keydown", (e) => {
  if (e.key === "Escape") void invoke("close_reader");
});
