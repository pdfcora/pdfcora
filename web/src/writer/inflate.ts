/**
 * Flate decompression.
 *
 * Needed because a cross-reference stream and the object streams it points into are both
 * compressed, and one corpus document keeps its Catalog inside one.
 *
 * Uses `DecompressionStream`, which is a web standard present in browsers and in Node.
 * An earlier version imported `node:zlib`; every Node test passed and the browser bundle
 * was dead on arrival, because that module does not exist there. Streams are async, which
 * is why everything that decompresses is async too.
 */

export class InflateError extends Error {
  constructor(message: string) {
    super(`inflate: ${message}`);
    this.name = 'InflateError';
  }
}

export async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length === 0) throw new InflateError('empty stream');

  // Try the zlib wrapper first, then raw: some producers omit the two-byte header.
  try {
    return await decompress(bytes, 'deflate');
  } catch {
    try {
      return await decompress(bytes, 'deflate-raw');
    } catch (error) {
      throw new InflateError(error instanceof Error ? error.message : String(error));
    }
  }
}

async function decompress(bytes: Uint8Array, format: CompressionFormat): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Undoes a PNG predictor.
 *
 * Cross-reference streams are routinely written with `/Predictor 12`, which makes each
 * row a delta against the one above. Inflating without undoing it yields plausible-
 * looking bytes and completely wrong offsets — the kind of failure that shows up as
 * "object not found" rather than as a decode error.
 *
 * Predictors below 10 are TIFF prediction, which no PDF this SDK has seen uses; it is
 * refused rather than silently ignored.
 */
export function undoPredictor(
  data: Uint8Array,
  predictor: number,
  columns: number,
  colors = 1,
  bitsPerComponent = 8,
): Uint8Array {
  if (predictor <= 1) return data;
  if (predictor < 10) throw new InflateError(`TIFF predictor ${predictor} is not supported`);

  const pixel = Math.max(1, Math.ceil((colors * bitsPerComponent) / 8));
  const rowLength = Math.ceil((columns * colors * bitsPerComponent) / 8);
  const stride = rowLength + 1;                 // each row carries a leading filter byte
  const rows = Math.floor(data.length / stride);

  const out = new Uint8Array(rows * rowLength);
  let previous = new Uint8Array(rowLength);

  for (let row = 0; row < rows; row++) {
    const type = data[row * stride]!;
    const source = data.subarray(row * stride + 1, row * stride + 1 + rowLength);
    const current = new Uint8Array(rowLength);

    for (let i = 0; i < rowLength; i++) {
      const raw = source[i] ?? 0;
      const left = i >= pixel ? current[i - pixel]! : 0;
      const up = previous[i]!;
      const upLeft = i >= pixel ? previous[i - pixel]! : 0;

      let value: number;
      switch (type) {
        case 0: value = raw; break;                                  // None
        case 1: value = raw + left; break;                           // Sub
        case 2: value = raw + up; break;                             // Up
        case 3: value = raw + ((left + up) >> 1); break;             // Average
        case 4: value = raw + paeth(left, up, upLeft); break;        // Paeth
        default: throw new InflateError(`unknown PNG filter type ${type}`);
      }
      current[i] = value & 0xff;
    }

    out.set(current, row * rowLength);
    previous = current;
  }
  return out;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const dl = Math.abs(estimate - left);
  const du = Math.abs(estimate - up);
  const dul = Math.abs(estimate - upLeft);
  if (dl <= du && dl <= dul) return left;
  return du <= dul ? up : upLeft;
}
