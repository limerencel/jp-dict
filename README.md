# 日本語文法解析

粘贴日语句子后，可查看分词、词性、动词活用、助词关系、振假名和离线词典释义。服务由 Node.js 提供前端页面和 API。

## 本地运行

需要 Node.js 22.13 或更新版本。

```bash
npm ci
npm run dev
```

打开 http://localhost:5173 。本地开发时前端在 5173 端口，API 在 8787 端口。

## 在 Linux 服务器部署

以下以仓库放在 `/home/<用户名>/jp-sentence`、使用域名和 Caddy 反向代理为例。先安装 Node.js 22.13+、Git 和 [Caddy](https://caddyserver.com/docs/install)，并将域名指向服务器；对外开放 80、443 端口，8787 端口保持仅本机可访问。

```bash
git clone https://github.com/limerencel/jp-dict.git jp-sentence
cd jp-sentence
npm ci
npm run build
cp .env.example .env
npm start
```

生产服务在本机的 8787 端口同时提供构建后的页面和 API。先在另一终端执行 `curl http://127.0.0.1:8787/api/config` 检查服务，再停止前台进程。默认监听 `127.0.0.1:8787`；`.env` 可修改 `PORT`、`JP_HOST`、`JP_DICT_DIR`、`JP_DATA_DIR`。

让服务随系统启动：创建 `/etc/systemd/system/jp-sentence.service`，将 `<用户名>` 换成实际 Linux 用户名。Node.js 与 npm 应安装在 systemd 能找到的 PATH 中。

```ini
[Unit]
Description=Japanese sentence analyzer
After=network.target

[Service]
Type=simple
User=<用户名>
WorkingDirectory=/home/<用户名>/jp-sentence
ExecStart=/usr/bin/env npm start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now jp-sentence
sudo systemctl status jp-sentence
```

将以下内容写入 `/etc/caddy/Caddyfile`，替换域名和密码哈希。先运行 `caddy hash-password` 生成哈希。项目的词典管理接口可修改数据，示例为整个站点加访问密码。

```caddyfile
example.com {
    basic_auth {
        owner <密码哈希>
    }
    reverse_proxy 127.0.0.1:8787
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

域名解析正确且 80、443 端口可达时，Caddy 会自动配置 HTTPS。部署后访问 `https://example.com`。

## 词典放哪里

服务器上的词典目录默认是仓库内的 `dictionaries/`。例如：

```text
jp-sentence/
├─ dictionaries/
│  ├─ JMdict.zip                 # Yomitan 词典，保持 zip 原样
│  └─ 明镜日汉双解辞典/
│     ├─ 明镜日汉双解辞典.mdx   # MDict 主文件
│     ├─ 明镜日汉双解辞典.css   # 可选
│     └─ 明镜日汉双解辞典.mdd   # 可选
└─ data/                         # 自动生成 SQLite 数据库和媒体文件
```

将文件上传到服务器的这个目录后，在网页「词典管理」点「重新扫描目录」，或在项目目录执行 `npm run dict:import`。服务启动时也会自动扫描。MDict 的 MDX、CSS、MDD 放在同一个子目录；每部词典建议单独建目录。详细格式见 [词典说明](dictionaries/README.md)。

`dictionaries/` 中的词典文件、`data/` 中的数据库和媒体文件、`.env` 都被 Git 忽略。它们需要在服务器上单独上传和备份；`git clone` 只取得程序代码。

## 更新

```bash
cd ~/jp-sentence
git pull
npm ci
npm run build
sudo systemctl restart jp-sentence
```

保留服务器上的 `dictionaries/`、`data/` 和 `.env`。查看运行日志：`journalctl -u jp-sentence -f`。

## 检查

```bash
npm test
npm run build
```
