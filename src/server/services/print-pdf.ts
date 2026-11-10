import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppConfig } from '../config';
import { AppError } from '../lib/errors';

/** Chrome/Chromium candidates, macOS first (the on-site machine is a Mac). */
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

export interface ChromeLookup {
  /** Explicit path (tests / operators). */
  chromePath?: string | null;
  /** Override the built-in candidate list (tests). */
  candidates?: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Locate a headless-capable browser. Server-side PDF is optional: when no
 * Chrome is installed the UI keeps the browser-print fallback.
 */
export function findChrome(lookup: ChromeLookup = {}): string | null {
  const env = lookup.env ?? process.env;
  const candidates = [
    lookup.chromePath ?? null,
    env.CHROME_PATH ?? null,
    ...(lookup.candidates ?? CHROME_CANDIDATES),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function runChrome(chrome: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('PDF_TIMEOUT'));
    }, timeoutMs);
    timer.unref?.();

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(0, 2000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`chrome exit ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}

export interface RenderPdfOptions extends ChromeLookup {
  timeoutMs?: number;
}

/**
 * Render a self-contained HTML document (inline CSS + data-URL QR images) to
 * A4 PDF via Chrome's `--print-to-pdf`. This reuses the exact print stylesheet
 * so PDF and paper never drift apart, without bundling a PDF/font dependency.
 */
export async function renderPdfFromHtml(
  config: AppConfig,
  html: string,
  options: RenderPdfOptions = {},
): Promise<Buffer> {
  const chrome = findChrome(options);
  if (!chrome) {
    throw new AppError(
      'PRINT_UNAVAILABLE',
      503,
      '没有找到 Chrome，暂时无法生成服务端 PDF；可以继续用浏览器打印',
      true,
    );
  }

  mkdirSync(config.paths.exports, { recursive: true });
  mkdirSync(config.paths.gen, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const htmlPath = join(config.paths.exports, `cards-${stamp}.html`);
  const pdfPath = join(config.paths.exports, `cards-${stamp}.pdf`);
  const profileDir = join(config.paths.gen, `chrome-${stamp}`);

  writeFileSync(htmlPath, html);
  try {
    await runChrome(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--no-first-run',
        '--disable-extensions',
        '--disable-dev-shm-usage',
        `--user-data-dir=${profileDir}`,
        '--no-pdf-header-footer',
        '--virtual-time-budget=5000',
        `--print-to-pdf=${pdfPath}`,
        pathToFileURL(htmlPath).href,
      ],
      options.timeoutMs ?? 30_000,
    );

    if (!existsSync(pdfPath)) {
      throw new AppError('PRINT_FAILED', 500, 'PDF 生成失败，请重试', true);
    }
    return readFileSync(pdfPath);
  } catch (error) {
    if (error instanceof AppError) throw error;
    const message = error instanceof Error ? error.message.slice(0, 120) : '未知错误';
    throw new AppError('PRINT_FAILED', 503, `PDF 生成失败：${message}`, true);
  } finally {
    rmSync(htmlPath, { force: true });
    rmSync(pdfPath, { force: true });
    rmSync(profileDir, { recursive: true, force: true });
  }
}
