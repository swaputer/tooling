(() => {
  const HOST_ID = "swaputer-inspector-trigger-host";
  const TX_PATTERN = /\/tx\/(0x[0-9a-fA-F]{64})(?:[/?#]|$)/;
  let activeTransactionHash = "";
  let checkingTransactionHash = "";

  interface DetectionResponse {
    readonly status: "verified" | "not_swaputer" | "unsupported" | "error";
    readonly executionCount?: number;
    readonly code?: string;
  }

  function currentTransactionHash(): string | null {
    return window.location.pathname.match(TX_PATTERN)?.[1]?.toLowerCase() ?? null;
  }

  function findTransactionHashElement(transactionHash: string): HTMLElement | null {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>("code, a, span, div"));
    const exact = candidates.filter((element) => element.textContent?.trim().toLowerCase() === transactionHash);
    exact.sort((left, right) => left.childElementCount - right.childElementCount || left.clientWidth - right.clientWidth);
    return exact[0] ?? null;
  }

  function createTrigger(transactionHash: string, executionCount: number): HTMLElement {
    const host = document.createElement("span");
    host.id = HOST_ID;
    host.style.display = "inline-flex";
    host.style.marginInlineStart = "8px";
    host.style.verticalAlign = "middle";
    const shadow = host.attachShadow({ mode: "closed" });
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", `Open ${executionCount} verified Swaputer execution${executionCount === 1 ? "" : "s"}`);
    button.textContent = executionCount === 1 ? "Swaputer ✓" : `Swaputer ×${executionCount} ✓`;
    const style = document.createElement("style");
    style.textContent = `
      button {
        appearance: none;
        border: 1px solid #2f6fed;
        border-radius: 6px;
        background: #ffffff;
        color: #175cd3;
        cursor: pointer;
        font: 600 12px/1.2 Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
        letter-spacing: -0.01em;
        padding: 5px 9px;
        white-space: nowrap;
        box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
      }
      button:hover { background: #f5f8ff; border-color: #175cd3; }
      button:focus-visible { outline: 2px solid #84adff; outline-offset: 2px; }
      button:active { transform: translateY(1px); }
    `;
    button.addEventListener("click", async () => {
      button.disabled = true;
      const originalText = button.textContent;
      button.textContent = "Opening…";
      try {
        const response = (await chrome.runtime.sendMessage({
          type: "SWAPUTER_OPEN_INSPECTOR",
          transactionHash,
          sourceUrl: window.location.href
        })) as DetectionResponse;
        if (response.status !== "verified") {
          button.textContent = "Open failed";
          button.title = `Swaputer Inspector could not open (${response.code ?? "UNKNOWN"})`;
          console.warn("[Swaputer Inspector] side panel open failed", response.code ?? "UNKNOWN");
          window.setTimeout(() => {
            button.textContent = originalText;
          }, 2_000);
        }
      } catch (error) {
        button.textContent = "Open failed";
        button.title = "Swaputer Inspector could not contact its background service";
        console.warn("[Swaputer Inspector] side panel message failed", error);
        window.setTimeout(() => {
          button.textContent = originalText;
        }, 2_000);
      } finally {
        button.disabled = false;
        if (button.textContent === "Opening…") button.textContent = originalText;
      }
    });
    shadow.append(style, button);
    return host;
  }

  async function inspectPage(): Promise<void> {
    const transactionHash = currentTransactionHash();
    if (transactionHash === null) return;
    if (transactionHash === activeTransactionHash && document.getElementById(HOST_ID) !== null) return;
    if (checkingTransactionHash === transactionHash) return;
    checkingTransactionHash = transactionHash;
    document.getElementById(HOST_ID)?.remove();
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "SWAPUTER_CHECK_TRANSACTION",
        transactionHash
      })) as DetectionResponse;
      if (response.status !== "verified") return;
      const target = findTransactionHashElement(transactionHash);
      if (target === null) return;
      target.insertAdjacentElement("afterend", createTrigger(transactionHash, response.executionCount ?? 1));
      activeTransactionHash = transactionHash;
    } catch (error) {
      console.warn("[Swaputer Inspector] transaction detection failed", error);
    } finally {
      checkingTransactionHash = "";
    }
  }

  const observer = new MutationObserver(() => {
    void inspectPage();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.setInterval(() => {
    const transactionHash = currentTransactionHash();
    if (transactionHash !== activeTransactionHash) void inspectPage();
  }, 1_000);
  void inspectPage();
})();
