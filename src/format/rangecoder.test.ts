// The range coder must be exactly reversible before anything depends on it — a
// coder that is merely usually correct corrupts video part way through a file.
// Checks reversibility across distributions, then measures against deflate on
// the shape of data the format actually produces.

import { RangeEncoder, RangeDecoder, ByteModel } from './rangecoder';

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

function roundTrip(data: Uint8Array): { out: Uint8Array; coded: Uint8Array } {
  const enc = new RangeEncoder();
  const m = new ByteModel();
  enc.encodeBytes(m, data);
  const coded = enc.finish();

  const dec = new RangeDecoder(coded);
  const m2 = new ByteModel();
  const out = new Uint8Array(data.length);
  dec.decodeBytes(m2, out);
  return { out, coded };
}

function eq(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function deflateSize(data: Uint8Array): Promise<number> {
  const cs = new CompressionStream('deflate-raw');
  const s = new Blob([data as BufferSource]).stream().pipeThrough(cs);
  return (await new Response(s).arrayBuffer()).byteLength;
}

// xorshift32 via Math.imul. A plain LCG in JS silently loses precision — the
// multiply exceeds 2^53 — and degenerates into a repetitive sequence, which made
// an earlier run of this file report deflate compressing "random" data 6x.
let seed = 987654321 >>> 0;
const rnd = () => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 4294967296;
};

async function run() {
  // --- reversibility -------------------------------------------------------
  {
    const empty = new Uint8Array(0);
    check('empty input', eq(roundTrip(empty).out, empty));

    const one = new Uint8Array([42]);
    check('single byte', eq(roundTrip(one).out, one));

    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    check('every byte value', eq(roundTrip(all).out, all));

    const zeros = new Uint8Array(50000);
    check('all zeros', eq(roundTrip(zeros).out, zeros));

    const ones = new Uint8Array(50000).fill(255);
    check('all 0xFF', eq(roundTrip(ones).out, ones));

    const random = new Uint8Array(100000);
    for (let i = 0; i < random.length; i++) random[i] = Math.floor(rnd() * 256);
    check('uniform random', eq(roundTrip(random).out, random));

    // The real case: residual planes, overwhelmingly zero with rare spikes.
    const residual = new Uint8Array(200000);
    for (let i = 0; i < residual.length; i++) {
      const r = rnd();
      residual[i] = r < 0.8 ? 0 : r < 0.95 ? (rnd() < 0.5 ? 1 : 2) : Math.floor(rnd() * 256);
    }
    const rt = roundTrip(residual);
    check('residual-shaped data', eq(rt.out, residual), `${residual.length} bytes`);

    // --- size vs deflate ---------------------------------------------------
    const dz = await deflateSize(residual);
    const ratio = dz / rt.coded.length;
    check(
      'beats deflate on residual data',
      rt.coded.length < dz,
      `range ${(rt.coded.length / 1024).toFixed(1)} KB vs deflate ${(dz / 1024).toFixed(1)} KB (${ratio.toFixed(2)}x)`,
    );

    const dRandom = await deflateSize(random);
    const rRandom = roundTrip(random).coded.length;
    check(
      'incompressible data stays near its original size',
      rRandom < random.length * 1.02,
      `range ${rRandom} vs deflate ${dRandom} vs raw ${random.length}`,
    );

    // Sparse bitmaps, like the changed-cell map.
    const bitmap = new Uint8Array(30000);
    for (let i = 0; i < bitmap.length; i++) bitmap[i] = rnd() < 0.1 ? Math.floor(rnd() * 256) : 0;
    const brt = roundTrip(bitmap);
    const bdz = await deflateSize(bitmap);
    check('sparse bitmap reversible', eq(brt.out, bitmap));
    check(
      'beats deflate on sparse bitmap',
      brt.coded.length < bdz,
      `range ${brt.coded.length} vs deflate ${bdz}`,
    );
  }

  // --- independent models stay independent ---------------------------------
  {
    const a = new Uint8Array(5000).fill(7);
    const b = new Uint8Array(5000);
    for (let i = 0; i < b.length; i++) b[i] = Math.floor(rnd() * 256);

    const enc = new RangeEncoder();
    const ma = new ByteModel();
    const mb = new ByteModel();
    enc.encodeBytes(ma, a);
    enc.encodeBytes(mb, b);
    const coded = enc.finish();

    const dec = new RangeDecoder(coded);
    const ma2 = new ByteModel();
    const mb2 = new ByteModel();
    const oa = new Uint8Array(a.length);
    const ob = new Uint8Array(b.length);
    dec.decodeBytes(ma2, oa);
    dec.decodeBytes(mb2, ob);
    check('two models in one stream', eq(oa, a) && eq(ob, b));
  }

  const passed = results.filter((r) => r.pass).length;
  (window as any).__RC_TEST__ = { passed, total: results.length, results };
  document.getElementById('out')!.innerHTML =
    `<h3>${passed}/${results.length} passed</h3>` +
    results
      .map(
        (r) =>
          `<div style="color:${r.pass ? '#6cff9a' : '#ff6b6b'}">${r.pass ? 'PASS' : 'FAIL'} — ${r.name}` +
          (r.detail ? ` <span style="color:#8a8a96">(${r.detail})</span>` : '') +
          '</div>',
      )
      .join('');
}

run().catch((e) => {
  (window as any).__RC_TEST__ = { error: String(e) };
  document.getElementById('out')!.textContent = 'ERROR: ' + e.message;
  console.error(e);
});
