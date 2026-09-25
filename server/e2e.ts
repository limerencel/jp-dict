/**
 * 端到端冒烟测试：拉起真实 HTTP 服务，依次打通 config / analyze / lookup / dictionaries。
 * 运行：npx tsx server/e2e.ts
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnalysisResult, LookupResponse } from '../shared/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, extra?: unknown): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`);
  }
}

async function main(): Promise<void> {
  // 用独立的临时数据目录，避免污染项目的 data/
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-e2e-'));
  // 刻意用原生 node 启动（不挂 tsx），这样 `npm start` 走的类型擦除路径才会被真实覆盖：
  // Node 只删类型、不生成代码，enum / namespace / 构造函数参数属性都会在这里炸出来。
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(ROOT, 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), JP_DATA_DIR: tmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d: Buffer) => (serverLog += d.toString()));
  child.stderr.on('data', (d: Buffer) => (serverLog += d.toString()));

  const stop = async () => {
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    // Windows 上 SQLite 句柄释放略有延迟，重试几次
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  };

  try {
    // 等待端口就绪
    let up = false;
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`${BASE}/api/config`);
        if (r.ok) {
          up = true;
          break;
        }
      } catch {
        /* 还没起来 */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!up) throw new Error(`服务未能启动。日志：\n${serverLog}`);

    console.log('\n[1] GET /api/config');
    const config = (await (await fetch(`${BASE}/api/config`)).json()) as Record<string, unknown>;
    check('返回 maxTextLength', typeof config.maxTextLength === 'number' && config.maxTextLength > 0);
    check('返回 dictDir', typeof config.dictDir === 'string');
    check('配置仅含本地分析字段', !('aiConfigured' in config) && !('translate' in config));

    console.log('\n[2] POST /api/analyze');
    const text = '先生に本を読ませられなかった。彼が作ってくれたお弁当はとてもおいしかったです。';
    const aRes = await fetch(`${BASE}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    check('HTTP 200', aRes.status === 200, aRes.status);
    const result = (await aRes.json()) as AnalysisResult;
    check('分出 2 句', result.sentences.length === 2, result.sentences.length);
    check('词表层拼接可还原原文', result.words.map((w) => w.surface).join('') === text);
    check('偏移与原文一致', result.words.every((w) => text.slice(w.start, w.end) === w.surface));

    const yomase = result.words.find((w) => w.surface === '読ませられなかった');
    check('合并出「読ませられなかった」', Boolean(yomase));
    check(
      '活用链还原到辞書形 読む',
      yomase?.inflection?.steps.at(-1) === '読む',
      yomase?.inflection?.steps,
    );
    const featureText = (yomase?.inflection?.features ?? []).join('·');
    check(
      '识别出使役・被动・否定・过去',
      ['使役', '被动', '否定', '过去'].every((f) => featureText.includes(f)),
      yomase?.inflection?.features,
    );

    const particles = result.words.filter((w) => w.isParticle);
    check('识别出助词', particles.length >= 4, particles.map((p) => p.surface));
    check('助词都有 romaji 与义项', particles.every((p) => Boolean(p.particle?.romaji && p.particle.sense)));
    check('は 的 romaji 是 wa', particles.find((p) => p.surface === 'は')?.particle?.romaji === 'wa');
    check('を 的 romaji 是 o', particles.find((p) => p.surface === 'を')?.particle?.romaji === 'o');
    const withArgs = particles.filter((p) => p.particle?.before || p.particle?.after);
    check('助词标注了前后成分', withArgs.length === particles.length, particles.length - withArgs.length);
    const ids = new Set(result.words.map((w) => w.id));
    check(
      'before/after 的 wordId 均有效',
      particles.every(
        (p) =>
          (!p.particle?.before || ids.has(p.particle.before.wordId)) &&
          (!p.particle?.after || ids.has(p.particle.after.wordId)),
      ),
    );
    check('生成了振假名', result.words.some((w) => w.furigana.some((f) => f.ruby)));

    console.log('\n  助词判定：');
    for (const p of particles) {
      const pi = p.particle!;
      console.log(
        `    ${p.surface}(${pi.romaji})  ${pi.categoryLabel} · ${pi.sense.label}` +
          `  前=${pi.before?.surface ?? '—'}(${pi.before?.role ?? '—'})` +
          `  后=${pi.after?.surface ?? '—'}(${pi.after?.role ?? '—'})`,
      );
    }
    console.log(`\n  活用链：${yomase?.inflection?.steps.join(' ← ')}`);
    console.log(`  形态名：${yomase?.inflection?.form}`);
    console.log(`  词素：${yomase?.subTokens.map((s) => `${s.surface}${s.role ? `(${s.role})` : ''}`).join(' / ')}`);

    console.log('\n[3] 长文本压测（约 4000 字）');
    const long = '日本語を勉強するのは楽しいと思います。雨が降っているので、今日は出かけないつもりだ。'.repeat(50);
    const t0 = Date.now();
    const lRes = await fetch(`${BASE}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: long }),
    });
    const lJson = (await lRes.json()) as AnalysisResult;
    const elapsed = Date.now() - t0;
    check(`${long.length} 字分析成功`, lRes.status === 200);
    check(`耗时 ${elapsed}ms < 5000ms`, elapsed < 5000);
    console.log(`    ${lJson.stats.sentences} 句 / ${lJson.stats.words} 词 / 服务端 ${lJson.stats.ms}ms`);

    console.log('\n[4] POST /api/lookup（无词典时应返回空结构而非报错）');
    const look = (await (
      await fetch(`${BASE}/api/lookup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ surface: '読ませられなかった', lemma: '読む', reading: 'よむ' }),
      })
    ).json()) as LookupResponse;
    check('query 为辞書形', look.query === '読む', look.query);
    check('entries 是数组', Array.isArray(look.entries));
    check('kanji 是数组', Array.isArray(look.kanji));

    console.log('\n[5] 词典管理接口');
    const dicts = (await (await fetch(`${BASE}/api/dictionaries`)).json()) as Record<string, unknown>;
    check('返回 dictionaries 数组', Array.isArray(dicts.dictionaries));
    const rescan = await fetch(`${BASE}/api/dictionaries/rescan`, { method: 'POST' });
    check('rescan 返回 200', rescan.status === 200);
    check('删除不存在的词典返回 404', (await fetch(`${BASE}/api/dictionaries/9999`, { method: 'DELETE' })).status === 404);
    check('未知媒体返回 404', (await fetch(`${BASE}/api/media/1/nope.png`)).status === 404);

    console.log('\n[6] 错误处理');
    check('空文本返回 400', (await fetch(`${BASE}/api/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"  "}' })).status === 400);
    check('聊天接口已移除', (await fetch(`${BASE}/api/chat`, { method: 'POST' })).status === 404);
    check('翻译接口已移除', (await fetch(`${BASE}/api/translate`, { method: 'POST' })).status === 404);
    check('未知接口返回 404', (await fetch(`${BASE}/api/nope`)).status === 404);
  } finally {
    await stop();
  }

  await realDictionaryChecks();

  console.log(`\n${'─'.repeat(60)}`);
  if (failures.length === 0) {
    console.log(`全部通过：${passed}/${passed}`);
  } else {
    console.log(`通过 ${passed}，失败 ${failures.length}：\n  - ${failures.join('\n  - ')}`);
    process.exitCode = 1;
  }
}

/**
 * 项目里已经导入过真词典时，额外验证查词结果的相关度排序。
 * 没有词典就跳过——CI 与干净检出的仓库不应该因此失败。
 */
async function realDictionaryChecks(): Promise<void> {
  const dbPath = path.join(ROOT, 'data', 'dictionaries.db');
  if (!fs.existsSync(dbPath)) {
    console.log('\n[8] 真实词典排序（未导入词典，跳过）');
    return;
  }

  console.log('\n[8] 真实词典的查词相关度排序');
  const port = PORT + 1;
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(ROOT, 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });

  try {
    let up = false;
    for (let i = 0; i < 150; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/config`)).ok) {
          up = true;
          break;
        }
      } catch {
        /* 还没起来 */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!up) {
      check('服务启动', false);
      return;
    }

    const lookup = async (body: Record<string, string>): Promise<LookupResponse> => {
      const res = await fetch(`http://127.0.0.1:${port}/api/lookup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return (await res.json()) as LookupResponse;
    };

    const cfg = (await (await fetch(`http://127.0.0.1:${port}/api/config`)).json()) as { dictReady?: boolean };
    if (!cfg.dictReady) {
      console.log('  （词典库为空，跳过）');
      return;
    }

    // 查询词本身就是词条时，它必须排第一
    const gakko = await lookup({ surface: '学校', lemma: '学校', reading: 'がっこう' });
    if (gakko.entries.length > 0) {
      check('精确匹配的词条排第一', gakko.entries[0].term === '学校', gakko.entries.slice(0, 3).map((e) => e.term));
    }

    // 同读多条时，释义丰富的常用词应该排在生僻词前面
    const ii = await lookup({ surface: 'いい', lemma: 'いい', reading: 'いい' });
    if (ii.entries.length > 1) {
      const order = ii.entries.map((e) => e.term);
      const best = ii.entries[0];
      const longest = ii.entries.reduce((a, b) =>
        JSON.stringify(b.glossary).length > JSON.stringify(a.glossary).length ? b : a,
      );
      check(`同读词按释义丰富度排序（首条 ${best.term}）`, best.term === longest.term, order);
      console.log(`    いい → ${order.join(' / ')}`);
    }
  } finally {
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  }
}

void main();
