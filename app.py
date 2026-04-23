"""
通义万相2.7视频生成器 - Flask主应用
实现文生图和图生视频的完整流程
"""
import os
import json
import time
import uuid
import base64
import requests
from datetime import datetime
from flask import Flask, render_template, request, jsonify, send_from_directory
from config import (
    WANX_IMAGE_API_URL, WANX_VIDEO_API_URL, WANX_TASK_QUERY_URL,
    VOLC_ACCESS_KEY, VOLC_SECRET_KEY, MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_BUCKET, MINIO_CUSTOM_DOMAIN,
    IMAGE_API_KEY, VIDEO_API_KEY, QWEN_API_KEY, QWEN_API_URL,
    POLL_INTERVAL, POLL_TIMEOUT,
    IMAGE_SAVE_DIR, VIDEO_SAVE_DIR,
    FLASK_HOST, FLASK_PORT, FLASK_DEBUG
)
from volcengine.visual.VisualService import VisualService

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 最大上佴50MB

# 人物库存储文件
CHARACTERS_FILE = os.path.join(os.path.dirname(__file__), 'characters.json')

# VLM 评审反馈与进化文件
BASE_DIR        = os.path.dirname(__file__)
FEEDBACK_FILE   = os.path.join(BASE_DIR, 'review_feedback.jsonl')
PROMPTS_FILE    = os.path.join(BASE_DIR, 'review_prompts.json')

# 内存中当前使用的评审提示词（应用启动时加载，进化后动态更新）
CURRENT_REVIEW_PROMPT = None   # 延迟初始化，在 _init_review_prompts() 中设置

# 分镜规划反馈与进化文件
SCENE_PROMPTS_FILE  = os.path.join(BASE_DIR, 'scene_prompts.json')
SCENE_FEEDBACK_FILE = os.path.join(BASE_DIR, 'scene_feedback.jsonl')
CURRENT_SCENE_PROMPT = None   # 延迟初始化，在 _init_scene_prompts() 中设置


def _init_review_prompts():
    """应用启动时初始化 review_prompts.json，加载最新评审提示词到内存。"""
    global CURRENT_REVIEW_PROMPT
    if not os.path.exists(PROMPTS_FILE):
        # 首次运行：用硬编码提示词创建 v1
        data = {
            "current_version": "v1",
            "versions": [{
                "version": "v1",
                "created_at": datetime.now().isoformat(),
                "feedback_count_at_creation": 0,
                "prompt": REVIEW_SYSTEM_PROMPT
            }]
        }
        with open(PROMPTS_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        CURRENT_REVIEW_PROMPT = REVIEW_SYSTEM_PROMPT
    else:
        with open(PROMPTS_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        versions = data.get('versions', [])
        if versions:
            CURRENT_REVIEW_PROMPT = versions[-1]['prompt']
        else:
            CURRENT_REVIEW_PROMPT = REVIEW_SYSTEM_PROMPT
    print(f"[VLM评审] 提示词已加载，当前版本: {data.get('current_version', 'v1')}")


def _init_scene_prompts():
    """应用启动时初始化 scene_prompts.json，加载最新分镜生成提示词到内存。"""
    global CURRENT_SCENE_PROMPT
    if not os.path.exists(SCENE_PROMPTS_FILE):
        # 首次运行：用硬编码提示词创建 v1
        data = {
            "current_version": "v1",
            "versions": [{
                "version": "v1",
                "created_at": datetime.now().isoformat(),
                "feedback_count_at_creation": 0,
                "prompt": SCENE_SYSTEM_PROMPT
            }]
        }
        with open(SCENE_PROMPTS_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        CURRENT_SCENE_PROMPT = SCENE_SYSTEM_PROMPT
    else:
        with open(SCENE_PROMPTS_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        versions = data.get('versions', [])
        if versions:
            CURRENT_SCENE_PROMPT = versions[-1]['prompt']
        else:
            CURRENT_SCENE_PROMPT = SCENE_SYSTEM_PROMPT
    print(f"[分镜规划] 提示词已加载，当前版本: {data.get('current_version', 'v1')}")


def load_characters():
    """从文件加载人物库"""
    if not os.path.exists(CHARACTERS_FILE):
        return []
    try:
        with open(CHARACTERS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return []


def save_characters(characters):
    """保存人物库到文件"""
    with open(CHARACTERS_FILE, 'w', encoding='utf-8') as f:
        json.dump(characters, f, ensure_ascii=False, indent=2)


def generate_image(prompt, negative_prompt="", size="2K", reference_images=None, api_key=None, api_url=None, model="wanx"):
    """
    调用文生图API生成图片
    
    Args:
        prompt: 图片描述文本
        negative_prompt: 反向提示词
        size: 图片尺寸 (1K, 2K, 4K)
        reference_images: 参考图片URL列表 (用于人物一致性)
        api_key: 可选，覆盖默认IMAGE_API_KEY
        api_url: 可选，覆盖默认IMAGE_API_URL
        model: 模型平台 (wanx=通义万相, jimeng=即梦AI)
    
    Returns:
        dict: {'success': bool, 'image_url': str, 'local_path': str, 'error': str}
    """
    if model == "jimeng":
        return generate_image_jimeng(prompt, negative_prompt, size, reference_images, api_key)
    else:
        return generate_image_wanx(prompt, negative_prompt, size, reference_images, api_key, api_url)


def generate_image_wanx(prompt, negative_prompt="", size="2K", reference_images=None, api_key=None, api_url=None):
    """通义万相文生图"""
    _api_key = api_key or IMAGE_API_KEY
    _api_url = api_url or WANX_IMAGE_API_URL
    try:
        # 构建content数组
        content = []
        
        # 如果有参考图片,先加入content
        if reference_images:
            for img_url in reference_images:
                content.append({"image": img_url})
        
        # 加入文本提示词
        content.append({"text": prompt})
        
        # 构建请求体
        payload = {
            "model": "wan2.7-image-pro",
            "input": {
                "messages": [
                    {
                        "role": "user",
                        "content": content
                    }
                ]
            },
            "parameters": {
                "size": size,
                "n": 1,
                "watermark": False,
                "thinking_mode": True
            }
        }
        
        # 如果有参考图输入，关闭thinking_mode（有图时不生效）
        if reference_images:
            payload["parameters"]["thinking_mode"] = False
        
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {_api_key}"
        }
        
        print(f"[文生图] 调用API, prompt: {prompt[:50]}...")
        if api_key:
            print(f"[文生图] 使用页面自定义API Key")
        response = requests.post(_api_url, json=payload, headers=headers, timeout=120)
        response.raise_for_status()
        result = response.json()
        
        # 解析返回的图片URL
        if "output" in result and "choices" in result["output"]:
            image_url = result["output"]["choices"][0]["message"]["content"][0]["image"]
            
            # 下载图片到本地
            local_filename = f"image_{uuid.uuid4().hex[:8]}.png"
            local_path = download_image(image_url, local_filename)
            
            # 同时保存原始URL（阿里云OSS URL，公网可访问）
            # 这样在生成视频时可以直接使用
            print(f"[文生图] 成功, 本地路径: {local_path}")
            print(f"[文生图] 原始URL: {image_url}")
            return {
                "success": True,
                "image_url": image_url,  # 使用阿里云原始URL
                "local_path": local_path,
                "filename": local_filename
            }
        else:
            error_msg = result.get("message", "未知错误")
            print(f"[文生图] 失败: {error_msg}")
            return {"success": False, "error": error_msg}
            
    except requests.exceptions.RequestException as e:
        error_msg = f"API调用失败: {str(e)}"
        print(f"[文生图] {error_msg}")
        return {"success": False, "error": error_msg}
    except Exception as e:
        error_msg = f"生成图片时出错: {str(e)}"
        print(f"[文生图] {error_msg}")
        return {"success": False, "error": error_msg}


def download_image(image_url, filename):
    """下载图片到本地"""
    try:
        response = requests.get(image_url, timeout=60)
        response.raise_for_status()
        
        local_path = os.path.join(IMAGE_SAVE_DIR, filename)
        with open(local_path, 'wb') as f:
            f.write(response.content)
        
        return local_path
    except Exception as e:
        print(f"[下载图片] 失败: {str(e)}")
        raise


def _get_jimeng_visual_service():
    """获取即梦AI视觉服务实例（volcengine SDK）"""
    visual_service = VisualService()
    visual_service.set_ak(VOLC_ACCESS_KEY)
    visual_service.set_sk(VOLC_SECRET_KEY)
    return visual_service


def generate_image_jimeng(prompt, negative_prompt="", size="2K", reference_images=None, api_key=None):
    """
    即梦AI文生图 4.0 - 通过火山引擎视觉API（volcengine SDK）
    
    Args:
        prompt: 图片描述文本
        negative_prompt: 反向提示词
        size: 图片尺寸 (1K, 2K, 4K)
        reference_images: 参考图片URL列表
        api_key: 未使用（保持接口一致）
    
    Returns:
        dict: {'success': bool, 'image_url': str, 'local_path': str, 'error': str}
    """
    if not VOLC_ACCESS_KEY or not VOLC_SECRET_KEY:
        return {"success": False, "error": "请先配置火山引擎 AK/SK（VOLC_ACCESS_KEY / VOLC_SECRET_KEY）"}
    
    # 即梦4.0 尺寸映射（宽x高）
    size_map = {
        "1K": {"width": 1024, "height": 1024},
        "2K": {"width": 2048, "height": 1024},  # 16:9 近似
        "4K": {"width": 2048, "height": 1024}
    }
    img_size = size_map.get(size, {"width": 1024, "height": 1024})
    
    try:
        visual_service = _get_jimeng_visual_service()
        
        # 构建请求参数 - 即梦图片生成4.0（异步两步调用）
        form = {
            "req_key": "jimeng_t2i_v40",
            "prompt": prompt,
            "width": img_size["width"],
            "height": img_size["height"],
            "seed": -1,
            "scale": 2.5,
        }
        
        # 反向提示词
        if negative_prompt:
            form["negative_prompt"] = negative_prompt
        
        # 参考图片（即梦4.0支持最多10张，只接受 http/https 公网URL）
        if reference_images:
            valid_refs = []
            upload_needed = []
            for url in reference_images:
                if not isinstance(url, str):
                    continue
                if url.startswith(('http://', 'https://')):
                    valid_refs.append(url)
                elif url.startswith('data:'):
                    upload_needed.append(url)
            
            # 自动上传 base64 参考图到 MinIO 公网存储
            if upload_needed:
                if all([MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_BUCKET]):
                    print(f"[即梦文生图] 开始上传 {len(upload_needed)} 张参考图到MinIO...")
                    for b64url in upload_needed:
                        try:
                            public_url = upload_base64_for_jimeng(b64url)
                            valid_refs.append(public_url)
                        except Exception as ue:
                            print(f"[即梦文生图] 参考图上传失败（已跳过）: {ue}")
                else:
                    print(f"[即梦文生图] 有 {len(upload_needed)} 张base64参考图，但未配置MinIO，已跳过")
                    print(f"[即梦文生图] 提示: 在.env中配置 MINIO_ENDPOINT/MINIO_ACCESS_KEY/MINIO_SECRET_KEY/MINIO_BUCKET 可启用参考图")
            
            if valid_refs:
                form["image_urls"] = valid_refs[:10]
                print(f"[即梦文生图] 参考图 {len(valid_refs)} 张 → 已加入请求")
            else:
                print(f"[即梦文生图] 无有效参考图，走纯文生图")
        
        print(f"[即梦文生图] 提交异步任务, req_key: jimeng_t2i_v40, prompt: {prompt[:50]}...")
        # 第1步：提交任务
        resp = visual_service.cv_sync2async_submit_task(form)
        print(f"[即梦文生图] 提交响应 code: {resp.get('code')}")
        
        if resp.get('code') != 10000:
            error_msg = resp.get('message', '未知错误')
            print(f"[即梦文生图] 提交失败({resp.get('code')}): {error_msg}")
            return {"success": False, "error": f"即梦API错误({resp.get('code')}): {error_msg}"}
        
        task_id = resp.get('data', {}).get('task_id', '')
        if not task_id:
            return {"success": False, "error": "API返回成功但无task_id"}
        
        print(f"[即梦文生图] 任务已提交, task_id: {task_id}, 开始轮询...")
        
        # 第2步：轮询查询结果
        import json as json_module
        query_form = {
            "req_key": "jimeng_t2i_v40",
            "task_id": task_id,
            "req_json": json_module.dumps({"return_url": True, "logo_info": {"add_logo": False}}),
        }
        
        max_wait = 120  # 最多等待120秒
        interval = 3
        elapsed = 0
        while elapsed < max_wait:
            time.sleep(interval)
            elapsed += interval
            
            poll_resp = visual_service.cv_sync2async_get_result(query_form)
            poll_code = poll_resp.get('code')
            poll_data = poll_resp.get('data', {})
            poll_status = poll_data.get('status', '')
            
            print(f"[即梦文生图] 轮询 ({elapsed}s): status={poll_status}, code={poll_code}")
            
            if poll_code == 10000 and poll_status == 'done':
                # 成功 - 解析图片URL
                image_urls = poll_data.get('image_urls', [])
                
                if not image_urls:
                    b64_list = poll_data.get('binary_data_base64', [])
                    if b64_list:
                        local_filename = f"image_{uuid.uuid4().hex[:8]}.png"
                        local_path = os.path.join(IMAGE_SAVE_DIR, local_filename)
                        with open(local_path, 'wb') as f:
                            f.write(base64.b64decode(b64_list[0]))
                        print(f"[即梦文生图] 成功(base64), 本地路径: {local_path}")
                        return {
                            "success": True,
                            "image_url": f"/images/{local_filename}",
                            "local_path": local_path,
                            "filename": local_filename
                        }
                    return {"success": False, "error": "API返回成功但无图片数据"}
                
                image_url = image_urls[0]
                local_filename = f"image_{uuid.uuid4().hex[:8]}.png"
                local_path = download_image(image_url, local_filename)
                
                print(f"[即梦文生图] 成功, 本地路径: {local_path}")
                return {
                    "success": True,
                    "image_url": image_url,
                    "local_path": local_path,
                    "filename": local_filename
                }
            
            elif poll_code != 10000 and poll_status not in ('generating', 'in_queue', ''):
                error_msg = poll_resp.get('message', '未知错误')
                return {"success": False, "error": f"即梦任务失败({poll_code}): {error_msg}"}
        
        return {"success": False, "error": f"即梦文生图超时({max_wait}秒)"}
            
    except Exception as e:
        error_msg = f"即梦文生图出错: {str(e)}"
        print(f"[即梦文生图] {error_msg}")
        return {"success": False, "error": error_msg}


def create_video_task_jimeng(image_url, prompt, negative_prompt="", duration=5):
    """
    即梦AI视频生成 3.0 Pro - 提交异步任务
    
    Args:
        image_url: 首帧图片URL（图生视频）或 None（文生视频）
        prompt: 视频描述文本
        negative_prompt: 反向提示词（未使用，接口不支持）
        duration: 视频时长(秒)，5 或 10
    
    Returns:
        dict: {'success': bool, 'task_id': str, 'error': str}
    """
    if not VOLC_ACCESS_KEY or not VOLC_SECRET_KEY:
        return {"success": False, "error": "请先配置火山引擎 AK/SK"}
    
    try:
        visual_service = _get_jimeng_visual_service()
        
        # 帧数: 5秒=121帧, 10秒=241帧
        frames = 241 if duration >= 10 else 121
        
        form = {
            "req_key": "jimeng_ti2v_v30_pro",
            "prompt": prompt,
            "seed": -1,
            "frames": frames,
            "aspect_ratio": "16:9",
        }
        
        # 图生视频：传入首帧图片
        if image_url:
            form["image_urls"] = [image_url]
        
        print(f"[即梦视频] 提交任务, prompt: {prompt[:50]}..., frames: {frames}")
        if image_url:
            print(f"[即梦视频] 首帧图片: {image_url[:80]}...")
        
        # 视频生成使用异步接口
        resp = visual_service.cv_sync2async_submit_task(form)
        
        print(f"[即梦视频] 响应 code: {resp.get('code')}")
        
        if resp.get('code') == 10000:
            task_id = resp.get('data', {}).get('task_id', '')
            if task_id:
                print(f"[即梦视频] 任务创建成功, task_id: {task_id}")
                return {"success": True, "task_id": f"jimeng_{task_id}"}
            else:
                return {"success": False, "error": "API返回成功但无task_id"}
        else:
            error_msg = resp.get('message', '未知错误')
            print(f"[即梦视频] 创建任务失败({resp.get('code')}): {error_msg}")
            return {"success": False, "error": f"即梦API错误({resp.get('code')}): {error_msg}"}
            
    except Exception as e:
        error_msg = f"创建即梦视频任务出错: {str(e)}"
        print(f"[即梦视频] {error_msg}")
        return {"success": False, "error": error_msg}


def query_task_jimeng(task_id):
    """
    查询即梦AI视频任务状态
    
    Args:
        task_id: 即梦任务ID（不含 jimeng_ 前缀）
    
    Returns:
        dict: {'status': str, 'video_url': str, 'error': str}
    """
    try:
        visual_service = _get_jimeng_visual_service()
        
        form = {
            "req_key": "jimeng_ti2v_v30_pro",
            "task_id": task_id,
        }
        
        print(f"[即梦查询] 查询任务: {task_id}")
        resp = visual_service.cv_sync2async_get_result(form)
        
        code = resp.get('code')
        data = resp.get('data', {})
        
        if code == 10000:
            status = data.get('status', '')
            print(f"[即梦查询] 任务状态: {status}")
            
            # 状态映射: 即梦 -> 通用
            status_map = {
                'done': 'SUCCEEDED',
                'generating': 'RUNNING',
                'in_queue': 'PENDING',
                'not_found': 'FAILED',
                'expired': 'FAILED',
            }
            mapped_status = status_map.get(status, 'RUNNING')
            
            result = {"status": mapped_status}
            
            if status == 'done':
                video_url = data.get('video_url', '')
                if video_url:
                    result["video_url"] = video_url
                    print(f"[即梦查询] 视频URL: {video_url[:80]}...")
            elif status in ('not_found', 'expired'):
                result["error"] = f"任务{status}"
            
            return result
        else:
            error_msg = resp.get('message', '未知错误')
            print(f"[即梦查询] 查询失败({code}): {error_msg}")
            return {"status": "FAILED", "error": f"查询失败: {error_msg}"}
            
    except Exception as e:
        print(f"[即梦查询] 异常: {str(e)}")
        return {"status": "FAILED", "error": f"查询任务失败: {str(e)}"}


def create_video_task(image_url, prompt, negative_prompt="", resolution="720P", duration=5, api_key=None, api_url=None):
    """
    创建图生视频任务 - 使用 wan2.7-i2v 模型
    
    Args:
        image_url: 首帧图片URL
        prompt: 视频描述文本
        negative_prompt: 反向提示词
        resolution: 分辨率 (720P, 1080P)
        duration: 视频时长(秒)，取値范围 2-15
        api_key: 可选，覆盖默认VIDEO_API_KEY
        api_url: 可选，覆盖默认VIDEO_API_URL
    
    Returns:
        dict: {'success': bool, 'task_id': str, 'error': str}
    """
    _api_key = api_key or VIDEO_API_KEY
    _api_url = api_url or WANX_VIDEO_API_URL
    try:
        # wan2.7-i2v 使用新版 media 数组格式
        payload = {
            "model": "wan2.7-i2v",
            "input": {
                "prompt": prompt,
                "media": [
                    {
                        "type": "first_frame",
                        "url": image_url
                    }
                ]
            },
            "parameters": {
                "resolution": resolution,
                "duration": duration,
                "prompt_extend": True,
                "watermark": False
            }
        }
        
        # 如果有反向提示词
        if negative_prompt:
            payload["input"]["negative_prompt"] = negative_prompt
        
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {_api_key}",
            "X-DashScope-Async": "enable"  # 异步模式必须启用
        }
        
        # 如果使用 oss:// 临时URL，需要添加额外请求头
        if image_url.startswith('oss://'):
            headers["X-DashScope-OssResourceResolve"] = "enable"
            print(f"[图生视频] 使用OSS临时URL，已添加 OssResourceResolve 头")
        
        print(f"[图生视频] 创建任务 (wan2.7-i2v), prompt: {prompt[:50]}...")
        print(f"[图生视频] 参数: resolution={resolution}, duration={duration}")
        print(f"[图生视频] 图片URL: {image_url[:100]}...")
        if api_key:
            print(f"[图生视频] 使用页面自定义API Key")
        
        response = requests.post(_api_url, json=payload, headers=headers, timeout=60)
        
        print(f"[图生视频] 响应状态码: {response.status_code}")
        print(f"[图生视频] 响应内容: {response.text}")
        
        if response.status_code != 200:
            error_detail = response.text
            print(f"[图生视频] API错误: {error_detail}")
            return {"success": False, "error": f"API错误: {error_detail}"}
        
        result = response.json()
        
        # 获取task_id
        if "output" in result and "task_id" in result["output"]:
            task_id = result["output"]["task_id"]
            print(f"[图生视频] 任务创建成功, task_id: {task_id}")
            return {"success": True, "task_id": task_id}
        else:
            error_msg = result.get("message", "未知错误")
            print(f"[图生视频] 创建任务失败: {error_msg}")
            return {"success": False, "error": error_msg}
            
    except requests.exceptions.RequestException as e:
        error_msg = f"API调用失败: {str(e)}"
        print(f"[图生视频] {error_msg}")
        return {"success": False, "error": error_msg}
    except Exception as e:
        error_msg = f"创建视频任务时出错: {str(e)}"
        print(f"[图生视频] {error_msg}")
        return {"success": False, "error": error_msg}


def create_video_task_r2v(prompt, reference_images=None, first_frame_url=None,
                          negative_prompt="", resolution="720P", duration=5,
                          api_key=None, api_url=None):
    """
    创建参考生视频任务 - 使用 wan2.7-r2v 模型
    
    支持多参考图 + 首帧图，可实现人物从画面外入场等效果。
    
    Args:
        prompt: 视频描述文本，可用"图1""图2"指代参考图
        reference_images: 参考图URL列表（最多5张，支持公网URL/oss://URL/Base64 data URL）
        first_frame_url: 首帧图片URL（可选，可以是纯背景场景）
        negative_prompt: 反向提示词
        resolution: 分辨率 (720P, 1080P)
        duration: 视频时长(秒)，取值范围 2-10
        api_key: 可选，覆盖默认VIDEO_API_KEY
        api_url: 可选，覆盖默认VIDEO_API_URL
    
    Returns:
        dict: {'success': bool, 'task_id': str, 'error': str}
    """
    _api_key = api_key or VIDEO_API_KEY
    _api_url = api_url or WANX_VIDEO_API_URL
    try:
        # 构建 media 数组
        media = []
        need_oss_header = False
        
        # 添加参考图
        if reference_images:
            for img_url in reference_images:
                if not img_url:
                    continue
                media.append({
                    "type": "reference_image",
                    "url": img_url
                })
                if img_url.startswith('oss://'):
                    need_oss_header = True
        
        # 添加首帧图（可选）
        if first_frame_url:
            media.append({
                "type": "first_frame",
                "url": first_frame_url
            })
            if first_frame_url.startswith('oss://'):
                need_oss_header = True
        
        if not media:
            return {"success": False, "error": "参考生视频需要至少提供一张参考图或首帧图"}
        
        # r2v 最长 10 秒
        duration = min(duration, 10)
        
        payload = {
            "model": "wan2.7-r2v",
            "input": {
                "prompt": prompt,
                "media": media
            },
            "parameters": {
                "resolution": resolution,
                "duration": duration,
                "prompt_extend": False,
                "watermark": False
            }
        }
        
        # 如果有反向提示词
        if negative_prompt:
            payload["input"]["negative_prompt"] = negative_prompt
        
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {_api_key}",
            "X-DashScope-Async": "enable"
        }
        
        # 如果使用 oss:// 临时URL
        if need_oss_header:
            headers["X-DashScope-OssResourceResolve"] = "enable"
            print(f"[参考生视频] 使用OSS临时URL，已添加 OssResourceResolve 头")
        
        print(f"[参考生视频] 创建任务 (wan2.7-r2v), prompt: {prompt[:50]}...")
        print(f"[参考生视频] 参数: resolution={resolution}, duration={duration}")
        print(f"[参考生视频] 参考图: {len(reference_images) if reference_images else 0}张, 首帧: {'有' if first_frame_url else '无'}")
        
        response = requests.post(_api_url, json=payload, headers=headers, timeout=60)
        
        print(f"[参考生视频] 响应状态码: {response.status_code}")
        print(f"[参考生视频] 响应内容: {response.text}")
        
        if response.status_code != 200:
            error_detail = response.text
            print(f"[参考生视频] API错误: {error_detail}")
            return {"success": False, "error": f"API错误: {error_detail}"}
        
        result = response.json()
        
        if "output" in result and "task_id" in result["output"]:
            task_id = result["output"]["task_id"]
            print(f"[参考生视频] 任务创建成功, task_id: {task_id}")
            return {"success": True, "task_id": task_id}
        else:
            error_msg = result.get("message", "未知错误")
            print(f"[参考生视频] 创建任务失败: {error_msg}")
            return {"success": False, "error": error_msg}
    
    except requests.exceptions.RequestException as e:
        error_msg = f"API调用失败: {str(e)}"
        print(f"[参考生视频] {error_msg}")
        return {"success": False, "error": error_msg}
    except Exception as e:
        error_msg = f"创建参考生视频任务时出错: {str(e)}"
        print(f"[参考生视频] {error_msg}")
        return {"success": False, "error": error_msg}


def query_task_status(task_id):
    """
    查询任务状态
    
    Args:
        task_id: 任务ID
    
    Returns:
        dict: {'status': str, 'video_url': str, 'error': str}
    """
    try:
        url = WANX_TASK_QUERY_URL.format(task_id=task_id)
        headers = {
            "Authorization": f"Bearer {VIDEO_API_KEY}"
        }
        
        print(f"[查询任务] 正在查询任务状态, task_id: {task_id}")
        response = requests.get(url, headers=headers, timeout=30)
        
        if response.status_code != 200:
            print(f"[查询任务] 查询失败, 状态码: {response.status_code}")
            print(f"[查询任务] 响应: {response.text}")
            return {"status": "FAILED", "error": f"查询失败: {response.text}"}
        
        result = response.json()
        print(f"[查询任务] 响应: {result}")
        
        if "output" in result:
            output = result["output"]
            task_status = output.get("task_status", "UNKNOWN")
            
            print(f"[查询任务] 任务状态: {task_status}")
            
            # 任务完成，获取视频URL
            # wan2.7-i2v 返回字段: output.video_url
            if task_status == "SUCCEEDED":
                video_url = output.get("video_url", "")
                if video_url:
                    print(f"[查询任务] 视频URL: {video_url[:80]}...")
                    return {"status": task_status, "video_url": video_url}
                else:
                    print(f"[查询任务] SUCCEEDED 但未找到 video_url, output keys: {list(output.keys())}")
                    return {"status": task_status}
            else:
                return {"status": task_status}
        else:
            error_msg = result.get("message", "未知错误")
            print(f"[查询任务] 错误: {error_msg}")
            return {"status": "FAILED", "error": error_msg}
            
    except Exception as e:
        print(f"[查询任务] 异常: {str(e)}")
        return {"status": "FAILED", "error": f"查询任务状态失败: {str(e)}"}


def download_video(video_url, task_id):
    """下载视频到本地"""
    try:
        response = requests.get(video_url, timeout=120)
        response.raise_for_status()
        
        filename = f"video_{task_id}.mp4"
        local_path = os.path.join(VIDEO_SAVE_DIR, filename)
        
        with open(local_path, 'wb') as f:
            f.write(response.content)
        
        print(f"[下载视频] 成功: {filename}")
        return local_path, filename
    except Exception as e:
        print(f"[下载视频] 失败: {str(e)}")
        raise


def get_upload_policy(api_key, model_name):
    """获取文件上传凭证（阿里云百炼临时存储）"""
    url = "https://dashscope.aliyuncs.com/api/v1/uploads"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    params = {
        "action": "getPolicy",
        "model": model_name
    }
    response = requests.get(url, headers=headers, params=params, timeout=30)
    if response.status_code != 200:
        raise Exception(f"获取上传凭证失败: {response.text}")
    return response.json()['data']


def upload_file_to_oss(policy_data, file_path):
    """将文件上传到阿里云OSS临时存储"""
    from pathlib import Path
    file_name = Path(file_path).name
    key = f"{policy_data['upload_dir']}/{file_name}"

    with open(file_path, 'rb') as f:
        files = {
            'OSSAccessKeyId': (None, policy_data['oss_access_key_id']),
            'Signature': (None, policy_data['signature']),
            'policy': (None, policy_data['policy']),
            'x-oss-object-acl': (None, policy_data['x_oss_object_acl']),
            'x-oss-forbid-overwrite': (None, policy_data['x_oss_forbid_overwrite']),
            'key': (None, key),
            'success_action_status': (None, '200'),
            'file': (file_name, f)
        }
        response = requests.post(policy_data['upload_host'], files=files, timeout=120)

    if response.status_code != 200:
        raise Exception(f"上传到OSS失败: {response.text}")
    return f"oss://{key}"


def upload_file_and_get_temp_url(file_path, model_name="wan2.7-i2v"):
    """上传本地文件到阿里云临时存储，返回 oss:// 临时URL（有效48小时）"""
    print(f"[上传文件] 开始上传: {file_path}")
    policy_data = get_upload_policy(VIDEO_API_KEY, model_name)
    oss_url = upload_file_to_oss(policy_data, file_path)
    print(f"[上传文件] 成功, 临时URL: {oss_url}")
    return oss_url


# base64 data URL → MinIO公网URL 缓存（避免重复上传同一张图）
_minio_url_cache = {}

def upload_base64_for_jimeng(base64_data_url):
    """
    将 base64 data URL 上传到 MinIO，返回公网 https URL。
    需在 .env 中配置 MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY / MINIO_BUCKET。
    结果会缓存到内存中，同一张图不会重复上传。
    """
    if not all([MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_BUCKET]):
        raise ValueError(
            "参考图需要配置 MinIO。"
            "请在 .env 文件中添加："
            "MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY / MINIO_BUCKET / MINIO_CUSTOM_DOMAIN"
        )

    import hashlib
    cache_key = hashlib.md5(base64_data_url[:200].encode()).hexdigest()
    if cache_key in _minio_url_cache:
        print(f"[MinIO] 命中缓存, URL: {_minio_url_cache[cache_key]}")
        return _minio_url_cache[cache_key]

    # 解析 data URL
    try:
        header, encoded = base64_data_url.split(',', 1)
        mime_type = header.split(':')[1].split(';')[0]   # image/jpeg
        ext = mime_type.split('/')[1] if '/' in mime_type else 'png'
        if ext == 'jpeg':
            ext = 'jpg'
    except Exception:
        encoded, mime_type, ext = base64_data_url, 'image/png', 'png'

    import base64 as b64mod, io as _io
    img_bytes = b64mod.b64decode(encoded)
    object_name = f"jimeng_refs/{cache_key}.{ext}"

    # 创建 MinIO 客户端
    from minio import Minio
    _endpoint = MINIO_ENDPOINT.replace('http://', '').replace('https://', '')
    _secure   = MINIO_ENDPOINT.startswith('https://')
    client = Minio(
        endpoint=_endpoint,
        access_key=MINIO_ACCESS_KEY,
        secret_key=MINIO_SECRET_KEY,
        secure=_secure
    )

    # 确保桶存在
    try:
        if not client.bucket_exists(MINIO_BUCKET):
            client.make_bucket(MINIO_BUCKET)
            print(f"[MinIO] 创建桶: {MINIO_BUCKET}")
    except Exception as be:
        print(f"[MinIO] 检查桶异常（继续尝试上传）: {be}")

    # 上传
    client.put_object(
        bucket_name=MINIO_BUCKET,
        object_name=object_name,
        data=_io.BytesIO(img_bytes),
        length=len(img_bytes),
        content_type=mime_type
    )

    # 构造公网URL
    if MINIO_CUSTOM_DOMAIN:
        url = f"{MINIO_CUSTOM_DOMAIN.rstrip('/')}/{MINIO_BUCKET}/{object_name}"
    else:
        _proto = 'https' if _secure else 'http'
        url = f"{_proto}://{_endpoint}/{MINIO_BUCKET}/{object_name}"

    print(f"[MinIO] 上传成功: {url}")
    _minio_url_cache[cache_key] = url
    return url


# ==================== Flask路由 ====================

@app.route('/')
def index():
    """渲染主页面"""
    return render_template('index.html')


@app.route('/api/generate-image', methods=['POST'])
def api_generate_image():
    """生成图片API"""
    try:
        data = request.json
        prompt = data.get('prompt', '').strip()
        negative_prompt = data.get('negative_prompt', '').strip()
        size = data.get('size', '2K')
        reference_images = data.get('reference_images', [])
        model = data.get('model', 'wanx')  # wanx=通义万相, jimeng=即梦AI
        # 接收页面传入的API配置（覆盖默认）
        page_api_key = data.get('api_key', '').strip() or None
        page_base_url = data.get('base_url', '').strip() or None
        # 如果提供了base_url，拼接具体接口路径
        page_api_url = None
        if page_base_url:
            page_api_url = page_base_url.rstrip('/') + '/api/v1/services/aigc/multimodal-generation/generation'
        
        if not prompt:
            return jsonify({"success": False, "error": "请输入图片描述"}), 400
        
        # 调用文生图API
        result = generate_image(prompt, negative_prompt, size, reference_images,
                                api_key=page_api_key, api_url=page_api_url, model=model)
        
        if result["success"]:
            return jsonify({
                "success": True,
                "image_url": result["image_url"],
                "local_path": result["local_path"],
                "filename": result["filename"]
            })
        else:
            return jsonify({"success": False, "error": result["error"]}), 500
            
    except Exception as e:
        return jsonify({"success": False, "error": f"服务器错误: {str(e)}"}), 500


@app.route('/api/generate-video', methods=['POST'])
def api_generate_video():
    """生成视频API - 支持通义万相i2v/r2v、即梦"""
    try:
        data = request.json
        image_url = data.get('image_url', '').strip()
        prompt = data.get('prompt', '').strip()
        negative_prompt = data.get('negative_prompt', '').strip()
        resolution = data.get('resolution', '720P')
        duration = data.get('duration', 5)
        model = data.get('model', 'wanx')  # wanx / r2v / jimeng
        reference_images = data.get('reference_images', [])  # r2v 参考图列表
        # 接收页面传入的API配置
        page_api_key = data.get('api_key', '').strip() or None
        page_base_url = data.get('base_url', '').strip() or None
        page_api_url = None
        if page_base_url:
            page_api_url = page_base_url.rstrip('/') + '/api/v1/services/aigc/video-generation/video-synthesis'
        
        if not prompt:
            return jsonify({"success": False, "error": "缺少视频描述"}), 400
        
        if model == 'jimeng':
            # 即梦视频生成
            result = create_video_task_jimeng(image_url if image_url else None, prompt, negative_prompt, duration)
        elif model == 'r2v':
            # 通义万相参考生视频 (wan2.7-r2v)
            # reference_images: 参考图URL列表（人物三视图等）
            # image_url: 可选首帧图（可以是纯背景）
            result = create_video_task_r2v(
                prompt,
                reference_images=reference_images if reference_images else None,
                first_frame_url=image_url if image_url else None,
                negative_prompt=negative_prompt,
                resolution=resolution,
                duration=duration,
                api_key=page_api_key,
                api_url=page_api_url
            )
        else:
            # 通义万相图生视频 (wan2.7-i2v)
            if not image_url:
                return jsonify({"success": False, "error": "通义万相需要提供首帧图片"}), 400
            result = create_video_task(image_url, prompt, negative_prompt, resolution, duration,
                                       api_key=page_api_key, api_url=page_api_url)
        
        if result["success"]:
            return jsonify({
                "success": True,
                "task_id": result["task_id"]
            })
        else:
            return jsonify({"success": False, "error": result["error"]}), 500
            
    except Exception as e:
        return jsonify({"success": False, "error": f"服务器错误: {str(e)}"}), 500


@app.route('/api/task/<task_id>', methods=['GET'])
def api_query_task(task_id):
    """查询任务状态API - 支持通义万相和即梦"""
    try:
        # 判断是否是即梦任务
        if task_id.startswith('jimeng_'):
            real_task_id = task_id[7:]  # 去掉 jimeng_ 前缀
            result = query_task_jimeng(real_task_id)
        else:
            result = query_task_status(task_id)
        
        print(f"[查询任务] 任务状态: {result['status']}")
        
        if result["status"] == "SUCCEEDED" and result.get("video_url"):
            print(f"[查询任务] 正在下载视频...")
            print(f"[查询任务] 视频URL: {result['video_url'][:80]}...")
            
            try:
                # 下载视频到本地
                local_path, filename = download_video(result["video_url"], task_id)
                result["local_path"] = local_path
                result["filename"] = filename
                print(f"[查询任务] 下载成功: {filename}")
            except Exception as download_error:
                print(f"[查询任务] 下载失败: {str(download_error)}")
                # 即使下载失败，也返回成功状态和URL
                result["download_error"] = str(download_error)
        
        # 打印返回给前端的完整数据
        print(f"[查询任务] 返回数据 keys: {list(result.keys())}")
        print(f"[查询任务] filename: {result.get('filename', 'NOT_SET')}")
        
        return jsonify(result)
        
    except Exception as e:
        print(f"[查询任务] API处理异常: {str(e)}")
        return jsonify({"status": "FAILED", "error": f"服务器错误: {str(e)}"}), 500


@app.route('/api/upload-image', methods=['POST'])
def api_upload_image():
    """上传图片API - 用于参考图上传"""
    try:
        if 'image' not in request.files:
            return jsonify({"success": False, "error": "没有图片文件"}), 400
        
        file = request.files['image']
        if file.filename == '':
            return jsonify({"success": False, "error": "文件名为空"}), 400
        
        # 保存文件
        filename = f"ref_{uuid.uuid4().hex[:8]}_{file.filename}"
        filepath = os.path.join(IMAGE_SAVE_DIR, filename)
        file.save(filepath)
        
        # 转换为Base64供API使用
        with open(filepath, 'rb') as f:
            image_data = f.read()
        
        base64_data = base64.b64encode(image_data).decode('utf-8')
        mime_type = "image/png" if filename.endswith('.png') else "image/jpeg"
        base64_url = f"data:{mime_type};base64,{base64_data}"
        
        return jsonify({
            "success": True,
            "filename": filename,
            "base64_url": base64_url,
            "local_path": filepath
        })
        
    except Exception as e:
        return jsonify({"success": False, "error": f"上传失败: {str(e)}"}), 500


@app.route('/api/upload-for-video', methods=['POST'])
def api_upload_for_video():
    """上传本地图片为视频生成使用。
    同时上传到：
      - 阿里云DashScope临时存储(返回 oss:// URL, 供通义万相使用)
      - MinIO公网存储(返回 https:// URL, 供即梦使用)
    """
    try:
        if 'image' not in request.files:
            return jsonify({"success": False, "error": "没有图片文件"}), 400
        
        file = request.files['image']
        if file.filename == '':
            return jsonify({"success": False, "error": "文件名为空"}), 400
        
        # 保存文件到本地
        filename = f"upload_{uuid.uuid4().hex[:8]}_{file.filename}"
        filepath = os.path.join(IMAGE_SAVE_DIR, filename)
        file.save(filepath)
        print(f"[上传视频图片] 保存本地: {filepath}")
        
        # 校验图片尺寸（wan2.7-i2v 要求最小 240x240）
        try:
            from PIL import Image as PILImage
            with PILImage.open(filepath) as img:
                w, h = img.size
            if w < 240 or h < 240:
                os.remove(filepath)
                return jsonify({
                    "success": False,
                    "error": f"图片尺寸太小（{w}×{h}），视频生成要求最小 240×240，请换一张图片"
                }), 400
            print(f"[上传视频图片] 尺寸校验通过: {w}×{h}")
        except Exception as pe:
            print(f"[上传视频图片] 尺寸校验跳过: {pe}")
        oss_url = upload_file_and_get_temp_url(filepath, model_name="wan2.7-i2v")
        
        # 同时上传到MinIO，获取 https:// URL（供即梦使用）
        https_url = None
        if all([MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_BUCKET]):
            try:
                import io as _io
                from minio import Minio
                _ep = MINIO_ENDPOINT.replace('http://', '').replace('https://', '')
                _secure = MINIO_ENDPOINT.startswith('https://')
                client = Minio(endpoint=_ep, access_key=MINIO_ACCESS_KEY,
                               secret_key=MINIO_SECRET_KEY, secure=_secure)
                object_name = f"jimeng_video_src/{filename}"
                with open(filepath, 'rb') as fh:
                    data = fh.read()
                client.put_object(
                    MINIO_BUCKET, object_name,
                    _io.BytesIO(data), len(data),
                    content_type=file.content_type or 'image/png'
                )
                if MINIO_CUSTOM_DOMAIN:
                    https_url = f"{MINIO_CUSTOM_DOMAIN.rstrip('/')}/{MINIO_BUCKET}/{object_name}"
                else:
                    _proto = 'https' if _secure else 'http'
                    https_url = f"{_proto}://{_ep}/{MINIO_BUCKET}/{object_name}"
                print(f"[上传视频图片] MinIO URL: {https_url}")
            except Exception as me:
                print(f"[上传视频图片] MinIO上传失败（即梦模型无法使用首帧图）: {me}")
        
        return jsonify({
            "success": True,
            "filename": filename,
            "oss_url": oss_url,        # 通义万相使用
            "https_url": https_url,    # 即梦使用（若MinIO未配置则为null）
            "local_path": filepath
        })
        
    except Exception as e:
        print(f"[上传视频图片] 失败: {str(e)}")
        return jsonify({"success": False, "error": f"上传失败: {str(e)}"}), 500


@app.route('/api/full-pipeline', methods=['POST'])
def api_full_pipeline():
    """完整流程API - 一键生成"""
    try:
        data = request.json
        image_prompt = data.get('image_prompt', '').strip()
        video_prompt = data.get('video_prompt', '').strip()
        negative_prompt = data.get('negative_prompt', '').strip()
        size = data.get('size', '2K')
        resolution = data.get('resolution', '720P')
        duration = data.get('duration', 5)
        reference_images = data.get('reference_images', [])
        
        if not image_prompt or not video_prompt:
            return jsonify({"success": False, "error": "请输入图片描述和视频描述"}), 400
        
        # 阶段1: 生成图片
        print("[完整流程] 阶段1: 生成图片")
        image_result = generate_image(image_prompt, negative_prompt, size, reference_images)
        
        if not image_result["success"]:
            return jsonify({
                "success": False,
                "stage": "image",
                "error": image_result["error"]
            }), 500
        
        # 阶段2: 生成视频
        print("[完整流程] 阶段2: 生成视频")
        # 使用本地图片的Base64
        image_for_video = upload_image_to_temp_url(image_result["local_path"])
        
        video_result = create_video_task(
            image_for_video, 
            video_prompt, 
            negative_prompt, 
            resolution, 
            duration
        )
        
        if not video_result["success"]:
            return jsonify({
                "success": False,
                "stage": "video",
                "task_id": video_result.get("task_id"),
                "error": video_result["error"],
                "image_url": image_result["image_url"],
                "image_filename": image_result["filename"]
            }), 500
        
        return jsonify({
            "success": True,
            "task_id": video_result["task_id"],
            "image_url": image_result["image_url"],
            "image_filename": image_result["filename"],
            "message": "视频任务已创建,请轮询任务状态"
        })
        
    except Exception as e:
        return jsonify({"success": False, "error": f"服务器错误: {str(e)}"}), 500


@app.route('/images/<filename>')
def serve_image(filename):
    """提供图片文件访问"""
    return send_from_directory(IMAGE_SAVE_DIR, filename)


@app.route('/videos/<filename>')
def serve_video(filename):
    """提供视频文件访问"""
    return send_from_directory(VIDEO_SAVE_DIR, filename)


# ==================== 分镜规划（千问大模型） ====================

# ==================== VLM 视频评审 ====================

REVIEW_SYSTEM_PROMPT = """你是一名专业的AI视频质量评审员。观看提供的视频片段，对照分镜提示词，从以下4个维度进行评审。

输出严格的JSON格式，不要包含任何额外文字或Markdown标记：
{
  "overall_score": 1-10的整数,
  "scene_match": {"score": 1-10, "comment": "场景/内容与提示词的匹配程度说明"},
  "motion_quality": {"score": 1-10, "comment": "人物/物体动作是否流畅自然的说明"},
  "visual_quality": {"score": 1-10, "comment": "画面构图、光影、清晰度说明"},
  "consistency": {"score": 1-10, "comment": "与场景描述中人物外貌/服装的一致性说明"},
  "suggestion": "简短改进建议（1-2句）"
}

评分标准：9-10优秀，7-8良好，5-6一般，3-4较差，1-2很差。"""


def review_video_with_vlm(video_url, scene_prompt, api_key=None):
    """
    使用千问vlm模型对视频进行场景匹配度评审

    Args:
        video_url: 视频公网可访问CDN URL
        scene_prompt: 分镜提示词（评审参考依据）
        api_key: 可选，覆盖QWEN_API_KEY

    Returns:
        dict: {'success': bool, 'review': dict, 'error': str}
    """
    import json
    _api_key = api_key or QWEN_API_KEY
    if not _api_key:
        return {"success": False, "error": "未配置QWEN_API_KEY"}

    headers = {
        "Authorization": f"Bearer {_api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": "qwen-vl-max",
        "messages": [
            {"role": "system", "content": CURRENT_REVIEW_PROMPT or REVIEW_SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "video", "video": video_url},
                {"type": "text", "text": f"分镜提示词：{scene_prompt}"}
            ]}
        ]
    }
    try:
        resp = requests.post(QWEN_API_URL, json=payload, headers=headers, timeout=120)
        resp.raise_for_status()
        raw = resp.json()
        content = raw["choices"][0]["message"]["content"]
        # 去掉可能的Markdown代码块包裹
        content = content.strip()
        if content.startswith("```"):
            content = content.split("\n", 1)[-1]
        if content.endswith("```"):
            content = content.rsplit("```", 1)[0]
        review = json.loads(content.strip())
        return {"success": True, "review": review}
    except json.JSONDecodeError as e:
        return {"success": False, "error": f"VLM返回格式异常：{str(e)}，原始内容：{content[:200]}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


@app.route('/api/review-video', methods=['POST'])
def api_review_video():
    """视频VLM评审API"""
    try:
        data = request.json
        video_url    = data.get('video_url', '').strip()
        scene_prompt = data.get('scene_prompt', '').strip()
        if not video_url:
            return jsonify({"success": False, "error": "缺少视频URL"}), 400
        result = review_video_with_vlm(video_url, scene_prompt)
        return jsonify(result)
    except Exception as e:
        return jsonify({"success": False, "error": f"服务器错误: {str(e)}"}), 500


EVOLVE_SYSTEM_PROMPT = """你是一名提示词优化专家。我将提供一批AI视频评审案例，以及用户对每次评审结果的文字纠正。
请分析用户反馈中反复出现的问题（如哪些情况被高估、哪些细节被忽视、哪些评分标准与用户实际认知不符），
然后重写评审系统提示词，使其更符合用户的判断标准。

要求：
1. 保留原提示词的四个评审维度和 JSON 输出格式（不能改变结构）
2. 针对用户反馈中的具体问题调整评分标准
3. 可以新增评分细则和示例
4. 只输出新的系统提示词全文，不要包含任何解释。"""


@app.route('/api/review-feedback', methods=['POST'])
def api_review_feedback():
    """保存用户对VLM评审结果的反馈"""
    try:
        data = request.json
        user_feedback = data.get('user_feedback', '').strip()
        if not user_feedback:
            return jsonify({"success": False, "error": "反馈内容不能为空"}), 400

        # 加载当前提示词版本号
        current_version = "v1"
        if os.path.exists(PROMPTS_FILE):
            with open(PROMPTS_FILE, 'r', encoding='utf-8') as f:
                prompts_data = json.load(f)
            current_version = prompts_data.get('current_version', 'v1')

        record = {
            "timestamp": datetime.now().isoformat(),
            "video_url": data.get('video_url', ''),
            "scene_prompt": data.get('scene_prompt', ''),
            "vlm_output": data.get('vlm_output', {}),
            "user_feedback": user_feedback,
            "prompt_version": current_version
        }
        with open(FEEDBACK_FILE, 'a', encoding='utf-8') as f:
            f.write(json.dumps(record, ensure_ascii=False) + '\n')

        # 统计总条数
        total = sum(1 for _ in open(FEEDBACK_FILE, 'r', encoding='utf-8'))
        return jsonify({"success": True, "total_feedbacks": total})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/evolve-review-prompt', methods=['POST'])
def api_evolve_review_prompt():
    """读取全部反馈，用千问分析并重写评审提示词"""
    global CURRENT_REVIEW_PROMPT
    try:
        if not os.path.exists(FEEDBACK_FILE):
            return jsonify({"success": False, "error": "暂无反馈记录"}), 400

        feedbacks = []
        with open(FEEDBACK_FILE, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line:
                    feedbacks.append(json.loads(line))

        if not feedbacks:
            return jsonify({"success": False, "error": "暂无反馈记录"}), 400

        # 构造千问请求：反馈案例 + 当前提示词
        cases_text = ""
        for i, fb in enumerate(feedbacks, 1):
            cases_text += f"""
案例{i}:
- 视频摈景描述: {fb.get('scene_prompt', '')[:200]}
- VLM评审结果: 综合评分={fb.get('vlm_output', {}).get('overall_score', '?')}
- 用户纠正反馈: {fb.get('user_feedback', '')}
"""

        user_msg = f"""当前评审提示词：
---
{CURRENT_REVIEW_PROMPT or REVIEW_SYSTEM_PROMPT}
---

用户反馈案例（共{len(feedbacks)}条）：
{cases_text}

请根据以上反馈重写评审系统提示词。"""

        headers = {
            "Authorization": f"Bearer {QWEN_API_KEY}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": "qwen-plus",
            "messages": [
                {"role": "system", "content": EVOLVE_SYSTEM_PROMPT},
                {"role": "user",   "content": user_msg}
            ]
        }
        resp = requests.post(QWEN_API_URL, json=payload, headers=headers, timeout=120)
        resp.raise_for_status()
        new_prompt = resp.json()["choices"][0]["message"]["content"].strip()

        # 版本号递增
        with open(PROMPTS_FILE, 'r', encoding='utf-8') as f:
            prompts_data = json.load(f)
        versions = prompts_data.get('versions', [])
        last_ver_num = int(versions[-1]['version'].lstrip('v')) if versions else 0
        new_version = f"v{last_ver_num + 1}"

        versions.append({
            "version": new_version,
            "created_at": datetime.now().isoformat(),
            "feedback_count_at_creation": len(feedbacks),
            "prompt": new_prompt
        })
        prompts_data['current_version'] = new_version
        with open(PROMPTS_FILE, 'w', encoding='utf-8') as f:
            json.dump(prompts_data, f, ensure_ascii=False, indent=2)

        CURRENT_REVIEW_PROMPT = new_prompt
        return jsonify({"success": True, "new_version": new_version,
                        "feedback_count": len(feedbacks),
                        "new_prompt_preview": new_prompt[:200]})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/review-status', methods=['GET'])
def api_review_status():
    """返回当前提示词版本、反馈总数、版本历史"""
    try:
        # 统计反馈条数
        feedback_count = 0
        recent_feedbacks = []
        if os.path.exists(FEEDBACK_FILE):
            all_lines = [l.strip() for l in open(FEEDBACK_FILE, 'r', encoding='utf-8') if l.strip()]
            feedback_count = len(all_lines)
            for line in all_lines[-5:]:
                fb = json.loads(line)
                recent_feedbacks.append({
                    "timestamp": fb.get('timestamp', ''),
                    "user_feedback": fb.get('user_feedback', '')[:100],
                    "prompt_version": fb.get('prompt_version', '')
                })
            recent_feedbacks.reverse()

        # 版本历史
        versions = []
        current_version = "v1"
        if os.path.exists(PROMPTS_FILE):
            with open(PROMPTS_FILE, 'r', encoding='utf-8') as f:
                prompts_data = json.load(f)
            current_version = prompts_data.get('current_version', 'v1')
            for v in reversed(prompts_data.get('versions', [])):
                versions.append({
                    "version": v['version'],
                    "created_at": v.get('created_at', ''),
                    "feedback_count_at_creation": v.get('feedback_count_at_creation', 0),
                    "prompt_preview": v['prompt'][:300]
                })

        return jsonify({
            "success": True,
            "current_version": current_version,
            "feedback_count": feedback_count,
            "recent_feedbacks": recent_feedbacks,
            "versions": versions
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ==================== 分镜规划（千问大模型） ====================

SCENE_SYSTEM_PROMPT = """你是一位世界顶级的分镜脚本大师和AI生成提示词专家，拥有20年电影分镜、动画分镜经验，精通电影视觉语言、构图美学、光影设计、叙事节奏和镜头衔接。

你的任务：把用户的场景描述拆分成若干个专业电影分镜，为每个分镜提供高度细化的四组内容，并设计分镜间的衔接方案。

══════════════════════════════════════
一、文生图提示词 (image_prompt)
══════════════════════════════════════
- 语言：中文
- 字数：200~400字
- 必须包含以下要素，逐条清晰罗列：
  1) 画面风格与色调：如「动画风格，明亮色彩，傍晚柔光」「赛博朋克，霓虹冷色调，夜雨反光」
  2) 场景环境描述：详细描述场景空间、地面、天空、远景、近景中的环境元素
  3) 每个人物/角色的独立描述：逐一描写每个人物的外貌特征、服装颜色款式、表情、姿态动作、手持物品、在画面中的位置关系（如「位于画面左侧靠前」「跟在右侧后方」）
  4) 人物间的互动关系与空间错落
  5) 构图说明：镜头类型（极近景/近景/中景/中全景/全景/远景/鸟瞰/仰拍/俯拍）+ 人物排列方式 + 视线/道路延伸方向
  6) 光线说明：光源方向、光质（硬光/柔光/散射光/逆光/侧光）、色温
  7) 禁止项：明确列出本镜头不允许出现的元素（格式：「禁止：xxx、xxx、xxx」）
- 不得使用人物姓名，必须用外貌特征描述替代（如「穿粉色羽绒服的10岁女孩」）
- 画质词必包含：电影级画面、超高清、高饱和度

══════════════════════════════════════
二、文生视频提示词 (video_prompt)
══════════════════════════════════════
- 语言：中文
- 字数：200~400字
- 必须逐条包含以下要素：
  1) 镜头运动：固定/推/拉/摇/移/跟/环绕，具体方向和速度
  2) 每个人物的动态描述：分别描写每个角色在这几秒内的具体动作序列、肢体变化、表情变化
  3) 人物间互动：对话动作、眼神交流、肢体接触等
  4) 环境动态：风吹树叶、水面波光、烟雾飘动等可见的场景运动
  5) 光影节奏：光线是否有变化、明暗过渡
  6) 音效描述：逐条列出本镜头应包含的音效层次——主体音效（人物动作产生的声音）、对白/语气音效（人物说话、笑声、叹息等，用引号标注具体台词）、环境音效（风声、水声、鸟鸣、车流等背景声）、情绪配乐（如需要，配乐风格简述）
  7) 禁止项：明确列出不允许出现的动态（格式：「禁止：xxx、xxx」）

══════════════════════════════════════
三、时长与节奏 (duration)
══════════════════════════════════════
- 给出建议时长（如「6秒」「8秒」）
- 简述节奏感（如「前慢后快」「均匀平稳」「渐入高潮」）

══════════════════════════════════════
四、分镜衔接设计
══════════════════════════════════════
- 每个分镜（除第一个）必须包含 transition 字段，说明与上一个分镜的衔接方式：
  * 衔接手法：硬切/叠化/淡入淡出/匹配剪辑/运动衔接/视线衔接/声音过渡等
  * 衔接逻辑：为什么这样衔接，如「上一镜人物视线望向远方，本镜切为远方的全景，形成视线衔接」
  * 情绪过渡：两个镜头间的情绪是递进、转折、还是延续
- 确保整体叙事流畅，避免突兀跳切

══════════════════════════════════════
六、全局规范
══════════════════════════════════════
- 分镜数量：根据场景复杂度决定，建议 3~8 个分镜
- 人物一致性：同一人物在不同分镜中的外貌描述必须完全一致（服装颜色、发型、体型等）
- 叙事连贯性：分镜序列必须构成完整的叙事弧线（开端→发展→高潮→收束）
- 视觉多样性：相邻分镜的镜头类型、构图方式应有变化，避免单调重复

══════════════════════════════════════
六、全局规范
══════════════════════════════════════
- 【格式铁律】所有JSON字段值只能是字符串或数字，绝对禁止嵌套数组[]或对象{}
- transition 必须是一段连贯的描述文字，禁止返回对象

══════════════════════════════════════
输出 JSON 格式（严格遵守，不返回任何其他内容）：
══════════════════════════════════════
{
  "total_scenes": 数字,
  "story_summary": "故事摘要（中文，80字内，概括整个分镜序列的叙事主线）",
  "scenes": [
    {
      "scene_number": 1,
      "scene_title": "分镜标题（4~8字，如'河岸欢乐骑行'）",
      "scene_desc": "分镜说明（中文，30~60字，说明这个镜头在叙事中的作用）",
      "shot_type": "镜头类型（如'中全景'、'特写'、'鸟瞰'）",
      "mood": "情绪氛围（如'欢快温馨'、'紧张压抑'）",
      "image_prompt": "文生图提示词（200~400字，按上述七要素逐条展开）",
      "video_prompt": "文生视频提示词（200~400字，按上述七要素逐条展开，含音效描述）",
      "duration": "建议时长与节奏（如'6秒，均匀平稳'）",
      "transition": "（纯字符串）衔接手法——逻辑说明——情绪过渡。如：匹配剪辑——上一镜风筝升空视线延伸到本镜天空全景——由欢快渐入宁静"
    }
  ]
}"""


SCENE_REVIEW_SYSTEM_PROMPT = """你是一位专业的分镜脚本评审专家。请对输入的【整组分镜序列】做全局评审。

评审要求：
1. 站在整体叙事角度，评估每个分镜在故事中的位置和衔接是否合理
2. 评估各分镜的时长分配是否与叙事节奏匹配
3. 评估分镜间的 transition（衔接）是否自然流畅
4. 评估整体是否构成完整的叙事弧线（开端→发展→高潮→收束）
5. 指出问题分镜及具体改进建议

每个分镜满分 10 分，四维度：
- narrative（叙事作用）：该分镜在整体故事中是否有明确引导作用
- image_prompt_score（文生图提示词质量）：要素完整性、画面描述精细度
- video_prompt_score（视频提示词质量）：镜头运动、人物动态、音效描述完整度
- transition_score（衔接合理性）：与前后分镜的衔接是否自然，第一个分镜评估其作为开场的合理性

严格返回 JSON，不得包含其他内容：
{
  "overall_score": 数字 (整组评分),
  "overall_comment": "中文整体评价，80字内",
  "scenes": [
    {
      "scene_number": 数字,
      "narrative": 数字,
      "image_prompt_score": 数字,
      "video_prompt_score": 数字,
      "transition_score": 数字,
      "score": 数字 (四维平均),
      "suggestion": "中文针对该分镜的改进建议，60字内"
    }
  ]
}"""


SCENE_EVOLVE_SYSTEM_PROMPT = """你是一位专业的分镜脚本生成系统提示词优化专家。
你会收到以下输入：
1. 当前系统提示词（即现在用来生成分镜的指令）
2. 用户对历次分镜结果的反馈列表

你的目标：分析反馈中的共性问题，有针对性地修订提示词中的相应章节或要求，生成完整的新版系统提示词。
要求：
- 保持原提示词的 JSON 格式要求不变
- 只输出新版完整提示词文本，不得添加其他说明文字或 markdown"""


def split_scenes_with_qwen(description, style="电影感写实", num_scenes="auto", api_key=None, model="qwen-plus"):
    """调用千问大模型将场景描述拆分为分镜"""
    _api_key = api_key or QWEN_API_KEY
    _model   = model or "qwen-plus"
    
    user_prompt = f"场景描述：{description}\n画面风格：{style}"
    if num_scenes != "auto" and str(num_scenes).isdigit():
        user_prompt += f"\n请生成 {num_scenes} 个分镜"
    else:
        user_prompt += "\n请根据内容复杂度自动决定分镜数量（3≈8个）"
    
    payload = {
        "model": _model,
        "messages": [
                {"role": "system", "content": CURRENT_SCENE_PROMPT or SCENE_SYSTEM_PROMPT},
            {"role": "user",   "content": user_prompt}
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.75,
        "max_tokens": 4096
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {_api_key}"
    }
    print(f"[分镜规划] 调用 {_model}, 场景: {description[:40]}...")
    resp = requests.post(QWEN_API_URL, json=payload, headers=headers, timeout=1200)
    print(f"[分镜规划] HTTP状态码: {resp.status_code}")
    if not resp.ok:
        print(f"[分镜规划] 错误响应体: {resp.text[:500]}")
    resp.raise_for_status()
    content = resp.json()["choices"][0]["message"]["content"]
    print(f"[分镜规划] 模型返回内容 ({len(content)}字): {content[:200]}...")
    return json.loads(content)


@app.route('/api/split-scenes', methods=['POST'])
def api_split_scenes():
    """分镜拆分接口"""
    try:
        data = request.json
        description = data.get('description', '').strip()
        style       = data.get('style', '电影感写实').strip()
        num_scenes  = data.get('num_scenes', 'auto')
        api_key     = data.get('api_key', '').strip() or None
        model       = data.get('model', 'qwen-plus').strip() or 'qwen-plus'
        
        if not description:
            return jsonify({'success': False, 'error': '请输入场景描述'}), 400
        
        result = split_scenes_with_qwen(description, style, num_scenes, api_key, model)
        return jsonify({'success': True, 'data': result})
    except json.JSONDecodeError as e:
        print(f"[分镜规划] JSON解析失败: {e}")
        return jsonify({'success': False, 'error': f'模型返回格式错误: {str(e)}'}), 500
    except requests.exceptions.RequestException as e:
        print(f"[分镜规划] 网络请求异常: {e}")
        return jsonify({'success': False, 'error': f'千问API调用失败: {str(e)}'}), 500
    except Exception as e:
        import traceback
        print(f"[分镜规划] 未知异常: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'error': f'服务器错误: {str(e)}'}), 500


@app.route('/api/review-scene', methods=['POST'])
def api_review_scene():
    """全部分镜全局评审接口"""
    try:
        data = request.json
        scenes = data.get('scenes', [])
        api_key = data.get('api_key', '').strip() or None
        _api_key = api_key or QWEN_API_KEY

        if not scenes:
            return jsonify({'success': False, 'error': '没有分镜数据'}), 400

        # 构建分镜序列概览
        timeline = '\n'.join(
            f"分镜{ s.get('scene_number','') }｜{s.get('scene_title','')}｜时长{s.get('duration','')}｜衔接：{s.get('transition','')}"
            for s in scenes
        )
        scene_details = '\n\n'.join(
            f"=== 分镜{s.get('scene_number','')} ===\n标题：{s.get('scene_title','')}\n说明：{s.get('scene_desc','')}\n镜头：{s.get('shot_type','')}｜情绪：{s.get('mood','')}\n文生图提示词：{s.get('image_prompt','')}\n视频提示词：{s.get('video_prompt','')}"
            for s in scenes
        )
        user_prompt = f"""请评审以下整组分镜序列：

分镜时间线：
{timeline}

各分镜详细内容：
{scene_details}

请站在整体叙事角度评审每个分镜的合理性，返回JSON。"""

        payload = {
            "model": "qwen-max",
            "messages": [
                {"role": "system", "content": SCENE_REVIEW_SYSTEM_PROMPT},
                {"role": "user",   "content": user_prompt}
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.3,
            "max_tokens": 2048
        }
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {_api_key}"
        }
        print(f"[分镜评审] 全局评审 {len(scenes)} 个分镜")
        resp = requests.post(QWEN_API_URL, json=payload, headers=headers, timeout=120)
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"]
        review = json.loads(content)
        return jsonify({'success': True, 'review': review})
    except Exception as e:
        print(f"[分镜评审] 异常: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/scene-feedback', methods=['POST'])
def api_scene_feedback():
    """存储分镜反馈"""
    try:
        data = request.json
        record = {
            "timestamp":    datetime.now().isoformat(),
            "scene_number": data.get('scene_number'),
            "scene_title":  data.get('scene_title', ''),
            "scene_data":   data.get('scene_data', {}),
            "review_output":data.get('review_output', {}),
            "user_feedback":data.get('user_feedback', '').strip()
        }
        if not record['user_feedback']:
            return jsonify({'success': False, 'error': '反馈内容不能为空'}), 400
        with open(SCENE_FEEDBACK_FILE, 'a', encoding='utf-8') as f:
            f.write(json.dumps(record, ensure_ascii=False) + '\n')
        total = sum(1 for _ in open(SCENE_FEEDBACK_FILE, 'r', encoding='utf-8'))
        print(f"[分镜反馈] 已存储，共 {total} 条")
        return jsonify({'success': True, 'total_feedbacks': total})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/evolve-scene-prompt', methods=['POST'])
def api_evolve_scene_prompt():
    """读取分镜反馈、千问重写分镜生成系统提示词"""
    global CURRENT_SCENE_PROMPT
    try:
        if not os.path.exists(SCENE_FEEDBACK_FILE):
            return jsonify({'success': False, 'error': '还没有反馈数据'}), 400
        feedbacks = []
        with open(SCENE_FEEDBACK_FILE, 'r', encoding='utf-8') as f:
            for line in f:
                try:
                    feedbacks.append(json.loads(line.strip()))
                except Exception:
                    pass
        if not feedbacks:
            return jsonify({'success': False, 'error': '反馈列表为空'}), 400

        current_prompt = CURRENT_SCENE_PROMPT or SCENE_SYSTEM_PROMPT
        fb_text = '\n'.join(
            f"[{i+1}] 分镜{r.get('scene_number','')}《{r.get('scene_title','')}》：{r.get('user_feedback','')}"
            for i, r in enumerate(feedbacks[-30:])
        )
        user_prompt = (
            f"当前系统提示词：\n{current_prompt}\n\n"
            f"用户反馈（最近 {len(feedbacks[-30:])} 条）：\n{fb_text}\n\n"
            "请输出优化后的完整系统提示词。"
        )

        api_key = QWEN_API_KEY
        payload = {
            "model": "qwen-max",
            "messages": [
                {"role": "system", "content": SCENE_EVOLVE_SYSTEM_PROMPT},
                {"role": "user",   "content": user_prompt}
            ],
            "temperature": 0.5,
            "max_tokens": 8192
        }
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}"
        }
        print(f"[分镜进化] 开始分析 {len(feedbacks)} 条反馈...")
        resp = requests.post(QWEN_API_URL, json=payload, headers=headers, timeout=300)
        resp.raise_for_status()
        new_prompt = resp.json()["choices"][0]["message"]["content"].strip()

        # 写入新版本
        with open(SCENE_PROMPTS_FILE, 'r', encoding='utf-8') as f:
            pdata = json.load(f)
        versions = pdata.get('versions', [])
        last_ver_num = int(versions[-1]['version'].lstrip('v')) if versions else 0
        new_ver = f"v{last_ver_num + 1}"
        versions.append({
            "version":                  new_ver,
            "created_at":               datetime.now().isoformat(),
            "feedback_count_at_creation": len(feedbacks),
            "prompt":                   new_prompt
        })
        pdata['current_version'] = new_ver
        pdata['versions'] = versions
        with open(SCENE_PROMPTS_FILE, 'w', encoding='utf-8') as f:
            json.dump(pdata, f, ensure_ascii=False, indent=2)
        CURRENT_SCENE_PROMPT = new_prompt
        print(f"[分镜进化] 完成，新版本 {new_ver}")
        return jsonify({'success': True, 'new_version': new_ver, 'feedback_count': len(feedbacks)})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/scene-status', methods=['GET'])
def api_scene_status():
    """分镜生成系统状态查询"""
    try:
        feedback_count = 0
        if os.path.exists(SCENE_FEEDBACK_FILE):
            feedback_count = sum(1 for _ in open(SCENE_FEEDBACK_FILE, 'r', encoding='utf-8'))
        versions = []
        current_version = 'v1'
        if os.path.exists(SCENE_PROMPTS_FILE):
            with open(SCENE_PROMPTS_FILE, 'r', encoding='utf-8') as f:
                pdata = json.load(f)
            current_version = pdata.get('current_version', 'v1')
            for v in pdata.get('versions', []):
                versions.append({
                    'version':                  v['version'],
                    'created_at':               v.get('created_at', ''),
                    'feedback_count_at_creation': v.get('feedback_count_at_creation', 0),
                    'prompt_preview':           v['prompt'][:120]
                })
        return jsonify({
            'success':         True,
            'current_version': current_version,
            'feedback_count':  feedback_count,
            'versions':        versions
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/characters', methods=['GET'])
def api_get_characters():
    """获取人物库列表"""
    characters = load_characters()
    # 返回时不包含完整base64（列表页只需要缩略图）
    result = []
    for char in characters:
        result.append({
            'id': char['id'],
            'name': char['name'],
            'created_at': char.get('created_at', ''),
            'image_count': len(char.get('images', [])),
            'thumbnail': char['images'][0]['base64_url'] if char.get('images') else None
        })
    return jsonify({'success': True, 'characters': result})


@app.route('/api/characters/<char_id>', methods=['GET'])
def api_get_character(char_id):
    """获取单个人物详情（含完整base64）"""
    characters = load_characters()
    char = next((c for c in characters if c['id'] == char_id), None)
    if not char:
        return jsonify({'success': False, 'error': '人物不存在'}), 404
    return jsonify({'success': True, 'character': char})


@app.route('/api/characters', methods=['POST'])
def api_create_character():
    """创建新人物"""
    try:
        data = request.json
        name = data.get('name', '').strip()
        images = data.get('images', [])  # [{filename, base64_url}]
        
        if not name:
            return jsonify({'success': False, 'error': '请输入人物名称'}), 400
        if not images:
            return jsonify({'success': False, 'error': '请至少上传一张参考图'}), 400
        
        characters = load_characters()
        
        # 检查名称是否重复
        if any(c['name'] == name for c in characters):
            return jsonify({'success': False, 'error': f'人物“{name}”已存在'}), 400
        
        new_char = {
            'id': uuid.uuid4().hex[:12],
            'name': name,
            'images': images,
            'created_at': datetime.now().strftime('%Y-%m-%d %H:%M')
        }
        characters.append(new_char)
        save_characters(characters)
        
        return jsonify({
            'success': True,
            'character': {
                'id': new_char['id'],
                'name': new_char['name'],
                'created_at': new_char['created_at'],
                'image_count': len(images),
                'thumbnail': images[0]['base64_url'] if images else None
            }
        })
    except Exception as e:
        return jsonify({'success': False, 'error': f'创建失败: {str(e)}'}), 500


@app.route('/api/characters/<char_id>', methods=['DELETE'])
def api_delete_character(char_id):
    """删除人物"""
    characters = load_characters()
    original_len = len(characters)
    characters = [c for c in characters if c['id'] != char_id]
    if len(characters) == original_len:
        return jsonify({'success': False, 'error': '人物不存在'}), 404
    save_characters(characters)
    return jsonify({'success': True})


if __name__ == '__main__':
    # 初始化 VLM 评审提示词系统
    _init_review_prompts()
    # 初始化分镜生成提示词系统
    _init_scene_prompts()
    print(f"启动服务器: http://{FLASK_HOST}:{FLASK_PORT}")
    print(f"调试模式: {FLASK_DEBUG}")
    app.run(host=FLASK_HOST, port=FLASK_PORT, debug=FLASK_DEBUG)
