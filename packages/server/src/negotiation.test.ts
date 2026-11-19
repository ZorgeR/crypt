import { describe, it, expect } from 'vitest';
import { acceptedPayloads } from './negotiation.js';

describe('acceptedPayloads', () => {
  it('treats a missing or empty header as a legacy, inline-only reader', () => {
    expect(acceptedPayloads(undefined)).toEqual({ inline: true, stream: false });
    expect(acceptedPayloads('')).toEqual({ inline: true, stream: false });
    expect(acceptedPayloads('   ')).toEqual({ inline: true, stream: false });
  });

  it('does not let wildcards reach streamed entries', () => {
    // What fetch, undici, curl, and every pre-streaming client send. Handing
    // them a container would burn a secret they cannot decode.
    expect(acceptedPayloads('*/*')).toEqual({ inline: true, stream: false });
    expect(acceptedPayloads('application/*')).toEqual({ inline: true, stream: false });
  });

  it('accepts streamed entries only when octet-stream is named', () => {
    expect(acceptedPayloads('application/octet-stream')).toEqual({ inline: false, stream: true });
    expect(acceptedPayloads('application/json')).toEqual({ inline: true, stream: false });
    expect(acceptedPayloads('application/octet-stream, application/json')).toEqual({
      inline: true,
      stream: true,
    });
  });

  it('honours q=0 as a refusal', () => {
    expect(acceptedPayloads('application/octet-stream;q=0, */*')).toEqual({
      inline: true,
      stream: false,
    });
    // The most specific range wins: json is refused even though */* allows it.
    expect(acceptedPayloads('application/json;q=0, */*')).toEqual({
      inline: false,
      stream: false,
    });
  });

  it('is case-insensitive and tolerates parameters and whitespace', () => {
    expect(acceptedPayloads(' Application/Octet-Stream ; q=0.9 ')).toEqual({
      inline: false,
      stream: true,
    });
    expect(acceptedPayloads('application/json; charset=utf-8')).toEqual({
      inline: true,
      stream: false,
    });
  });

  it('ignores malformed ranges', () => {
    expect(acceptedPayloads('nonsense, application/octet-stream')).toEqual({
      inline: false,
      stream: true,
    });
    expect(acceptedPayloads('nonsense')).toEqual({ inline: false, stream: false });
  });
});
