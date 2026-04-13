"""
测试脚本 - 验证API接口是否正常工作
"""
import requests
import json
import base64

# API配置
IMAGE_API_KEY = "sk-71d37f4158434469acf3640bd747476b"
VIDEO_API_KEY = "sk-8d384464a7ff4d5fb42be752c5c05c55"

IMAGE_API_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
VIDEO_API_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis"
TASK_QUERY_URL = "https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}"

def test_image_api():
    """测试文生图API"""
    print("\n" + "="*50)
    print("测试1: 文生图API")
    print("="*50)
    
    try:
        payload = {
            "model": "wan2.7-image-pro",
            "input": {
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"text": "一只可爱的小猫在草地上玩耍，阳光明媚"}
                        ]
                    }
                ]
            },
            "parameters": {
                "size": "1K",
                "n": 1,
                "watermark": False,
                "thinking_mode": True
            }
        }
        
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {IMAGE_API_KEY}"
        }
        
        print("正在调用文生图API...")
        response = requests.post(IMAGE_API_URL, json=payload, headers=headers, timeout=60)
        
        print(f"状态码: {response.status_code}")
        print(f"响应: {json.dumps(response.json(), ensure_ascii=False, indent=2)}")
        
        if response.status_code == 200:
            result = response.json()
            if "output" in result and "choices" in result["output"]:
                image_url = result["output"]["choices"][0]["message"]["content"][0]["image"]
                print(f"\n✅ 文生图API测试成功!")
                print(f"生成的图片URL: {image_url}")
                return True, image_url
        
        print(f"\n❌ 文生图API测试失败")
        return False, None
        
    except Exception as e:
        print(f"\n❌ 文生图API测试异常: {str(e)}")
        return False, None


def test_video_api(image_url):
    """测试图生视频API"""
    print("\n" + "="*50)
    print("测试2: 图生视频API")
    print("="*50)
    
    try:
        payload = {
            "model": "wan2.6-i2v-flash",
            "input": {
                "prompt": "小猫在草地上快乐地奔跑，尾巴摇晃",
                "img_url": image_url
            },
            "parameters": {
                "resolution": "480P",
                "duration": 5,
                "prompt_extend": True,
                "watermark": False
            }
        }
        
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {VIDEO_API_KEY}",
            "X-DashScope-Async": "enable"
        }
        
        print("正在调用图生视频API...")
        response = requests.post(VIDEO_API_URL, json=payload, headers=headers, timeout=60)
        
        print(f"状态码: {response.status_code}")
        print(f"响应: {json.dumps(response.json(), ensure_ascii=False, indent=2)}")
        
        if response.status_code == 200:
            result = response.json()
            if "output" in result and "task_id" in result["output"]:
                task_id = result["output"]["task_id"]
                print(f"\n✅ 图生视频API测试成功!")
                print(f"任务ID: {task_id}")
                return True, task_id
        
        print(f"\n❌ 图生视频API测试失败")
        return False, None
        
    except Exception as e:
        print(f"\n❌ 图生视频API测试异常: {str(e)}")
        return False, None


def test_task_query(task_id):
    """测试任务查询API"""
    print("\n" + "="*50)
    print("测试3: 任务查询API")
    print("="*50)
    
    try:
        url = TASK_QUERY_URL.format(task_id=task_id)
        headers = {
            "Authorization": f"Bearer {VIDEO_API_KEY}"
        }
        
        print(f"正在查询任务状态... (task_id: {task_id})")
        response = requests.get(url, headers=headers, timeout=30)
        
        print(f"状态码: {response.status_code}")
        print(f"响应: {json.dumps(response.json(), ensure_ascii=False, indent=2)}")
        
        if response.status_code == 200:
            result = response.json()
            task_status = result.get("output", {}).get("task_status", "UNKNOWN")
            print(f"\n✅ 任务查询API测试成功!")
            print(f"当前状态: {task_status}")
            return True, task_status
        
        print(f"\n❌ 任务查询API测试失败")
        return False, None
        
    except Exception as e:
        print(f"\n❌ 任务查询API测试异常: {str(e)}")
        return False, None


def main():
    print("\n" + "="*60)
    print(" 通义万相2.7 API接口测试")
    print("="*60)
    
    # 测试1: 文生图
    success1, image_url = test_image_api()
    
    if not success1 or not image_url:
        print("\n\n⚠️  文生图API测试失败，无法继续测试视频生成API")
        return
    
    # 测试2: 图生视频
    success2, task_id = test_video_api(image_url)
    
    if not success2 or not task_id:
        print("\n\n⚠️  图生视频API测试失败，无法测试任务查询API")
        return
    
    # 测试3: 任务查询
    success3, task_status = test_task_query(task_id)
    
    # 汇总结果
    print("\n" + "="*60)
    print(" 测试结果汇总")
    print("="*60)
    print(f"文生图API:    {'✅ 通过' if success1 else '❌ 失败'}")
    print(f"图生视频API:  {'✅ 通过' if success2 else '❌ 失败'}")
    print(f"任务查询API:  {'✅ 通过' if success3 else '❌ 失败'}")
    
    if success1 and success2 and success3:
        print("\n🎉 所有API测试通过!")
    else:
        print("\n⚠️  部分API测试失败，请检查配置")


if __name__ == "__main__":
    main()
