/**
 * Somewhere to write a decrypted payload that is not memory.
 *
 * A multi-gigabyte download cannot be assembled into a Blob, so we need a sink
 * that streams to disk. Three, in order of preference:
 *
 *   1. File System Access API — a real file handle. Chrome, Edge, Opera.
 *   2. Service worker  — manufactures a native browser download from a stream.
 *      Everywhere else, including Firefox, Safari, and mobile. See
 *      public/_download/sw.js, which is scoped to /_download/ and can intercept
 *      nothing else.
 *   3. Blob — buffers everything. Only for payloads small enough to hold.
 *
 * Everything is served from our own origin; no third-party script or iframe is
 * involved at any point.
 *
 * ---------------------------------------------------------------------------
 * Call this from the click handler, before starting the transfer.
 * ---------------------------------------------------------------------------
 * `showSaveFilePicker` requires user activation, and activation does not
 * survive an intervening `await`. Create the sink first, then fetch.
 */

const SW_URL = '/_download/sw.js';
const SW_MESSAGE_TYPE = 'crypt.fyi/download';
/** Above this, a Blob is not a responsible fallback. */
export const BLOB_SINK_LIMIT = 200 * 1024 * 1024;
/**
 * How long to wait, once every byte has been handed to the worker, for its
 * confirmation that the browser pulled them. A worker from an older build never
 * sends one, so the download is treated as finished after this.
 */
const COMPLETION_GRACE_MS = 30_000;

export type SaveSinkKind = 'file-system-access' | 'service-worker' | 'blob';

type SaveSinkOptions = {
  filename: string;
  /** Plaintext byte length; lets the browser show real progress. */
  size: number;
  mimeType?: string;
};

type FileSystemWritable = WritableStream<Uint8Array> & { close(): Promise<void> };
type FileSystemFileHandle = { createWritable(): Promise<FileSystemWritable> };
type SaveFilePicker = (options: {
  suggestedName?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}) => Promise<FileSystemFileHandle>;

const getSaveFilePicker = (): SaveFilePicker | undefined =>
  (globalThis as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;

/**
 * Transferring a ReadableStream to the worker needs transferable streams
 * (Chrome 87+, Firefox 103+, Safari 16.4+). Probe rather than sniff versions.
 */
const supportsTransferableStreams = (): boolean => {
  try {
    const stream = new ReadableStream();
    const channel = new MessageChannel();
    channel.port1.postMessage(stream, [stream as unknown as Transferable]);
    channel.port1.close();
    channel.port2.close();
    return true;
  } catch {
    return false;
  }
};

export const supportsFileSystemAccess = (): boolean => typeof getSaveFilePicker() === 'function';

export const supportsServiceWorkerSink = (): boolean =>
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  window.isSecureContext &&
  supportsTransferableStreams();

/** Opaque, bounded token — the shape the worker will accept. */
const newDownloadId = (): string => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};

/**
 * A promise with its settle functions exposed. Callers await `done` only after
 * a successful transfer, so on the abort path it rejects with nobody listening;
 * the attached no-op handler keeps that from surfacing as an unhandled
 * rejection while still delivering it to anyone who does await it.
 */
const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
};

// The worker is registered on demand and unregistered once the last download
// finishes, so it is not resident while the app is merely open.
let activeDownloads = 0;

const releaseWorker = async () => {
  activeDownloads = Math.max(0, activeDownloads - 1);
  if (activeDownloads > 0) {
    return;
  }
  try {
    const registration = await navigator.serviceWorker.getRegistration(SW_URL);
    await registration?.unregister();
  } catch {
    // Unregistering is hygiene, not correctness.
  }
};

const armWorker = async (
  id: string,
  stream: ReadableStream<Uint8Array>,
  options: SaveSinkOptions,
  /** Called when the worker reports the browser has pulled every byte. */
  onComplete: () => void,
): Promise<void> => {
  const registration = await navigator.serviceWorker.register(SW_URL);

  // Deliberately NOT navigator.serviceWorker.ready: that resolves only once the
  // *current page* has a controlling worker, and this worker is scoped to
  // /_download/ precisely so it never controls the app. Awaiting it hangs
  // forever. The worker's own state is the signal that matters here.
  const worker = registration.active ?? registration.waiting ?? registration.installing;
  if (!worker) {
    throw new Error('download worker failed to start');
  }
  if (worker.state !== 'activated') {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('download worker did not activate')),
        10_000,
      );
      const onChange = () => {
        if (worker.state === 'activated') {
          clearTimeout(timeout);
          worker.removeEventListener('statechange', onChange);
          resolve();
        }
      };
      worker.addEventListener('statechange', onChange);
      onChange();
    });
  }

  // Wait for the worker to confirm it is holding the stream before navigating.
  // Without the ack there is a window in which a terminated worker would drop
  // the entry and the iframe would 404. The port then stays open for the
  // worker's completion notice, which is what `done` waits on.
  const channel = new MessageChannel();
  const acked = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      channel.port1.close();
      reject(new Error('download worker did not respond'));
    }, 10_000);
    channel.port1.onmessage = (
      event: MessageEvent<{ ok?: boolean; reason?: string; type?: string }>,
    ) => {
      if (event.data?.type === 'complete') {
        channel.port1.close();
        onComplete();
        return;
      }
      clearTimeout(timeout);
      if (event.data?.ok) {
        resolve();
      } else {
        channel.port1.close();
        reject(new Error(event.data?.reason ?? 'worker refused'));
      }
    };
  });

  worker.postMessage(
    { type: SW_MESSAGE_TYPE, id, filename: options.filename, size: options.size, stream },
    [stream as unknown as Transferable, channel.port2],
  );

  await acked;
};

/** Triggers the download without navigating the page away. */
const openDownloadFrame = (id: string): (() => void) => {
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.src = `/_download/${id}`;
  document.body.appendChild(frame);
  return () => frame.remove();
};

/**
 * A sink that can be created before the filename is known.
 *
 * The name lives inside the container's encrypted metadata frame, so it is only
 * available after the header authenticates — by which point the click's user
 * activation is gone. The File System Access picker therefore has to run
 * immediately (the user names the file themselves), while the service worker
 * and blob sinks can wait and use the real name.
 */
export type PendingSaveSink = {
  kind: SaveSinkKind;
  writable: WritableStream<Uint8Array>;
  /** Call once the container's metadata is known. */
  arm(info: { filename: string; size: number }): Promise<void>;
  /**
   * Settles once the download is over: resolves when every byte has landed —
   * on disk, or with the browser's download manager for the service worker —
   * and rejects if the sink is aborted. Await it after the transfer finishes;
   * whatever the sink held for the download is released when it settles.
   */
  done: Promise<void>;
  /** Abandons the download and releases anything held for it. */
  abort(reason?: unknown): Promise<void>;
};

export const createPendingSaveSink = async (suggestedName: string): Promise<PendingSaveSink> => {
  // The service worker is preferred, even where the File System Access API is
  // available, because it is armed *after* the container header authenticates
  // and can therefore use the real filename. The FSA picker has to run inside
  // the click to keep transient user activation, which is long before the name
  // is known — so it can only ever offer a placeholder, and the saved file ends
  // up called that. A correct filename beats choosing the folder.
  if (supportsServiceWorkerSink()) {
    const done = deferred();
    let closeFrame: (() => void) | undefined;
    let armed = false;
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    // Ends the download exactly once, however it ends: completion, the grace
    // timeout, a failed arm, or an abort. Only an armed download holds a slot
    // in the worker count, so only an armed one gives it back.
    const settle = async (outcome: { ok: true } | { ok: false; reason: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      closeFrame?.();
      closeFrame = undefined;
      if (armed) {
        await releaseWorker();
      }
      if (outcome.ok) {
        done.resolve();
      } else {
        done.reject(outcome.reason);
      }
    };

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
      // Every byte has now been handed to the worker, but the browser may not
      // have pulled the last of them yet; removing the iframe or unregistering
      // the worker here could cut the download short. Wait for the worker's
      // confirmation, bounded in case it never comes.
      flush() {
        graceTimer = setTimeout(() => void settle({ ok: true }), COMPLETION_GRACE_MS);
      },
    });

    return {
      kind: 'service-worker',
      writable,
      arm: async ({ filename, size }) => {
        const id = newDownloadId();
        activeDownloads += 1;
        armed = true;
        try {
          await armWorker(id, readable, { filename, size }, () => void settle({ ok: true }));
        } catch (error) {
          await settle({ ok: false, reason: error });
          throw error;
        }
        closeFrame = openDownloadFrame(id);
      },
      done: done.promise,
      abort: async (reason) => {
        // Usually already aborted through the reader's own writer, in which
        // case the stream is locked and this is a no-op.
        await writable.abort(reason).catch(() => undefined);
        await settle({ ok: false, reason });
      },
    };
  }

  // Fallback for a secure context with FSA but no usable service worker. The
  // name cannot be recovered here, so the user names the file themselves.
  const picker = getSaveFilePicker();
  if (picker) {
    const handle = await picker({ suggestedName });
    const fileWriter = (await handle.createWritable()).getWriter();
    const done = deferred();
    // Wrapped so `done` follows the file's own close, which resolves only once
    // the write has been committed to disk.
    const writable = new WritableStream<Uint8Array>({
      write: (chunk) => fileWriter.write(chunk),
      close: async () => {
        await fileWriter.close();
        done.resolve();
      },
      abort: async (reason) => {
        await fileWriter.abort(reason).catch(() => undefined);
        done.reject(reason);
      },
    });
    return {
      kind: 'file-system-access',
      writable,
      arm: async () => {},
      done: done.promise,
      abort: async (reason) => {
        await writable.abort(reason).catch(() => undefined);
        done.reject(reason);
      },
    };
  }

  const chunks: Uint8Array[] = [];
  let name = suggestedName;
  const done = deferred();

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
    close() {
      const blob = new Blob(chunks as BlobPart[], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      done.resolve();
    },
  });

  return {
    kind: 'blob',
    writable,
    arm: async ({ filename, size }) => {
      if (size > BLOB_SINK_LIMIT) {
        throw new Error(
          'This browser cannot save a file this large. Try Chrome or Edge, which support streaming downloads.',
        );
      }
      name = filename;
    },
    done: done.promise,
    abort: async (reason) => {
      await writable.abort(reason).catch(() => undefined);
      chunks.length = 0;
      done.reject(reason);
    },
  };
};
