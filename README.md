# jp-sentence · 日语句子语法解析

粘贴日语文本 → 一键解析。词单位切分、助词标注、活用还原、振假名、离线词典释义、整句翻译、AI 追问。

界面走**复古衬线**路线：思源宋体、方正版式、日间生成り紙暖黄 / 夜间墨色行灯，输入区在正中央，结果在下方展开，点词从右侧滑出详情栏。

词典能力对标 [Yomitan](https://github.com/yomidevs/yomitan)：可直接导入 Yomitan 格式的词典 zip，也原生支持 MDict `.mdx`（含配套 CSS/MDD），但做成了**整句解析**而非划词弹窗。

---

## 快速开始

```bash
npm install
cp .env.example .env      # 可选：填 AI_API_KEY 才能用 AI 问答
npm run dev               # 后端 :8787 + 前端 :5173
```

打开 http://localhost:5173 。

不配 AI、不导词典也能直接用——分词、词性、活用、助词分析、振假名全部离线可用。

生产模式：

```bash
npm run build && npm start   # 单进程托管前后端，访问 :8787
```

## 导入词典

最简单的用法是把词典文件放进项目的 `dictionaries/`：

```text
dictionaries/
├─ JMdict.zip                         # Yomitan 词典
└─ 明镜日汉双解辞典/
   ├─ 明镜日汉双解辞典.mdx           # MDict 主文件
   ├─ mjrhsjcd.css                    # 可选：词典排版
   └─ 明镜日汉双解辞典.mdd           # 可选：图片、音频等资源
```

建议每部 MDict 词典单独放一个子目录，并让 `.mdx`、`.css`、`.mdd` 位于同一目录。然后任选一种方式导入：

- 网页打开「词典管理」，点击「重新扫描目录」
- 重启 `npm run dev` 或 `npm start`
- 运行 `npm run dict:import`

Yomitan zip 和“内部包含 MDX 的 zip”都可以直接放入，**不需要解压**。也可从目录外直接导入：

```bash
npm run dict:import -- "D:\\DOC\\JP_Dict\\某词典\\某词典.mdx"
```

Yomitan 支持 term / term_meta（声调 + 词频）/ kanji / tag bank、v1/v3、structured-content 与内嵌图片。MDict 支持 v1.2/v2.0、UTF-8/UTF-16、zlib/LZO、`Encrypted=2` 标准混淆、`@@@LINK` 别名、配套 CSS/MDD；使用者密码加密的 `Encrypted=1` 暂不支持。完整说明见 [`dictionaries/README.md`](dictionaries/README.md)。

## 解析能力

**词单位合并** —— 形态素分析器会把 `読ませられなかった` 切成 5 片。本项目把它们合并回一个语义完整的词单位，用**下划线**标出边界（相邻词单位之间留出可见间隙），内部再用虚线刻度标出词素接缝。这样"哪几个假名连在一起是一个词"一眼可辨。

```
読ませられなかった   ← 一个词单位
読ま │ せ │ られ │ なかっ │ た
     使役  被动   否定   过去
```

**活用还原** —— 逐级还原到辞書形，并给出中文形态名：

```
読ませられなかった ← 読ませられない ← 読ませられる ← 読ませる ← 読む
形态：使役被动·过去否定
```

**助词分析** —— 60+ 助词的知识库 + 16 组复合助词识别。每个助词标出罗马字、分类、**当前语境下的义项**、判定依据，以及它连接的前后成分：

```
に(ni)  格助词 · 动作主体   前=先生(施事)   后=読ませられなかった(使役被动谓语)
を(o)   格助词 · 动作对象   前=本           后=読ませられなかった(他动词谓语)
は(wa)  系助词 · 主题       前=お弁当       后=おいしかったです(对主题的陈述)
```

义项判定是真做语境推断的，例如 `に` 会区分时点 / 归着点 / 施事 / 变化结果 / 频率，`で` 会区分场所 / 手段 / 原因 / 范围，`が` 会区分主语 / 对象语 / 逆接接续。开启「助词关系图」还能在句子下方看到连接弧线。

**词典释义排版** —— 研究社这类词典的释义是**一整条纯文本**，靠 `►` `・` `〔〕` `┏…[…]` `｜` `[⇒…]` 这套自有约定组织。项目内置解析器把它还原成真正的辞典排版：词头行、带编号的义项、日英分列的例句、可点击的参见、可替换记号。例句多的词默认折叠（`いい` 有 159 条），首屏 DOM 从 25.7 KB 降到 7.2 KB。全库 24.8 万条实测**零崩溃、零内容丢失**。

**翻译** —— 工具条上开「译文」，逐句译文显示在解析结果下方。支持 DeepL / Microsoft / AI / Google 免费端点 / LibreTranslate / MyMemory，自动挑可用的，失败自动降级。Google 免费端点无需任何配置。

**交互** —— 悬停出简要释义小面板；单击打开右侧详情 Panel（声调曲线、形态分析、词素拆解、助词详解、按词典分组的完整释义、汉字卡片，带前进/后退历史）；开「助词关系图」可在句子下方看到连接弧线；AI 面板自动携带当前词 / 当前句 / 全文作为上下文，流式回答，可随时停止。

## 项目结构

```
shared/          前后端共享：types.ts（数据契约）、kana.ts、glossary.ts
server/
  index.ts       HTTP 服务与路由（纯 node:http）
  config.ts      路径与环境变量
  analyze/       分词 → 词单位合并 → 活用还原 → 助词判定
  dict/          Yomitan zip / MDict mdx 解析 → SQLite → 查询层
  translate/     多服务商翻译 + 缓存 + 自动降级
  ai/            OpenAI 兼容的流式对话
web/src/
  components/    界面组件
  lib/           glossFormat.ts（纯文本释义解析器）
  styles/        dictionary.css（词典与详情面板排版）
  styles.css     设计令牌与外壳布局
dictionaries/    ← 词典 zip / mdx 与配套 CSS、MDD 放这里
data/            SQLite 库与解包出的词典图片（自动生成）
```

技术选型上刻意保持了轻依赖：分词用 `@sglkc/kuromoji`（IPADIC，内置词典），存储用 Node 22.13+ 内置的 `node:sqlite`（无原生模块、无需编译），解压是自研的最小 ZIP 读取器（中央目录随机访问，支持 zip64），字体用 `@fontsource-variable` 的思源宋体（124 个 unicode-range 子集，**完全离线**，浏览器只下载用到的子集）。服务端直接由 Node 运行 TypeScript，没有构建步骤。

> 服务端由 Node 原生类型擦除运行，**只删类型、不生成代码**。所以 `server/` 里不能用 `enum`、`namespace` 和构造函数参数属性——`npm run test:e2e` 会用原生 node 启动服务来兜住这条约束。

## 配置

`.env`（参考 `.env.example`）：

| 变量 | 说明 |
| --- | --- |
| `PORT` | 后端端口，默认 8787 |
| `JP_MAX_TEXT` | 单次分析字符上限，默认 20000，超出会截断并提示 |
| `JP_DICT_DIR` / `JP_DATA_DIR` | 词典与数据目录，默认为项目下的 `dictionaries/`、`data/` |
| `AI_BASE_URL` | OpenAI 兼容接口地址 |
| `AI_API_KEY` | 留空则 AI 面板显示配置引导，其余功能不受影响 |
| `AI_MODEL` | 模型名 |
| `TRANSLATE_PROVIDER` | `auto`（默认）或 `deepl`/`microsoft`/`ai`/`google`/`libre`/`mymemory` |
| `TRANSLATE_TARGET` | 默认目标语言，默认 `zh-CN` |
| `DEEPL_API_KEY` 等 | 各翻译服务商的密钥，全部可留空 |

AI 走标准的 `/chat/completions` 流式接口，OpenAI、DeepSeek、智谱、Moonshot、OpenRouter、本地 Ollama 都可以，只需换 `AI_BASE_URL`。

翻译默认 `auto`：按 `deepl > microsoft > ai > google > libre > mymemory` 取第一个可用的，主服务商失败时自动降级到无需密钥的备用。**什么都不配也能用**（走 Google 免费端点）。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/config` | 运行时配置 |
| `POST` | `/api/analyze` | `{text}` → `AnalysisResult` |
| `POST` | `/api/lookup` | `{surface, lemma?, reading?}` → 词条 / 汉字 / 声调 / 词频 |
| `GET` | `/api/dictionaries` | 词典列表 |
| `POST` | `/api/dictionaries/rescan` | 重新扫描目录 |
| `PATCH` `DELETE` | `/api/dictionaries/:id` | 启停 / 优先级 / 删除 |
| `GET` | `/api/media/:dictId/*` | 词典内嵌图片 |
| `POST` | `/api/translate` | `{texts[]}` → 批量译文（带缓存与降级） |
| `POST` | `/api/chat` | SSE 流式对话 |

所有响应结构定义在 [`shared/types.ts`](shared/types.ts)。

## 测试

```bash
npm test               # 全部：类型检查 + 词典 + 分析 + 释义解析 + 翻译 + 端到端
npm run test:dict      # Yomitan 导入与查询（程序化生成假词典）
npm run test:analyze   # 分词 / 活用 / 助词判定
npm run test:gloss     # 研究社纯文本释义解析器
npm run test:translate # 翻译层（加 --live 会真的联网）
npm run test:e2e       # 用原生 node 拉起真实服务跑通全部接口
```

## 已知局限

- 形态素分析基于 IPADIC。`れる/られる` 的**可能 / 被动 / 尊敬**只在紧跟使役时能确定，其余标为「被动/可能/尊他」。
- 助词义项判定依赖内置的场所 / 工具 / 时间 / 移动动词等词表，表外词会落到兜底义项，`reason` 字段会写明「缺少更强线索」。
- 复合名词（如 `日本語学校`）只在词典能查到整串时才合并，否则保持拆分——宁可保守。
- 数量词读音只修正了高频不规则组合（`七時→しちじ`、`一日→ついたち` 等）。
- 熟字训等无法对齐的振假名会降级为整词一个 ruby。
- 释义解析器只在研究社词典上做过全量验证。其他纯文本词典的记号约定可能不同，识别不出来时会降级为保留换行的段落（不会丢内容）。
- 词条相关度排序在词典 `score` 全为 0 时靠「释义体量」兜底，这只是常用度的代理指标，个别词可能排得不理想。
- 翻译的 Google 免费端点是公开的非官方接口，国内网络可能不通；配上 DeepL 或 AI 更稳。
