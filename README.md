# SillyTavern 回复统计

一个轻量、独立的 SillyTavern 前端扩展，在每条 AI 回复的角色名旁显示：

`≈入12k·出860·流32t/s`

- `入`：本轮输入 token 估算值。
- `出`：本轮输出 token 估算值。
- `流`：输出量除以请求总耗时得到的平均速度，包含排队和首字等待，不是严格的正文流式速度。
- `≈`：表示统计值为估算；`—`：表示旧消息或当前数据不足，不会伪装成 0。

扩展只监听 SillyTavern 原生消息事件，并读取当前消息和 itemized prompt 数据。它不会覆盖 `fetch`/XHR，不会修改请求、API 地址、密钥或预设，也不依赖 PayGo。

扩展只把少量数字写入 `message.extra.reply_token_stats`，不会保存完整提示词。

## 安装

将整个 `st-reply-stats` 文件夹复制到：

```text
SillyTavern/public/scripts/extensions/third-party/st-reply-stats
```

然后由用户自行刷新 SillyTavern 页面。通常不需要重启服务。

### Android / Termux

假设 SillyTavern 位于 `~/SillyTavern`，扩展文件夹已放进手机下载目录：

```sh
termux-setup-storage  # 仅首次需要
cp -r ~/storage/shared/Download/st-reply-stats \
  ~/SillyTavern/public/scripts/extensions/third-party/
```

如实际路径不同，请相应修改。电脑端完成项目并不代表手机端已经安装。

## 测试

```sh
npm test
```

已针对 SillyTavern 1.19.0 检查。
