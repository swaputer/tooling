import { afterEach, describe, expect, it, vi } from "vitest";

describe("Swaputer side-panel opening", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("starts sidePanel.open before the asynchronous selection write completes", async () => {
    const calls: string[] = [];
    let finishSelectionWrite: (() => void) | undefined;
    const selectionWrite = new Promise<void>((resolve) => {
      finishSelectionWrite = resolve;
    });

    vi.stubGlobal("chrome", {
      runtime: {
        onInstalled: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() }
      },
      storage: {
        session: {
          set: vi.fn(() => {
            calls.push("selection-write-started");
            return selectionWrite;
          })
        }
      },
      sidePanel: {
        setPanelBehavior: vi.fn(() => Promise.resolve()),
        open: vi.fn(() => {
          calls.push("panel-open-started");
          return Promise.resolve();
        })
      }
    });

    const { openInspector } = await import("./background");
    const resultPromise = openInspector(
      `0x${"1".repeat(64)}`,
      "https://sepolia.basescan.org/tx/sample",
      { tab: { id: 17 } } as chrome.runtime.MessageSender
    );

    expect(calls).toEqual(["selection-write-started", "panel-open-started"]);
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 17 });

    finishSelectionWrite?.();
    await expect(resultPromise).resolves.toEqual({ status: "verified" });
  });

  it("fails closed when the click message has no source tab", async () => {
    vi.stubGlobal("chrome", {
      runtime: {
        onInstalled: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() }
      },
      storage: { session: { set: vi.fn() } },
      sidePanel: {
        setPanelBehavior: vi.fn(() => Promise.resolve()),
        open: vi.fn(() => Promise.resolve())
      }
    });

    const { openInspector } = await import("./background");
    await expect(openInspector(`0x${"2".repeat(64)}`, undefined, {})).resolves.toEqual({
      status: "error",
      code: "MISSING_SOURCE_TAB"
    });
    expect(chrome.sidePanel.open).not.toHaveBeenCalled();
  });
});
