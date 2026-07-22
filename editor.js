const DRAFT_KEY = "gookhee-cv-draft";

const editor = document.getElementById("jsonEditor");
const statusLine = document.getElementById("editorStatus");

async function loadBaseResume() {
  const draft = localStorage.getItem(DRAFT_KEY);
  if (draft) return JSON.parse(draft);
  const response = await fetch("resume.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not load resume.json");
  return response.json();
}

function setStatus(message, state = "neutral") {
  statusLine.textContent = message;
  statusLine.dataset.state = state;
}

function parseEditor() {
  return JSON.parse(editor.value);
}

function downloadJson() {
  const data = parseEditor();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "resume.json";
  link.click();
  URL.revokeObjectURL(url);
}

loadBaseResume()
  .then((resume) => {
    editor.value = JSON.stringify(resume, null, 2);
    setStatus("Ready.");
  })
  .catch((error) => setStatus(error.message, "error"));

editor.addEventListener("input", () => {
  try {
    parseEditor();
    setStatus("Valid JSON. Unsaved changes.", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

document.getElementById("saveDraft").addEventListener("click", () => {
  try {
    const data = parseEditor();
    localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
    setStatus("Saved in this browser. Open the CV page to preview.", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

document.getElementById("resetDraft").addEventListener("click", async () => {
  localStorage.removeItem(DRAFT_KEY);
  const response = await fetch("resume.json", { cache: "no-store" });
  const data = await response.json();
  editor.value = JSON.stringify(data, null, 2);
  setStatus("Reset to resume.json.", "ok");
});

document.getElementById("downloadEditorJson").addEventListener("click", () => {
  try {
    downloadJson();
    setStatus("Downloaded resume.json.", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
});
