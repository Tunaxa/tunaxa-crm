import {
  ChangeEvent,
  DragEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "../lib/api";

export type UploadedFile = {
  id?: string;
  filename?: string;
  originalName?: string;
  mimeType?: string;
  size?: number;
  url?: string;
  [key: string]: unknown;
};

export type FileUploadStatus = "ready" | "uploading" | "uploaded" | "error";

export type FileUploadItem = {
  id: string;
  file: File;
  status: FileUploadStatus;
  progress: number;
  error?: string;
  preview?: string;
  uploaded?: UploadedFile;
};

export type FileUploadProps = {
  multiple?: boolean;
  accept?: string;
  onFilesChange?: (files: File[]) => void;
  maxSize?: number;
  maxFiles?: number;
  autoUpload?: boolean;
  /** Path relative to the API base, so the default resolves to /api/uploads. */
  endpoint?: string;
  contactId?: string;
  dealId?: string;
  onUploadComplete?: (uploaded: UploadedFile[]) => void;
  onUploadError?: (message: string) => void;
  disabled?: boolean;
};

export type SelectionOptions = {
  accept?: string;
  maxSize?: number;
  maxFiles?: number;
  multiple?: boolean;
};

export type SelectionResult = {
  items: FileUploadItem[];
  overflow: number;
  error: string;
};

export type UploadOptions = {
  endpoint?: string;
  contactId?: string;
  dealId?: string;
  signal?: AbortSignal;
};

export const DEFAULT_MAX_SIZE = 20 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 10;

let itemSequence = 0;

function createItemId() {
  itemSequence += 1;
  return `file-upload-item-${itemSequence}`;
}

export function formatFileSize(bytes: number) {
  if (bytes >= 1024 * 1024) {
    const megabytes = bytes / (1024 * 1024);
    return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
  }
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

type FileLike = Pick<File, "name" | "type" | "size">;

/**
 * Matches an `accept` string the same way a browser does for the file picker,
 * but also applies it to dropped files. Supports `image/*`, exact MIME types,
 * and `.ext` suffixes.
 */
export function matchesAccept(file: Pick<File, "name" | "type">, accept?: string) {
  if (!accept) return true;
  const tokens = accept
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return true;

  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();

  return tokens.some((token) => {
    if (token === "*/*" || token === "*") return true;
    if (token.startsWith(".")) return name.endsWith(token);
    if (token.endsWith("/*")) {
      const prefix = token.slice(0, token.indexOf("/"));
      return type.startsWith(`${prefix}/`);
    }
    return type === token;
  });
}

export function validateFile(
  file: FileLike,
  options: { accept?: string; maxSize?: number } = {},
) {
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  if (file.size > maxSize) {
    return `File too large. Maximum size is ${formatFileSize(maxSize)}.`;
  }
  if (!matchesAccept(file, options.accept)) {
    return options.accept
      ? `File type not allowed. Accepted types: ${options.accept}.`
      : "File type not allowed.";
  }
  return undefined;
}

export function selectedFileLimit(options: SelectionOptions = {}) {
  return options.multiple
    ? Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES)
    : 1;
}

/** Shared by the file input and drag-and-drop paths so validation cannot drift. */
export function buildSelection(
  files: File[],
  options: SelectionOptions = {},
): SelectionResult {
  const limit = selectedFileLimit(options);
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  const accepted = files.slice(0, limit);
  const overflow = files.length - accepted.length;

  const items = accepted.map((file) => {
    const error = validateFile(file, { accept: options.accept, maxSize });
    return {
      id: createItemId(),
      file,
      status: error ? ("error" as const) : ("ready" as const),
      progress: 0,
      error,
      preview:
        !error && file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : undefined,
    } satisfies FileUploadItem;
  });

  return {
    items,
    overflow,
    error:
      overflow > 0
        ? `You can select up to ${limit} file${limit === 1 ? "" : "s"} at a time.`
        : "",
  };
}

export function revokePreview(item: FileUploadItem) {
  if (item.preview) URL.revokeObjectURL(item.preview);
}

export function revokeAllPreviews(items: FileUploadItem[]) {
  items.forEach(revokePreview);
}

/** Replaces the current selection (including single-file overwrite) safely. */
export function replaceSelection(
  previous: FileUploadItem[],
  files: File[],
  options: SelectionOptions = {},
) {
  revokeAllPreviews(previous);
  return buildSelection(files, options);
}

export function removeItem(items: FileUploadItem[], id: string) {
  const removed = items.find((item) => item.id === id);
  if (removed) revokePreview(removed);
  return items.filter((item) => item.id !== id);
}

export function markUploading(items: FileUploadItem[], ids: readonly string[]) {
  const pending = new Set(ids);
  return items.map((item) =>
    pending.has(item.id)
      ? { ...item, status: "uploading" as const, progress: 0, error: undefined }
      : item,
  );
}

export function markUploaded(
  items: FileUploadItem[],
  ids: readonly string[],
  uploaded: UploadedFile[],
) {
  const pending = new Set(ids);
  return items.map((item) => {
    if (!pending.has(item.id)) return item;
    return {
      ...item,
      status: "uploaded" as const,
      progress: 100,
      error: undefined,
      uploaded: uploaded[ids.indexOf(item.id)],
    };
  });
}

export function markUploadFailed(
  items: FileUploadItem[],
  ids: readonly string[],
  message: string,
) {
  const failed = new Set(ids);
  return items.map((item) =>
    failed.has(item.id)
      ? { ...item, status: "error" as const, progress: 0, error: message }
      : item,
  );
}

export function toUploadErrorMessage(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : "Upload failed.";
}

/** `/api/uploads` and `uploads` both become `/uploads` before api() prefixes `/api`. */
export function normalizeEndpoint(endpoint: string) {
  const value = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return value.startsWith("/api/") ? value.slice(4) : value;
}

export function buildUploadForm(files: File[], options: UploadOptions = {}) {
  const form = new FormData();
  files.forEach((file) => form.append("files", file, file.name));
  if (options.contactId) form.append("contact", options.contactId);
  if (options.dealId) form.append("deal", options.dealId);
  return form;
}

export function uploadFiles(files: File[], options: UploadOptions = {}) {
  return api<UploadedFile[]>(normalizeEndpoint(options.endpoint ?? "/uploads"), {
    method: "POST",
    body: buildUploadForm(files, options),
    signal: options.signal,
  });
}

type ActivationKeyEvent = {
  key: string;
  preventDefault: () => void;
};

export function handleDropzoneKeyDown(
  event: ActivationKeyEvent,
  open: () => void,
  disabled = false,
) {
  if (disabled) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    open();
  }
}

export function fileUploadStatusLabel(item: FileUploadItem, autoUpload: boolean) {
  if (item.status === "uploading") return "Uploading…";
  if (item.status === "uploaded") return "Uploaded";
  if (item.status === "error") return "Upload failed";
  return autoUpload ? "Ready to upload" : "Selected";
}

export type FileUploadItemViewProps = {
  item: FileUploadItem;
  autoUpload?: boolean;
  disabled?: boolean;
  onRemove?: (id: string) => void;
};

export function FileUploadItemView({
  item,
  autoUpload = false,
  disabled = false,
  onRemove,
}: FileUploadItemViewProps) {
  return (
    <div className="file-upload-item">
      {item.preview ? (
        <img
          src={item.preview}
          alt={item.file.name}
          className="file-upload-preview"
        />
      ) : (
        <div className="file-upload-file-icon" aria-hidden="true">
          FILE
        </div>
      )}

      <div className="file-upload-info">
        <div className="file-upload-name">{item.file.name}</div>

        <div
          className="file-upload-progress"
          role="progressbar"
          aria-label={`Upload progress for ${item.file.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={item.progress}
        >
          <div
            className="file-upload-progress-bar"
            style={{ width: `${item.progress}%` }}
          />
        </div>

        {item.error ? (
          <div className="file-upload-error" role="alert" aria-live="polite">
            {item.error}
          </div>
        ) : (
          <div className="file-upload-status">
            {fileUploadStatusLabel(item, autoUpload)}
          </div>
        )}
      </div>

      <button
        type="button"
        className="file-upload-remove"
        onClick={() => onRemove?.(item.id)}
        aria-label={`Remove ${item.file.name}`}
        disabled={disabled}
      >
        ×
      </button>
    </div>
  );
}

export default function FileUpload({
  multiple = false,
  accept,
  onFilesChange,
  maxSize = DEFAULT_MAX_SIZE,
  maxFiles,
  autoUpload = false,
  endpoint = "/uploads",
  contactId,
  dealId,
  onUploadComplete,
  onUploadError,
  disabled = false,
}: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<FileUploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [batchError, setBatchError] = useState("");

  const itemsRef = useRef<FileUploadItem[]>([]);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  // Defer revocation by a tick so React StrictMode's mount/cleanup/mount cycle
  // in development does not revoke previews that are still on screen.
  const revokeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    if (revokeTimerRef.current !== null) {
      clearTimeout(revokeTimerRef.current);
      revokeTimerRef.current = null;
    }
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      controllerRef.current?.abort();
      revokeTimerRef.current = setTimeout(() => {
        revokeTimerRef.current = null;
        revokeAllPreviews(itemsRef.current);
      }, 0);
    };
  }, []);

  function commit(next: FileUploadItem[]) {
    itemsRef.current = next;
    setItems(next);
  }

  function openPicker() {
    if (disabled) return;
    const input = inputRef.current;
    if (input && typeof input.click === "function") input.click();
  }

  async function uploadBatch(batch: FileUploadItem[], generation: number) {
    const uploadable = batch.filter((item) => !item.error);
    if (uploadable.length === 0) return;

    const ids = uploadable.map((item) => item.id);
    const controller = new AbortController();
    controllerRef.current = controller;
    commit(markUploading(itemsRef.current, ids));

    try {
      const saved = await uploadFiles(
        uploadable.map((item) => item.file),
        { endpoint, contactId, dealId, signal: controller.signal },
      );
      if (!mountedRef.current || generation !== generationRef.current) return;

      const uploaded = Array.isArray(saved) ? saved : [];
      commit(markUploaded(itemsRef.current, ids, uploaded));
      onUploadComplete?.(uploaded);
    } catch (error) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      const message = toUploadErrorMessage(error);
      commit(markUploadFailed(itemsRef.current, ids, message));
      onUploadError?.(message);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  function processFiles(selectedFiles: File[]) {
    if (disabled) return;

    controllerRef.current?.abort();
    const generation = generationRef.current + 1;
    generationRef.current = generation;

    const result = replaceSelection(itemsRef.current, selectedFiles, {
      accept,
      maxSize,
      maxFiles,
      multiple,
    });

    setBatchError(result.error);
    commit(result.items);

    const valid = result.items.filter((item) => !item.error);
    onFilesChange?.(valid.map((item) => item.file));

    if (autoUpload && valid.length > 0) void uploadBatch(result.items, generation);
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    processFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    processFiles(Array.from(event.dataTransfer.files));
  }

  function removeFile(id: string) {
    const next = removeItem(itemsRef.current, id);
    commit(next);
    onFilesChange?.(
      next.filter((item) => !item.error).map((item) => item.file),
    );
  }

  const uploading = items.some((item) => item.status === "uploading");

  return (
    <div
      className={`file-upload${disabled ? " is-disabled" : ""}${
        uploading ? " is-uploading" : ""
      }`}
      aria-busy={uploading}
    >
      <div
        className={`file-upload-dropzone${dragging ? " is-dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={openPicker}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onKeyDown={(event) =>
          handleDropzoneKeyDown(event, openPicker, disabled)
        }
      >
        <strong>Drop files here</strong>
        <span>or click to browse</span>

        <input
          ref={inputRef}
          type="file"
          hidden
          multiple={multiple}
          accept={accept}
          disabled={disabled}
          onChange={handleInputChange}
        />
      </div>

      {batchError ? (
        <div
          className="file-upload-error file-upload-batch-error"
          role="alert"
          aria-live="polite"
        >
          {batchError}
        </div>
      ) : null}

      {items.length > 0 && (
        <div className="file-upload-list">
          {items.map((item) => (
            <FileUploadItemView
              key={item.id}
              item={item}
              autoUpload={autoUpload}
              disabled={disabled}
              onRemove={removeFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}
