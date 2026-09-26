import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PronunciationError } from './errors.ts';
import type { Pronunciation } from './input.ts';
import { SYNTHESIS_IDENTITY, type Synthesizer } from './provider.ts';

export interface StoreOptions {
  cacheDir: string;
  dailyCharLimit?: number;
  monthlyCharLimit?: number;
  synthesizer: Synthesizer;
  maxCacheBytes?: number;
}

export interface StoreResult {
  audio: Buffer;
  hit: boolean;
  hash: string;
}

export class PronunciationStore {
  private cacheDir: string;
  private dailyCharLimit: number;
  private monthlyCharLimit: number;
  private maxCacheBytes: number;
  private synthesizer: Synthesizer;
  private db: DatabaseSync;
  private inflight = new Map<string, Promise<StoreResult>>();

  constructor(options: StoreOptions) {
    this.cacheDir = path.resolve(options.cacheDir);
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.dailyCharLimit = options.dailyCharLimit ?? 10000;
    this.monthlyCharLimit = options.monthlyCharLimit ?? 200000;
    this.maxCacheBytes = options.maxCacheBytes ?? 256 * 1024 * 1024;
    this.synthesizer = options.synthesizer;

    const dbPath = path.join(this.cacheDir, 'quota.db');
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage (
        period TEXT PRIMARY KEY,
        characters INTEGER NOT NULL
      );
    `);
  }

  public getCacheKey(ssml: string): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify({ ...SYNTHESIS_IDENTITY, ssml }))
      .digest('hex');
  }

  private getDatePeriods(): { day: string; month: string } {
    const now = new Date();
    // 使用 JST 时间 (Asia/Tokyo)
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = formatter.formatToParts(now);
    const y = parts.find((p) => p.type === 'year')!.value;
    const m = parts.find((p) => p.type === 'month')!.value;
    const d = parts.find((p) => p.type === 'day')!.value;
    return {
      day: `day:${y}-${m}-${d}`,
      month: `month:${y}-${m}`,
    };
  }

  private checkAndReserveQuota(characters: number): void {
    const { day, month } = this.getDatePeriods();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const getStmt = this.db.prepare('SELECT characters FROM usage WHERE period = ?');
      const dayRow = getStmt.get(day) as { characters: number } | undefined;
      const monthRow = getStmt.get(month) as { characters: number } | undefined;

      const currentDay = dayRow?.characters ?? 0;
      const currentMonth = monthRow?.characters ?? 0;

      if (currentDay + characters > this.dailyCharLimit) {
        throw new PronunciationError(
          429,
          `今日发音字符配额已耗尽（已用 ${currentDay}，上限 ${this.dailyCharLimit}），请明天再试。`,
        );
      }

      if (currentMonth + characters > this.monthlyCharLimit) {
        throw new PronunciationError(
          429,
          `当月发音字符配额已耗尽（已用 ${currentMonth}，上限 ${this.monthlyCharLimit}），请下月再试。`,
        );
      }

      const upsertStmt = this.db.prepare(`
        INSERT INTO usage (period, characters)
        VALUES (?, ?)
        ON CONFLICT(period) DO UPDATE SET characters = characters + excluded.characters
      `);
      upsertStmt.run(day, characters);
      upsertStmt.run(month, characters);

      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  public async getOrCreate(item: Pronunciation, signal: AbortSignal): Promise<StoreResult> {
    const hash = this.getCacheKey(item.ssml);
    const filePath = path.join(this.cacheDir, `${hash}.mp3`);

    // 1. 检查磁盘缓存
    if (fs.existsSync(filePath)) {
      try {
        const audio = fs.readFileSync(filePath);
        if (audio.length > 0) {
          return { audio, hit: true, hash };
        }
      } catch {
        // 读取失败则重新合成
      }
    }

    // 2. singleflight 去重
    const active = this.inflight.get(hash);
    if (active) {
      return active;
    }

    const task = (async (): Promise<StoreResult> => {
      // 检查并扣除配额
      this.checkAndReserveQuota(item.characters);

      // 上游合成
      const audio = await this.synthesizer(item.ssml, signal);
      if (!audio || audio.length === 0) {
        throw new PronunciationError(502, '语音合成服务返回了空音频');
      }

      // 原子写入文件
      const tmpPath = path.join(this.cacheDir, `${hash}.tmp.${crypto.randomBytes(6).toString('hex')}`);
      fs.writeFileSync(tmpPath, audio);
      fs.renameSync(tmpPath, filePath);

      return { audio, hit: false, hash };
    })();

    this.inflight.set(hash, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(hash);
    }
  }

  public close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}
