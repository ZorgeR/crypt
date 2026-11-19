import { planParts, StreamClient, type StreamUploadInput } from './streamClient';
import { TAG_LENGTH, encryptStream } from './encryption/stream';
import { ErrorInlinePayload, ErrorPayloadTooLarge, ErrorUnexpectedStatus } from './client';

const MIN = 5 * 1024 * 1024;
const FRAME = 4 * 1024 * 1024;

describe('part planning', () => {
  it('sends a single part when the payload fits in one', () => {
    const parts = planParts({
      headerLength: 1706,
      frameCount: 1,
      frameSize: FRAME,
      lastFrameSize: 1024,
    });

    // The only part is also the final one, so the storage minimum does not apply.
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ firstFrame: 1, lastFrame: 1 });
    expect(parts[0].bytes).toBe(1706 + 1024 + TAG_LENGTH);
  });

  it('groups frames until each part clears the storage minimum', () => {
    const parts = planParts({
      headerLength: 1706,
      frameCount: 4,
      frameSize: FRAME,
      lastFrameSize: 2 * 1024 * 1024,
    });

    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ firstFrame: 1, lastFrame: 2 });
    expect(parts[1]).toMatchObject({ firstFrame: 3, lastFrame: 4 });
    // Every part but the last must be at or above the minimum.
    expect(parts[0].bytes).toBeGreaterThanOrEqual(MIN);
  });

  it('folds an undersized tail into the previous part', () => {
    // Frames 1-2 clear the minimum; frame 3 alone would not, and a non-final
    // part below the minimum is rejected by storage.
    const parts = planParts({
      headerLength: 1706,
      frameCount: 3,
      frameSize: FRAME,
      lastFrameSize: 1024,
    });

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ firstFrame: 1, lastFrame: 3 });
  });

  it('covers every frame exactly once, in order', () => {
    const parts = planParts({
      headerLength: 2048,
      frameCount: 9,
      frameSize: FRAME,
      lastFrameSize: FRAME,
    });

    const covered = parts.flatMap((part) =>
      Array.from({ length: part.lastFrame - part.firstFrame + 1 }, (_, i) => part.firstFrame + i),
    );
    expect(covered).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('accounts for the header in the first part only', () => {
    const headerLength = 4096;
    const parts = planParts({
      headerLength,
      frameCount: 4,
      frameSize: FRAME,
      lastFrameSize: 2 * 1024 * 1024,
    });

    const total = parts.reduce((sum, part) => sum + part.bytes, 0);
    const expected = headerLength + 3 * (FRAME + TAG_LENGTH) + (2 * 1024 * 1024 + TAG_LENGTH);
    expect(total).toBe(expected);
  });

  it('honours a caller-supplied minimum', () => {
    const parts = planParts({
      headerLength: 0,
      frameCount: 4,
      frameSize: 256,
      lastFrameSize: 256,
      minPartSize: 512,
    });

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts.slice(0, -1)) {
      expect(part.bytes).toBeGreaterThanOrEqual(512);
    }
  });
});

type Call = { url: string; method: string; headers: Record<string, string>; body?: Uint8Array };

/** Records every request and answers from `handler`, which may throw to simulate a network failure. */
const fakeFetch = (handler: (call: Call) => Response) => {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      body: init?.body instanceof Uint8Array ? init.body : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { impl, calls };
};

const API = 'http://vault.test';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const opened = () =>
  json(201, { id: 'v1', dt: 'dt', ut: 'ut', minPartSize: 5 * 1024 * 1024, maxParts: 10_000 });

const upload = (): StreamUploadInput => ({
  content: new Uint8Array(1000).fill(3),
  metadata: { name: 'a.bin', type: 'application/octet-stream' },
  b: true,
  ttl: 60_000,
  m: { encryption: { algorithm: 'ml-kem-768-stream' } },
  frameSizeLog2: 8,
});

/** Opens and completes normally; parts are answered by `part`. */
const uploadServer = (part: (attempt: number) => Response) => {
  let attempt = 0;
  return fakeFetch((call) => {
    if (call.url.endsWith('/vault/stream')) return opened();
    if (call.url.includes('/parts/')) return part(++attempt);
    if (call.url.endsWith('/complete')) return json(201, { id: 'v1', dt: 'dt' });
    throw new Error(`unexpected request ${call.method} ${call.url}`);
  });
};

describe('StreamClient uploads', () => {
  const origFetch = globalThis.fetch;
  const client = () => new StreamClient({ apiUrl: API, partAttempts: 3, retryDelayMs: 1 });
  const puts = (calls: Call[]) => calls.filter((call) => call.method === 'PUT');

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('retries a part after a server error, re-sending identical bytes', async () => {
    const server = uploadServer((attempt) =>
      attempt === 1 ? new Response(null, { status: 503 }) : new Response(null, { status: 204 }),
    );
    globalThis.fetch = server.impl;

    await client().create(upload());

    const sent = puts(server.calls);
    expect(sent).toHaveLength(2);
    expect(Buffer.from(sent[0].body!).equals(Buffer.from(sent[1].body!))).toBe(true);
  });

  it('retries a part after a network failure', async () => {
    const server = uploadServer((attempt) => {
      if (attempt === 1) throw new TypeError('fetch failed');
      return new Response(null, { status: 204 });
    });
    globalThis.fetch = server.impl;

    await client().create(upload());
    expect(puts(server.calls)).toHaveLength(2);
  });

  it('gives up after the configured attempts and reports the last status', async () => {
    const server = uploadServer(() => new Response(null, { status: 503 }));
    globalThis.fetch = server.impl;

    await expect(client().create(upload())).rejects.toMatchObject({ status: 503 });
    expect(puts(server.calls)).toHaveLength(3);
    expect(server.calls.some((call) => call.url.endsWith('/complete'))).toBe(false);
  });

  it('does not retry a part the server rejected outright', async () => {
    const server = uploadServer(() => new Response(null, { status: 404 }));
    globalThis.fetch = server.impl;

    const failure = client().create(upload());
    await expect(failure).rejects.toBeInstanceOf(ErrorUnexpectedStatus);
    await expect(failure).rejects.toMatchObject({ status: 404 });
    expect(puts(server.calls)).toHaveLength(1);
  });

  it('reports an oversized part as too large, without retrying', async () => {
    const server = uploadServer(() => new Response(null, { status: 413 }));
    globalThis.fetch = server.impl;

    await expect(client().create(upload())).rejects.toBeInstanceOf(ErrorPayloadTooLarge);
    expect(puts(server.calls)).toHaveLength(1);
  });

  it('reports an oversized declaration as too large', async () => {
    const server = fakeFetch(() => json(413, { msg: 'too large' }));
    globalThis.fetch = server.impl;

    await expect(client().create(upload())).rejects.toBeInstanceOf(ErrorPayloadTooLarge);
    expect(puts(server.calls)).toHaveLength(0);
  });
});

describe('StreamClient downloads', () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  const watchedSink = () => {
    const state = { written: 0, aborted: false };
    const sink = new WritableStream<Uint8Array>({
      write(chunk) {
        state.written += chunk.length;
      },
      abort() {
        state.aborted = true;
      },
    });
    return { sink, state };
  };

  it('asks for the container only, and reports an inline entry the server refused', async () => {
    const server = fakeFetch(() => json(406, { stored: 'inline' }));
    globalThis.fetch = server.impl;
    const { sink, state } = watchedSink();

    await expect(
      new StreamClient({ apiUrl: API }).readToSink('v1', 'key', undefined, { sink }),
    ).rejects.toBeInstanceOf(ErrorInlinePayload);
    // Naming only octet-stream is what makes the server refuse instead of burning.
    expect(server.calls[0].headers.Accept).toBe('application/octet-stream');
    expect(state.written).toBe(0);
  });

  it('refuses a header whose wrapped key length would force a huge buffer', async () => {
    const container = await encryptStream(new Uint8Array(10), {
      key: 'k'.repeat(32),
      metadata: { name: 'x', type: '', size: 10 },
      frameSizeLog2: 8,
    });
    new DataView(container.buffer).setUint32(12, 0xffffffff, false);
    globalThis.fetch = fakeFetch(
      () =>
        new Response(container, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
    ).impl;
    const { sink, state } = watchedSink();

    await expect(
      new StreamClient({ apiUrl: API }).readToSink('v1', 'k'.repeat(32), undefined, { sink }),
    ).rejects.toThrow(/wrapped key length/);
    expect(state.written).toBe(0);
    expect(state.aborted).toBe(true);
  });
});
