//! Adaptive binary range coder with bit-tree byte models.
//!
//! A direct port of the TypeScript implementation, kept deliberately faithful:
//! the two must produce byte-identical output or a file written by one will not
//! decode in the other. All arithmetic is explicitly wrapping `u32`, matching the
//! JavaScript original's `>>> 0` truncation.
//!
//! The coder is the carry-less Subbotin variant, chosen over the LZMA-style one
//! because it avoids carry propagation — the usual source of subtle corruption.
//! Bytes are coded as eight binary decisions through a 256-entry probability
//! tree, each entry an 11-bit probability adapted after every use.

const TOP: u32 = 1 << 24;
const BOT: u32 = 1 << 16;
const PROB_TOTAL: u32 = 1 << 11;
const PROB_INIT: u16 = (PROB_TOTAL >> 1) as u16;
const ADAPT_SHIFT: u16 = 5;

/// One adaptive bit-tree, able to code bytes.
#[derive(Clone)]
pub struct ByteModel {
    probs: [u16; 256],
}

impl Default for ByteModel {
    fn default() -> Self {
        Self { probs: [PROB_INIT; 256] }
    }
}

impl ByteModel {
    pub fn new() -> Self {
        Self::default()
    }
}

pub struct RangeEncoder {
    low: u32,
    range: u32,
    out: Vec<u8>,
}

impl Default for RangeEncoder {
    fn default() -> Self {
        Self::new()
    }
}

impl RangeEncoder {
    pub fn new() -> Self {
        Self { low: 0, range: u32::MAX, out: Vec::new() }
    }

    fn encode_freq(&mut self, cum_freq: u32, freq: u32, tot_freq: u32) {
        let r = self.range / tot_freq;
        self.low = self.low.wrapping_add(r.wrapping_mul(cum_freq));
        self.range = r.wrapping_mul(freq);
        self.normalize();
    }

    fn normalize(&mut self) {
        loop {
            if (self.low ^ self.low.wrapping_add(self.range)) < TOP {
                // Top byte is settled; emit it.
            } else if self.range < BOT {
                // Range too small to split reliably — clamp so it stays codeable.
                self.range = self.low.wrapping_neg() & (BOT - 1);
            } else {
                break;
            }
            self.out.push((self.low >> 24) as u8);
            self.low <<= 8;
            self.range <<= 8;
        }
    }

    fn encode_bit(&mut self, model: &mut ByteModel, index: usize, bit: u32) {
        let p = model.probs[index] as u32;
        if bit == 0 {
            self.encode_freq(0, p, PROB_TOTAL);
            model.probs[index] = (p + ((PROB_TOTAL - p) >> ADAPT_SHIFT)) as u16;
        } else {
            self.encode_freq(p, PROB_TOTAL - p, PROB_TOTAL);
            model.probs[index] = (p - (p >> ADAPT_SHIFT)) as u16;
        }
    }

    /// Codes one byte through a bit-tree, most significant bit first.
    pub fn encode_byte(&mut self, model: &mut ByteModel, value: u8) {
        let mut ctx: usize = 1;
        for i in (0..8).rev() {
            let bit = ((value >> i) & 1) as u32;
            self.encode_bit(model, ctx, bit);
            ctx = ((ctx << 1) | bit as usize) & 0xff;
            if ctx == 0 {
                ctx = 1;
            }
        }
    }

    pub fn finish(mut self) -> Vec<u8> {
        // Flush enough bytes for the decoder to resolve the final interval.
        for _ in 0..4 {
            self.out.push((self.low >> 24) as u8);
            self.low <<= 8;
        }
        self.out
    }
}

pub struct RangeDecoder<'a> {
    low: u32,
    range: u32,
    code: u32,
    data: &'a [u8],
    pos: usize,
}

impl<'a> RangeDecoder<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        let mut d = Self { low: 0, range: u32::MAX, code: 0, data, pos: 0 };
        for _ in 0..4 {
            let b = d.next() as u32;
            d.code = (d.code << 8) | b;
        }
        d
    }

    fn next(&mut self) -> u8 {
        if self.pos < self.data.len() {
            let b = self.data[self.pos];
            self.pos += 1;
            b
        } else {
            0
        }
    }

    fn normalize(&mut self) {
        loop {
            if (self.low ^ self.low.wrapping_add(self.range)) < TOP {
                // settled
            } else if self.range < BOT {
                self.range = self.low.wrapping_neg() & (BOT - 1);
            } else {
                break;
            }
            let b = self.next() as u32;
            self.code = (self.code << 8) | b;
            self.low <<= 8;
            self.range <<= 8;
        }
    }

    fn decode_bit(&mut self, model: &mut ByteModel, index: usize) -> u32 {
        let p = model.probs[index] as u32;
        let r = self.range / PROB_TOTAL;
        let value = core::cmp::min(PROB_TOTAL - 1, self.code.wrapping_sub(self.low) / r);

        let bit;
        if value < p {
            self.range = r.wrapping_mul(p);
            model.probs[index] = (p + ((PROB_TOTAL - p) >> ADAPT_SHIFT)) as u16;
            bit = 0;
        } else {
            self.low = self.low.wrapping_add(r.wrapping_mul(p));
            self.range = r.wrapping_mul(PROB_TOTAL - p);
            model.probs[index] = (p - (p >> ADAPT_SHIFT)) as u16;
            bit = 1;
        }
        self.normalize();
        bit
    }

    pub fn decode_byte(&mut self, model: &mut ByteModel) -> u8 {
        let mut ctx: usize = 1;
        let mut value: u32 = 0;
        for _ in 0..8 {
            let bit = self.decode_bit(model, ctx);
            value = (value << 1) | bit;
            ctx = ((ctx << 1) | bit as usize) & 0xff;
            if ctx == 0 {
                ctx = 1;
            }
        }
        value as u8
    }
}

/// Contexts selected by the previous value in the same plane. Models are carried
/// across frames; see the note in `lib.rs` on why that is what makes contexts pay.
const CTX: usize = 5;

fn bucket(v: u8) -> usize {
    match v {
        0 => 0,
        1..=2 => 1,
        3..=6 => 2,
        7..=16 => 3,
        _ => 4,
    }
}

#[derive(Clone)]
pub struct PlaneModel {
    models: [ByteModel; CTX],
    prev: u8,
}

impl Default for PlaneModel {
    fn default() -> Self {
        Self {
            models: [
                ByteModel::new(),
                ByteModel::new(),
                ByteModel::new(),
                ByteModel::new(),
                ByteModel::new(),
            ],
            prev: 0,
        }
    }
}

impl PlaneModel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn encode(&mut self, enc: &mut RangeEncoder, value: u8) {
        let b = bucket(self.prev);
        enc.encode_byte(&mut self.models[b], value);
        self.prev = value;
    }

    pub fn decode(&mut self, dec: &mut RangeDecoder) -> u8 {
        let b = bucket(self.prev);
        let v = dec.decode_byte(&mut self.models[b]);
        self.prev = v;
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(data: &[u8]) -> Vec<u8> {
        let mut enc = RangeEncoder::new();
        let mut m = ByteModel::new();
        for &b in data {
            enc.encode_byte(&mut m, b);
        }
        let coded = enc.finish();

        let mut dec = RangeDecoder::new(&coded);
        let mut m2 = ByteModel::new();
        (0..data.len()).map(|_| dec.decode_byte(&mut m2)).collect()
    }

    #[test]
    fn empty_input() {
        assert_eq!(round_trip(&[]), Vec::<u8>::new());
    }

    #[test]
    fn every_byte_value() {
        let data: Vec<u8> = (0..=255).collect();
        assert_eq!(round_trip(&data), data);
    }

    #[test]
    fn long_runs() {
        let zeros = vec![0u8; 50_000];
        assert_eq!(round_trip(&zeros), zeros);
        let ones = vec![255u8; 50_000];
        assert_eq!(round_trip(&ones), ones);
    }

    /// xorshift32 — a plain LCG loses precision in the JS original and
    /// degenerates, so the same generator is used on both sides.
    fn xorshift(seed: &mut u32) -> u32 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 17;
        *seed ^= *seed << 5;
        *seed
    }

    #[test]
    fn uniform_random() {
        let mut s = 987_654_321u32;
        let data: Vec<u8> = (0..100_000).map(|_| (xorshift(&mut s) & 0xff) as u8).collect();
        assert_eq!(round_trip(&data), data);
    }

    #[test]
    fn residual_shaped_data() {
        let mut s = 424_242u32;
        let data: Vec<u8> = (0..200_000)
            .map(|_| {
                let r = xorshift(&mut s) % 100;
                if r < 80 {
                    0
                } else if r < 95 {
                    1 + (xorshift(&mut s) % 2) as u8
                } else {
                    (xorshift(&mut s) & 0xff) as u8
                }
            })
            .collect();

        let mut enc = RangeEncoder::new();
        let mut m = ByteModel::new();
        for &b in &data {
            enc.encode_byte(&mut m, b);
        }
        let coded = enc.finish();
        assert_eq!(round_trip(&data), data);
        // Overwhelmingly-zero data must compress substantially.
        assert!(coded.len() < data.len() / 2, "coded {} of {}", coded.len(), data.len());
    }

    #[test]
    fn plane_models_round_trip() {
        let mut s = 13u32;
        let data: Vec<u8> = (0..30_000)
            .map(|_| if xorshift(&mut s) % 10 < 8 { 0 } else { (xorshift(&mut s) & 0xff) as u8 })
            .collect();

        let mut enc = RangeEncoder::new();
        let mut pm = PlaneModel::new();
        for &b in &data {
            pm.encode(&mut enc, b);
        }
        let coded = enc.finish();

        let mut dec = RangeDecoder::new(&coded);
        let mut pm2 = PlaneModel::new();
        let out: Vec<u8> = (0..data.len()).map(|_| pm2.decode(&mut dec)).collect();
        assert_eq!(out, data);
    }
}
