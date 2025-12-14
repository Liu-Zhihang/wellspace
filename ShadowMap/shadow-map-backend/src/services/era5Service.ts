import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';

const ERA5_DEFAULT_PATH =
  (process.env['ERA5_FILE_PATH'] ?? '').trim();
const ERA5_FILE_TEMPLATE =
  (process.env['ERA5_FILE_TEMPLATE'] ?? '').trim(); // supports %Y %m
// 优先环境变量；否则尝试 backend 根的 ../scripts/era5_extract.py；再回退 dist/scripts
const ERA5_SCRIPT_CANDIDATES = [
  process.env['ERA5_PYTHON_SCRIPT'],
  path.resolve(process.cwd(), '../scripts/era5_extract.py'),
  path.resolve(__dirname, '../../scripts/era5_extract.py'),
].filter(Boolean) as string[];
const PYTHON_BIN = process.env['ERA5_PYTHON_BIN'] || 'python3';

export class Era5Service {
  private static instance: Era5Service;

  static getInstance() {
    if (!Era5Service.instance) {
      Era5Service.instance = new Era5Service();
    }
    return Era5Service.instance;
  }

  async getWeather(lat: number, lon: number, time: Date) {
    const filePath = this.resolveFilePath(time);
    if (!fs.existsSync(filePath)) {
      throw new Error(`ERA5 file not found at ${filePath}`);
    }
    const scriptPath = this.resolveScriptPath();
    if (!scriptPath) {
      throw new Error(`ERA5 extract script not found in candidates: ${ERA5_SCRIPT_CANDIDATES.join(', ')}`);
    }
    const isoTime = time.toISOString();
    const payload = JSON.stringify({
      file: filePath,
      lat,
      lon,
      isoTime,
    });

    const child = spawn(PYTHON_BIN, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutPromise = this.collect(child.stdout);
    const stderrPromise = this.collect(child.stderr);
    child.stdin.write(payload);
    child.stdin.end();
    const exitCode: number = await new Promise((resolve) => child.on('close', (code) => resolve(code ?? 0)));
    const stdout = await stdoutPromise;
    const stderr = await stderrPromise;
    if (exitCode !== 0) {
      throw new Error(`ERA5 extract failed (${exitCode}): ${stderr || 'Unknown error'}`);
    }
    try {
      const parsed = JSON.parse(stdout) as {
        cloudCover: number | null;
        irradianceWm2: number | null;
        source: string;
        details?: Record<string, unknown>;
      };
      return parsed;
    } catch (error) {
      throw new Error(`ERA5 extract parse error: ${stdout || (error as Error).message}`);
    }
  }

  private async collect(stream: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve, reject) => {
      let buf = '';
      stream.setEncoding('utf-8');
      stream.on('data', (chunk) => (buf += chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(buf.trim()));
    });
  }

  private resolveFilePath(time: Date): string {
    const y = time.getUTCFullYear().toString();
    const m = String(time.getUTCMonth() + 1).padStart(2, '0');
    if (ERA5_FILE_TEMPLATE) {
      const templated = ERA5_FILE_TEMPLATE.replace('%Y', y).replace('%m', m);
      if (templated && fs.existsSync(templated)) {
        return templated;
      }
    }

    if (ERA5_DEFAULT_PATH && fs.existsSync(ERA5_DEFAULT_PATH)) {
      return ERA5_DEFAULT_PATH;
    }

    throw new Error('ERA5 is not configured. Set ERA5_FILE_TEMPLATE or ERA5_FILE_PATH.');
  }

  private resolveScriptPath(): string | null {
    for (const candidate of ERA5_SCRIPT_CANDIDATES) {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }
}
