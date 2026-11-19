import { INLINE_MEDIA_TYPE, STREAM_MEDIA_TYPE, type AcceptedPayloads } from '@crypt.fyi/core';

type MediaRange = { type: string; subtype: string; q: number };

const parseAccept = (header: string): MediaRange[] =>
  header
    .split(',')
    .map((part) => {
      const [range, ...params] = part.split(';').map((piece) => piece.trim().toLowerCase());
      const [type, subtype] = (range ?? '').split('/');
      if (!type || !subtype) {
        return undefined;
      }
      let q = 1;
      for (const param of params) {
        const [name, value] = param.split('=').map((piece) => piece.trim());
        if (name === 'q') {
          const parsed = Number(value);
          q = Number.isFinite(parsed) ? parsed : 1;
        }
      }
      return { type, subtype, q };
    })
    .filter((range): range is MediaRange => range !== undefined);

/** Quality the reader assigns a media type, using the most specific matching range. */
const qualityOf = (ranges: MediaRange[], mediaType: string, allowWildcards: boolean): number => {
  const [type, subtype] = mediaType.split('/');
  const exact = ranges.find((range) => range.type === type && range.subtype === subtype);
  if (exact) return exact.q;
  if (!allowWildcards) return 0;
  const typeWide = ranges.find((range) => range.type === type && range.subtype === '*');
  if (typeWide) return typeWide.q;
  const any = ranges.find((range) => range.type === '*' && range.subtype === '*');
  return any ? any.q : 0;
};

/**
 * Which payload kinds a reader of `GET /vault/{id}` can decode, from its Accept
 * header.
 *
 * Streamed entries are only for readers that name `application/octet-stream`
 * explicitly. Wildcards deliberately do not count: every client released before
 * streaming existed — the CLI, the extension, older web bundles, curl — sends
 * `*\/*` or nothing, and handing any of them a container would burn a secret
 * they cannot open. Inline entries keep their old contract: no header, a
 * wildcard, or `application/json` all accept them.
 */
export const acceptedPayloads = (header: string | undefined): AcceptedPayloads => {
  if (!header || header.trim() === '') {
    return { inline: true, stream: false };
  }
  const ranges = parseAccept(header);
  return {
    inline: qualityOf(ranges, INLINE_MEDIA_TYPE, true) > 0,
    stream: qualityOf(ranges, STREAM_MEDIA_TYPE, false) > 0,
  };
};
