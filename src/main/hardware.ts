// Host-hardware detection + adaptive performance profile.
//
// ARIA ships one binary that must run well on a beefy RDNA-4 desktop AND on a
// thin laptop. Rather than hard-code settings tuned for the dev machine, we
// detect the host's CPU/RAM/GPU once at startup and derive a "performance tier"
// that drives adaptive defaults and — crucially — a GPU-work cap. The two
// continuous GPU consumers ARIA actually controls are the on-device whisper STT
// (Vulkan) and the renderer's animated orb; on a weak GPU, running both flat out
// while a reply is spoken can drive the GPU to 100% and freeze the whole desktop
// (the reported crash). The profile bounds that work so it stays well under the
// configured cap.
//
// Detection is best-effort and never throws: every probe is wrapped, has a short
// timeout, and degrades to a sane default. The result is cached — hardware does
// not change during a run.

import os from 'os';
import fs from 'fs';
import { execFileSync } from 'child_process';

export interface GpuInfo {
  name: string;
  vendor: 'amd' | 'nvidia' | 'intel' | 'unknown';
  vramMB: number | null; // total VRAM if we could read it, else null
  discrete: boolean;     // a dedicated GPU (vs integrated/unknown)
}

export type Tier = 'low' | 'medium' | 'high';

export interface HardwareInfo {
  cpuCores: number;      // logical cores
  cpuModel: string;
  totalMemGB: number;    // rounded to 1 decimal
  gpu: GpuInfo;
  tier: Tier;
  platform: string;
}

// Concrete, adaptive knobs derived from the hardware + the user's GPU cap.
export interface PerfProfile {
  // whisper -t: how many CPU threads STT may use. Bounded so STT can't peg every
  // core (which on a small machine starves the UI and audio playback).
  sttThreads: number;
  // Suggested STT backend. We never silently override an explicit user choice in
  // config; this is the recommended default for the tier/cap.
  sttBackend: 'vulkan' | 'cpu';
  // Orb render budget. 'low' disables the GPU-expensive shadow blur and runs at a
  // low frame rate; 'high' is the full-quality animation. This is the main lever
  // that keeps the renderer's GPU compositor load bounded.
  orbQuality: 'low' | 'medium' | 'high';
  // The effective GPU cap (percent) this profile targets, echoed back for the UI.
  gpuCapPct: number;
}

let cached: HardwareInfo | null = null;

function safeExec(cmd: string, args: string[], timeoutMs = 1500): string {
  try {
    return execFileSync(cmd, args, {
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4 * 1024 * 1024,
    }).toString();
  } catch {
    return '';
  }
}

function vendorOf(name: string): GpuInfo['vendor'] {
  const n = name.toLowerCase();
  if (/amd|radeon|rdna|navi|advanced micro/.test(n)) return 'amd';
  if (/nvidia|geforce|rtx|gtx|quadro|tesla/.test(n)) return 'nvidia';
  if (/intel|arc|iris|uhd graphics|hd graphics/.test(n)) return 'intel';
  return 'unknown';
}

// VRAM via the AMD/Intel DRM sysfs node — a clean integer in bytes, no parsing of
// human-formatted tool output. Returns null when the node is absent (e.g. NVIDIA,
// which exposes it differently) so callers don't treat 0 as "no VRAM".
function readDrmVramMB(): number | null {
  try {
    const drm = '/sys/class/drm';
    if (!fs.existsSync(drm)) return null;
    for (const entry of fs.readdirSync(drm)) {
      if (!/^card\d+$/.test(entry)) continue;
      const p = `${drm}/${entry}/device/mem_info_vram_total`;
      try {
        const bytes = parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
        if (Number.isFinite(bytes) && bytes > 0) return Math.round(bytes / (1024 * 1024));
      } catch { /* try next card */ }
    }
  } catch { /* sysfs unavailable */ }
  return null;
}

function nvidiaVramMB(): number | null {
  const out = safeExec('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits']);
  const m = out.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function detectGpu(): GpuInfo {
  let name = '';

  // 1) Vulkan is the backend ARIA's STT uses, so vulkaninfo is the most relevant
  //    probe — and it names the device ARIA will actually run on.
  const vk = safeExec('vulkaninfo', ['--summary']);
  if (vk) {
    const m = vk.match(/deviceName\s*=\s*(.+)/);
    if (m) name = m[1].trim();
  }

  // 2) Fallback: lspci VGA/3D line (works without any Vulkan loader installed).
  if (!name) {
    const pci = safeExec('sh', ['-c', "lspci 2>/dev/null | grep -Ei 'vga|3d|display'"]);
    const line = pci.split('\n').find(Boolean) || '';
    const after = line.split(':').slice(2).join(':').trim();
    if (after) name = after;
  }

  const vendor = vendorOf(name);
  let vramMB = readDrmVramMB();
  if (vramMB === null && vendor === 'nvidia') vramMB = nvidiaVramMB();

  // "Discrete" heuristic: a known dGPU family name, or >= 3 GB of dedicated VRAM.
  const discrete =
    /radeon rx|geforce|rtx|gtx|quadro|tesla|arc a\d/i.test(name) ||
    (vramMB !== null && vramMB >= 3000);

  return { name: name || 'Unknown GPU', vendor, vramMB, discrete };
}

function deriveTier(cpuCores: number, totalMemGB: number, gpu: GpuInfo): Tier {
  // Low: anything cramped on CPU or RAM, or a clearly weak/integrated GPU.
  if (cpuCores <= 4 || totalMemGB < 8) return 'low';
  if (gpu.vramMB !== null && gpu.vramMB < 2000) return 'low';
  if (!gpu.discrete && gpu.vendor !== 'unknown') return 'medium';

  // High: lots of cores + RAM AND a capable discrete GPU (or unknown-but-plenty).
  const bigGpu = gpu.vramMB === null ? gpu.discrete : gpu.vramMB >= 8000;
  if (cpuCores >= 8 && totalMemGB >= 16 && bigGpu) return 'high';
  return 'medium';
}

export function detectHardware(): HardwareInfo {
  if (cached) return cached;
  const cpus = os.cpus() || [];
  const cpuCores = cpus.length || 1;
  const cpuModel = (cpus[0]?.model || 'Unknown CPU').replace(/\s+/g, ' ').trim();
  const totalMemGB = Math.round((os.totalmem() / 1e9) * 10) / 10;
  const gpu = detectGpu();
  const tier = deriveTier(cpuCores, totalMemGB, gpu);
  cached = { cpuCores, cpuModel, totalMemGB, gpu, tier, platform: process.platform };
  return cached;
}

// Map a hardware tier + the user's GPU cap (percent) to concrete runtime knobs.
// The cap is the dominant lever: a low cap forces conservative settings even on
// strong hardware (the user asked ARIA to stay light), while the tier prevents
// us from over-driving weak hardware even at a high cap.
export function perfProfile(hw: HardwareInfo, gpuCapPct: number): PerfProfile {
  const cap = clampCap(gpuCapPct);

  // STT threads: a fraction of the cores scaled by the cap, leaving headroom for
  // the UI/audio. At least 1, never more than (cores - 1) on multicore hosts.
  const capFrac = cap / 100;
  const headroom = hw.cpuCores > 2 ? hw.cpuCores - 1 : hw.cpuCores;
  const sttThreads = Math.max(1, Math.min(headroom, Math.round(hw.cpuCores * capFrac)));

  // Orb quality: the lower of what the tier can afford and what the cap allows.
  const tierMax: PerfProfile['orbQuality'] = hw.tier === 'high' ? 'high' : hw.tier === 'medium' ? 'medium' : 'low';
  const capMax: PerfProfile['orbQuality'] = cap <= 35 ? 'low' : cap <= 60 ? 'medium' : 'high';
  const orbQuality = minQuality(tierMax, capMax);

  // STT backend: prefer the GPU (Vulkan) unless the cap is very low or there's no
  // usable discrete GPU — then the CPU path keeps GPU utilisation near zero.
  const sttBackend: PerfProfile['sttBackend'] =
    cap <= 35 || (!hw.gpu.discrete && hw.gpu.vendor !== 'unknown') ? 'cpu' : 'vulkan';

  return { sttThreads, sttBackend, orbQuality, gpuCapPct: cap };
}

const QORDER: PerfProfile['orbQuality'][] = ['low', 'medium', 'high'];
function minQuality(a: PerfProfile['orbQuality'], b: PerfProfile['orbQuality']): PerfProfile['orbQuality'] {
  return QORDER[Math.min(QORDER.indexOf(a), QORDER.indexOf(b))];
}

export function clampCap(pct: unknown): number {
  const n = typeof pct === 'number' && Number.isFinite(pct) ? pct : 50;
  return Math.max(20, Math.min(100, Math.round(n)));
}
