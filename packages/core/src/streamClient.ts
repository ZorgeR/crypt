import {
  createStreamEncryptor,
  openStream,
  frameCountFor,
  parseStreamHeader,
  readWrappedKeyLength,
  HEADER_FIXED_LENGTH,
  TAG_LENGTH,
  DEFAULT_FRAME_SIZE_LOG2,
  type StreamMetadata,
} from './encryption/stream';
import { generateRandomString } from './random';
import { deriveVerificationHash } from './verification';
import { KEY_VERSION_2_PREFIX } from './verification';
import {
  STREAM_MEDIA_TYPE,
  type CreateStreamRequest,
  type CreateStreamResponse,
  type CreateVaultResponse,
} from './api';
import {
  ErrorNotFound,
  ErrorInvalidKeyAndOrPassword,
  ErrorUnexpectedStatus,
  ErrorPayloadTooLarge,
  ErrorInlinePayload,
  storedKindOf,
} from './client';
import { createFetchRetryClient, FetchRetryError, HTTPError } from './fetchRetry';

/** S3's floor for every part but the last; mirrored from the server. */
const MIN_PART_SIZE = 5 * 1024 * 1024;

/** Attempts per part, counting the first. */
const DEFAULT_PART_ATTEMPTS = 4;
/** First retry delay; doubles per attempt up to {@link MAX_RETRY_DELAY_MS}. */
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 15_000;

export type ProgressPhase = 'encrypting' | 'uploading' | 'downloading' | 'decrypting';

export type ProgressEvent = {
  phase: ProgressPhase;
  /** Plaintext (or ciphertext, when transferring) bytes handled so far. */
  bytes: number;
  total: number;
};

/**
 * Payloads above this take the streamed path. Kept here so the client, the UI,
 * and the CLI all route on the same number.
 *
 * Deliberately small: an inline secret is stored whole in Redis, and expands
 * ~1.8x (no password) to ~2.4x (password) through encryption and base64, so
 * every byte of threshold costs multiples of itself in memory. 128 KiB covers
 * text secrets and small files comfortably while keeping a max-size inline
 * entry around 300 KB rather than 3.5 MB.
 */
export const INLINE_PAYLOAD_MAX_BYTES = 128 * 1024;

/**
 * A payload the client can read piecewise. A `File` never has to be resident:
 * only the frames currently being encrypted are in memory.
 */
export type ByteSource = {
  size: number;
  slice(start: number, end: number): Promise<Uint8Array>;
};

export const bytesToSource = (bytes: Uint8Array): ByteSource => ({
  size: bytes.length,
  slice: async (start, end) => bytes.subarray(start, end),
});

/** Backs a source with a Blob or File, which reads lazily from disk. */
export const blobToSource = (blob: Blob): ByteSource => ({
  size: blob.size,
  slice: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
});

// Blob is absent in some runtimes, so probe before testing against it — an
// inline `typeof` guard also stops TypeScript narrowing the union.
const isBlob = (value: unknown): value is Blob =>
  typeof Blob !== 'undefined' && value instanceof Blob;

const toByteSource = (input: Uint8Array | Blob | ByteSource): ByteSource => {
  if (input instanceof Uint8Array) return bytesToSource(input);
  if (isBlob(input)) return blobToSource(input);
  return input;
};

/**
 * Reads an exact number of bytes at a time from a response stream.
 *
 * Chunks are held in a list and only assembled when a caller asks for them, so
 * filling a 4 MiB frame from 64 KB network chunks costs one copy rather than
 * one per chunk.
 */
const createByteReader = (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  let chunks: Uint8Array[] = [];
  let buffered = 0;
  let exhausted = false;

  const pull = async (): Promise<boolean> => {
    if (exhausted) return false;
    const { value, done } = await reader.read();
    if (done) {
      exhausted = true;
      return false;
    }
    if (value?.length) {
      chunks.push(value);
      buffered += value.length;
    }
    return true;
  };

  return {
    async readExactly(length: number): Promise<Uint8Array> {
      while (buffered < length) {
        if (!(await pull())) {
          throw new Error(`stream ended after ${buffered} bytes, expected ${length}`);
        }
      }

      const out = new Uint8Array(length);
      let offset = 0;
      while (offset < length) {
        const chunk = chunks[0];
        const take = Math.min(chunk.length, length - offset);
        out.set(chunk.subarray(0, take), offset);
        offset += take;
        if (take === chunk.length) {
          chunks.shift();
        } else {
          chunks[0] = chunk.subarray(take);
        }
      }
      buffered -= length;
      return out;
    },
    async cancel(reason?: unknown) {
      chunks = [];
      buffered = 0;
      await reader.cancel(reason).catch(() => undefined);
    },
  };
};

export type StreamUploadInput = Omit<CreateStreamRequest, 'h' | 'size' | 'frames'> & {
  content: Uint8Array | Blob | ByteSource;
  metadata: Omit<StreamMetadata, 'size'>;
  password?: string;
  frameSizeLog2?: number;
  onProgress?: (event: ProgressEvent) => void;
  signal?: AbortSignal;
};

/**
 * A part is a whole number of frames, so a failed part can be re-encrypted
 * byte-for-byte and retried without touching its neighbours. Part 1 also
 * carries the container header.
 *
 * Every part except the last must clear the storage minimum, which is what
 * decides how many frames get grouped together.
 */
export const planParts = (args: {
  headerLength: number;
  frameCount: number;
  frameSize: number;
  lastFrameSize: number;
  minPartSize?: number;
}): Array<{ firstFrame: number; lastFrame: number; bytes: number }> => {
  const { headerLength, frameCount, frameSize, lastFrameSize } = args;
  const minPartSize = args.minPartSize ?? MIN_PART_SIZE;
  const sealedFrameSize = frameSize + TAG_LENGTH;

  const parts: Array<{ firstFrame: number; lastFrame: number; bytes: number }> = [];
  let firstFrame = 1;
  let bytes = headerLength;

  for (let frame = 1; frame <= frameCount; frame++) {
    bytes += frame === frameCount ? lastFrameSize + TAG_LENGTH : sealedFrameSize;

    const isLastFrame = frame === frameCount;
    // Close the part once it clears the minimum, or when the payload runs out.
    if (bytes >= minPartSize || isLastFrame) {
      parts.push({ firstFrame, lastFrame: frame, bytes });
      firstFrame = frame + 1;
      bytes = 0;
    }
  }

  // If the tail part came out below the minimum it cannot stand alone unless it
  // is the only part, so fold it into its predecessor.
  if (parts.length > 1) {
    const tail = parts[parts.length - 1];
    if (tail.bytes < minPartSize) {
      const previous = parts[parts.length - 2];
      previous.lastFrame = tail.lastFrame;
      previous.bytes += tail.bytes;
      parts.pop();
    }
  }

  return parts;
};

/**
 * Drives the streamed upload and download flows: container framing, part
 * planning, and the three-call transport. Deliberately free of browser APIs so
 * it runs in the CLI and under test; a worker or a UI wraps it rather than
 * reimplementing it.
 */
export class StreamClient {
  private readonly apiUrl: string;
  private readonly keyLength: number;
  private readonly xClient: string | undefined;
  private readonly putPart: typeof fetch;

  constructor({
    apiUrl,
    keyLength = 32,
    xClient,
    partAttempts = DEFAULT_PART_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  }: {
    apiUrl: string;
    keyLength?: number;
    xClient?: string;
    /** Attempts per part, counting the first. */
    partAttempts?: number;
    /** First retry delay in milliseconds; doubles on each further attempt. */
    retryDelayMs?: number;
  }) {
    this.apiUrl = apiUrl;
    this.keyLength = keyLength;
    this.xClient = xClient;
    // A part is a whole number of frames sealed under a fixed key and counter
    // nonces, so a re-sent part is byte-identical to the first attempt, and the
    // server replaces a part number it has already seen. That makes a retry
    // safe even when the failure was a lost response to a stored part. No
    // per-request timeout: a slow uplink is not a failure, a dropped one is.
    this.putPart = createFetchRetryClient({
      // Resolved per call rather than captured, matching the other requests
      // here, so a fetch installed after construction (tests, polyfills) is used.
      fetchFn: (input, init) => fetch(input, init),
      maxAttempts: partAttempts,
      requestTimeoutMs: 0,
      calculateBackoff: (attempt) => Math.min(retryDelayMs * 2 ** attempt, MAX_RETRY_DELAY_MS),
    });
  }

  private headers(contentType = 'application/json') {
    const headers: Record<string, string> = { 'Content-Type': contentType };
    if (this.xClient) {
      headers['X-Client'] = this.xClient;
    }
    return headers;
  }

  async create(input: StreamUploadInput): Promise<CreateVaultResponse & { key: string }> {
    const {
      content,
      metadata,
      password,
      frameSizeLog2 = DEFAULT_FRAME_SIZE_LOG2,
      onProgress,
      signal,
      ...vaultFields
    } = input;

    const source = toByteSource(content);
    const rawKey = await generateRandomString(this.keyLength);
    const hasPassword = password !== undefined && password !== '';

    const encryptor = await createStreamEncryptor({
      key: rawKey,
      password: hasPassword ? password : undefined,
      plaintextLength: source.size,
      metadata: { ...metadata, size: source.size },
      frameSizeLog2,
    });

    const frameSize = encryptor.frameSize;
    const frameCount = encryptor.frameCount;
    const lastFrameSize = source.size - (frameCount - 1) * frameSize;
    const parts = planParts({
      headerLength: encryptor.header.length,
      frameCount,
      frameSize,
      lastFrameSize,
    });
    const totalBytes = parts.reduce((sum, part) => sum + part.bytes, 0);

    const opened = await fetch(`${this.apiUrl}/vault/stream`, {
      method: 'POST',
      headers: this.headers(),
      signal,
      body: JSON.stringify({
        ...vaultFields,
        h: hasPassword
          ? await deriveVerificationHash('v2', rawKey, password)
          : await deriveVerificationHash('legacy', rawKey),
        size: totalBytes,
        frames: frameCount,
      }),
    });
    if (!opened.ok) {
      throw opened.status === 413
        ? new ErrorPayloadTooLarge()
        : new ErrorUnexpectedStatus(opened.status);
    }
    const session = (await opened.json()) as CreateStreamResponse;

    let uploaded = 0;
    for (const [index, part] of parts.entries()) {
      const chunks: Uint8Array[] = [];
      if (index === 0) {
        chunks.push(encryptor.header);
      }

      for (let frame = part.firstFrame; frame <= part.lastFrame; frame++) {
        const start = (frame - 1) * frameSize;
        // Only this frame is resident; a File is read from disk on demand.
        const plaintext = await source.slice(start, Math.min(start + frameSize, source.size));
        chunks.push(await encryptor.encryptFrame(frame, plaintext));
        onProgress?.({
          phase: 'encrypting',
          bytes: Math.min(frame * frameSize, source.size),
          total: source.size,
        });
      }

      const body = concat(chunks);
      try {
        await this.putPart(
          `${this.apiUrl}/vault/stream/${session.id}/parts/${index + 1}?ut=${encodeURIComponent(session.ut)}`,
          { method: 'PUT', headers: this.headers(STREAM_MEDIA_TYPE), body, signal },
        );
      } catch (error) {
        throw partError(error, signal);
      }

      uploaded += body.length;
      onProgress?.({ phase: 'uploading', bytes: uploaded, total: totalBytes });
    }

    const completed = await fetch(`${this.apiUrl}/vault/stream/${session.id}/complete`, {
      method: 'POST',
      headers: this.headers(),
      signal,
      body: JSON.stringify({ ut: session.ut }),
    });
    if (!completed.ok) {
      throw new ErrorUnexpectedStatus(completed.status);
    }

    return {
      id: session.id,
      dt: session.dt,
      key: hasPassword ? `${KEY_VERSION_2_PREFIX}${rawKey}` : rawKey,
    };
  }

  /**
   * Requests the container, naming only the streamed media type. An inline
   * entry is then refused with 406 before it is burned or counted, rather than
   * consumed by a reader that cannot decode it.
   */
  private async fetchContainer(id: string, h: string, signal?: AbortSignal): Promise<Response> {
    const res = await fetch(`${this.apiUrl}/vault/${id}?h=${h}`, {
      headers: { ...this.headers(), Accept: STREAM_MEDIA_TYPE },
      signal,
    });
    if (!res.ok) {
      if (res.status === 400) throw new ErrorInvalidKeyAndOrPassword();
      if (res.status === 404) throw new ErrorNotFound();
      if (res.status === 406 && (await storedKindOf(res)) === 'inline') {
        throw new ErrorInlinePayload();
      }
      throw new ErrorUnexpectedStatus(res.status);
    }
    if (res.headers.get('content-type')?.includes('application/json')) {
      // Unreachable against a server that negotiates; kept so a misbehaving
      // one fails loudly instead of being parsed as a container.
      await res.body?.cancel().catch(() => undefined);
      throw new ErrorInlinePayload();
    }
    return res;
  }

  /** The shared key is version-prefixed when a password is required. */
  private async credentials(key: string, password: string | undefined) {
    const hasVersionPrefix = key.startsWith(KEY_VERSION_2_PREFIX);
    const rawKey = hasVersionPrefix ? key.slice(KEY_VERSION_2_PREFIX.length) : key;
    return {
      rawKey,
      h: hasVersionPrefix
        ? await deriveVerificationHash('v2', rawKey, password)
        : await deriveVerificationHash('legacy', rawKey),
    };
  }

  /**
   * Streams a payload straight into a sink, decrypting frame by frame.
   *
   * Nothing larger than one frame is ever resident, so this is what a
   * multi-gigabyte download has to use — `read` below buffers the whole
   * container and is only appropriate for payloads that fit in memory.
   *
   * The sink applies backpressure through its writer, so a slow disk throttles
   * the network rather than filling the heap.
   */
  async readToSink(
    id: string,
    key: string,
    password: string | undefined,
    options: {
      sink: WritableStream<Uint8Array>;
      /**
       * Fires once the header authenticates and before any payload byte is
       * written. The filename lives inside the encrypted container, so this is
       * the earliest a caller can name the download.
       */
      onMetadata?: (metadata: StreamMetadata) => void | Promise<void>;
      onProgress?: (event: ProgressEvent) => void;
      signal?: AbortSignal;
    },
  ): Promise<{ metadata: StreamMetadata; burned: boolean }> {
    const { rawKey, h } = await this.credentials(key, password);

    const res = await this.fetchContainer(id, h, options.signal);
    if (!res.body) {
      throw new Error('response carried no body');
    }

    const burned = res.headers.get('x-crypt-burned') === 'true';
    const reader = createByteReader(res.body);
    const writer = options.sink.getWriter();

    try {
      // The header is variable length: read the fixed head, learn the wrapped
      // key length, then the rest of the prefix and the metadata frame.
      const head = await reader.readExactly(HEADER_FIXED_LENGTH);
      const wrappedKeyLength = readWrappedKeyLength(head);
      const rest = await reader.readExactly(28 + wrappedKeyLength - HEADER_FIXED_LENGTH);

      const prefix = new Uint8Array(head.length + rest.length);
      prefix.set(head, 0);
      prefix.set(rest, head.length);

      const parsed = parseStreamHeader(prefix);
      const metaFrame = await reader.readExactly(parsed.metaLength);

      const headerBytes = new Uint8Array(prefix.length + metaFrame.length);
      headerBytes.set(prefix, 0);
      headerBytes.set(metaFrame, prefix.length);

      const decryptor = await openStream(headerBytes, rawKey, password);
      const { header } = decryptor;
      await options.onMetadata?.(decryptor.metadata);
      let written = 0;

      for (let frame = 1; frame <= header.frameCount; frame++) {
        const isFinal = frame === header.frameCount;
        const plaintextLength = isFinal
          ? header.plaintextLength - (header.frameCount - 1) * header.frameSize
          : header.frameSize;

        const sealed = await reader.readExactly(plaintextLength + TAG_LENGTH);
        const opened = await decryptor.decryptFrame(frame, sealed);

        // Backpressure lives here: a slow sink slows the whole pipeline.
        await writer.write(opened);
        written += opened.length;
        options.onProgress?.({
          phase: 'downloading',
          bytes: written,
          total: header.plaintextLength,
        });
      }

      if (written !== header.plaintextLength) {
        throw new Error(`recovered ${written} bytes, header declares ${header.plaintextLength}`);
      }

      await writer.close();
      return { metadata: decryptor.metadata, burned };
    } catch (error) {
      await reader.cancel(error);
      await writer.abort(error).catch(() => undefined);
      throw error;
    }
  }

  async read(
    id: string,
    key: string,
    password?: string,
    options: { onProgress?: (event: ProgressEvent) => void; signal?: AbortSignal } = {},
  ): Promise<{ content: Uint8Array; metadata: StreamMetadata; burned: boolean }> {
    const { rawKey, h } = await this.credentials(key, password);

    const res = await this.fetchContainer(id, h, options.signal);
    const container = new Uint8Array(await res.arrayBuffer());
    const burned = res.headers.get('x-crypt-burned') === 'true';

    const decryptor = await openStream(container, rawKey, password);
    const { header } = decryptor;
    const content = new Uint8Array(header.plaintextLength);
    let written = 0;

    for (let frame = 1; frame <= header.frameCount; frame++) {
      const start = header.headerLength + (frame - 1) * (header.frameSize + TAG_LENGTH);
      const isFinal = frame === header.frameCount;
      const end = isFinal ? container.length : start + header.frameSize + TAG_LENGTH;
      const opened = await decryptor.decryptFrame(frame, container.subarray(start, end));
      content.set(opened, written);
      written += opened.length;
      options.onProgress?.({
        phase: 'decrypting',
        bytes: written,
        total: header.plaintextLength,
      });
    }

    if (written !== header.plaintextLength) {
      throw new Error(`recovered ${written} bytes, header declares ${header.plaintextLength}`);
    }

    return { content, metadata: decryptor.metadata, burned };
  }
}

/**
 * Turns a failed part upload into the error a caller can act on. The retry
 * wrapper reports every attempt; the last one is what decided the outcome.
 */
const partError = (error: unknown, signal: AbortSignal | undefined): unknown => {
  if (signal?.aborted) {
    return signal.reason ?? error;
  }
  const last = error instanceof FetchRetryError ? error.errors[error.errors.length - 1] : error;
  if (last instanceof HTTPError) {
    return last.status === 413
      ? new ErrorPayloadTooLarge()
      : new ErrorUnexpectedStatus(last.status);
  }
  return last;
};

const concat = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

export { frameCountFor, parseStreamHeader };
