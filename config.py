"""
配置文件
定义API端点、参数配置等
"""
import os
from dotenv import load_dotenv

# 加载环境变量
load_dotenv()

# 通义万相 API配置 - 北京地域
WANX_IMAGE_API_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
WANX_VIDEO_API_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis"
WANX_TASK_QUERY_URL = "https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}"

# 即梦AI API配置 - 火山引擎视觉API（使用 AK/SK 认证）
VOLC_ACCESS_KEY = os.getenv("VOLC_ACCESS_KEY", "")
VOLC_SECRET_KEY = os.getenv("VOLC_SECRET_KEY", "")

# MinIO 对象存储配置 - 用于将人物库参考图上传为公网URL供即梦使用
MINIO_ENDPOINT      = os.getenv("MINIO_ENDPOINT", "")        # e.g. http://192.168.101.60:9000
MINIO_ACCESS_KEY    = os.getenv("MINIO_ACCESS_KEY", "")
MINIO_SECRET_KEY    = os.getenv("MINIO_SECRET_KEY", "")
MINIO_BUCKET        = os.getenv("MINIO_BUCKET", "")          # e.g. biddinghelper
MINIO_CUSTOM_DOMAIN = os.getenv("MINIO_CUSTOM_DOMAIN", "")   # e.g. https://bszs.cctocloud.com:30443

# API Keys
IMAGE_API_KEY = os.getenv("IMAGE_API_KEY", "")  # 通义万相文生图
VIDEO_API_KEY = os.getenv("VIDEO_API_KEY", "")  # 通义万相图生视频
# 千问API Key，默认与文生图共用（DashScope单 Key 可调用所有模型）
QWEN_API_KEY  = os.getenv("QWEN_API_KEY", IMAGE_API_KEY)

# 千问 OpenAI 兼容接口
QWEN_API_URL  = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"

# 任务轮询配置
POLL_INTERVAL = 5  # 轮询间隔(秒)
POLL_TIMEOUT = 600  # 超时时间(秒), 10分钟

# 文件存储路径
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
IMAGE_SAVE_DIR = os.path.join(BASE_DIR, "images")
VIDEO_SAVE_DIR = os.path.join(BASE_DIR, "videos")

# 创建存储目录
os.makedirs(IMAGE_SAVE_DIR, exist_ok=True)
os.makedirs(VIDEO_SAVE_DIR, exist_ok=True)

# Flask配置
FLASK_HOST = os.getenv("FLASK_HOST", "127.0.0.1")
FLASK_PORT = int(os.getenv("FLASK_PORT", "5000"))
FLASK_DEBUG = os.getenv("FLASK_DEBUG", "True").lower() == "true"
