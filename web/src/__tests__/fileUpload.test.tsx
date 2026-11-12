import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FileUpload, {
  DEFAULT_MAX_SIZE,
  FileUploadItemView,
  buildSelection,
  fileUploadStatusLabel,
  handleDropzoneKeyDown,
  markUploadFailed,
  markUploaded,
  markUploading,
  matchesAccept,
  removeItem,
  replaceSelection,
  revokeAllPreviews,
  toUploadErrorMessage,
  uploadFiles,
  validateFile,
  type FileUploadItem,
} from "../components/FileUpload";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../lib/api", () => ({ api: apiMock }));

const createObjectURL = vi.fn<(obj: Blob | MediaSource) => string>();
const revokeObjectURL = vi.fn<(url: string) => void>();

function makeFile(name = "photo.png", type = "image/png", size = 8) {
  return new File([new Uint8Array(size)], name, { type });
}

let sequence = 0;

function makeItem(
  name = "photo.png",
  overrides: Partial<FileUploadItem> = {},
): FileUploadItem {
  sequence += 1;
  return {
    id: `item-${sequence}`,
    file: makeFile(name),
    status: "ready",
    progress: 0,
    preview: `blob:item-${sequence}`,
    ...overrides,
  };
}

beforeEach(() => {
  apiMock.mockReset();
  createObjectURL.mockReset();
  revokeObjectURL.mockReset();
  sequence = 0;
  let url = 0;
  createObjectURL.mockImplementation(() => `blob:test-${++url}`);
  vi.spyOn(URL, "createObjectURL").mockImplementation(createObjectURL);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeObjectURL);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FileUpload accessibility", () => {
  it("renders button semantics with a keyboard-reachable dropzone", () => {
    const markup = renderToStaticMarkup(<FileUpload accept="image/*" />);

    expect(markup).toContain('role="button"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('aria-disabled="false"');
    expect(markup).toContain('type="file"');
    expect(markup).toContain('accept="image/*"');
  });

  it("renders a disabled, non-focusable dropzone when disabled", () => {
    const markup = renderToStaticMarkup(<FileUpload disabled />);

    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toMatch(/<input[^>]*disabled/);
  });

  it("cancels Enter and Space defaults before opening the picker", () => {
    for (const key of ["Enter", " "]) {
      const preventDefault = vi.fn();
      const open = vi.fn();
      handleDropzoneKeyDown({ key, preventDefault }, open);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledTimes(1);
    }
  });

  it("does not activate the picker when disabled", () => {
    const preventDefault = vi.fn();
    const open = vi.fn();
    handleDropzoneKeyDown({ key: " ", preventDefault }, open, true);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("announces errors and exposes progressbar semantics per item", () => {
    const item = makeItem("big.png", {
      status: "error",
      error: "File too large. Maximum size is 20 MB.",
    });
    const markup = renderToStaticMarkup(
      <FileUploadItemView item={item} onRemove={() => {}} />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("File too large");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuemin="0"');
    expect(markup).toContain('aria-valuemax="100"');
    expect(markup).toContain('aria-valuenow="0"');
    expect(markup).toContain('aria-label="Remove big.png"');
  });

  it("only reports an item as uploaded after a completed upload", () => {
    const ready = renderToStaticMarkup(
      <FileUploadItemView item={makeItem("a.png")} />,
    );
    const uploaded = renderToStaticMarkup(
      <FileUploadItemView
        item={makeItem("b.png", { status: "uploaded", progress: 100 })}
      />,
    );

    expect(ready).toContain("Selected");
    expect(ready).toContain('aria-valuenow="0"');
    expect(uploaded).toContain("Uploaded");
    expect(uploaded).toContain('aria-valuenow="100"');
  });
});

describe("FileUpload validation parity", () => {
  it("uses one pipeline for input and drop selections", () => {
    const unsupported = buildSelection([makeFile("notes.txt", "text/plain", 4)], {
      accept: "image/*",
      maxSize: 10,
    });
    const oversized = buildSelection([makeFile("big.png", "image/png", 11)], {
      accept: "image/*",
      maxSize: 10,
    });

    expect(unsupported.items[0].status).toBe("error");
    expect(unsupported.items[0].error).toContain("File type not allowed");
    expect(oversized.items[0].status).toBe("error");
    expect(oversized.items[0].error).toContain("File too large");
  });

  it("caps selections at maxFiles and announces the limit", () => {
    const result = buildSelection(
      [makeFile("a.png"), makeFile("b.png"), makeFile("c.png")],
      { multiple: true, maxFiles: 2 },
    );

    expect(result.items).toHaveLength(2);
    expect(result.overflow).toBe(1);
    expect(result.error).toContain("up to 2 files");
  });

  it("keeps exactly one file in single-file mode", () => {
    const result = buildSelection([makeFile("a.png"), makeFile("b.png")], {
      multiple: false,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].file.name).toBe("a.png");
  });

  it("matches accept wildcards, exact MIME types, and extensions", () => {
    expect(matchesAccept({ name: "a.PNG", type: "image/png" }, ".png")).toBe(
      true,
    );
    expect(matchesAccept({ name: "a.png", type: "image/png" }, "image/*")).toBe(
      true,
    );
    expect(matchesAccept({ name: "a.txt", type: "text/plain" }, "image/*")).toBe(
      false,
    );
    expect(
      matchesAccept(
        { name: "a.pdf", type: "application/pdf" },
        "application/pdf",
      ),
    ).toBe(true);
    expect(
      matchesAccept({ name: "a.pdf", type: "application/pdf" }, ".png,image/*"),
    ).toBe(false);
  });

  it("defaults to the backend's 20 MB size limit", () => {
    expect(DEFAULT_MAX_SIZE).toBe(20 * 1024 * 1024);
    expect(
      validateFile({
        name: "big.png",
        type: "image/png",
        size: DEFAULT_MAX_SIZE + 1,
      }),
    ).toContain("20 MB");
    expect(
      validateFile({
        name: "ok.png",
        type: "image/png",
        size: DEFAULT_MAX_SIZE,
      }),
    ).toBeUndefined();
  });
});

describe("FileUpload blob URL lifecycle", () => {
  it("creates previews only for images", () => {
    buildSelection([makeFile("doc.pdf", "application/pdf", 4)], {
      accept: "application/pdf",
    });
    expect(createObjectURL).not.toHaveBeenCalled();

    const image = buildSelection([makeFile("photo.png")], {});
    expect(image.items[0].preview).toBe("blob:test-1");
  });

  it("revokes the preview when an item is removed", () => {
    const result = buildSelection([makeFile("photo.png")], {});
    const preview = result.items[0].preview;

    const next = removeItem(result.items, result.items[0].id);

    expect(next).toHaveLength(0);
    expect(revokeObjectURL).toHaveBeenCalledWith(preview);
  });

  it("revokes the replaced preview in single-file mode", () => {
    const first = buildSelection([makeFile("a.png")], { multiple: false });
    const preview = first.items[0].preview;

    const second = replaceSelection(first.items, [makeFile("b.png")], {
      multiple: false,
    });

    expect(second.items).toHaveLength(1);
    expect(second.items[0].file.name).toBe("b.png");
    expect(revokeObjectURL).toHaveBeenCalledWith(preview);
  });

  it("revokes every remaining preview during unmount cleanup", () => {
    const result = buildSelection(
      [makeFile("a.png"), makeFile("b.png")],
      { multiple: true },
    );

    revokeAllPreviews(result.items);

    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledWith(result.items[0].preview);
    expect(revokeObjectURL).toHaveBeenCalledWith(result.items[1].preview);
  });
});

describe("FileUpload backend transport", () => {
  it("posts FormData with backend field names through api('/uploads')", async () => {
    const saved = [{ id: "upload-1", url: "/uploads/a.png" }];
    apiMock.mockResolvedValue(saved);
    const signal = new AbortController().signal;

    const result = await uploadFiles([makeFile("a.png")], {
      contactId: "contact-1",
      dealId: "deal-1",
      signal,
    });

    expect(result).toEqual(saved);
    expect(apiMock).toHaveBeenCalledTimes(1);
    const [path, options] = apiMock.mock.calls[0];
    expect(path).toBe("/uploads");
    expect(options.method).toBe("POST");
    expect(options.signal).toBe(signal);
    expect(options.body).toBeInstanceOf(FormData);

    const body = options.body as FormData;
    expect(body.getAll("files")).toHaveLength(1);
    expect((body.get("files") as File).name).toBe("a.png");
    expect(body.get("contact")).toBe("contact-1");
    expect(body.get("deal")).toBe("deal-1");
  });

  it("normalizes /api/uploads so api() does not double-prefix", async () => {
    apiMock.mockResolvedValue([]);

    await uploadFiles([makeFile("a.png")], { endpoint: "/api/uploads" });

    expect(apiMock.mock.calls[0][0]).toBe("/uploads");
  });

  it("moves items through uploading, uploaded, and error states", () => {
    const first = makeItem("a.png", { id: "a" });
    const second = makeItem("b.png", { id: "b" });

    const uploading = markUploading([first, second], ["a"]);
    expect(uploading[0].status).toBe("uploading");
    expect(uploading[0].progress).toBe(0);
    expect(uploading[1].status).toBe("ready");

    const uploaded = markUploaded(uploading, ["a"], [
      { id: "upload-1", url: "/uploads/a.png" },
    ]);
    expect(uploaded[0].status).toBe("uploaded");
    expect(uploaded[0].progress).toBe(100);
    expect(uploaded[0].uploaded).toEqual({
      id: "upload-1",
      url: "/uploads/a.png",
    });
    expect(uploaded[1].status).toBe("ready");

    const failed = markUploadFailed([first], ["a"], "Upload rejected");
    expect(failed[0].status).toBe("error");
    expect(failed[0].progress).toBe(0);
    expect(failed[0].error).toBe("Upload rejected");
  });

  it("derives honest status labels and error messages", () => {
    expect(fileUploadStatusLabel(makeItem(), false)).toBe("Selected");
    expect(fileUploadStatusLabel(makeItem(), true)).toBe("Ready to upload");
    expect(
      fileUploadStatusLabel(makeItem("a.png", { status: "uploading" }), true),
    ).toBe("Uploading…");
    expect(
      fileUploadStatusLabel(makeItem("a.png", { status: "uploaded" }), true),
    ).toBe("Uploaded");
    expect(toUploadErrorMessage(new Error("Upload rejected"))).toBe(
      "Upload rejected",
    );
    expect(toUploadErrorMessage("nope")).toBe("Upload failed.");
  });
});
