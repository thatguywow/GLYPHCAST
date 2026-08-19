import { initGPU } from './engine/gpu';
import { buildGlyphAtlas } from './engine/glyphAtlas';
import { Renderer } from './engine/renderer';
import { StaticPlayer } from './player/staticPlayer';
import { DEFAULT_PARAMS, Mode, type RenderParams } from './types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $('canvas') as HTMLCanvasElement;
const statsEl = $('stats');
const dropEl = $('drop');
const fatalEl = $('fatal');
const fatalMsg = $('fatalMsg');
const infoEl = $('info');

async function main() {
  let gpu;
  try {
    gpu = await initGPU(canvas);
  } catch (e) {
    fatalMsg.textContent = (e as Error).message;
    fatalEl.classList.remove('hidden');
    return;
  }

  const atlas = buildGlyphAtlas(gpu.device);
  // The file supplies the grid; only presentation options matter here.
  const params: RenderParams = { ...DEFAULT_PARAMS, mode: Mode.AsciiColor, cellPx: 8 };
  const renderer = new Renderer(gpu, atlas, params);
  const player = new StaticPlayer(renderer);

  const playBtn = $('play') as HTMLButtonElement;
  const seek = $('seek') as HTMLInputElement;

  player.onStats = (s) => {
    statsEl.textContent =
      `${s.fps.toFixed(0)} fps · frame ${s.frame}/${s.frames} · ` +
      `${s.seconds.toFixed(1)}s / ${s.duration.toFixed(1)}s`;
    seek.value = String((s.frame / Math.max(1, s.frames - 1)) * 1000);
  };
  player.onEnded = () => {
    playBtn.textContent = 'Play';
  };
  player.onError = (m) => {
    infoEl.textContent = 'Playback error: ' + m;
  };

  async function load(file: File) {
    try {
      dropEl.classList.add('hidden');
      infoEl.textContent = 'Loading…';
      await player.load(await file.arrayBuffer());
      const m = player.meta!;
      infoEl.textContent =
        `${file.name} — ${m.cols}x${m.rows} · ${m.fps.toFixed(1)}fps · ` +
        `${player.frameCount} frames · ${(player.frameCount / m.fps).toFixed(1)}s · ` +
        `${m.color ? 'colour' : 'mono'} · ${(file.size / 1048576).toFixed(1)} MB`;
      playBtn.disabled = false;
      seek.disabled = false;
      player.play();
      playBtn.textContent = 'Pause';
    } catch (e) {
      infoEl.textContent = 'Could not open: ' + (e as Error).message;
      dropEl.classList.remove('hidden');
    }
  }

  ($('pick') as HTMLButtonElement).onclick = () => ($('file') as HTMLInputElement).click();
  ($('file') as HTMLInputElement).onchange = (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void load(f);
  };

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) void load(f);
  });

  playBtn.onclick = () => {
    player.toggle();
    playBtn.textContent = player.isPlaying ? 'Pause' : 'Play';
  };

  seek.oninput = () => {
    const wasPlaying = player.isPlaying;
    player.pause();
    const target = Math.round((+seek.value / 1000) * (player.frameCount - 1));
    void (player as any).seekTo(target).then(() => {
      if (wasPlaying) player.play();
      else playBtn.textContent = 'Play';
    });
  };

  const cell = $('cell') as HTMLInputElement;
  cell.oninput = () => {
    params.cellPx = +cell.value;
    $('cellVal').textContent = cell.value;
    const m = player.meta;
    if (m) {
      renderer.setParams(params);
      renderer.setExternalGrid(m.cols, m.rows);
      (player as any).draw();
    }
  };

  ($('copyText') as HTMLButtonElement).onclick = async () => {
    const t = player.text();
    if (!t) return;
    await navigator.clipboard.writeText(t);
    infoEl.textContent = `Copied ${t.length} characters.`;
  };

  // Allow loading a file straight from a URL, so a page can ship with content.
  const src = new URLSearchParams(location.search).get('src');
  if (src) {
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load(new File([await res.blob()], src.split('/').pop() ?? 'stream.glyph'));
    } catch (e) {
      infoEl.textContent = `Could not load ${src}: ${(e as Error).message}`;
    }
  }
}

void main();
