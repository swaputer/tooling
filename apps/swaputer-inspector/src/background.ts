import { inspectTransaction, isInspectionError } from "./lib/inspect";
import { InspectionErrorCode, type Hex, type InspectorSelection } from "./lib/types";

type InspectorMessage =
  | { readonly type: "SWAPUTER_CHECK_TRANSACTION"; readonly transactionHash: string }
  | { readonly type: "SWAPUTER_OPEN_INSPECTOR"; readonly transactionHash: string; readonly sourceUrl?: string };

export interface DetectionResponse {
  readonly status: "verified" | "not_swaputer" | "unsupported" | "error";
  readonly executionCount?: number;
  readonly code?: string;
}

const SELECTION_KEY = "swaputerInspectorSelection";

async function detect(transactionHash: string): Promise<DetectionResponse> {
  try {
    const result = await inspectTransaction(transactionHash);
    return { status: "verified", executionCount: result.executions.length };
  } catch (error) {
    if (!isInspectionError(error)) return { status: "error", code: "UNEXPECTED" };
    if (
      error.code === InspectionErrorCode.NOT_SWAPUTER ||
      error.code === InspectionErrorCode.TRANSACTION_REVERTED ||
      error.code === InspectionErrorCode.TRANSACTION_NOT_FOUND
    ) {
      return { status: "not_swaputer", code: error.code };
    }
    if (
      error.code === InspectionErrorCode.UNSUPPORTED_DEPLOYMENT ||
      error.code === InspectionErrorCode.KERNEL_CODE_HASH_MISMATCH
    ) {
      return { status: "unsupported", code: error.code };
    }
    return { status: "error", code: error.code };
  }
}

export async function openInspector(
  transactionHash: string,
  sourceUrl: string | undefined,
  sender: chrome.runtime.MessageSender
): Promise<DetectionResponse> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
    return { status: "error", code: InspectionErrorCode.INVALID_TRANSACTION_HASH };
  }
  const selection: InspectorSelection = {
    transactionHash: transactionHash.toLowerCase() as Hex,
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    selectedAt: Date.now()
  };
  const tabId = sender.tab?.id;
  if (tabId === undefined) return { status: "error", code: "MISSING_SOURCE_TAB" };

  // sidePanel.open must be invoked while Chrome still considers this message to
  // be part of the content-script button's user gesture. Starting it after an
  // awaited storage/setOptions call loses that activation and Chrome rejects it.
  // The manifest already defines the global side-panel path, so no per-tab
  // setOptions call is necessary.
  const selectionWrite = chrome.storage.session.set({ [SELECTION_KEY]: selection });
  const panelOpen = chrome.sidePanel.open({ tabId });
  await Promise.all([selectionWrite, panelOpen]);
  return { status: "verified" };
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((rawMessage: unknown, sender, sendResponse) => {
  const message = rawMessage as Partial<InspectorMessage>;
  if (message.type === "SWAPUTER_CHECK_TRANSACTION" && typeof message.transactionHash === "string") {
    void detect(message.transactionHash).then(sendResponse);
    return true;
  }
  if (message.type === "SWAPUTER_OPEN_INSPECTOR" && typeof message.transactionHash === "string") {
    void openInspector(message.transactionHash, message.sourceUrl, sender)
      .then(sendResponse)
      .catch((error: unknown) => {
        console.error("[Swaputer Inspector] side panel open failed", error);
        sendResponse({ status: "error", code: "SIDE_PANEL_OPEN_FAILED" } satisfies DetectionResponse);
      });
    return true;
  }
  return false;
});
