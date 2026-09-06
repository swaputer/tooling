import {
  AlertTriangle,
  ChevronRight,
  LoaderCircle,
  Search
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { VMRecord } from "@swaputer/receipt-codec";
import { formatInteger, formatToken, recordName, shorten } from "../lib/format";
import { inspectTransaction, isInspectionError } from "../lib/inspect";
import { InspectionErrorCode, type InspectionResult, type InspectorSelection } from "../lib/types";

const SELECTION_KEY = "swaputerInspectorSelection";
const DEV_SAMPLE_TRANSACTION = "0x75e5d367bf42acf2555b71a0d1004403936fab89f5ed782d80ab97f3eb935331";

type ViewState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly transactionHash: string }
  | { readonly kind: "ready"; readonly result: InspectionResult }
  | { readonly kind: "error"; readonly transactionHash: string; readonly code: string };

function isExtensionRuntime(): boolean {
  return typeof chrome !== "undefined" && chrome.runtime?.id !== undefined;
}

async function initialTransactionHash(): Promise<string | null> {
  const fromQuery = new URLSearchParams(window.location.search).get("tx");
  if (fromQuery !== null) return fromQuery;
  if (!isExtensionRuntime()) return null;
  const stored = await chrome.storage.session.get(SELECTION_KEY);
  return (stored[SELECTION_KEY] as InspectorSelection | undefined)?.transactionHash ?? null;
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className={mono ? "field-value mono" : "field-value"} title={value}>{value}</span>
    </div>
  );
}

function RecordRow({ record, index }: { record: VMRecord; index: number }) {
  return (
    <details className="record-row" open={record.kind === "miniContractDeployed"}>
      <summary>
        <ChevronRight className="record-chevron" size={15} />
        <span className="record-index">{index + 1}</span>
        <span className="record-name">{recordName(record)}</span>
        <span className={`record-kind record-kind-${record.kind}`}>{record.kind === "application" ? "raw" : "kernel"}</span>
      </summary>
      <div className="record-body">
        <Field label="Emitter" value={record.emitter} mono />
        {record.kind === "miniContractDeployed" && (
          <>
            <Field label="Contract ID" value={record.decoded.contractId} mono />
            <Field label="Creator" value={record.decoded.creator} mono />
            <Field label="Code hash" value={record.decoded.codeHash} mono />
          </>
        )}
        {record.kind === "application" && (
          <>
            {record.topics.map((topic, topicIndex) => (
              <Field key={`${topic}-${topicIndex}`} label={`Topic ${topicIndex}`} value={topic} mono />
            ))}
            <Field label="Data" value={record.data} mono />
          </>
        )}
      </div>
    </details>
  );
}

function EmptyInspector({ onSubmit }: { onSubmit: (hash: string) => void }) {
  const [value, setValue] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(value.trim());
  };
  return (
    <main className="center-state">
      <div className="state-icon"><Search size={21} /></div>
      <h1>Inspect a transaction</h1>
      <p>Open a Base Sepolia transaction page or paste its hash to check for a verified Swaputer execution.</p>
      <form className="hash-form" onSubmit={submit}>
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="0x transaction hash"
          aria-label="Transaction hash"
          spellCheck={false}
        />
        <button type="submit">Inspect</button>
      </form>
      {!isExtensionRuntime() && (
        <button className="sample-link" type="button" onClick={() => onSubmit(DEV_SAMPLE_TRANSACTION)}>
          Load verified sample
        </button>
      )}
    </main>
  );
}

function ErrorInspector({ code, transactionHash, retry }: { code: string; transactionHash: string; retry: () => void }) {
  const content: Record<string, { title: string; body: string }> = {
    [InspectionErrorCode.NOT_SWAPUTER]: {
      title: "Not a Swaputer transaction",
      body: "No verified Kernel Events was found in this transaction receipt."
    },
    [InspectionErrorCode.TRANSACTION_REVERTED]: {
      title: "Transaction reverted",
      body: "Reverted transactions cannot retain a Swaputer execution receipt."
    },
    [InspectionErrorCode.UNSUPPORTED_DEPLOYMENT]: {
      title: "Unknown deployment",
      body: "A Events-shaped event exists, but it is not bound to a supported Swaputer deployment."
    },
    [InspectionErrorCode.KERNEL_CODE_HASH_MISMATCH]: {
      title: "Kernel verification failed",
      body: "The runtime code hash does not match the immutable deployment manifest."
    },
    [InspectionErrorCode.MALFORMED_EVENTS]: {
      title: "Malformed receipt",
      body: "The log failed strict VMReceiptV1 validation. No partial result was returned."
    },
    [InspectionErrorCode.TRANSACTION_NOT_FOUND]: {
      title: "Transaction not found",
      body: "The configured Base Sepolia RPCs do not currently return this transaction."
    },
    [InspectionErrorCode.INVALID_TRANSACTION_HASH]: {
      title: "Invalid transaction hash",
      body: "Enter a 32-byte 0x-prefixed Ethereum transaction hash."
    }
  };
  const selected = content[code] ?? {
    title: "RPC unavailable",
    body: "Swaputer Inspector could not fetch the receipt from either configured RPC endpoint."
  };
  return (
    <main className="center-state error-state">
      <div className="state-icon state-icon-error"><AlertTriangle size={21} /></div>
      <h1>{selected.title}</h1>
      <p>{selected.body}</p>
      <code>{shorten(transactionHash, 14, 10)}</code>
      <button className="retry-button" type="button" onClick={retry}>Try again</button>
    </main>
  );
}

function ReadyInspector({ result }: { result: InspectionResult }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const execution = result.executions[selectedIndex] ?? result.executions[0];
  if (execution === undefined) return null;
  const summary = execution.receipt.worldExecution;
  return (
    <main className="inspection">
      {result.executions.length > 1 && (
        <div className="execution-tabs" role="tablist" aria-label="Executions in transaction">
          {result.executions.map((item, index) => (
            <button
              key={item.logIndex.toString()}
              className={index === selectedIndex ? "active" : ""}
              type="button"
              onClick={() => setSelectedIndex(index)}
            >
              Execution {index + 1}
            </button>
          ))}
        </div>
      )}

      <section className="summary-section">
        <Field label="Network" value={result.deployment.networkName} />
        <Field label="Status" value="Verified" />
        <Field label="World ID" value={execution.worldId} mono />
        <Field label="Executed bytes" value={`${formatInteger(summary.executedBytes)} bytes`} />
        <Field label="Actor" value={summary.actor === `0x${"0".repeat(64)}` ? "Unsigned NOP" : summary.actor} mono />
        <Field label="Root target" value={summary.rootTarget} mono />
      </section>

      <section className="amount-strip" aria-label="Execution token accounting">
        <div><span>Token burned</span><strong>{formatToken(summary.tokenBurned)} SVMG</strong></div>
        <div><span>Gross output</span><strong>{formatToken(summary.grossTokenOut)} SVMG</strong></div>
        <div><span>Net output</span><strong>{formatToken(summary.netTokenOut)} SVMG</strong></div>
      </section>

      <section className="records-section">
        <div className="section-heading">
          <div>
            <h2>Virtual records</h2>
            <p>VMReceiptV1 · canonical order</p>
          </div>
          <span>{execution.receipt.recordCount} records</span>
        </div>
        <div className="record-list">
          {execution.receipt.records.map((record, index) => (
            <RecordRow key={`${record.emitter}-${index}`} record={record} index={index} />
          ))}
        </div>
      </section>

    </main>
  );
}

export function App() {
  const [state, setState] = useState<ViewState>({ kind: "idle" });

  const inspect = useCallback(async (transactionHash: string) => {
    setState({ kind: "loading", transactionHash });
    try {
      const result = await inspectTransaction(transactionHash);
      setState({ kind: "ready", result });
    } catch (error) {
      const code = isInspectionError(error) ? error.code : "RPC_UNAVAILABLE";
      setState({ kind: "error", transactionHash, code });
    }
  }, []);

  useEffect(() => {
    void initialTransactionHash().then((transactionHash) => {
      if (transactionHash !== null) void inspect(transactionHash);
    });
    if (!isExtensionRuntime()) return undefined;
    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      const selection = changes[SELECTION_KEY]?.newValue as InspectorSelection | undefined;
      if (areaName === "session" && selection !== undefined) void inspect(selection.transactionHash);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [inspect]);

  const content = useMemo(() => {
    if (state.kind === "idle") return <EmptyInspector onSubmit={inspect} />;
    if (state.kind === "loading") {
      return (
        <main className="center-state">
          <LoaderCircle className="spinner" size={25} />
          <h1>Checking the receipt</h1>
          <p>Verifying the chain, Kernel runtime and strict VMReceiptV1 structure.</p>
          <code>{shorten(state.transactionHash, 14, 10)}</code>
        </main>
      );
    }
    if (state.kind === "error") {
      return <ErrorInspector code={state.code} transactionHash={state.transactionHash} retry={() => void inspect(state.transactionHash)} />;
    }
    return <ReadyInspector result={state.result} />;
  }, [inspect, state]);

  return (
    <div className="app-shell">
      {content}
    </div>
  );
}
