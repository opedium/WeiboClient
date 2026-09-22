# WeiboClient (微博自动化操作与 API 集成客户端)

[![Python](https://img.shields.io/badge/Python-3.9+-3776AB.svg?logo=python&logoColor=white)](https://www.python.org/)
[![License](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![MongoDB](https://img.shields.io/badge/MongoDB-Supported-47A248.svg?logo=mongodb&logoColor=white)](https://www.mongodb.com/)
[![Appwrite](https://img.shields.io/badge/Appwrite-Cloud%20Functions-FD366E.svg?logo=appwrite&logoColor=white)](https://appwrite.io/)

> 一个功能完备的 Python 微博自动化操作客户端与交互式 CLI 工具包。支持多媒体分块上传（图文/视频）、发博/转评赞交互、超话签到、数据采集持久化（MongoDB）以及 Appwrite 无服务云函数部署。

---

## 📑 核心功能特性 (Key Features)

### 1. 交互式命令行工具 (`client.py`)
- **菜单导航 & 自动补全**：内置 `readline` / `pyreadline3` 支持命令历史记录与 Tab 自动补全。
- **三种执行模式**：
  - **交互模式**：`python client.py` 提供交互式菜单与友好提示。
  - **批处理模式**：`python client.py all` 自动执行所有免输入安全操作。
  - **预览模式**：`python client.py --dry-run <action_id>` 预览参数与请求结构，不发送实际网络请求。
- **彩色终端反馈**：通过 `colorama` 实时显示响应状态（成功 `✓` / 失败 `✗` / 鉴权失效提示）。

### 2. 多媒体与内容发布管道
- **图片分块上传**：支持本地多格式图片上传，自动返回 `pid` 图片标识符。
- **高清视频上传**：实现视频文件分块上传、元数据提取、封面生成（`cover_pid` 与 `media_id`）。
- **多样化发布**：支持纯文字微博、多图微博、原创视频微博及可见性权限控制。
- **ID 编码互转**：支持微博 Base62 字母 ID（`mblogid` / `bid`）与底层 64 位数字 ID（`mid`）的双向无损转换。

### 3. 社交互动与自动化操作
- **转评赞交互**：支持快转、自定义带文字转发、发评论、回复特定楼层评论、点赞与取消点赞。
- **超话自动化**：支持关注超话社区、超话一键签到（支持通过 `topic_id` 或超话名称触发）。
- **用户与时间线检索**：获取个人时间线、群组列表、视频合集、关注列表、粉丝列表及全网关键词搜索。

### 4. 数据持久化与云函数部署
- **MongoDB 数据管道**：支持采集数据自动入库，配置重试机制与日志轮转。
- **Appwrite 无服务器函数**：内置 `appwrite-auth/` 云函数，支持无服务器运行与鉴权隔离。

---

## 🛠️ 安装与快速开始 (Getting Started)

### 1. 克隆仓库与安装依赖

```bash
git clone https://github.com/opedium/WeiboClient.git
cd WeiboClient
pip install -r requirements.txt
```

### 2. 账号鉴权配置 (`cookies.yaml`)

在项目根目录下创建 `cookies.yaml` 文件并填入有效的微博 Web 端 Cookie：

```yaml
# cookies.yaml 示例
cookie: "SUB=_2A25...; SUBP=0033...; _s_tentry=-; ..."
```

### 3. 启动交互式客户端

```bash
# 启动交互式操作菜单
python client.py

# 查看所有支持的操作指令列表
python client.py --list

# 预览特定操作（如发布微博 ac_05）
python client.py --dry-run ac_05

# 依次执行所有基础查询操作
python client.py all
```

---

## 💻 Python SDK 调用示例 (SDK Usage)

除了命令行工具外，`WeiBoClient` 也可作为标准 Python 库导入到其他项目中：

```python
from weibo import WeiBoClient
from weibo.consts import Video

# 从配置文件初始化客户端
client = WeiBoClient.load_from_file('cookies.yaml')

# 1. 上传图片并发布图文微博
upload_res = client.upload_picture("path/to/image.jpg")
pid = upload_res['pic']['pid']
client.post_tweet(content="Hello from WeiboClient SDK! 🚀", pid=pid)

# 2. 超话签到
client.checkin_super_topic_by_name(name="编程超话")

# 3. 转发与评论
tweet_mid = client.bid_to_mid("Ox7abc123") # 转换 mblogid 为数字 mid
client.repost_tweet(mid=tweet_mid, content="转发支持！")
client.comment_tweet(mid=tweet_mid, content="打卡学习！")
```

---

## 📂 项目结构 (Repository Structure)

```
WeiboClient/
├── client.py                # 交互式 CLI 客户端工具
├── examples.py              # SDK 接口完整调用示例集合
├── post_weibo.py            # 快速发博独立脚本
├── config.py                # MongoDB 与全局日志重试配置
├── API_RESPONSE_REVIEW.md   # API 响应统一格式规范文档
├── requirements.txt         # Python 依赖清单
├── weibo/                   # 核心客户端模块
│   ├── client.py            # WeiBoClient 主类
│   ├── consts.py            # 常量与枚举定义
│   └── util.py              # ID 转换与工具函数
├── appwrite-auth/           # Appwrite 云函数鉴权套件
├── database/                # MongoDB 数据库持久化实现
└── utils/                   # 网络请求与辅助工具
```

---

## 📋 支持的操作代码对照表 (Action Codes)

| 代码 | 功能描述 | 典型输入参数 |
| :--- | :--- | :--- |
| `ac_00` | 上传本地图片 | 图片文件绝对/相对路径 |
| `ac_01` | 上传视频与封面 | 视频文件路径 |
| `ac_02` | 获取用户视频合集 | 无 |
| `ac_03` | 获取用户加入的所有群组 | 无 |
| `ac_04` | 关注超话社区 | `topic_id`, `name` |
| `ac_04_1` / `ac_04_2` | 超话日常打卡签到 | `topic_id` 或 `name` |
| `ac_05` | 发布微博（文字/图片/视频） | `content`, `pid`, `media_id` |
| `ac_06` | 删除指定微博 | `mid` 或 `mblogid` |
| `ac_07` / `ac_08` | 快转 / 自定义转发微博 | `mid`, `content` |
| `ac_09` / `ac_10` | 评论微博 / 回复特定评论 | `mid`, `cid`, `content` |
| `ac_11` / `ac_12` | 微博点赞 / 取消点赞 | `mid` |
| `ac_13` / `ac_14` | 评论点赞 / 取消点赞 | `cid` |
| `ac_15` / `ac_16` | 关注用户 / 取消关注用户 | `uid` |

---

## 📄 开源协议 (License)

本项目基于 [GNU General Public License v3.0 (GPL-3.0)](LICENSE) 开源发布。
