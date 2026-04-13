"""
配置文件
定义API端点、参数配置等
"""
import os
from dotenv import load_dotenv

# 加载环境变量
load_dotenv()

# API配置 - 北京地域
IMAGE_API_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
VIDEO_API_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis"
TASK_QUERY_URL = "https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}"

# API Keys
IMAGE_API_KEY = os.getenv("IMAGE_API_KEY", "sk-71d37f4158434469acf3640bd747476b")
VIDEO_API_KEY = os.getenv("VIDEO_API_KEY", "sk-8d384464a7ff4d5fb42be752c5c05c55")

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
