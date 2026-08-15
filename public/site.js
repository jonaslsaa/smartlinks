const copyButton = document.querySelector("#copy-agent-prompt");
const copyStatus = document.querySelector("#copy-status");
const manualCopy = document.querySelector("#manual-copy");
const manualPrompt = document.querySelector("#manual-agent-prompt");

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Embedded browsers and clipboard policies may reject the modern API.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) {
    throw new Error("Clipboard access is unavailable.");
  }
}

copyButton?.addEventListener("click", async () => {
  const guideUrl = new URL("/smartlinks-for-agents.md", window.location.origin).href;
  const prompt = `Read ${guideUrl} and use it as the source of truth for Smartlinks. Help me turn my intent into the smallest suitable Smartlink script, validate it locally with the CLI, and build the final link. Ask only for missing product decisions or credentials. My intent: `;

  try {
    await copyText(prompt);
    copyButton.firstChild.textContent = "Prompt copied ";
    if (manualCopy) manualCopy.hidden = true;
    if (copyStatus) copyStatus.textContent = "Paste it into your coding agent and add your intent.";
  } catch {
    if (manualPrompt instanceof HTMLTextAreaElement) {
      manualPrompt.value = prompt;
      if (manualCopy) manualCopy.hidden = false;
      manualPrompt.focus();
      manualPrompt.select();
    }
    if (copyStatus) copyStatus.textContent = "Clipboard unavailable. Copy the prompt shown below.";
  }
});
