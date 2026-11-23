# dsh-anima-wardrobe

把 **ComfyUI + AnimaWardrobe** 搬进 DeepSeek Harness：右侧栏面板控制模型、画幅、采样、提示词、LoRA 与三层权重，并提供 `anima_draw` 工具在对话里直接出图。

支持 **Comfyui-Anima-Wardrobe V5 与 V6** 两种节点。

---

## 版本

| 版本 | 适用节点 | 说明 |
|---|---|---|
| **1.3.3**（当前） | V5 / V6 | 推荐 |
| 1.1.1 | V5 / V6 | 无随机面板内嵌、无「当前套用」 |
| 1.0.0 | 仅 V5 | 最早版本，不含 V6 专属输入 |

同一时间只能安装一个版本。

---

## 1.3.3 更新内容

> **这是非必要更新。** 1.1.1 能正常出图，本版不影响已有工作流的兼容性；只有需要下面这些能力时才需要升级。

**新增**

- 内嵌 ComfyUI 原版「随机提示词面板」：可拖动窗口、最小化、关闭，自动定位到节点按钮打开的同一面板
- 「当前套用」区块：列出正在影响出图的全局项（服装库启用项 / 池化 / 袜子鞋子覆盖 / 场景覆盖 / 角色服装预设），每项可一键停用
- 随机面板改动后，最小化或关闭时自动让 ComfyUI 保存工作流再读回面板；只有「生成一张」「立即保存」才写回工作流 JSON
- 作品 IP / 角色改为只读展示（由随机面板决定），点击「去改」直接打开面板
- 启动 ComfyUI 时自动加 `--enable-cors-header`，解决内嵌时的 403
- 可选桥接扩展 `dsh_anima_bridge`：内嵌页面自动打开随机面板、向面板实时上报节点参数

**修正**

- 取消角色后仍显示「角色服装预设」的误报
- 指定角色时角色预设匹配不上（文件键是 `x_(y)` 写法、内部是 `x, y` 写法）
- 遮罩文字与顶栏按钮在深色主题下不可见

---

## 运行前提

| 需要 | 说明 |
|---|---|
| DeepSeek Harness | 带内核 `sidebarRightTabs` 与 `sidebarRight` 服务（0.9 以上） |
| ComfyUI | 0.4.x，默认 `http://127.0.0.1:8188` |
| Comfyui-Anima-Wardrobe | V5 或 V6，装在 `custom_nodes` |
| 模型 | UNet + 对应 CLIP + VAE，参见下表 |

| 模型族 | CLIP | CLIP type | VAE |
|---|---|---|---|
| `miaomiaoHarem_anima*` | `qwen_3_06b_base` | `stable_diffusion` | `qwen_image_vae` |
| `moss_image_*` | `qwen3.5_9b_int8_convrot` | `moss_image` | `flux2-vae` |
| `qwen_image_2.1_*` | `qwen3vl_8b_w4a8` | `qwen_image` | `qwen_image_2.1_vae_bf16` |

---

## 安装

两种方式选一种：

**A. 直接安装 release 里的 tgz**

把 `release/dsh-anima-wardrobe-1.3.3.tgz` 拖进 DSH 的插件管理界面，或用：

```
dsh plugin add file:<绝对路径>/dsh-anima-wardrobe-1.3.3.tgz
```

**B. 从源码目录 link（开发用）**

```
dsh plugin add link:<仓库目录的绝对路径>
```

装完**完全退出 DSH 再重开**（不是刷新页面）。

### 可选：桥接扩展

把 `bridge/` 整个目录复制到 `<ComfyUI>/custom_nodes/dsh_anima_bridge/`，重启 ComfyUI。不装也能用，只是内嵌面板时不会自动弹出、最小化时不会自动保存工作流。

---

## 首次配置

`cordis.patch.yml` 里只暴露最常改的两项：

```yaml
outputRoot: 'D:\Comfy-Desktop\ComfyUI-Shared\output'   # 出图根目录，必须改
workflowFile: '…\V5-Anima_miaomiaoHarem_anima.json'    # 你自己的工作流
```

其余走默认：`comfyUrl: http://127.0.0.1:8188`、`comfyCors: true`、`timeoutMs: 900000`。
面板找不到 ComfyUI 的 python 时，可在配置里写 `comfyPython`。

---

## 面板

侧边栏底部「Anima」按钮打开右侧栏面板：

| 区 | 内容 |
|---|---|
| 模型 | CLIP（含 type）/ VAE / UNet；切换 UNet 自动套用该模型的档案 |
| 档案 | 保存/套用「CLIP + 类型 + VAE + CFG + 采样器 + 调度器 + 步数 + 采样偏移 + 解码方式」整套 |
| 图片参数 | 比例/宽高/张数、采样器、调度器、采样偏移（AuraFlow）、VAE 解码（整块/分块） |
| 提示词 | 负向词、质量词 |
| LoRA | 列表编辑 + 命名预设 |
| 三层权重 | sections / fields / options 逐层加权（0 关 / 1 默认 / 3 必现） |
| Anima 参数 | 作品 IP、角色（只读，点「去改」）、特征补全、外观跟随、干爽/双女（V6）、档位、服装、胸围、场景锁、额外正文 |
| 当前套用 | 正在影响出图的全局项，可逐项停用 |
| 动作 | 生成一张 / 立即保存 / 写回工作流 JSON / 打开随机面板 |

---

## `anima_draw` 工具

对话里说「画一张……」就会调用。主要参数：

| 参数 | 作用 |
|---|---|
| `prompt` | 只放质量词与自然语言描述 |
| `weights` | `{sections, fields, options}` 三层权重 |
| `role` / `work` | 指定角色 / 限定作品（互斥） |
| `nsfwLevel` / `outfitStyle` / `breastSize` | 档位 / 服装 / 胸围 |
| `forcedScene` | 场景 id 定点锁定（V6） |
| `drySkinFilter` / `duoRoleFill` | V6 的干爽 / 双女补位 |
| `width` / `height` / `steps` / `guidance` / `sampler` / `scheduler` | 覆盖面板设置 |

出图回执会带：引擎的「已调 N 项权重 / 强制出现 / 权重命中」、⚠ 警告、以及「全局套用正在接管本图」的提醒。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 面板模型下拉是空的 | ComfyUI 没启动，点底部「启动 ComfyUI」 |
| 启动报 `No module named 'torch'` | 自动探测到 `standalone-env`，在配置里写 `comfyPython` 指向 `.venv\Scripts\pythonw.exe` |
| 桌面弹出 `python.exe` 黑框 | 用 `pythonw.exe`（插件已自动优先选它） |
| 内嵌面板 403 | 确认启动参数含 `--enable-cors-header *`（`comfyCors: true`） |
| 内嵌面板空白/黑屏 | 点顶栏「新窗口」在浏览器标签打开 |
| 画面出现紫/绿色带 | 关掉「VAE 解码 → 分块」 |
| 人物辨识不对 | 检查「特征」是否勾上、`role` 是否写对 |

---

## 目录

```
.
├─ package.json / cordis.patch.yml / index.js / client.js / icon.svg
├─ README.md / LICENSE / .gitignore
├─ templates/anima_api.json     21 节点 API 工作流模板
├─ templates/fields.json        15 段 / 57 字段 / 1139 选项
├─ release/dsh-anima-wardrobe-1.3.3.tgz
├─ bridge/                      可选桥接扩展（ComfyUI 侧）
└─ legacy/v1.1.1, legacy/v1.0.0 历史版本
```

---

MIT License
