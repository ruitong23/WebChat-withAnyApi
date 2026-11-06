# 从旧服务器定制版统一到 main

此版本已吸收旧服务器版的连接密钥管理、多设备同步、冲突副本和未保存保护，并保留项目目录、每条对话独立 JSON、15 条按需加载和拖动归档。应用直接运行仓库源码，不需要打包，也不需要在服务器上维护另一份应用修改。

## 保留现有服务配置

已经运行 `node /opt/WebChat-withAnyApi/scripts/dev.mjs` 的 systemd 服务可以继续使用。保留原来的系统用户、端口、HTTPS、Nginx 登录、代理配置和以下环境变量：

```ini
LUMEN_HOST=127.0.0.1
PORT=4177
LUMEN_PUBLIC_ORIGIN=https://你的域名
LUMEN_ALLOW_PRIVATE=false
LUMEN_CONFIG_FILE=/var/lib/lumen-webchat/model-configs.json
LUMEN_WORKSPACE_FILE=/var/lib/lumen-webchat/workspace.sqlite
```

`LUMEN_ALLOW_PRIVATE=false` 禁止向 localhost/内网地址转发；连接内网模型的安装可以设为 `true`。未设置时允许内网，以兼容本机模型。`LUMEN_PUBLIC_ORIGIN` 是浏览器访问的完整来源（协议、域名、可选端口，不带尾部路径），用于同源检查。

Nginx 已经把整个网站代理到 Node 的，无需改成静态目录，也无需替换现有 systemd 文件。服务用户需要对原数据目录有写权限，源码目录只需可读。数据继续保存在 `/var/lib/`，兼容 `ProtectSystem=strict`。

## 首次接入：只处理一次服务器上的源码修改

旧服务器存在没有提交的定制源码，直接 `git pull` 会因文件冲突而失败。先备份、暂存这些修改，再拉取 main。下面以服务 `lumen-webchat` 和上述路径为例，执行前核对实际路径及服务名；这是一次性迁移步骤。

先在界面等待保存完成并停止生成。然后以有权限的用户执行：

```sh
set -e
umask 077
cd /opt/WebChat-withAnyApi
git status --short
sudo systemctl stop lumen-webchat

backup_dir="/root/lumen-backup-$(date +%Y%m%d-%H%M%S)"
sudo mkdir -p "$backup_dir"
sudo cp -a /var/lib/lumen-webchat "$backup_dir/data"
sudo tar --exclude=.git --exclude=node_modules --exclude=data --exclude=work --exclude=dist \
  -czf "$backup_dir/source.tar.gz" -C /opt/WebChat-withAnyApi .

git stash push --include-untracked -m "Server custom source before unified main"
git pull --ff-only origin main
sudo systemctl start lumen-webchat
sudo systemctl status lumen-webchat --no-pager
```

停服后复制整个数据目录，包含 SQLite 的 `-wal`、`-shm` 文件，避免在线只复制主数据库而遗漏已提交内容。源码备份和 stash 只留在服务器，不要上传其中的本机配置或密钥。旧定制源码已经合并到 main，升级后不要再 `git stash pop` 把旧实现覆盖回来。

## 自动迁移如何工作

- 保留 `LUMEN_WORKSPACE_FILE` 原来的 `.sqlite`、`.sqlite3` 或 `.db` 路径即可。首次启动读取旧数据库和已提交的 WAL，在同一目录生成 `<原数据库文件名>.json` 索引，例如 `workspace.sqlite.json`，以及 `conversations/` 和 `projects/`。不需要手动导出导入。
- 原 SQLite 数据库保留。JSON 索引成功生成后，后续启动只使用 JSON 文件，不会重复导入 SQLite 或覆盖新对话。迁移写入采用恢复日志，中断后会继续完成；数据库损坏或无法读取时启动失败，不会用空工作空间替代旧数据。
- 迁移旧 SQLite 需要 Node.js **22.13 或更高版本**（原部署的 Node 22.22 可以使用），无需安装 SQLite/npm 依赖。纯 JSON 安装仍支持 Node 20.3+。
- 同一个 API 地址的多组连接按连接 ID 分开保存密钥，保留各自名称、密钥和管理地址。网页只得到“已保存密钥”的状态，密钥留空不会清掉已有值；取消保存或使用“清除密钥”可移除。使用已保存密钥的请求由服务器转发。
- `model-configs.json` 沿用原路径和格式。旧服务器浏览器遗留的参数预设可在“设置 → 数据 → 导入此浏览器的旧数据”导入，即使 `lumen.v1` 已经移除也支持。
- 同时刷新所有已打开的旧网页标签，避免旧前端继续调用旧接口。检查原对话、两组连接、流式回复和项目移动，再确认上线结果。

后续备份仍需保留整个数据目录，不能只备份索引或旧 SQLite。升级后产生的新消息只写 JSON，旧数据库不会继续更新。

## 以后更新

从此保持服务器工作区源码干净，本机配置放在 systemd/环境变量，运行数据放在原 `/var/lib/` 目录。以后执行：

```sh
cd /opt/WebChat-withAnyApi
git pull --ff-only origin main && sudo systemctl restart lumen-webchat
```

不需要重新打包或改 Nginx。Node 进程重启才会加载更新后的后端；更新前等待保存和生成结束。浏览器刷新会读取同一次更新的前后端代码。

## 回退首次升级

若验证失败，停止服务后用首次备份恢复**整套旧源码和旧数据**，保持文件属主和权限，再启动旧服务。不要把旧 SQLite 的内容导入已经使用中的新 JSON，也不要仅删除 JSON 索引触发重复迁移。升级后已经新增的对话需要先导出或备份整个新数据目录，再决定如何合并。
