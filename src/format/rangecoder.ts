/**
 * Adaptive binary range coder with bit-tree byte models.
 *
 * deflate cannot spend less than one bit on a symbol, so a plane where almost
 * every value is zero still costs about a bit per value. An arithmetic coder
 * spends FRACTIONAL bits: a symbol the model expects with probability 0.99 costs
 * roughly 0.014 bits. Our residual planes are overwhelmingly zeros, which is
 * exactly the distribution deflate handles worst and this handles best.
 *
 * The range coder is the carry-less Subbotin variant — it avoids the carry
 * propagation of the LZMA-style coder, which is the usual source of subtle
 * corruption bugs. Bytes are coded as eight binary decisions through a 256-entry
 * probability tree (the LZMA bit-tree arrangement), each entry an 11-bit
 * probability adapted after every use. Separate trees per plane keep unrelated
 * statistics from polluting each other.
 */

const TOP = 1 << 24;
const BOT = 1 << 16;
const PROB_TOTAL = 1 << 11; // 2048
const PROB_INIT = PROB_TOTAL >> 1;
const ADAPT_SHIFT = 5;

/** One adaptive bit-tree, able to code bytes. */
export class ByteModel {
  readonly probs = new Uint16Array(256).fill(PROB_INIT);
  reset() {
    this.probs.fill(PROB_INIT);
  }
}

export class RangeEncoder {
  private low = 0;
  private range = 0xffffffff;
  private out: number[] = [];

  private encodeFreq(cumFreq: number, freq: number, totFreq: number) {
    const r = Math.floor(this.range / totFreq);
    this.low = (this.low + r * cumFreq) >>> 0;
    this.range = (r * freq) >>> 0;
    this.normalize();
  }

  private normalize() {
    for (;;) {
      if (((this.low ^ (this.low + this.range)) >>> 0) < TOP) {
        // Top byte is settled; emit it.
      } else if (this.range < BOT) {
        // Range too small to split reliably — clamp so it stays codeable.
        this.range = (-this.low & (BOT - 1)) >>> 0;
      } else {
        break;
      }
      this.out.push((this.low >>> 24) & 0xff);
      this.low = (this.low << 8) >>> 0;
      this.range = (this.range << 8) >>> 0;
    }
  }

  encodeBit(model: Uint16Array, index: number, bit: number) {
    const p = model[index];
    if (bit === 0) {
      this.encodeFreq(0, p, PROB_TOTAL);
      model[index] = p + ((PROB_TOTAL - p) >> ADAPT_SHIFT);
    } else {
      this.encodeFreq(p, PROB_TOTAL - p, PROB_TOTAL);
      model[index] = p - (p >> ADAPT_SHIFT);
    }
  }

  /** Codes one byte through a bit-tree, most significant bit first. */
  encodeByte(model: ByteModel, value: number) {
    let ctx = 1;
    for (let i = 7; i >= 0; i--) {
      const bit = (value >> i) & 1;
      this.encodeBit(model.probs, ctx, bit);
      ctx = ((ctx << 1) | bit) & 0xff;
      if (ctx === 0) ctx = 1;
    }
  }

  encodeBytes(model: ByteModel, data: Uint8Array, start = 0, end = data.length) {
    for (let i = start; i < end; i++) this.encodeByte(model, data[i]);
  }

  finish(): Uint8Array {
    // Flush enough bytes for the decoder to resolve the final interval.
    for (let i = 0; i < 4; i++) {
      this.out.push((this.low >>> 24) & 0xff);
      this.low = (this.low << 8) >>> 0;
    }
    return new Uint8Array(this.out);
  }
}

export class RangeDecoder {
  private low = 0;
  private range = 0xffffffff;
  private code = 0;
  private pos = 0;

  constructor(private data: Uint8Array) {
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.next()) >>> 0;
  }

  private next(): number {
    return this.pos < this.data.length ? this.data[this.pos++] : 0;
  }

  private normalize() {
    for (;;) {
      if (((this.low ^ (this.low + this.range)) >>> 0) < TOP) {
        // settled
      } else if (this.range < BOT) {
        this.range = (-this.low & (BOT - 1)) >>> 0;
      } else {
        break;
      }
      this.code = ((this.code << 8) | this.next()) >>> 0;
      this.low = (this.low << 8) >>> 0;
      this.range = (this.range << 8) >>> 0;
    }
  }

  decodeBit(model: Uint16Array, index: number): number {
    const p = model[index];
    const r = Math.floor(this.range / PROB_TOTAL);
    const value = Math.min(PROB_TOTAL - 1, Math.floor(((this.code - this.low) >>> 0) / r));

    let bit: number;
    if (value < p) {
      this.range = (r * p) >>> 0;
      model[index] = p + ((PROB_TOTAL - p) >> ADAPT_SHIFT);
      bit = 0;
    } else {
      this.low = (this.low + r * p) >>> 0;
      this.range = (r * (PROB_TOTAL - p)) >>> 0;
      model[index] = p - (p >> ADAPT_SHIFT);
      bit = 1;
    }
    this.normalize();
    return bit;
  }

  decodeByte(model: ByteModel): number {
    let ctx = 1;
    let value = 0;
    for (let i = 7; i >= 0; i--) {
      const bit = this.decodeBit(model.probs, ctx);
      value = (value << 1) | bit;
      ctx = ((ctx << 1) | bit) & 0xff;
      if (ctx === 0) ctx = 1;
    }
    return value & 0xff;
  }

  decodeBytes(model: ByteModel, out: Uint8Array, start = 0, end = out.length) {
    for (let i = start; i < end; i++) out[i] = this.decodeByte(model);
  }
}
