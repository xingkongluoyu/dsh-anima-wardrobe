# dsh-anima-wardrobe

把 **AnimaWardrobe V5 / V6** 的 ComfyUI 工作流搬进 DeepSeek Harness：一个常驻面板 + 一个对话内出图工具。

- **右侧栏面板**：模型三件套、画幅与采样参数、负向词/质量词、LoRA、三层提示词权重、角色与作品、出图浏览、ComfyUI 启停，全在同一页。
- **`anima_draw` 工具**：对话里说一句就出图，模型可以按角色调整提示词权重，出图后会读回引擎的权重报告。

工作流节点本身来自 [Comfyui-Anima-Wardrobe-V5](https://github.com/lingdongbudong/Comfyui-Anima-Wardrobe-V5) / [Comfyui-Anima-Wardrobe-V6](https://github.com/lingdongbudong/Comfyui-Anima-Wardrobe-V6)（`AnimaV5RandomPrompt` 等），本插件不修改它的 Python 代码，只负责用 HTTP API 组装并提交工作流。

---

## 版本与仓库结构

| 位置 | 版本 | 适用的 Comfyui-Anima-Wardrobe |
| --- | --- | --- |
| 仓库根目录（就是本目录） | **1.1.1** | **V5 与 V6 都支持**（V6 多出的 3 个输入已接到面板与工具上） |
| `legacy/v1.0.0/` | 1.0.0 | **只适用于 V5**，没有 V6 的干爽 / 双女 / 场景锁 |
| `release/` | 1.1.1 | 打好的 tarball，可用 `dsh plugin add file:<路径>` 直接安装 |

`legacy/v1.0.0/` 保留上一版，给仍在用 **V5** 的环境；如果节点已经升级到 V6，直接用仓库根目录这份。

## 仓库结构

```
dsh-anima-wardrobe-1.1.1/
├─ package.json            插件元数据（dsh.bundle / dsh.client）
├─ cordis.patch.yml        bundle 注册与默认配置
├─ index.js                host 半：ComfyUI 调用、anima_draw 工具、HTTP 路由
├─ client.js               前端半：右侧栏面板、侧边栏入口按钮
├─ icon.svg                侧边栏按钮图标
├─ templates/
│  ├─ anima_api.json       工作流 API 模板（21 节点，含 PreviewAny 回执）
│  └─ fields.json          三层权重用的段/字段/选项表（来自 V6 词库）
├─ release/
│  └─ dsh-anima-wardrobe-1.1.1.tgz
└─ legacy/
   └─ v1.0.0/              1.0.0 版源码（仅 V5）
```

---

## 运行前提

| 依赖 | 说明 |
| --- | --- |
| DeepSeek Harness | 需要内核提供 `sidebarRightTabs` / `sidebarRight` / `layout` 服务（本插件不依赖第三方侧边栏插件） |
| ComfyUI | 0.4x，HTTP 可访问（默认 `http://127.0.0.1:8188`） |
| Comfyui-Anima-Wardrobe V5 / V6 | 提供 `AnimaV5RandomPrompt`（V6 里是 `AnimaV6RandomPrompt`，同一实现）与 `presets/anima_v4_pools.json` |
| 模型文件 | 一个 UNet、与它配套的 CLIP 与 VAE（例：Anima → `qwen_3_06b_base` + `qwen_image_vae`；MOSS → `qwen3.5_9b_*` + `flux2-vae`；Qwen-Image-2.1 → `qwen3vl_8b_*` + `qwen_image_2.1_vae_bf16`） |
| 可选 | LoraManager（工作流里的 `Lora Loader` 节点）、XB_ToolBox（工作流里的 `XB_KSampler` 等） |

---

## 安装

装完**完全退出 DSH 再重开**。

### 方式一：本地目录（开发/自用）

```bash
dsh plugin add link:<本包所在绝对路径>
```

或在 GUI 里对插件管理器说「用 `<路径>` 安装这个 bundle」。

### 方式二：tarball

```bash
dsh plugin add file:<release/dsh-anima-wardrobe-1.1.1.tgz 的绝对路径>
```

### 装完之后

1. 重启 DSH。
2. 左侧边栏底部（设置齿轮旁）出现 **Anima** 按钮，点它打开右侧栏面板。
3. 面板顶部「模型」区下拉是空的？说明 ComfyUI 没起来 —— 点底部「启动 ComfyUI」。

---

## 首次配置

配置文件是包内的 `cordis.patch.yml`，改完重启 DSH 生效。

```yaml
- insert:
    - id: anima-wardrobe
      name: 'dsh-anima-wardrobe'
      config:
        comfyUrl: 'http://127.0.0.1:8188'        # ComfyUI 地址
        outputRoot: 'D:\Comfy-Desktop\ComfyUI-Shared\output'   # ComfyUI 的 --output-directory
        imageRelDir: '图片/Anima/ANIMA12'         # 出图子目录（SaveImage 的 filename_prefix 前缀）
        workflowFile: ''                          # 你自己的 UI 格式工作流 json（可选，用于写回）
        templateFile: ''                          # 留空用包内 templates/anima_api.json
        fieldsFile: ''                            # 留空用包内 templates/fields.json
        timeoutMs: 900000                         # 单次出图超时
        pollIntervalMs: 1200                      # /history 轮询间隔
        comfyPython: ''                           # 留空自动探测（优先 <安装目录>\ComfyUI\.venv\Scripts\python.exe）
        launchLogPath: ''                         # 留空写到 $DSH_HOME/anima-wardrobe-comfy.log
```

要点：

- `outputRoot` + `imageRelDir` 决定面板「出图」区读哪个目录，和你工作流里 `SaveImage` 的 `filename_prefix` 前缀要对上。
- `workflowFile` 只影响「写回工作流 JSON」按钮和首次 seeding。留空不影响出图。
- 面板上的设置存在 `$DSH_HOME/anima-wardrobe.json`（`$DSH_HOME` 默认 `~/.dsh`）。

---

## 面板速览

打开方式：左侧边栏底部 **Anima** 按钮 → 右侧栏出现面板。

### 模型

| 控件 | 作用 |
| --- | --- |
| CLIP / 类型 | CLIPLoader 的 `clip_name` 与 `type`。**类型必须配对**：Anima → `stable_diffusion`，MOSS → `moss_image`，Qwen-Image-2.1 → `qwen_image`（不是 flux2） |
| VAE | VAELoader 的 `vae_name` |
| UNet | UNETLoader 的 `unet_name` |
| 档案 | 「保存为当前模型档案」把当前整套参数存到该 UNet 名下；以后切回来自动套用。档案包含：CLIP 名 + 类型、VAE、CFG、采样器、调度器、步数、采样偏移、VAE 解码方式 |

### 图片参数

比例 / 宽高 / 步数 / CFG / 采样器 / 调度器 / **采样偏移** / **VAE 解码** / 张数。

- **采样偏移**：勾上就在模型链里插入 `ModelSamplingAuraFlow`（UNet → 它 → SageAttention → LoRA → KSampler）。MOSS 官方要求 `shift = 5`，Flux 系常用 3–5；Anima 与 Qwen-Image 官方模板不带，保持关闭即可。关闭时该节点整个不提交。
- **VAE 解码**：不勾 = 整块 `VAEDecode`（干净，占显存）；勾上 = `XB_VAEDecodeTiledImage`（省显存，块边界可能留紫/绿色带，Qwen 类 VAE 尤其明显）。

### 提示词

两个文本框直接对应工作流：**负向词** → `1036 CLIPTextEncode`；**质量词** → `1034 StringConcatenate.string_a`。

### LoRA

列表式增删改：名称（来自 ComfyUI 的 lora 列表）、强度、启停。写进 `1142 Lora Loader` 的 `loras` 数组。

「预设」行可以把当前整份列表按名字存下来，下次一键套用。

### 提示词权重

对应 `AnimaV5RandomPrompt.weights_json`，三层：

```
sections（整段） → fields（字段） → options（具体选项，键是英文 tag 小写）
```

权重 `0–3`：**0 = 关闭该倾向、1 = 默认（不写）、2 = 提高、3 = 必现**。上层「模型参考页面配置」决定页面权重是否打底。

### Anima 参数

作品 IP、角色（单选）、特征（补齐角色特征 tag）、外观（跟随角色外观）、干爽（禁止汗/湿润标签，V6）、双女（自动补位，V6）、档位、服装、胸围、场景锁（按场景 id 定点锁定，V6）、额外正文。

- **作品 IP** 与 **角色** 互斥，右侧按钮决定谁生效：选作品 = 每次在这个 IP 里随机抽人；选角色 = 固定这个角色。
- **人物特征**（发色/瞳色/发型/体型等 9 个字段）在权重里被动过时，角色随机会被自动关掉（否则引擎会静默忽略这些权重）。

### 动作与出图

- 生成一张 / 立即保存（带备份）/ 写回工作流 JSON。
- 底部状态栏：ComfyUI 在线 → 「打开 ComfyUI 界面」+「停止」；离线 → 「启动 ComfyUI」。
- 出图浏览：单图显示，`‹` `›` 翻页，右侧显示 `i / n`。

---

## `anima_draw` 工具

对话里直接说需求即可，也可以显式给参数。

| 参数 | 说明 |
| --- | --- |
| `prompt` | 追加到正向提示词末尾（自然语言 / 画面描述） |
| `weights` | `{sections, fields, options}`，控制随机提示词的权重 |
| `followPanel` | 本次是否让面板权重打底（默认跟面板开关） |
| `nsfwLevel` | `sfw` / `suggestive` / `explicit` / `hardcore` / `extreme` / `any` |
| `seed` | 种子（-1 = 每次重抽） |
| `width` / `height` / `batchSize` / `steps` / `guidance` | 覆盖面板的画幅与采样参数 |
| `role` / `work` | 指定角色（trigger，如 `firefly, honkai: star rail`） / 限定作品 IP；互斥 |
| `drySkinFilter` / `duoRoleFill` | V6：禁止汗/湿润标签 / 双女自动补位（只选 1 位角色画多人时补同作品另一位女性） |
| `forcedScene` | V6：按场景 id 定点锁定，写进 `weights_json.forced.n_canon`，优先于整库随机 |
| `outfitStyle` / `breastSize` | 服装风格 / 胸围档 |
| `clip` / `vae` / `unet` | 临时换模型三件套 |
| `loras` | `[{name, strength}]` |
| `negative` / `quality` | 覆盖负向词 / 质量词 |

出图后回执会带上引擎的权重报告：

```
· 自动关闭了「随机 IP 角色」（权重里指定了 hair_len、hair_color），本张按纯词库人物出图
· 引擎：已调 4 项权重
· 强制出现：齐颈短发、粉发
· 权重命中：hair_len 齐颈短发 = short hair；hair_color 粉发 = pink hair
· ⚠ 「腿」点名的 white thighhighs 与当前状态矛盾，本次未生效
```

看到 `⚠` 就按提示改权重，别重复同样的调用。

---

## 权重优先级

| 面板「模型参考页面配置」 | `anima_draw` 的 `weights` |
| --- | --- |
| 开（默认） | 页面权重为基础，工具参数在它之上覆盖 |
| 关 | 只用工具参数，页面权重完全不参与 |

---

## 常见问题

**面板里模型下拉是空的 / `ComfyUI 未启动`**
ComfyUI 没起来。点底部「启动 ComfyUI」，约 10 秒后变在线；若失败，看 `$DSH_HOME/anima-wardrobe-comfy.log`。

**启动报 `No module named 'torch'`**
`resolveLaunchSpec` 探测到了没装依赖的 `standalone-env`。在 `cordis.patch.yml` 里显式指定 `comfyPython` 指向 ComfyUI 实际使用的 venv python。

**启动后桌面弹出一个 cmd 黑框**
插件已优先用 `pythonw.exe`（GUI 子系统）。若日志显示用的是 `python.exe`，说明同目录没有 `pythonw.exe`，可手动在 `comfyPython` 里指向 `pythonw.exe`。

**出图有紫色/绿色色带**
分块 VAE 解码的块边界色偏。关掉「VAE 解码 → 分块」，用整块解码。

**模型下拉里有的选项但出图报错**
多半是 CLIP 的「类型」选错（不同类型走不同的加载分支与权重键名）。

**面板不出现**
确认 DSH 版本提供了内核 `sidebarRightTabs` 服务；浏览器控制台或 `$DSH_HOME/anima-wardrobe-diag.log` 会有 `apply` / `no-sidebar-right` 记录。

**角色库 / 作品列表是空的**
面板会依次尝试 `cordis.patch.yml` 里的 `charactersFile`、V6 安装目录、V5 安装目录下的 `presets/anima_v4_characters.json`。三个都找不到时会提示「读取角色库失败」，在 `charactersFile` 里写绝对路径即可。

---

## 卸载

在插件管理器里禁用或移除 `dsh-anima-wardrobe`。删除 `$DSH_HOME/anima-wardrobe.json` 可清掉面板设置。

---

## 变更日志

### 1.1.1（2026-11-18）

适配 Comfyui-Anima-Wardrobe **V6**：

- `templates/fields.json` 按 V6 词库重新生成（15 段 / 57 字段 / 1139 选项，补上 6 个渐变过膝袜）
- 面板新增「干爽」「双女」「场景锁」三个控件，`anima_draw` 新增 `drySkinFilter` / `duoRoleFill` / `forcedScene`
- 角色库路径改为自动探测（V6 优先，回退 V5），V5 目录被移走后不再导致角色库读空

### 1.0.0（2026-11-13）

首个可分发版本，对应 Comfyui-Anima-Wardrobe **V5**。

---

## 许可

MIT，见 [LICENSE](LICENSE)。
