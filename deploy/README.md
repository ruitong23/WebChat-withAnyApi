# 部署服务器保存版

此版本将对话、附件、连接配置、勾选保存的 API 密钥和预设保存在运行 Node 服务的服务器磁盘。访问同一服务的浏览器使用同一个工作空间；本次未加入登录或账号隔离。已保存的密钥按连接 ID 分开，以明文写入服务器私有数据文件，接口仅返回是否已保存；浏览器临时输入的密钥仅留在当前页面内存中。

**推荐直接运行 Git 仓库源码**：`node scripts/dev.mjs`。后续 `git pull --ff-only origin main` 后重启 Node 服务即可，不必构建或上传文件包。已有服务器定制版、SQLite 数据和原 Nginx/systemd 配置的兼容步骤见 [旧服务器升级指南](UPGRADE.md)。下方构建方式为可选的独立目录部署。

仅上传 HTML/JS/CSS 到 Nginx 静态目录不能保存服务器文件。需要同时启动下方 Node 服务，并将同一域名的 `/api/` 请求转发给它。Node.js 20.3 或更高版本即可，无需安装 npm 依赖。

## 构建并上传

在源码目录运行：

```sh
npm run build
npm run validate
```

将 `dist/` 的全部内容上传到服务器，例如 `/opt/lumen/`。目录结构为：

```text
/opt/lumen/
  public/           Nginx 对外提供的网页文件
  server/           Node 服务与磁盘存储代码
  deploy/           Nginx 与 systemd 配置示例
  package.json
```

## 启动服务

首次可以在服务器终端验证：

```sh
cd /opt/lumen
LUMEN_HOST=127.0.0.1 LUMEN_DATA_DIR=/var/lib/lumen node server/index.mjs
```

先创建 `/var/lib/lumen`，并让运行 Node 的系统用户拥有写权限。也可设置 `LUMEN_DATA_DIR=/你已有的网站目录/私有数据目录`，但不要放入 Nginx 的 `public/` 根目录。默认不设置时保存在部署目录的 `data/`。

长期运行时，将 `deploy/lumen.service` 中的路径、Node 可执行文件位置、系统用户改为实际值，再安装服务：

```sh
sudo cp deploy/lumen.service /etc/systemd/system/lumen.service
sudo systemctl daemon-reload
sudo systemctl enable --now lumen
sudo systemctl status lumen
```

示例使用 Debian/Ubuntu 常见的 `www-data` 用户。systemd 的 `StateDirectory=lumen` 会创建数据目录并赋予服务用户权限。

## 配置 Nginx

使用 `deploy/nginx.conf`，修改域名和 `root` 后加入现有 Nginx 配置。如果已有网站，只需将其中的 `location /api/` 加入该域名的 `server` 配置，并把新的 `public/` 文件放到原静态目录。保留 `proxy_set_header Host $http_host`；关闭响应缓冲以保持流式输出。

```sh
sudo nginx -t
sudo systemctl reload nginx
```

前端和 `/api/` 必须位于同一个域名。已有 HTTPS 配置可继续使用。此示例按域名根路径部署。

Nginx 配置依据：[代理模块](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)、[HTTP 核心模块](https://nginx.org/en/docs/http/ngx_http_core_module.html)。

## 数据与升级

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
- 更新时替换 `public/`、`server/`，再运行 `sudo systemctl restart lumen`。保留并备份数据目录；不要用空目录覆盖已有数据。服务器重启后会从磁盘恢复。
- 单个工作空间保存请求上限为 128 MiB，单次模型转发请求仍为 24 MiB。运行一个 Node 实例，不要用多进程同时写同一个数据目录。

验证方法：电脑 A 创建对话并等待保存，再用另一浏览器或手机访问同一域名；应看到同样的记录和已保存连接。重启 Node 服务后再次验证。

## 侧栏按需加载

- 初始只读取项目名称和最多 15 条标题，展开的各项目与未分组共同使用额度，当前展开的目录优先；项目名称不计入 15 条。
- 列表底部“加载更多”每次增加 15 条，滚动不会自动请求更多。展开目录、已加载数量、搜索、侧栏滚动位置和当前对话都写入 workspace.json 的视图设置，刷新后自动恢复。
- 正文通过单条对话接口读取，普通保存采用增量接口，只提交变更内容；未加载的对话不会被当作删除。只在批量移动、导出全部等明确操作时访问完整范围。首次升级旧目录会一次性补齐索引中的标题和校验值，后续无需读取全部正文来展示侧栏。
- 桌面可拖动侧栏对话或右侧对话标题进入项目，拖到“未分组”可移出。拖动会更新所属项目并移动服务器中的 JSON 文件；手机继续支持顶部的移动按钮。
- 本次前后端接口一同更新，部署时同时替换 public/ 和 server/，然后重启 Node 服务，并保留原数据目录。
