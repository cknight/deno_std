// Copyright 2018-2023 the Deno authors. All rights reserved. MIT license.
// This module is browser compatible.

import { concat } from "../bytes/concat.ts";
import { createLPS } from "./_common.ts";

/** Disposition of the delimiter. */
export type DelimiterDisposition =
  /** Include delimiter in the found chunk. */
  | "suffix"
  /** Include delimiter in the subsequent chunk. */
  | "prefix"
  /** Discard the delimiter. */
  | "discard" // delimiter discarded
;

export interface DelimiterStreamOptions {
  /** Disposition of the delimiter. */
  disposition?: DelimiterDisposition;
}

/**
 * Divide a stream into chunks delimited by a given byte sequence.
 *
 * @example
 * Divide a CSV stream by commas, discarding the commas:
 * ```ts
 * import { DelimiterStream } from "https://deno.land/std@$STD_VERSION/streams/delimiter_stream.ts";
 * const res = await fetch("https://example.com/data.csv");
 * const parts = res.body!
 *   .pipeThrough(new DelimiterStream(new TextEncoder().encode(",")))
 *   .pipeThrough(new TextDecoderStream());
 * ```
 *
 * @example
 * Divide a stream after semi-colons, keeping the semi-colons in the output:
 * ```ts
 * import { DelimiterStream } from "https://deno.land/std@$STD_VERSION/streams/delimiter_stream.ts";
 * const res = await fetch("https://example.com/file.js");
 * const parts = res.body!
 *   .pipeThrough(
 *     new DelimiterStream(
 *       new TextEncoder().encode(";"),
 *       { disposition: "suffix" },
 *     )
 *   )
 *   .pipeThrough(new TextDecoderStream());
 * ```
 *
 * @param delimiter Delimiter byte sequence
 * @param options Options for the transform stream
 * @returns Transform stream
 */
export class DelimiterStream extends TransformStream<Uint8Array, Uint8Array> {
  #bufs: Uint8Array[] = [];
  #delimiter: Uint8Array;
  #matchIndex = 0;
  #delimLPS: Uint8Array;
  #disp: DelimiterDisposition;

  constructor(
    delimiter: Uint8Array,
    options?: DelimiterStreamOptions,
  ) {
    super({
      transform: (chunk, controller) => {
        this.#handle(chunk, controller);
      },
      flush: (controller) => {
        controller.enqueue(concat(...this.#bufs));
      },
    });

    this.#delimiter = delimiter;
    this.#delimLPS = createLPS(delimiter);
    this.#disp = options?.disposition ?? "discard";
  }

  #handle(
    chunk: Uint8Array,
    controller: TransformStreamDefaultController<Uint8Array>,
  ) {
    const bufs = this.#bufs;
    const length = chunk.byteLength;
    const disposition = this.#disp;
    const delimiter = this.#delimiter;
    const delimLen = delimiter.length;
    const lps = this.#delimLPS;
    let chunkStart = 0;
    let matchIndex = this.#matchIndex;
    let inspectIndex = 0;
    while (inspectIndex < length) {
      if (chunk[inspectIndex] === delimiter[matchIndex]) {
        // Next byte matched our next delimiter byte
        inspectIndex++;
        matchIndex++;
        if (matchIndex === delimLen) {
          // Full match
          matchIndex = 0;
          const delimiterStartIndex = inspectIndex - delimLen;
          const delimitedChunkEnd = disposition === "suffix"
            ? inspectIndex
            : delimiterStartIndex;
          if (delimitedChunkEnd <= 0 && bufs.length === 0) {
            // Our chunk started with a delimiter and no previous chunks exist:
            // Enqueue an empty chunk.
            controller.enqueue(new Uint8Array());
          } else if (delimitedChunkEnd > 0 && bufs.length === 0) {
            // No previous chunks, slice from current chunk.
            controller.enqueue(chunk.subarray(chunkStart, delimitedChunkEnd));
            // Our chunk may have more than one delimiter; we must remember where
            // the next delimited chunk begins.
            chunkStart = disposition === "prefix"
              ? delimiterStartIndex
              : inspectIndex;
          } else if (delimitedChunkEnd === 0 && bufs.length > 0) {
            // Our chunk started with a delimiter, previous chunks are passed as
            // they are (with concatenation).
            if (bufs.length === 1) {
              // Concat not needed when a single buffer is passed.
              controller.enqueue(bufs[0]);
            } else {
              controller.enqueue(concat(...bufs));
            }
            // Drop all previous chunks.
            bufs.length = 0;
            if (disposition !== "prefix") {
              // suffix or discard: The next chunk starts where our inspection finished.
              // We should only ever end up here with a discard disposition as
              // for a suffix disposition this branch would mean that the previous
              // chunk ended with a full match but was not enqueued.
              chunkStart = inspectIndex;
            }
          } else if (delimitedChunkEnd < 0 && bufs.length > 0) {
            // Our chunk started by finishing a partial delimiter match.
            const lastIndex = bufs.length - 1;
            const last = bufs[lastIndex];
            const lastSliceIndex = last.byteLength + delimitedChunkEnd;
            const lastSliced = last.subarray(0, lastSliceIndex);
            if (lastIndex === 0) {
              controller.enqueue(lastSliced);
            } else {
              bufs[lastIndex] = lastSliced;
              controller.enqueue(concat(...bufs));
            }
            bufs.length = 0;
            if (disposition === "prefix") {
              // Must keep last bytes of last chunk.
              bufs.push(last.subarray(lastSliceIndex));
            } else {
              chunkStart = inspectIndex;
            }
          } else if (delimitedChunkEnd > 0 && bufs.length > 0) {
            // Previous chunks and current chunk together form a delimited chunk.
            const chunkSliced = chunk.subarray(chunkStart, delimitedChunkEnd);
            const result = concat(...bufs, chunkSliced);
            bufs.length = 0;
            chunkStart = disposition === "prefix"
              ? delimitedChunkEnd
              : inspectIndex;
            controller.enqueue(result);
          } else {
            throw new Error("unreachable");
          }
        }
      } else if (matchIndex === 0) {
        // No match ongoing, keep going through the buffer.
        inspectIndex++;
      } else {
        // Ongoing match: Degrade to the previous possible match.
        // eg. If we're looking for 'AAB' and had matched 'AA' previously
        // but now got a new 'A', then we'll drop down to having matched
        // just 'A'. The while loop will turn around again and we'll rematch
        // to 'AA' and proceed onwards to try and match on 'B' again.
        matchIndex = lps[matchIndex - 1];
      }
    }
    // Save match index.
    this.#matchIndex = matchIndex;
    if (chunkStart === 0) {
      bufs.push(chunk);
    } else if (chunkStart !== length - 1) {
      // If we matched partially somewhere in the middle of our chunk
      // then the remnants should be pushed into buffers.
      bufs.push(chunk.subarray(chunkStart));
    }
  }
}
