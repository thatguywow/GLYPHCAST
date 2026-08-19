//! Reader and writer for the GLYPHCAST `.glyph` container.
//!
//! This crate is the portable definition of the format. It has no dependencies
//! on purpose — no codec, no GPU stack — so it can be linked into a CLI, a
//! server, or a WASM build without dragging anything along. Layers that decode
//! video or rasterise glyphs belong above it.
//!
//! It is a faithful port of the TypeScript implementation and must stay
//! byte-compatible with it: a file written by either side has to decode on the
//! other.
//!
//! # Layout (little-endian)
//!
//! ```text
//! magic        8   "GLYPHCST"
//! version      u16 = 5
//! flags        u16 bit0 = per-cell colour present
//! cols         u16
//! rows         u16
//! fps          f32
//! frameCount   u32
//! charTableLen u32
//! audioLen     u32
//! charTable    UTF-8 JSON array of the glyph characters
//! audio        fragmented MP4, or absent when audioLen is 0
//! frames[]     each: tag u8 (0 = key, 1 = delta), rawLen u32, codedLen u32, payload
//! ```
//!
//! Planes are stored separately (all glyph indices, then foreground, then
//! background) because cells correlate far more strongly within a plane than
//! across one. Colour is stored as prediction residuals — from the cell to the
//! left within a key frame, from the same cell one frame earlier in a delta —
//! zigzag mapped so small differences of either sign become small bytes. Glyph
//! indices are stored raw: predicting them was measured and made files larger,
//! because a glyph is chosen by shape and neighbouring choices are not
//! numerically close.
//!
//! Entropy coding is an adaptive range coder whose models persist across the
//! whole file. That is what makes the contexts pay — per-frame models never
//! accumulate enough history to sharpen — and it is why frames must be decoded
//! in order. Playback needs sequential decoding regardless, since the frames form
//! a delta chain.

mod rangecoder;

pub use rangecoder::{ByteModel, PlaneModel, RangeDecoder, RangeEncoder};

const MAGIC: &[u8; 8] = b"GLYPHCST";
const VERSION: u16 = 5;
const FLAG_COLOR: u16 = 1;
const HEADER_BASE: usize = 32;

#[derive(Debug)]
pub enum GlyphError {
    NotGlyphFile,
    UnsupportedVersion(u16),
    Truncated,
    BadCharTable,
}

impl core::fmt::Display for GlyphError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            GlyphError::NotGlyphFile => write!(f, "not a .glyph file"),
            GlyphError::UnsupportedVersion(v) => write!(f, "unsupported .glyph version {v}"),
            GlyphError::Truncated => write!(f, "file is truncated"),
            GlyphError::BadCharTable => write!(f, "character table is not valid"),
        }
    }
}

impl std::error::Error for GlyphError {}

/// One frame's worth of cells.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GridFrame {
    /// One glyph index per cell, row-major.
    pub glyphs: Vec<u8>,
    /// RGB triplets per cell; empty in mono files.
    pub fg: Vec<u8>,
    pub bg: Vec<u8>,
}

impl GridFrame {
    pub fn new(cells: usize, color: bool) -> Self {
        Self {
            glyphs: vec![0; cells],
            fg: if color { vec![0; cells * 3] } else { Vec::new() },
            bg: if color { vec![0; cells * 3] } else { Vec::new() },
        }
    }
}

#[derive(Clone, Debug)]
pub struct GlyphMeta {
    pub cols: u16,
    pub rows: u16,
    pub fps: f32,
    pub color: bool,
    pub chars: Vec<String>,
}

impl GlyphMeta {
    pub fn cells(&self) -> usize {
        self.cols as usize * self.rows as usize
    }
}

/// Signed residual -> byte, so small differences of either sign are small bytes.
#[inline]
fn zig(cur: u8, pred: u8) -> u8 {
    let d = cur.wrapping_sub(pred) as i8;
    (((d as i32) << 1) ^ ((d as i32) >> 31)) as u8
}

#[inline]
fn unzig(z: u8, pred: u8) -> u8 {
    let signed = ((z >> 1) as i32) ^ -((z & 1) as i32);
    (pred as i32).wrapping_add(signed) as u8
}

struct Models {
    bitmap: PlaneModel,
    glyph: PlaneModel,
    fg: PlaneModel,
    bg: PlaneModel,
}

impl Models {
    fn new() -> Self {
        Self {
            bitmap: PlaneModel::new(),
            glyph: PlaneModel::new(),
            fg: PlaneModel::new(),
            bg: PlaneModel::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

pub struct GlyphWriter {
    meta: GlyphMeta,
    audio: Vec<u8>,
    out: Vec<u8>,
    frames: u32,
    prev: Option<GridFrame>,
    models: Models,
    header_written: bool,
}

impl GlyphWriter {
    pub fn new(meta: GlyphMeta, audio: Vec<u8>) -> Self {
        Self {
            meta,
            audio,
            out: Vec::new(),
            frames: 0,
            prev: None,
            models: Models::new(),
            header_written: false,
        }
    }

    fn write_header(&mut self) -> Result<(), GlyphError> {
        let table = serialise_chars(&self.meta.chars);
        let mut h = Vec::with_capacity(HEADER_BASE + table.len() + self.audio.len());
        h.extend_from_slice(MAGIC);
        h.extend_from_slice(&VERSION.to_le_bytes());
        h.extend_from_slice(&(if self.meta.color { FLAG_COLOR } else { 0 }).to_le_bytes());
        h.extend_from_slice(&self.meta.cols.to_le_bytes());
        h.extend_from_slice(&self.meta.rows.to_le_bytes());
        h.extend_from_slice(&self.meta.fps.to_le_bytes());
        h.extend_from_slice(&0u32.to_le_bytes()); // frame count, patched on finish
        h.extend_from_slice(&(table.len() as u32).to_le_bytes());
        h.extend_from_slice(&(self.audio.len() as u32).to_le_bytes());
        h.extend_from_slice(&table);
        h.extend_from_slice(&self.audio);
        self.out.extend_from_slice(&h);
        self.header_written = true;
        Ok(())
    }

    /// Appends a frame, keyed every `key_interval` frames so playback can resync.
    pub fn add_frame(&mut self, frame: &GridFrame, key_interval: u32) -> Result<(), GlyphError> {
        if !self.header_written {
            self.write_header()?;
        }

        let n = self.meta.cells();
        let per = 1 + if self.meta.color { 6 } else { 0 };
        let mut is_key = self.prev.is_none() || self.frames % key_interval == 0;
        let mut changed: Vec<u32> = Vec::new();

        if !is_key {
            changed = self.changed_cells(frame);
            // Compare encodings by pre-coding size rather than coding both: once
            // enough of the grid has moved, sending everything is smaller than a
            // bitmap plus that many cells, and it adds a resync point for free.
            let delta_raw = (n + 7) / 8 + changed.len() * per;
            if delta_raw >= n * per {
                is_key = true;
                changed.clear();
            }
        }

        let mut enc = RangeEncoder::new();
        if is_key {
            self.code_key(&mut enc, frame);
        } else {
            self.code_delta(&mut enc, frame, &changed);
        }
        let coded = enc.finish();

        self.out.push(if is_key { 0 } else { 1 });
        self.out.extend_from_slice(&(n as u32).to_le_bytes());
        self.out.extend_from_slice(&(coded.len() as u32).to_le_bytes());
        self.out.extend_from_slice(&coded);

        self.frames += 1;
        self.prev = Some(frame.clone());
        Ok(())
    }

    fn changed_cells(&self, cur: &GridFrame) -> Vec<u32> {
        let prev = self.prev.as_ref().unwrap();
        let n = self.meta.cells();
        let mut out = Vec::new();
        for i in 0..n {
            let mut diff = prev.glyphs[i] != cur.glyphs[i];
            if !diff && self.meta.color {
                let c = i * 3;
                diff = prev.fg[c] != cur.fg[c]
                    || prev.fg[c + 1] != cur.fg[c + 1]
                    || prev.fg[c + 2] != cur.fg[c + 2]
                    || prev.bg[c] != cur.bg[c]
                    || prev.bg[c + 1] != cur.bg[c + 1]
                    || prev.bg[c + 2] != cur.bg[c + 2];
            }
            if diff {
                out.push(i as u32);
            }
        }
        out
    }

    fn code_key(&mut self, enc: &mut RangeEncoder, f: &GridFrame) {
        let n = self.meta.cells();
        for i in 0..n {
            self.models.glyph.encode(enc, f.glyphs[i]);
        }
        if self.meta.color {
            for c in 0..3 {
                for i in 0..n {
                    let pred = if i > 0 { f.fg[(i - 1) * 3 + c] } else { 0 };
                    self.models.fg.encode(enc, zig(f.fg[i * 3 + c], pred));
                }
            }
            // Within a cell the background is usually a darker version of the
            // foreground, so predict it from the foreground.
            for c in 0..3 {
                for i in 0..n {
                    self.models.bg.encode(enc, zig(f.bg[i * 3 + c], f.fg[i * 3 + c]));
                }
            }
        }
    }

    fn code_delta(&mut self, enc: &mut RangeEncoder, cur: &GridFrame, changed: &[u32]) {
        let n = self.meta.cells();
        let map_bytes = (n + 7) / 8;
        let mut bitmap = vec![0u8; map_bytes];
        for &i in changed {
            bitmap[(i >> 3) as usize] |= 1 << (i & 7);
        }
        // The bitmap goes first so the decoder can recover the changed count.
        for b in 0..map_bytes {
            self.models.bitmap.encode(enc, bitmap[b]);
        }
        for &i in changed {
            self.models.glyph.encode(enc, cur.glyphs[i as usize]);
        }
        if self.meta.color {
            let prev = self.prev.as_ref().unwrap();
            for c in 0..3 {
                for &i in changed {
                    let p = i as usize * 3 + c;
                    self.models.fg.encode(enc, zig(cur.fg[p], prev.fg[p]));
                }
            }
            for c in 0..3 {
                for &i in changed {
                    let p = i as usize * 3 + c;
                    self.models.bg.encode(enc, zig(cur.bg[p], prev.bg[p]));
                }
            }
        }
    }

    /// Patches the real frame count into the header and returns the file.
    pub fn finish(mut self) -> Result<Vec<u8>, GlyphError> {
        if !self.header_written {
            self.write_header()?;
        }
        self.out[20..24].copy_from_slice(&self.frames.to_le_bytes());
        Ok(self.out)
    }

    pub fn frame_count(&self) -> u32 {
        self.frames
    }
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

pub struct GlyphReader {
    data: Vec<u8>,
    pub meta: GlyphMeta,
    pub frame_count: u32,
    audio_range: (usize, usize),
    offsets: Vec<usize>,
    models: Models,
    next_index: u32,
}

impl GlyphReader {
    pub fn open(data: Vec<u8>) -> Result<Self, GlyphError> {
        if data.len() < HEADER_BASE {
            return Err(GlyphError::Truncated);
        }
        if &data[0..8] != MAGIC {
            return Err(GlyphError::NotGlyphFile);
        }
        let version = u16::from_le_bytes([data[8], data[9]]);
        if version != VERSION {
            return Err(GlyphError::UnsupportedVersion(version));
        }
        let flags = u16::from_le_bytes([data[10], data[11]]);
        let cols = u16::from_le_bytes([data[12], data[13]]);
        let rows = u16::from_le_bytes([data[14], data[15]]);
        let fps = f32::from_le_bytes([data[16], data[17], data[18], data[19]]);
        let frame_count = u32::from_le_bytes([data[20], data[21], data[22], data[23]]);
        let table_len = u32::from_le_bytes([data[24], data[25], data[26], data[27]]) as usize;
        let audio_len = u32::from_le_bytes([data[28], data[29], data[30], data[31]]) as usize;

        let table_end = HEADER_BASE + table_len;
        let audio_end = table_end + audio_len;
        if data.len() < audio_end {
            return Err(GlyphError::Truncated);
        }
        let chars = parse_chars(&data[HEADER_BASE..table_end])?;

        let meta = GlyphMeta { cols, rows, fps, color: (flags & FLAG_COLOR) != 0, chars };

        // Index frame offsets up front so playback can seek without rescanning.
        let mut offsets = Vec::with_capacity(frame_count as usize);
        let mut o = audio_end;
        for _ in 0..frame_count {
            if o + 9 > data.len() {
                return Err(GlyphError::Truncated);
            }
            offsets.push(o);
            let coded = u32::from_le_bytes([data[o + 5], data[o + 6], data[o + 7], data[o + 8]]);
            o += 9 + coded as usize;
        }
        if o > data.len() {
            return Err(GlyphError::Truncated);
        }

        Ok(Self {
            data,
            meta,
            frame_count,
            audio_range: (table_end, audio_end),
            offsets,
            models: Models::new(),
            next_index: 0,
        })
    }

    /// The embedded soundtrack, empty when the file carries none.
    pub fn audio(&self) -> &[u8] {
        &self.data[self.audio_range.0..self.audio_range.1]
    }

    /// Decodes frame `i` into `state`.
    ///
    /// Models adapt across the whole file, so frames must be fed in order. Asking
    /// for anything else rebuilds model state by replaying from the beginning,
    /// which the delta chain would require regardless.
    pub fn decode_into(&mut self, i: u32, state: &mut GridFrame) -> Result<(), GlyphError> {
        if i != self.next_index {
            self.models = Models::new();
            for f in 0..=i {
                self.decode_frame(f, state)?;
            }
            self.next_index = i + 1;
            return Ok(());
        }
        self.decode_frame(i, state)?;
        self.next_index = i + 1;
        Ok(())
    }

    fn decode_frame(&mut self, i: u32, state: &mut GridFrame) -> Result<(), GlyphError> {
        let o = *self.offsets.get(i as usize).ok_or(GlyphError::Truncated)?;
        let tag = self.data[o];
        let coded_len =
            u32::from_le_bytes([self.data[o + 5], self.data[o + 6], self.data[o + 7], self.data[o + 8]])
                as usize;
        let payload = &self.data[o + 9..o + 9 + coded_len];
        let mut dec = RangeDecoder::new(payload);
        let n = self.meta.cells();
        let color = self.meta.color;

        if tag == 0 {
            for c in 0..n {
                state.glyphs[c] = self.models.glyph.decode(&mut dec);
            }
            if color {
                for c in 0..3 {
                    for p in 0..n {
                        let pred = if p > 0 { state.fg[(p - 1) * 3 + c] } else { 0 };
                        state.fg[p * 3 + c] = unzig(self.models.fg.decode(&mut dec), pred);
                    }
                }
                for c in 0..3 {
                    for p in 0..n {
                        let pred = state.fg[p * 3 + c];
                        state.bg[p * 3 + c] = unzig(self.models.bg.decode(&mut dec), pred);
                    }
                }
            }
        } else {
            let map_bytes = (n + 7) / 8;
            let mut bitmap = vec![0u8; map_bytes];
            for b in 0..map_bytes {
                bitmap[b] = self.models.bitmap.decode(&mut dec);
            }
            let mut idx: Vec<usize> = Vec::new();
            for c in 0..n {
                if bitmap[c >> 3] & (1 << (c & 7)) != 0 {
                    idx.push(c);
                }
            }
            for &c in &idx {
                state.glyphs[c] = self.models.glyph.decode(&mut dec);
            }
            if color {
                // state still holds the previous frame, which is the predictor.
                for c in 0..3 {
                    for &j in &idx {
                        let p = j * 3 + c;
                        state.fg[p] = unzig(self.models.fg.decode(&mut dec), state.fg[p]);
                    }
                }
                for c in 0..3 {
                    for &j in &idx {
                        let p = j * 3 + c;
                        state.bg[p] = unzig(self.models.bg.decode(&mut dec), state.bg[p]);
                    }
                }
            }
        }
        Ok(())
    }

    pub fn new_state(&self) -> GridFrame {
        GridFrame::new(self.meta.cells(), self.meta.color)
    }

    /// The given state rendered as plain text, one line per row.
    pub fn to_text(&self, state: &GridFrame) -> String {
        let cols = self.meta.cols as usize;
        let rows = self.meta.rows as usize;
        let mut s = String::new();
        for y in 0..rows {
            for x in 0..cols {
                let g = state.glyphs[y * cols + x] as usize;
                s.push_str(self.meta.chars.get(g).map(|c| c.as_str()).unwrap_or(" "));
            }
            if y + 1 < rows {
                s.push('\n');
            }
        }
        s
    }
}

// ---------------------------------------------------------------------------
// Character table: a JSON array of strings, matching the TypeScript writer.
// Hand-rolled rather than pulling in serde, to keep the crate dependency-free.
// ---------------------------------------------------------------------------

fn serialise_chars(chars: &[String]) -> Vec<u8> {
    let mut s = String::from("[");
    for (i, c) in chars.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push('"');
        for ch in c.chars() {
            match ch {
                '"' => s.push_str("\\\""),
                '\\' => s.push_str("\\\\"),
                '\n' => s.push_str("\\n"),
                '\r' => s.push_str("\\r"),
                '\t' => s.push_str("\\t"),
                c if (c as u32) < 0x20 => s.push_str(&format!("\\u{:04x}", c as u32)),
                c => s.push(c),
            }
        }
        s.push('"');
    }
    s.push(']');
    s.into_bytes()
}

fn parse_chars(bytes: &[u8]) -> Result<Vec<String>, GlyphError> {
    let s = core::str::from_utf8(bytes).map_err(|_| GlyphError::BadCharTable)?;
    let s = s.trim();
    if !s.starts_with('[') || !s.ends_with(']') {
        return Err(GlyphError::BadCharTable);
    }
    let mut out = Vec::new();
    let mut chars = s[1..s.len() - 1].chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            ' ' | ',' | '\n' | '\t' | '\r' => continue,
            '"' => {
                let mut item = String::new();
                loop {
                    let ch = chars.next().ok_or(GlyphError::BadCharTable)?;
                    match ch {
                        '"' => break,
                        '\\' => {
                            let esc = chars.next().ok_or(GlyphError::BadCharTable)?;
                            match esc {
                                'n' => item.push('\n'),
                                'r' => item.push('\r'),
                                't' => item.push('\t'),
                                'u' => {
                                    let mut hex = String::new();
                                    for _ in 0..4 {
                                        hex.push(chars.next().ok_or(GlyphError::BadCharTable)?);
                                    }
                                    let v = u32::from_str_radix(&hex, 16)
                                        .map_err(|_| GlyphError::BadCharTable)?;
                                    item.push(char::from_u32(v).ok_or(GlyphError::BadCharTable)?);
                                }
                                other => item.push(other),
                            }
                        }
                        other => item.push(other),
                    }
                }
                out.push(item);
            }
            _ => return Err(GlyphError::BadCharTable),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(color: bool) -> GlyphMeta {
        GlyphMeta {
            cols: 40,
            rows: 12,
            fps: 30.0,
            color,
            chars: [" ", ".", ":", "=", "#", "@", "█"].iter().map(|s| s.to_string()).collect(),
        }
    }

    fn xorshift(seed: &mut u32) -> u32 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 17;
        *seed ^= *seed << 5;
        *seed
    }

    fn make_frames(m: &GlyphMeta, count: usize) -> Vec<GridFrame> {
        let n = m.cells();
        let mut s = 12345u32;
        let mut f = GridFrame::new(n, m.color);
        for i in 0..n {
            f.glyphs[i] = (xorshift(&mut s) % 7) as u8;
            if m.color {
                for c in 0..3 {
                    f.fg[i * 3 + c] = (xorshift(&mut s) & 0xff) as u8;
                    f.bg[i * 3 + c] = (xorshift(&mut s) & 0xff) as u8;
                }
            }
        }
        let mut out = vec![f.clone()];
        for _ in 1..count {
            for i in 0..n {
                if xorshift(&mut s) % 100 < 15 {
                    f.glyphs[i] = (xorshift(&mut s) % 7) as u8;
                    if m.color {
                        f.fg[i * 3] = (xorshift(&mut s) & 0xff) as u8;
                        f.bg[i * 3 + 2] = (xorshift(&mut s) & 0xff) as u8;
                    }
                }
            }
            out.push(f.clone());
        }
        out
    }

    fn round_trip(color: bool, count: usize, key_interval: u32) {
        let m = meta(color);
        let frames = make_frames(&m, count);
        let mut w = GlyphWriter::new(m.clone(), Vec::new());
        for f in &frames {
            w.add_frame(f, key_interval).unwrap();
        }
        let bytes = w.finish().unwrap();

        let mut r = GlyphReader::open(bytes).unwrap();
        assert_eq!(r.frame_count as usize, frames.len());
        assert_eq!(r.meta.cols, m.cols);
        assert_eq!(r.meta.rows, m.rows);
        assert_eq!(r.meta.fps, m.fps);
        assert_eq!(r.meta.color, color);
        assert_eq!(r.meta.chars, m.chars);

        let mut state = r.new_state();
        for (i, expected) in frames.iter().enumerate() {
            r.decode_into(i as u32, &mut state).unwrap();
            assert_eq!(&state, expected, "frame {i} differs");
        }
    }

    #[test]
    fn colour_round_trip() {
        round_trip(true, 10, 4);
    }

    #[test]
    fn mono_round_trip() {
        round_trip(false, 8, 3);
    }

    #[test]
    fn every_frame_is_a_key_frame() {
        round_trip(true, 5, 1);
    }

    #[test]
    fn audio_is_carried_through() {
        let m = meta(false);
        let audio: Vec<u8> = (0..1000).map(|i| (i % 251) as u8).collect();
        let mut w = GlyphWriter::new(m.clone(), audio.clone());
        for f in make_frames(&m, 3) {
            w.add_frame(&f, 2).unwrap();
        }
        let r = GlyphReader::open(w.finish().unwrap()).unwrap();
        assert_eq!(r.audio(), &audio[..]);
    }

    #[test]
    fn text_matches_the_grid() {
        let m = GlyphMeta {
            cols: 4,
            rows: 2,
            fps: 1.0,
            color: false,
            chars: [" ", ".", ":", "=", "#", "@", "█"].iter().map(|s| s.to_string()).collect(),
        };
        let mut f = GridFrame::new(8, false);
        f.glyphs.copy_from_slice(&[0, 1, 2, 3, 4, 5, 6, 0]);
        let mut w = GlyphWriter::new(m, Vec::new());
        w.add_frame(&f, 120).unwrap();
        let mut r = GlyphReader::open(w.finish().unwrap()).unwrap();
        let mut state = r.new_state();
        r.decode_into(0, &mut state).unwrap();
        assert_eq!(r.to_text(&state), " .:=\n#@█ ");
    }

    #[test]
    fn rejects_junk() {
        assert!(GlyphReader::open(vec![1, 2, 3, 4, 5, 6, 7, 8, 9]).is_err());
    }

    #[test]
    fn seeking_backwards_replays_the_chain() {
        let m = meta(true);
        let frames = make_frames(&m, 12);
        let mut w = GlyphWriter::new(m.clone(), Vec::new());
        for f in &frames {
            w.add_frame(f, 5).unwrap();
        }
        let mut r = GlyphReader::open(w.finish().unwrap()).unwrap();

        let mut state = r.new_state();
        for i in 0..frames.len() {
            r.decode_into(i as u32, &mut state).unwrap();
        }
        // Jumping back must rebuild model state, not carry it forward.
        let mut state2 = r.new_state();
        r.decode_into(3, &mut state2).unwrap();
        assert_eq!(&state2, &frames[3]);
    }

    #[test]
    fn char_table_survives_multibyte_and_escapes() {
        let chars: Vec<String> =
            [" ", "\"", "\\", "█", "é", "\n"].iter().map(|s| s.to_string()).collect();
        let encoded = serialise_chars(&chars);
        assert_eq!(parse_chars(&encoded).unwrap(), chars);
    }
}
