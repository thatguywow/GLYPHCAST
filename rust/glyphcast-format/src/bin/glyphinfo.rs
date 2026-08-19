//! Inspects a .glyph file: prints its header, decodes every frame, and shows the
//! first frame as text. Doubles as the cross-language check — the file it reads
//! is written by the TypeScript compiler, so if this agrees, the two
//! implementations of the format genuinely match.

use glyphcast_format::GlyphReader;
use std::io::Read;

fn main() {
    let path = match std::env::args().nth(1) {
        Some(p) => p,
        None => {
            eprintln!("usage: glyphinfo <file.glyph>");
            std::process::exit(2);
        }
    };

    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .expect("could not open file")
        .read_to_end(&mut bytes)
        .expect("could not read file");
    let total = bytes.len();

    let mut reader = GlyphReader::open(bytes).expect("could not parse .glyph");
    println!("file        {path}");
    println!("size        {} bytes", total);
    println!("grid        {}x{}", reader.meta.cols, reader.meta.rows);
    println!("fps         {}", reader.meta.fps);
    println!("frames      {}", reader.frame_count);
    println!("colour      {}", reader.meta.color);
    println!("glyphs      {}", reader.meta.chars.len());
    println!("audio       {} bytes", reader.audio().len());

    // Decoding the whole chain is the real test: a mismatch in the coder or the
    // predictors surfaces part way through, not on frame 0.
    let mut state = reader.new_state();
    let mut first = String::new();
    for i in 0..reader.frame_count {
        reader.decode_into(i, &mut state).expect("frame failed to decode");
        if i == 0 {
            first = reader.to_text(&state);
        }
    }
    println!("decoded     all {} frames OK", reader.frame_count);

    println!("\nframe 0:");
    for line in first.lines().take(12) {
        println!("{line}");
    }
}
