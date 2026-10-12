import { useRef, useState } from "react";
import SignatureCanvas from "react-signature-canvas";
import { Modal } from "../ui";
import {
  createTypedSignatureDataUrl,
  isSignatureReady,
  type SignatureMode,
} from "./signatureUtils";

export type SignatureSubmission = {
  mode: SignatureMode;
  imageDataUrl: string;
  typedName: string;
  consented: true;
  signedAt: string;
};

type SignatureModalProps = {
  onClose: () => void;
  onSubmit: (signature: SignatureSubmission) => void | Promise<void>;
  initialName?: string;
};

export function SignatureModal({
  onClose,
  onSubmit,
  initialName = "",
}: SignatureModalProps) {
  const canvasRef = useRef<SignatureCanvas | null>(null);
  const [mode, setMode] = useState<SignatureMode>("draw");
  const [typedName, setTypedName] = useState(initialName);
  const [hasDrawing, setHasDrawing] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = isSignatureReady({ mode, typedName, hasDrawing, agreed });

  function selectMode(nextMode: SignatureMode) {
    setMode(nextMode);
    setError("");
  }

  function clearDrawing() {
    canvasRef.current?.clear();
    setHasDrawing(false);
    setError("");
  }

  async function submit() {
    if (!agreed) {
      setError("You must agree to sign this document electronically.");
      return;
    }
    if (mode === "draw" && (!hasDrawing || canvasRef.current?.isEmpty())) {
      setError("Draw your signature before submitting.");
      return;
    }
    if (mode === "type" && !typedName.trim()) {
      setError("Type your name before submitting.");
      return;
    }

    const imageDataUrl =
      mode === "draw"
        ? canvasRef.current!.getTrimmedCanvas().toDataURL("image/png")
        : createTypedSignatureDataUrl(typedName);

    setBusy(true);
    setError("");
    try {
      await onSubmit({
        mode,
        imageDataUrl,
        typedName: mode === "type" ? typedName.trim() : "",
        consented: true,
        signedAt: new Date().toISOString(),
      });
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "The signature could not be submitted.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Electronic signature"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={busy || !ready}
            onClick={submit}
          >
            {busy ? "Submitting…" : "Submit Signature"}
          </button>
        </>
      }
    >
      <div className="signature-modal-content">
        <p className="signature-intro">
          Choose how you want to sign. Your signature is not submitted until you
          confirm your electronic-signature consent below.
        </p>

        <div className="signature-mode-tabs" role="group" aria-label="Signature method">
          <button
            type="button"
            className={mode === "draw" ? "active" : ""}
            aria-pressed={mode === "draw"}
            onClick={() => selectMode("draw")}
          >
            Draw signature
          </button>
          <button
            type="button"
            className={mode === "type" ? "active" : ""}
            aria-pressed={mode === "type"}
            onClick={() => selectMode("type")}
          >
            Type your name
          </button>
        </div>

        {mode === "draw" ? (
          <div className="signature-draw-panel">
            <div className="signature-canvas-wrap">
              <SignatureCanvas
                ref={canvasRef}
                penColor="#172033"
                minWidth={1.2}
                maxWidth={2.8}
                clearOnResize={false}
                onBegin={() => setError("")}
                onEnd={() => setHasDrawing(!canvasRef.current?.isEmpty())}
                canvasProps={{
                  width: 500,
                  height: 190,
                  className: "signature-canvas",
                  "aria-label": "Draw your signature",
                }}
              />
              <span className="signature-line" aria-hidden="true" />
            </div>
            <div className="signature-draw-actions">
              <span>Use your mouse, trackpad, or touchscreen.</span>
              <button
                className="btn ghost compact"
                type="button"
                disabled={!hasDrawing}
                onClick={clearDrawing}
              >
                Clear
              </button>
            </div>
          </div>
        ) : (
          <div className="signature-type-panel">
            <label className="field">
              <span>Your full name</span>
              <input
                value={typedName}
                autoComplete="name"
                placeholder="Type your name"
                onChange={(event) => {
                  setTypedName(event.target.value);
                  setError("");
                }}
              />
            </label>
            <div className="signature-type-preview" aria-label="Signature preview">
              {typedName.trim() || "Your signature preview"}
            </div>
          </div>
        )}

        <label className="signature-consent">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(event) => {
              setAgreed(event.target.checked);
              setError("");
            }}
          />
          <span>I agree to sign this document electronically</span>
        </label>

        {error ? (
          <p className="signature-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
