# 部署服务器保存版

此版本将对话、附件、连接配置、勾选保存的 API 密钥和预设保存在运行 Node 服务的服务器磁盘。访问同一服务的浏览器使用同一个工作空间；本次未加入登录或账号隔离。已保存的密钥按连接 ID 分开，以明文写入服务器私有数据文件，接口仅返回是否已保存；浏览器临时输入的密钥仅留在当前页面内存中。

**推荐直接运行 Git 仓库源码**：`node scripts/dev.mjs`。后续 `git pull --ff-only origin main` 后重启 Node 服务即可，不必构建或上传文件包。运行数据和本机配置独立于 Git 源码。下方构建方式为可选的独立目录部署。

仅上传 HTML/JS/CSS 到 Nginx 静态目录不能保存服务器文件。需要同时启动下方 Node 服务，并将同一域名的 `/api/` 请求转发给它。Node.js 20.3 或更高版本即可，无需安装 npm 依赖。

## 从 Git 仓库部署

以下示例适用于使用 systemd 的 Debian/Ubuntu。`/opt/lumen`、`/var/lib/lumen`、服务名 `lumen` 和系统用户 `www-data` 都是示例值，可以按自己的环境修改。Node.js 需要能由 `/usr/bin/node` 运行；如果安装位置不同，修改服务文件中的 `ExecStart`。

```sh
sudo git clone https://github.com/ruitong23/WebChat-withAnyApi.git /opt/lumen
cd /opt/lumen
sudo cp deploy/lumen.service /etc/systemd/system/lumen.service
sudo systemctl daemon-reload
sudo systemctl enable --now lumen
sudo systemctl status lumen
```

服务直接运行仓库中的 `scripts/dev.mjs`，不需要构建或安装 npm 依赖。示例监听 `127.0.0.1:4177`，由 Nginx 提供外部访问；systemd 会创建 `/var/lib/lumen` 并赋予服务用户写权限。已有的服务也可以使用，只需配置正确的启动命令和持久数据目录。

## 本机配置

服务器上的配置放在 Git 仓库之外。示例服务可选读取 `/etc/lumen/lumen.env`，不存在这个文件时使用服务文件中的默认值。文件格式是每行 `变量=值`，例如：

```ini
PORT=4177
LUMEN_HOST=127.0.0.1
LUMEN_DATA_DIR=/var/lib/lumen
LUMEN_PUBLIC_ORIGIN=https://chat.example.com
LUMEN_ALLOW_PRIVATE=false
```

将域名改成自己的实际域名；本机或局域网使用时可省略 `LUMEN_PUBLIC_ORIGIN`。配置目录和文件需要由管理员自行创建，修改配置后重启自己的服务。

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `PORT` | Node 监听端口 | `4177` |
| `LUMEN_HOST` | 监听地址；仅本机用 `127.0.0.1`，局域网用 `0.0.0.0` | `0.0.0.0`；示例服务覆盖为 `127.0.0.1` |
| `LUMEN_DATA_DIR` | 持久数据目录 | 应用目录下的 `data/`；示例服务覆盖为 `/var/lib/lumen` |
| `LUMEN_WORKSPACE_FILE` | 单独指定 JSON 工作空间索引；对话和项目保存在它的同级目录 | 数据目录中的 `workspace.json` |
| `LUMEN_CONFIG_FILE` | 单独指定模型配置 JSON | 数据目录中的 `model-configs.json` |
| `LUMEN_PUBLIC_ORIGIN` | 浏览器访问的来源，包含协议、域名和可选端口，不带路径 | 根据请求推断 |
| `LUMEN_ALLOW_PRIVATE` | 设为 `false` 禁止向 localhost/内网地址转发；连接本机或内网模型时设为 `true` | 允许内网 |

数据目录必须允许运行 Node 的系统用户写入。不要把它放进公开的静态文件目录。`npm start` 不会自动读取 `.env`；直接运行时请通过终端环境或进程管理器设置这些变量。

## 配置 Nginx

`deploy/nginx.conf` 是通用反向代理示例：将 `example.com` 改成自己的域名，并让代理端口与 `PORT` 一致。整个网站都转发给 Node，由 Node 提供网页和 API；不需要设置静态 `root`。关闭代理缓冲以保持流式输出。

将配置加入自己的 Nginx 站点后检查并重载：

```sh
sudo nginx -t
sudo systemctl reload nginx
```

前端和 API 使用同一个域名，示例按域名根路径部署。可以沿用已有 HTTPS 和登录设置，也可以自行在 Nginx 添加。示例文件本身只提供 HTTP 转发。

## 更新与备份

使用与首次安装相同的代码目录及服务名，例如：

```sh
cd /opt/lumen
sudo git pull --ff-only origin main
sudo systemctl restart lumen
```

拉取成功后再重启，新的后端才会生效。`git pull` 本身不会自动重启进程；自动重启由各安装环境的进程管理器或本机 Git 钩子配置。仓库不包含特定服务器的钩子、登录配置或迁移脚本。

更新前等待生成和保存结束。保持 Git 工作区源码干净，本机配置留在 `/etc/` 或进程管理器中，运行数据放在持久目录。更新代码时保留数据目录；备份时先停止服务，再完整备份数据目录，完成后重新启动。

## 可选：独立目录部署

如果需要脱离 Git 仓库运行，可以手动执行 `npm run build` 和 `npm run validate`，将生成的 `dist/` 内容复制到自己的应用目录。其启动命令为 `node server/index.mjs`，生成的 `dist/deploy/lumen.service` 也使用这个入口。Nginx 仍可将整个网站转发到 Node。

这种方式的更新需要替换应用代码后重启服务；持久数据目录保持不变。直接运行 Git 仓库的部署不需要这个步骤。

## 数据结构与保存行为

每个项目和每条对话分别保存，目录结构为：

```text
data/
  workspace.json                           全局索引、连接、保存的密钥和预设
  model-configs.json                       模型参数
  conversations/
    <对话ID>.json                          未分组对话的消息和附件
  projects/
    <项目ID>/
      project.json                         项目名称、创建时间、相对路径
      conversations/
        <对话ID>.json                      该项目的对话消息和附件
```

项目和对话使用稳定 ID 命名；旧数据中不是标准 UUID 的 ID 会转换为安全的文件名。项目名称改动不会改变其目录，项目路径单独保存在 project.json 的 path 字段中，并可在界面的“项目设置”中查看。

- 侧栏“新建项目”可移入当前对话、移入当前分组的全部对话，或创建空项目；顶部文件夹按钮用于移动当前对话。移动会写入新目录并清理原位置，正文和附件保留。删除项目会把对话移到未分组。
- 旧版单文件服务器数据在首次访问时自动拆分，保留 workspace.json.v1.bak；项目和对话 JSON 单独保存后，后续只重写发生变化的文件。多文件保存中断时，会依据 workspace.json.pending.json 恢复完成，完成后自动清除恢复记录。
- 备份和恢复请保留整个数据目录，包含索引、projects/、conversations/ 和模型配置；只拷贝 workspace.json 不再包含对话正文。
- `model-configs.json`：按 API 地址和模型共享的参数。
- 浏览器中旧版数据不会自动覆盖服务器。进入“设置 → 数据 → 导入此浏览器的旧数据”可迁移当前浏览器原有记录；也支持导入旧版导出的对话 JSON。
- 左下角显示保存状态。保存失败时可点击重试；同一条对话或连接发生不同设备并发修改时自动保留冲突副本，已在另一设备删除的对话再次编辑会保存恢复副本。过期删除不会删除较新的内容。项目或预设冲突会提示保留未保存修改并导出后刷新。
- 页面空闲时每 3 秒检查版本变化，只读取目录和当前对话；没有变化返回 304，不拉取所有正文。生成、编辑连接、拖动、弹窗和未保存时暂停接收远端状态，保留当前草稿和视图位置。
- 请求模型前先确认问题已保存，生成结束再次确认保存；离开页面时有未保存数据会触发浏览器确认提示。
- 流式输出期间也会定期保存已接收内容。离开页面前等待“已保存到服务器”；网络中断或关闭浏览器后的后续模型输出不会继续生成。
- 单个工作空间保存请求上限为 128 MiB，单次模型转发请求仍为 24 MiB。运行一个 Node 实例，不要用多进程同时写同一个数据目录。

验证方法：电脑 A 创建对话并等待保存，再用另一浏览器或手机访问同一域名；应看到同样的记录和已保存连接。重启 Node 服务后再次验证。

## 侧栏按需加载

- 初始只读取项目名称和最多 15 条标题，展开的各项目与未分组共同使用额度，当前展开的目录优先；项目名称不计入 15 条。
- 列表底部“加载更多”每次增加 15 条，滚动不会自动请求更多。展开目录、已加载数量、搜索、侧栏滚动位置和当前对话都写入 workspace.json 的视图设置，刷新后自动恢复。
- 正文通过单条对话接口读取，普通保存采用增量接口，只提交变更内容；未加载的对话不会被当作删除。只在批量移动、导出全部等明确操作时访问完整范围。首次升级旧目录会一次性补齐索引中的标题和校验值，后续无需读取全部正文来展示侧栏。
- 桌面可拖动侧栏对话或右侧对话标题进入项目，拖到“未分组”可移出。拖动会更新所属项目并移动服务器中的 JSON 文件；手机继续支持顶部的移动按钮。
- 前后端需要使用同一版本；更新后重启 Node 服务并刷新网页，保留原数据目录。
