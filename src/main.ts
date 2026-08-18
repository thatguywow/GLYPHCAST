import { initGPU } from './engine/gpu';
import { buildGlyphAtlas } from './engine/glyphAtlas';
import { Renderer } from './engine/renderer';
import { Player } from './player/player';
import { DemoSource } from './demo/demoSource';
import { DEFAULT_PARAMS, type RenderParams } from './types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $('canvas') as HTMLCanvasElement;
const errEl = $('err');
const dropEl = $('drop');
const statsEl = $('stats');
const fatalEl = $('fatal');
const fatalMsg = $('fatalMsg');

const playBtn = $('play') as HTMLButtonElement;
const restartBtn = $('restart') as HTMLButtonElement;
const pickBtn = $('pick') as HTMLButtonElement;
const fileInput = $('file') as HTMLInputElement;
const demoBtn = $('demo') as HTMLButtonElement;

function showError(msg: string) {
  errEl.textContent = msg;
  console.error(msg);
}

function showFatal(msg: string) {
  fatalMsg.textContent = msg;
  fatalEl.classList.remove('hidden');
  console.error(msg);
}

async function main() {
  let gpu;
  try {
    gpu = await initGPU(canvas);
  } catch (e) {
    // Without a GPU nothing can render — surface it loudly, not as tiny red text.
    showFatal((e as Error).message);
    return;
  }

  const atlas = buildGlyphAtlas(gpu.device);
  const params: RenderParams = { ...DEFAULT_PARAMS };
  const renderer = new Renderer(gpu, atlas, params);
  const player = new Player(renderer);
  const demo = new DemoSource();

  let loadedFile: File | null = null;

  player.onError = showError;
  player.onReady = () => {
    playBtn.disabled = false;
    restartBtn.disabled = false;
    errEl.textContent = '';
  };
  player.onStats = (s) => {
    const dur = s.duration ? ` / ${s.duration.toFixed(0)}s` : '';
    statsEl.textContent = `${s.fps.toFixed(0)} fps · buf ${s.buffered} · ${s.currentTime.toFixed(1)}s${dur}`;
  };

  demo.onFrame = (cv, w, h) => renderer.render(cv, w, h);
  demo.onStats = (fps) => {
    statsEl.textContent = `DEMO · ${fps.toFixed(0)} fps · ${renderer.outputSize[0]}×${renderer.outputSize[1]}`;
  };

  function stopDemo() {
    if (demo.isRunning) {
      demo.stop();
      demoBtn.textContent = '▶ Demo (no file, no server)';
    }
  }

  async function loadFile(file: File) {
    stopDemo();
    loadedFile = file;
    dropEl.classList.add('hidden');
    playBtn.textContent = 'Play';
    playBtn.disabled = true;
    await player.load(file);
  }

  // --- demo ---------------------------------------------------------------
  demoBtn.onclick = () => {
    if (demo.isRunning) {
      stopDemo();
      return;
    }
    player.pause();
    playBtn.textContent = 'Play';
    dropEl.classList.add('hidden');
    demo.start();
    demoBtn.textContent = '■ Stop demo';
  };

  // --- file input ---------------------------------------------------------
  pickBtn.onclick = () => fileInput.click();
  fileInput.onchange = () => {
    const f = fileInput.files?.[0];
    if (f) void loadFile(f);
  };

  // --- drag & drop --------------------------------------------------------
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) void loadFile(f);
  });

  // --- transport ----------------------------------------------------------
  playBtn.onclick = () => {
    stopDemo();
    player.toggle();
    playBtn.textContent = player.isPlaying ? 'Pause' : 'Play';
  };
  restartBtn.onclick = () => {
    if (loadedFile) void loadFile(loadedFile);
  };

  // --- live params --------------------------------------------------------
  const applyParams = () => {
    renderer.setParams(params);
    // Reflect changes immediately when nothing is actively driving frames.
    if (!player.isPlaying && !demo.isRunning) player.rerender();
  };

  const cols = $('cols') as HTMLInputElement;
  cols.oninput = () => {
    params.cols = +cols.value;
    $('colsVal').textContent = cols.value;
    applyParams();
  };

  const cell = $('cell') as HTMLInputElement;
  cell.oninput = () => {
    params.cellPx = +cell.value;
    $('cellVal').textContent = cell.value;
    applyParams();
  };

  const color = $('color') as HTMLSelectElement;
  color.onchange = () => {
    params.colorMode = +color.value;
    applyParams();
  };

  const edge = $('edge') as HTMLInputElement;
  edge.onchange = () => {
    params.edgeEnable = edge.checked;
    applyParams();
  };

  const edgeThresh = $('edgeThresh') as HTMLInputElement;
  edgeThresh.oninput = () => {
    params.edgeThreshold = +edgeThresh.value;
    $('edgeVal').textContent = (+edgeThresh.value).toFixed(2);
    applyParams();
  };
}

void main();
