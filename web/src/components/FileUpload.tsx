import { ChangeEvent, DragEvent, useRef, useState } from "react";

type FileUploadProps = {
  multiple?: boolean;
  accept?: string;
  onFilesChange?: (files: File[]) => void;
  maxSize?: number;
};

type FileState = {
  file: File;
  progress: number;
  error?: string;
  preview?: string;
};

export default function FileUpload({
  multiple = false,
  accept,
  onFilesChange,
  maxSize,
}: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<FileState[]>([]);
  const [dragging, setDragging] = useState(false);

  const processFiles = (selectedFiles: File[]) => {
    const validFiles = selectedFiles.map((file) => {
      const error =
        maxSize && file.size > maxSize
          ? `File too large. Maximum size is ${(maxSize / 1024 / 1024).toFixed(1)} MB.`
          : undefined;

      const preview = file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : undefined;

      return {
        file,
        progress: error ? 0 : 100,
        error,
        preview,
      };
    });

    const nextFiles = multiple ? validFiles : validFiles.slice(0, 1);

    setFiles(nextFiles);
    onFilesChange?.(
      nextFiles.filter((item) => !item.error).map((item) => item.file),
    );
  };

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    processFiles(Array.from(event.target.files ?? []));
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    processFiles(Array.from(event.dataTransfer.files));
  };

  const removeFile = (index: number) => {
    const nextFiles = files.filter((_, fileIndex) => fileIndex !== index);
    setFiles(nextFiles);
    onFilesChange?.(
      nextFiles.filter((item) => !item.error).map((item) => item.file),
    );
  };

  return (
    <div className="file-upload">
      <div
        className={`file-upload-dropzone${dragging ? " is-dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            inputRef.current?.click();
          }
        }}
      >
        <strong>Drop files here</strong>
        <span>or click to browse</span>

        <input
          ref={inputRef}
          type="file"
          hidden
          multiple={multiple}
          accept={accept}
          onChange={handleInputChange}
        />
      </div>

      {files.length > 0 && (
        <div className="file-upload-list">
          {files.map((item, index) => (
            <div className="file-upload-item" key={`${item.file.name}-${index}`}>
              {item.preview ? (
                <img
                  src={item.preview}
                  alt={item.file.name}
                  className="file-upload-preview"
                />
              ) : (
                <div className="file-upload-file-icon">FILE</div>
              )}

              <div className="file-upload-info">
                <div className="file-upload-name">{item.file.name}</div>

                <div className="file-upload-progress">
                  <div
                    className="file-upload-progress-bar"
                    style={{ width: `${item.progress}%` }}
                  />
                </div>

                {item.error ? (
                  <div className="file-upload-error">{item.error}</div>
                ) : (
                  <div className="file-upload-status">
                    {item.progress}% uploaded
                  </div>
                )}
              </div>

              <button
                type="button"
                className="file-upload-remove"
                onClick={() => removeFile(index)}
                aria-label={`Remove ${item.file.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}