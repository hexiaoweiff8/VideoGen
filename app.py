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
    IMAGE_API_URL, VIDEO_API_URL, TASK_QUERY_URL,
    IMAGE_API_KEY, VIDEO_API_KEY,
    POLL_INTERVAL, POLL_TIMEOUT,
    IMAGE_SAVE_DIR, VIDEO_SAVE_DIR,
    FLASK_HOST, FLASK_PORT, FLASK_DEBUG
)

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 最大上传50MB

# 人物库存储文件
CHARACTERS_FILE = os.path.join(os.path.dirname(__file__), 'characters.json')


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


def generate_image(prompt, negative_prompt="", size="2K", reference_images=None, api_key=None, api_url=None):
    """
    调用文生图API生成图片
    
    Args:
        prompt: 图片描述文本
        negative_prompt: 反向提示词
        size: 图片尺寸 (1K, 2K, 4K)
        reference_images: 参考图片URL列表 (用于人物一致性)
        api_key: 可选，覆盖默认IMAGE_API_KEY
        api_url: 可选，覆盖默认IMAGE_API_URL
    
    Returns:
        dict: {'success': bool, 'image_url': str, 'local_path': str, 'error': str}
    """
    _api_key = api_key or IMAGE_API_KEY
    _api_url = api_url or IMAGE_API_URL
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
    _api_url = api_url or VIDEO_API_URL
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


def query_task_status(task_id):
    """
    查询任务状态
    
    Args:
        task_id: 任务ID
    
    Returns:
        dict: {'status': str, 'video_url': str, 'error': str}
    """
    try:
        url = TASK_QUERY_URL.format(task_id=task_id)
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
    """上传本地文件到阿里云临时存储，返回 oss:// 临时URL（有咉48小时）"""
    print(f"[上传文件] 开始上传: {file_path}")
    policy_data = get_upload_policy(VIDEO_API_KEY, model_name)
    oss_url = upload_file_to_oss(policy_data, file_path)
    print(f"[上传文件] 成功, 临时URL: {oss_url}")
    return oss_url


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
                                api_key=page_api_key, api_url=page_api_url)
        
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
    """生成视频API"""
    try:
        data = request.json
        image_url = data.get('image_url', '').strip()
        prompt = data.get('prompt', '').strip()
        negative_prompt = data.get('negative_prompt', '').strip()
        resolution = data.get('resolution', '720P')
        duration = data.get('duration', 5)
        # 接收页面传入的API配置
        page_api_key = data.get('api_key', '').strip() or None
        page_base_url = data.get('base_url', '').strip() or None
        page_api_url = None
        if page_base_url:
            page_api_url = page_base_url.rstrip('/') + '/api/v1/services/aigc/text-2-video-synthesis/video-synthesis'
        
        if not image_url or not prompt:
            return jsonify({"success": False, "error": "缺少必要参数"}), 400
        
        # 创建视频生成任务
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
    """查询任务状态API"""
    try:
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
    """上传本地图片为视频生成使用，自动上传到阿里云临时存储并返回 oss:// URL"""
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
        
        # 上传到阿里云临时存储，获取 oss:// URL
        oss_url = upload_file_and_get_temp_url(filepath, model_name="wan2.7-i2v")
        
        return jsonify({
            "success": True,
            "filename": filename,
            "oss_url": oss_url,  # 用于视频生成的临时URL
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


# ==================== 人物库接口 ====================

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
    print(f"启动服务器: http://{FLASK_HOST}:{FLASK_PORT}")
    print(f"调试模式: {FLASK_DEBUG}")
    app.run(host=FLASK_HOST, port=FLASK_PORT, debug=FLASK_DEBUG)
