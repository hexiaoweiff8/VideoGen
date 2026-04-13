"""
诊断测试 - 检查图生视频API调用失败的原因
"""
import requests
import json
import base64
import os

# 读取已生成的图片
IMAGE_DIR = r"E:\共享目录\项目\AI\视频生成\images"
video_api_key = "sk-8d384464a7ff4d5fb42be752c5c05c55"
VIDEO_API_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis"

# 找一个已生成的图片
test_images = [f for f in os.listdir(IMAGE_DIR) if f.startswith('image_')]
if not test_images:
    print("没有找到已生成的图片")
    exit(1)

# 使用最新的图片
latest_image = sorted(test_images)[-1]
image_path = os.path.join(IMAGE_DIR, latest_image)
print(f"使用图片: {latest_image}")

# 读取并转为Base64
with open(image_path, 'rb') as f:
    image_data = f.read()

base64_data = base64.b64encode(image_data).decode('utf-8')
image_url = f"data:image/png;base64,{base64_data}"
print(f"Base64图片URL长度: {len(image_url)} 字符")

# 测试1: 使用本地生成的图片URL
print("\n" + "="*60)
print("测试1: 使用本地生成的图片URL")
print("="*60)

test_cases = [
    {
        "name": "Base64编码图片",
        "prompt": "角色眨眼睛，微微点头",
        "resolution": "480P",
        "duration": 5
    },
    {
        "name": "短prompt",
        "prompt": "角色微笑",
        "resolution": "480P",
        "duration": 5
    }
]

for test_case in test_cases:
    print(f"\n测试: {test_case['name']}")
    print(f"Prompt: {test_case['prompt']}")
    print(f"参数: resolution={test_case['resolution']}, duration={test_case['duration']}")
    
    payload = {
        "model": "wan2.6-i2v-flash",
        "input": {
            "prompt": test_case["prompt"],
            "img_url": image_url
        },
        "parameters": {
            "resolution": test_case["resolution"],
            "duration": test_case["duration"],
            "prompt_extend": True,
            "watermark": False
        }
    }
    
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {video_api_key}",
        "X-DashScope-Async": "enable"
    }
    
    try:
        response = requests.post(VIDEO_API_URL, json=payload, headers=headers, timeout=60)
        print(f"状态码: {response.status_code}")
        
        if response.status_code == 200:
            result = response.json()
            print(f"响应: {json.dumps(result, ensure_ascii=False, indent=2)}")
            
            if "output" in result and "task_id" in result["output"]:
                task_id = result["output"]["task_id"]
                print(f"✅ 成功! task_id: {task_id}")
            else:
                print(f"❌ 失败: {result.get('message', '未知错误')}")
        else:
            print(f"❌ HTTP错误 {response.status_code}")
            print(f"响应: {response.text}")
            
    except Exception as e:
        print(f"❌ 异常: {str(e)}")
    
    print("-" * 60)
