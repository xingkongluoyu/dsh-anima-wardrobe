# dsh_anima_bridge —— DSH Anima 面板的 ComfyUI 侧桥接

只做两件事，不改 AnimaWardrobe 的任何文件：

1. 当页面带有 `?dshPanel=1` 时，自动点开 Anima 随机提示词面板的「⚙ 打开随机面板」
2. 每 2 秒把节点上的三个「套用项」（场景搭配 / 定点锁定 / 勾选池）上报给 DSH 侧边栏

不装它也能用：DSH 面板里的 iframe 照样能显示，只是需要你自己点节点上的按钮。

## 安装

把整个 `dsh_anima_bridge` 文件夹放进：

```
<ComfyUI>/custom_nodes/dsh_anima_bridge/
├─ __init__.py
└─ web/js/bridge.js
```

重启 ComfyUI 即可。日志里会出现 `[dsh-anima-bridge]` 前缀的报错（如果有）。

## 卸载

删掉这个文件夹，重启 ComfyUI。
