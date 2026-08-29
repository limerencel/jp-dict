/**
 * 翻译层自测：验证服务商注册、自动选择、缓存与批量切分。
 * 默认只跑离线逻辑；加 --live 会真的打网络请求（需要能访问外网）。
 */
import { clearTranslationCache, listProviders, listTargets, translate } from './index.ts';
import { PROVIDERS, resolveProvider } from './providers.ts';

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

const SENTENCES = [
  '先生に本を読ませられなかった。',
  '彼が作ってくれたお弁当はとてもおいしかったです。',
  '雨が降っているので、今日は出かけないつもりだ。',
];

async function main(): Promise<void> {
  console.log('\n[1] 服务商注册表');
  const providers = listProviders();
  check('注册了 6 个服务商', providers.length === 6, providers.map((p) => p.id));
  check('google 与 mymemory 无需密钥且始终可用', providers.filter((p) => !p.needsKey && p.available).length >= 2);
  check('每个服务商都有中文提示', providers.every((p) => p.hint.length > 0));
  check('目标语言含简体中文', listTargets().some((t) => t.code === 'zh-CN'));

  console.log('\n[2] 自动选择与显式指定');
  check('auto 能解析出一个可用服务商', resolveProvider('auto').available());
  check('显式指定 google 生效', resolveProvider('google').id === 'google');
  check('指定不可用的服务商时回退', resolveProvider('deepl').id !== 'deepl' || Boolean(process.env.DEEPL_API_KEY));
  check('批量能力声明合理', PROVIDERS.every((p) => p.batchSize >= 0));

  console.log('\n[3] 空文本与缓存（不走网络）');
  const empty = await translate(['', '   '], { provider: 'google' });
  check('全空文本直接返回，不请求网络', empty.translations.every((t) => t === '') && empty.cached.every(Boolean));

  if (!process.argv.includes('--live')) {
    console.log('\n  （跳过联网测试，加 --live 参数可实际调用翻译服务）');
  } else {
    console.log('\n[4] 联网翻译');
    clearTranslationCache();
    const t0 = Date.now();
    const first = await translate(SENTENCES, { provider: 'google' });
    console.log(`    服务商：${first.providerLabel}  耗时 ${Date.now() - t0}ms${first.notice ? `  ${first.notice}` : ''}`);
    for (let i = 0; i < SENTENCES.length; i++) {
      console.log(`    ${SENTENCES[i]}\n      → ${first.translations[i]}`);
    }
    check('返回条数与输入一致', first.translations.length === SENTENCES.length);
    check('每条都有译文', first.translations.every((t) => t.trim().length > 0));
    check('首次全部未命中缓存', first.cached.every((c) => !c));

    const t1 = Date.now();
    const second = await translate(SENTENCES, { provider: 'google' });
    const elapsed = Date.now() - t1;
    check('二次请求全部命中缓存', second.cached.every(Boolean));
    check(`缓存命中很快（${elapsed}ms < 50ms）`, elapsed < 50);
    check('缓存内容与首次一致', second.translations.join('|') === first.translations.join('|'));
  }

  console.log(`\n${'─'.repeat(60)}`);
  if (failures.length === 0) console.log(`全部通过：${passed}/${passed}`);
  else {
    console.log(`通过 ${passed}，失败 ${failures.length}：\n  - ${failures.join('\n  - ')}`);
    process.exitCode = 1;
  }
}

void main();
