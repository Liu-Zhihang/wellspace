import axios, { AxiosRequestConfig } from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { HttpsProxyAgent } from 'https-proxy-agent';

const GFS_VERBOSE = process.env['LOG_VERBOSE_GFS'] === 'true';

const execFileAsync = promisify(execFile);

interface GfsCloudCoverResult {
  cloudCoverRatio: number; // 0-1
  rawValue: number; // percent 0-100
  forecastHour: number;
  runTimestamp: Date;
  queryUrl: string;
  runOffsetHours: number;
}

export class GfsCloudService {
  private static instance: GfsCloudService;

  private readonly baseUrl = 'https://nomads.ncep.noaa.gov/dods/gfs_0p25';
  private readonly gridResolution = 0.25; // degrees
  private readonly latMax = 90;
  private readonly lonMax = 360;
  private readonly timeStepHours = 3; // forecast hours per index (approx for GFS 0p25 beyond short range)
  private readonly fallbackOffsetsHours = [0, 6, 12, 18, 24, 30, 36]; // Try current run then walk backwards

  private constructor() {}

  public static getInstance(): GfsCloudService {
    if (!GfsCloudService.instance) {
      GfsCloudService.instance = new GfsCloudService();
    }
    return GfsCloudService.instance;
  }

  /**
   * Fetch total cloud cover ratio (0-1) from GFS OPeNDAP ASCII endpoint.
   *
   * @param lat latitude in degrees [-90, 90]
   * @param lon longitude in degrees [-180, 180]
   * @param targetTime desired analysis/forecast time (UTC)
  */
  public async getCloudCover(lat: number, lon: number, targetTime: Date): Promise<GfsCloudCoverResult> {
    this.validateCoordinates(lat, lon);

    let lastError: unknown = null;

    for (const offsetHours of this.fallbackOffsetsHours) {
      const queryTime = new Date(targetTime.getTime() - offsetHours * 60 * 60 * 1000);
      const { runTimestamp, cycleHourUtc, forecastHour, timeIndex } = this.resolveRunAndTimeIndex(queryTime);
      const { latIndex, lonIndex } = this.computeGridIndices(lat, lon);
      const datasetPath = this.buildDatasetPath(runTimestamp, cycleHourUtc);

      const query = `tcdcclm[${timeIndex}:1:${timeIndex}][${latIndex}:1:${latIndex}][${lonIndex}:1:${lonIndex}]`;
      const requestUrl = `${datasetPath}.ascii?${query}`;

      try {
        const response = await axios.get(requestUrl, this.buildAxiosConfig(requestUrl));

        const cloudPercent = this.parseAsciiResponse(response.data);
        const ratio = Math.min(Math.max(cloudPercent / 100, 0), 1);

        if (offsetHours > 0 && GFS_VERBOSE) {
          console.warn(`[gfs] 落回 ${offsetHours}h 前的运行 (cycle ${cycleHourUtc}Z)`);
        }

        return {
          cloudCoverRatio: ratio,
          rawValue: cloudPercent,
          forecastHour,
          runTimestamp,
          queryUrl: requestUrl,
          runOffsetHours: offsetHours
        };
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (GFS_VERBOSE) {
          console.warn(`[gfs] 获取失败 (cycle ${cycleHourUtc}Z, offset ${offsetHours}h): ${message}`);
        }

        // 在当前运行失败时尝试一次 curl 兜底
        if (message.includes('Client network socket') || message.includes('Request failed with status code 503')) {
          const curlPercent = await this.fetchViaCurl(requestUrl);
          if (curlPercent !== null) {
            const ratio = Math.min(Math.max(curlPercent / 100, 0), 1);

            if (GFS_VERBOSE) {
              console.warn('[gfs] 使用 curl fallback 成功');
            }
            return {
              cloudCoverRatio: ratio,
              rawValue: curlPercent,
              forecastHour,
              runTimestamp,
              queryUrl: requestUrl,
              runOffsetHours: offsetHours
            };
          }
        }

        continue;
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error('GFS cloud cover unavailable');
  }

  private validateCoordinates(lat: number, lon: number): void {
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      throw new Error('Invalid coordinates');
    }
    if (lat < -90 || lat > 90) {
      throw new Error('Latitude out of range');
    }
    if (lon < -180 || lon > 180) {
      throw new Error('Longitude out of range');
    }
  }

  /**
   * Determine dataset run (cycle) and forecast index based on target time.
   */
  private resolveRunAndTimeIndex(targetTime: Date): {
    runTimestamp: Date;
    cycleHourUtc: number;
    forecastHour: number;
    timeIndex: number;
  } {
    const utc = new Date(targetTime);
    const cycles = [0, 6, 12, 18];
    const hour = utc.getUTCHours();
    const cycleHourUtc = cycles.reduce((prev, curr) => (hour >= curr ? curr : prev), cycles[cycles.length - 1]);

    let runDate = new Date(Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate(), cycleHourUtc, 0, 0));

    if (hour < cycles[0]) {
      // Before 00Z of the day, roll back to previous day 18Z cycle
      runDate = new Date(Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate() - 1, 18, 0, 0));
    } else if (hour < cycleHourUtc) {
      // Should not happen due to reduce logic, but guard anyway
      runDate = new Date(Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate(), cycleHourUtc, 0, 0));
    }

    let forecastHour = Math.round((utc.getTime() - runDate.getTime()) / (60 * 60 * 1000));
    if (forecastHour < 0) {
      forecastHour += 24;
    }
    if (forecastHour > 384) {
      forecastHour = 384;
    }

    const timeIndex = Math.max(Math.round(forecastHour / this.timeStepHours), 0);

    return {
      runTimestamp: runDate,
      cycleHourUtc,
      forecastHour,
      timeIndex
    };
  }

  /**
   * Convert lat/lon into GFS 0.25° grid indices.
   * Latitudes are stored from 90N down to -90S.
   * Longitudes range 0-360 Eastward.
   */
  private computeGridIndices(lat: number, lon: number): { latIndex: number; lonIndex: number } {
    const latSteps = Math.round((this.latMax - (-this.latMax)) / this.gridResolution); // 720
    const lonSteps = Math.round(this.lonMax / this.gridResolution); // 1440

    const latClamped = Math.min(Math.max(lat, -this.latMax), this.latMax);
    const lonNormalized = ((lon % 360) + 360) % 360;

    const latIndex = Math.round((this.latMax - latClamped) / this.gridResolution);
    const lonIndex = Math.round(lonNormalized / this.gridResolution);

    if (latIndex < 0 || latIndex > latSteps) {
      throw new Error(`Latitude index out of range: ${latIndex}`);
    }
    if (lonIndex < 0 || lonIndex > lonSteps) {
      throw new Error(`Longitude index out of range: ${lonIndex}`);
    }

    return { latIndex, lonIndex };
  }

  private buildDatasetPath(runTimestamp: Date, cycleHourUtc: number): string {
    const y = runTimestamp.getUTCFullYear();
    const m = (runTimestamp.getUTCMonth() + 1).toString().padStart(2, '0');
    const d = runTimestamp.getUTCDate().toString().padStart(2, '0');
    const cycle = cycleHourUtc.toString().padStart(2, '0');

    return `${this.baseUrl}/gfs${y}${m}${d}/gfs_0p25_${cycle}z`;
  }

  private buildAxiosConfig(requestUrl: string): AxiosRequestConfig {
    const headers = {
      'Accept-Encoding': 'gzip, deflate',
    };

    const proxyUrl = this.resolveProxyUrl(new URL(requestUrl).hostname);
    if (!proxyUrl) {
      return {
        responseType: 'text',
        timeout: 15_000,
        headers,
      };
    }

    try {
      const agent = new HttpsProxyAgent(proxyUrl);
      return {
        responseType: 'text',
        timeout: 15_000,
        headers,
        httpsAgent: agent,
        httpAgent: agent,
        proxy: false,
      };
    } catch (error) {
      if (GFS_VERBOSE) {
        console.warn('[gfs] 创建代理 agent 失败:', error);
      }
      return {
        responseType: 'text',
        timeout: 15_000,
        headers,
      };
    }
  }

  private resolveProxyUrl(hostname: string): string | null {
    if (this.shouldBypassProxy(hostname)) {
      return null;
    }

    const envProxy =
      process.env['HTTPS_PROXY'] ||
      process.env['https_proxy'] ||
      process.env['HTTP_PROXY'] ||
      process.env['http_proxy'];

    if (!envProxy) {
      return null;
    }

    return envProxy;
  }

  private shouldBypassProxy(hostname: string): boolean {
    const noProxy =
      process.env['NO_PROXY'] ||
      process.env['no_proxy'];

    if (!noProxy) {
      return false;
    }

    const entries = noProxy
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean);

    if (entries.length === 0) {
      return false;
    }

    return entries.some(entry => {
      if (entry === '*') {
        return true;
      }

      if (hostname === entry) {
        return true;
      }

      if (entry.startsWith('.')) {
        return hostname.endsWith(entry);
      }

      if (hostname.endsWith('.' + entry)) {
        return true;
      }

      return false;
    });
  }

  /**
   * Parse the simple ASCII response returned by the NOMADS OPeNDAP endpoint.
   */
  private parseAsciiResponse(payload: string): number {
    const lines = payload
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const dataIndex = lines.findIndex((line) => line.startsWith('tcdcclm'));
    if (dataIndex === -1) {
      throw new Error('Unable to parse cloud cover from GFS response');
    }

    for (let i = dataIndex; i < lines.length; i++) {
      const line = lines[i];

      const eqMatch = line.match(/=\s*(-?\d+(\.\d+)?)/);
      if (eqMatch) {
        return parseFloat(eqMatch[1]);
      }

      const commaMatch = line.match(/,\s*(-?\d+(\.\d+)?)/);
      if (commaMatch) {
        return parseFloat(commaMatch[1]);
      }
    }

    throw new Error('GFS response missing value assignment');
  }

  private async fetchViaCurl(requestUrl: string): Promise<number | null> {
    try {
      const proxyUrl = this.resolveProxyUrl(new URL(requestUrl).hostname);
      const args = [
        '--globoff',
        '-sS',
        '--compressed',
        '--max-time',
        '20',
      ];

      if (proxyUrl) {
        args.push('-x', proxyUrl);
      }

      args.push(requestUrl);

      const { stdout, stderr } = await execFileAsync('curl', args, {
        env: process.env,
      });

      try {
        return this.parseAsciiResponse(stdout);
      } catch (parseError) {
        const preview = stdout.slice(0, 200).replace(/\s+/g, ' ');
        if (preview) {
          if (GFS_VERBOSE) {
            console.warn('[gfs] curl 返回无法解析:', preview);
          }
        }
        throw parseError;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (GFS_VERBOSE) {
        console.warn('[gfs] curl fallback 失败:', message);
      }
      return null;
    }
  }
}

export const gfsCloudService = GfsCloudService.getInstance();
