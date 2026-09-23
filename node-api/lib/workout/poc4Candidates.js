/**
 * POC #4 candidate catalog. This file does not download models.
 * Download sizes are Ollama library defaults as of 2026-09-19.
 */
export const HARDWARE = {
  hostname: 'home-ai',
  cpu: 'AMD Ryzen 7 PRO 5850U (8c/16t, ~15W U-series)',
  ram_usable_gb: 27.3,
  ram_policy_max_gb: 22,
  gpu: 'AMD Radeon Cezanne iGPU — CPU inference only',
  ollama_version_observed: '0.12.3',
};

export const BASELINE = {
  tag: 'llama3.2-vision:11b',
  status: 'installed',
  parameter_size: '10.7B',
  quantization: 'Q4_K_M',
  download_gb: 7.8,
  poc3: {
    canonical_exact: '0 / 3',
    raw_cells_all_three_runs: '33 / 45',
    warm_latency_sec: 122,
    b03_exact: '3 / 3',
  },
};

export const CANDIDATES = [
  {
    tag: 'llama3.2-vision:11b',
    role: 'baseline',
    wave: 'control',
    parameter_size: '10.7B',
    quantization: 'Q4_K_M',
    download_gb: 7.8,
    accepts_image: true,
    installed: true,
    ollama_min: '0.5+',
    ram_feasible: true,
    recommend: true,
    why: 'Established baseline. Recovers dense numeric tables (B03/B05–B07) but fails BW, blank weights, effort, and pain. Include as the control run, do not re-tune.',
  },
  {
    tag: 'qwen2.5vl:7b',
    role: 'primary',
    wave: 1,
    parameter_size: '7B',
    quantization: 'Ollama default (~Q4, 6.0GB)',
    download_gb: 6.0,
    accepts_image: true,
    installed: false,
    ollama_min: '0.7.0',
    ram_feasible: true,
    recommend: true,
    why: 'Document/table/form structured-output VLM. 7B class fits this CPU/RAM box and is the strongest apples-to-apples accuracy bet versus Llama 3.2 Vision 11B without upgrading Ollama.',
  },
  {
    tag: 'minicpm-v:8b',
    role: 'ocr',
    wave: 1,
    parameter_size: '8B',
    quantization: 'Ollama default (~Q4, 5.5GB)',
    download_gb: 5.5,
    accepts_image: true,
    installed: false,
    ollama_min: '0.3.10',
    ram_feasible: true,
    recommend: true,
    why: 'OCRBench-oriented MiniCPM-V 2.6. Dense visual tokens (640 tokens / 1.8MP) are a better fit for a large iPhone sheet photo on CPU than 11B Llama.',
  },
  {
    tag: 'gemma3:4b',
    role: 'small-document',
    wave: 1,
    parameter_size: '4B',
    quantization: 'Ollama default (~Q4, 3.3GB)',
    download_gb: 3.3,
    accepts_image: true,
    installed: false,
    ollama_min: '0.6.0',
    ram_feasible: true,
    recommend: true,
    why: 'Smallest multimodal Gemma 3. DocVQA 72.8 at 4B. Tests whether a 4B document model can beat 11B Llama on handwriting/table cells at much lower RAM/CPU cost.',
  },
  {
    tag: 'granite3.2-vision:2b',
    role: 'document-specialist',
    wave: 1,
    parameter_size: '2B',
    quantization: 'Ollama default (2.4GB)',
    download_gb: 2.4,
    accepts_image: true,
    installed: false,
    ollama_min: '0.5.13',
    ram_feasible: true,
    recommend: true,
    why: 'IBM Granite vision trained specifically for tables, charts, and document extraction. Tiny enough to be a true CPU-friendly alternative if accuracy is close.',
  },
  {
    tag: 'qwen2.5vl:3b',
    role: 'small-ablation',
    wave: 'optional',
    parameter_size: '3B',
    quantization: 'Ollama default (~Q4, 3.2GB)',
    download_gb: 3.2,
    accepts_image: true,
    installed: false,
    ollama_min: '0.7.0',
    ram_feasible: true,
    recommend: false,
    why: 'Edge Qwen2.5-VL. Worth pulling only if 7B is too slow on this U-series CPU or we want a size ablation. Skip in the first download if we want fewer models.',
  },
  {
    tag: 'gemma3:12b',
    role: 'optional-larger',
    wave: 'optional',
    parameter_size: '12B',
    quantization: 'Ollama default (~Q4, 8.1GB)',
    download_gb: 8.1,
    accepts_image: true,
    installed: false,
    ollama_min: '0.6.0',
    ram_feasible: true,
    recommend: false,
    why: 'Stronger DocVQA (82.3) but same size class as the 11B baseline. Only justified if 4B Gemma is promising but underpowered. CPU time will be similar to Llama 11B.',
  },
];

export const REJECTED = [
  {
    tag: 'qwen3-vl:8b',
    download_gb: 6.1,
    reason: 'Best current Qwen VLM for OCR/documents, but requires Ollama 0.12.7. Server is 0.12.3. Revisit only after a deliberate Ollama upgrade, not as part of this pull.',
  },
  {
    tag: 'qwen3-vl:4b / 2b',
    download_gb: '3.3 / 1.9',
    reason: 'Blocked on the same 0.12.7 requirement.',
  },
  {
    tag: 'gemma4:e4b / 12b',
    download_gb: '9.6 / 7.6',
    reason: 'Newer multimodal Gemma. Likely needs a newer Ollama than 0.12.3, uses thinking/system-prompt conventions, and is not an apples-to-apples first wave.',
  },
  {
    tag: 'deepseek-ocr:3b',
    download_gb: 'unknown (library)',
    reason: 'Requires Ollama 0.13.0 and a special OCR prompt dialect. Would break the frozen POC #3 prompt.',
  },
  {
    tag: 'llama3.2-vision:90b',
    download_gb: '~50+',
    reason: 'Far above 20–22 GB RAM policy. Forbidden class.',
  },
  {
    tag: 'qwen2.5vl:32b / 72b',
    download_gb: '21 / ~49',
    reason: '32B is 21GB weights before KV/image embeddings. Would contend with other home services and likely swap.',
  },
  {
    tag: 'gemma3:27b',
    download_gb: 17,
    reason: 'Fits disk, not a practical CPU model on a 15W 5850U while other services run.',
  },
  {
    tag: 'mistral-small3.1:24b',
    download_gb: '~15+',
    reason: '24B multimodal. Too large for this RAM/CPU policy.',
  },
  {
    tag: 'llava:7b / 13b',
    download_gb: '~4.7 / ~8',
    reason: 'Older general captioning models. Weak on dense document tables compared with Qwen2.5-VL / MiniCPM-V / Granite document models.',
  },
  {
    tag: 'moondream:1.8b',
    download_gb: '~1.7',
    reason: 'Edge captioning toy. Not a handwriting/table extractor.',
  },
  {
    tag: 'dolphin-mixtral:8x7b / llama3 / mistral',
    download_gb: 'already installed',
    reason: 'Text-only. dolphin-mixtral is 26.4GB and must not be loaded during this shootout.',
  },
];

export function recommendedFirstWave() {
  return CANDIDATES.filter((c) => c.recommend && c.wave === 1);
}

export function recommendedDownloadGb() {
  return recommendedFirstWave().reduce((sum, c) => sum + c.download_gb, 0);
}
