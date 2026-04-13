// 全局状态
let currentTaskId = null;
let currentImageFilename = null;
let currentVideoFilename = null;
let videoSourceImageUrl = null;  // 右侧视频生成使用的图片URL（oss:// 或 https://），独立于左侧
let referenceImageUrl = null;    // 左侧文生图使用的参考图Base64 URL
let pollTimer = null;
let pollStartTime = null;

const POLL_INTERVAL = 5000; // 5秒
const POLL_TIMEOUT = 600000; // 10分钟

// ==================== 工具函数 ====================

/**
 * 显示Toast提示
 */
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    
    setTimeout(() => {
        toast.className = 'toast';
    }, 3000);
}

/**
 * 更新步骤指示器
 */
function updateStepIndicator(step) {
    document.querySelectorAll('.step').forEach(el => {
        const stepNum = parseInt(el.dataset.step);
        if (stepNum < step) {
            el.classList.add('completed');
            el.classList.remove('active');
        } else if (stepNum === step) {
            el.classList.add('active');
            el.classList.remove('completed');
        } else {
            el.classList.remove('active', 'completed');
        }
    });
}

/**
 * 更新状态显示
 */
function updateStatus(stage, status, taskId = null) {
    // 使用新的任务状态栏
    const statusBar = document.getElementById('task-status-bar');
    statusBar.classList.add('show');
    
    document.getElementById('current-task-name').textContent = stage;
    document.getElementById('current-task-status').textContent = status;
    
    if (taskId) {
        document.getElementById('task-id').textContent = taskId;
    }
    
    // 更新进度条
    updateProgress(status);
}

/**
 * 更新进度条
 */
function updateProgress(status) {
    const taskProgressBar = document.getElementById('task-progress-bar');
    
    const progressMap = {
        'PENDING': { width: '20%', hint: '任务排队中...' },
        'RUNNING': { width: '60%', hint: '正在生成中...' },
        '处理中...': { width: '30%', hint: '处理中...' },
        '创建任务中...': { width: '40%', hint: '创建任务中...' },
        'SUCCEEDED': { width: '100%', hint: '完成!' },
        '完成 ✓': { width: '100%', hint: '完成!' },
        'FAILED': { width: '100%', hint: '失败' },
        '失败 ✗': { width: '100%', hint: '失败' }
    };
    
    const progress = progressMap[status] || { width: '0%', hint: '' };
    taskProgressBar.style.width = progress.width;
    
    // 如果完成或失败,3秒后隐藏状态栏
    if (status === 'SUCCEEDED' || status === '完成 ✓' || 
        status === 'FAILED' || status === '失败 ✗') {
        setTimeout(() => {
            statusBar.classList.remove('show');
        }, 3000);
    }
}

/**
 * 字符计数
 */
function updateCharCount(textareaId, countId) {
    const textarea = document.getElementById(textareaId);
    const count = document.getElementById(countId);
    count.textContent = textarea.value.length;
}

// ==================== 参考图上传 ====================

/**
 * 处理参考图上传
 */
async function handleReferenceUpload(input, type) {
    const file = input.files[0];
    if (!file) return;
    
    // 验证文件
    if (!file.type.startsWith('image/')) {
        showToast('请上传图片文件', 'error');
        return;
    }
    
    if (file.size > 20 * 1024 * 1024) {
        showToast('图片大小不能超过20MB', 'error');
        return;
    }
    
    // 显示预览
    const preview = document.getElementById(`preview-${type}`);
    const reader = new FileReader();
    reader.onload = function(e) {
        preview.src = e.target.result;
        preview.style.display = 'block';
        preview.parentElement.querySelector('.upload-placeholder').style.display = 'none';
    };
    reader.readAsDataURL(file);
    
    // 上传到服务器
    const formData = new FormData();
    formData.append('image', file);
    
    try {
        showToast('正在上传参考图...');
        const response = await fetch('/api/upload-image', {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        
        if (result.success) {
            // 保存参考图URL
            referenceImageUrl = result.base64_url;
            showToast('参考图上传成功', 'success');
        } else {
            showToast('上传失败: ' + result.error, 'error');
        }
    } catch (error) {
        showToast('上传失败: ' + error.message, 'error');
    }
}

// ==================== 阶段1: 生成图片 ====================

/**
 * 生成图片
 */
async function generateImage() {
    const prompt = document.getElementById('image-prompt').value.trim();
    const negativePrompt = document.getElementById('negative-prompt').value.trim();
    const size = document.getElementById('image-size').value;
    
    if (!prompt) {
        showToast('请输入图片描述', 'error');
        return;
    }
    
    // 收集参考图(如果有的话)
    const refImages = referenceImageUrl ? [referenceImageUrl] : [];
    
    // 更新UI
    updateStatus('生成图片', '处理中...');
    updateStepIndicator(1);
    
    try {
        showToast('正在生成图片,请稍候...');
        
        const response = await fetch('/api/generate-image', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                prompt: prompt,
                negative_prompt: negativePrompt,
                size: size,
                reference_images: refImages
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            // 保存图片信息
            currentImageFilename = result.filename;
            
            // 显示生成的图片（传入阿里云原始URL）
            displayGeneratedImage(result.filename, result.image_url);
            
            // 更新步骤
            updateStepIndicator(2);
            updateStatus('图片生成', '完成 ✓', null);
            
            showToast('图片生成成功!', 'success');
        } else {
            updateStatus('图片生成', '失败 ✗');
            showToast('生成失败: ' + result.error, 'error');
        }
    } catch (error) {
        updateStatus('图片生成', '失败 ✗');
        showToast('请求失败: ' + error.message, 'error');
    }
}

/**
 * 显示生成的图片（仅更新左侧区域，不干涉右侧）
 */
function displayGeneratedImage(filename, aliUrl) {
    const imageResultCard = document.getElementById('image-result-card');
    const generatedImage = document.getElementById('generated-image');
    const imagePlaceholder = document.getElementById('image-placeholder');
    
    const localUrl = `/images/${filename}`;
    
    // 在图片结果区显示本地图片
    generatedImage.src = localUrl;
    generatedImage.style.display = 'block';
    imagePlaceholder.style.display = 'none';
    imageResultCard.style.display = 'block';
}

/**
 * 处理URL输入（清除上传的图片，以URL为准）
 */
function handleUrlInput(value) {
    if (value.trim()) {
        // 用户输入了URL，清除之前上传的图片
        videoSourceImageUrl = null;
        // 隐藏上传状态
        const statusDiv = document.getElementById('local-upload-status');
        statusDiv.style.display = 'none';
        // 隐藏预览（URL不做预览）
        const selectedVideoImage = document.getElementById('selected-video-image');
        const selectedImageBox = document.getElementById('selected-image-box');
        selectedVideoImage.style.display = 'none';
        selectedImageBox.querySelector('.placeholder-text').style.display = 'block';
    }
}

/**
 * 上传本地图片作为视频首帧
 */
async function handleLocalImageUpload(input) {
    const file = input.files[0];
    if (!file) return;
    
    // 验证文件
    if (!file.type.startsWith('image/')) {
        showToast('请上传图片文件', 'error');
        return;
    }
    if (file.size > 20 * 1024 * 1024) {
        showToast('图片大小不能超过20MB', 'error');
        return;
    }
    
    // 立即显示本地预览
    const selectedImageBox = document.getElementById('selected-image-box');
    const selectedVideoImage = document.getElementById('selected-video-image');
    const reader = new FileReader();
    reader.onload = (e) => {
        selectedVideoImage.src = e.target.result;
        selectedVideoImage.style.display = 'block';
        selectedImageBox.querySelector('.placeholder-text').style.display = 'none';
    };
    reader.readAsDataURL(file);
    
    // 显示进度提示
    const statusDiv = document.getElementById('local-upload-status');
    const progressText = document.getElementById('upload-progress-text');
    statusDiv.style.display = 'block';
    progressText.textContent = '正在上传到阿里云临时存储，请稍候...';
    
    document.getElementById('btn-generate-video').disabled = true;
    
    try {
        const formData = new FormData();
        formData.append('image', file);
        
        const response = await fetch('/api/upload-for-video', {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        
        if (result.success) {
            // 使用 oss:// 临时URL作为视频首帧
            videoSourceImageUrl = result.oss_url;
            document.getElementById('image-url-input').value = '';
            progressText.textContent = `✅ 上传成功！有效期48小时`;
            progressText.style.color = '#4caf50';
            showToast('本地图片上传成功，可以生成视频了！', 'success');
        } else {
            progressText.textContent = `❌ 上传失败: ${result.error}`;
            progressText.style.color = '#f44336';
            showToast('上传失败: ' + result.error, 'error');
        }
    } catch (error) {
        progressText.textContent = `❌ 网络错误: ${error.message}`;
        progressText.style.color = '#f44336';
        showToast('上传失败: ' + error.message, 'error');
    }
    
    // 重置文件输入框，允许重复选择相同文件
    input.value = '';
}

// ==================== 阶段2: 生成视频 ====================

/**
 * 生成视频
 */
async function generateVideo() {
    // 优先使用上传的图片（videoSourceImageUrl），其次使用输入的URL
    const imageUrlInput = document.getElementById('image-url-input').value.trim();
    const imageUrl = videoSourceImageUrl || imageUrlInput;
    
    if (!imageUrl) {
        showToast('请上传图片或输入图片URL', 'error');
        return;
    }
    
    // 验证图片URL格式（oss://允许）
    if (imageUrlInput && !videoSourceImageUrl) {
        if (!imageUrlInput.startsWith('http') && !imageUrlInput.startsWith('oss://') && !imageUrlInput.startsWith('data:')) {
            showToast('图片URL必须以http://、https://开头', 'error');
            return;
        }
    }
    
    const prompt = document.getElementById('video-prompt').value.trim();
    const resolution = document.getElementById('video-resolution').value;
    const duration = parseInt(document.getElementById('video-duration').value);
    
    if (!prompt) {
        showToast('请输入视频描述', 'error');
        return;
    }
    
    // 验证时长范围 (wan2.7-i2v 支持 2-15 秒)
    if (duration < 2 || duration > 15) {
        showToast('视频时长必须在2-15秒之间', 'error');
        return;
    }
    
    // 更新UI
    updateStatus('生成视频', '创建任务中...');
    
    try {
        showToast('正在创建视频任务...');
        
        console.log('发送视频生成请求:', {
            image_url: imageUrl.substring(0, 100) + '...',
            prompt: prompt,
            resolution: resolution,
            duration: duration
        });
        
        const response = await fetch('/api/generate-video', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                image_url: imageUrl,
                prompt: prompt,
                resolution: resolution,
                duration: duration
            })
        });
        
        const result = await response.json();
        
        console.log('视频生成响应:', result);
        
        if (result.success) {
            currentTaskId = result.task_id;
            showToast('视频任务创建成功,正在生成...');
            
            // 开始轮询任务状态
            startPolling();
        } else {
            showToast('创建任务失败: ' + (result.error || '未知错误'), 'error');
            updateStatus('生成视频', '失败 ✗');
        }
    } catch (error) {
        console.error('请求失败:', error);
        showToast('请求失败: ' + error.message, 'error');
        updateStatus('生成视频', '失败 ✗');
    }
}

/**
 * 开始轮询任务状态
 */
function startPolling() {
    pollStartTime = Date.now();
    
    if (pollTimer) {
        clearInterval(pollTimer);
    }
    
    pollTimer = setInterval(async () => {
        // 检查超时
        if (Date.now() - pollStartTime > POLL_TIMEOUT) {
            clearInterval(pollTimer);
            updateStatus('生成视频', '超时 ✗', currentTaskId);
            showToast('任务超时,请重试', 'error');
            return;
        }
        
        try {
            const response = await fetch(`/api/task/${currentTaskId}`);
            const result = await response.json();
            
            if (result.status === 'SUCCEEDED') {
                // 任务完成
                clearInterval(pollTimer);
                
                console.log('🎬 视频生成完成!');
                console.log('result:', result);
                console.log('result.filename:', result.filename);
                console.log('result.video_url:', result.video_url);
                
                // 优先使用本地filename，如果下载失败则使用原始URL
                if (result.filename && result.filename !== 'undefined' && result.filename !== undefined) {
                    console.log('📁 使用本地文件:', result.filename);
                    displayGeneratedVideo(result.filename);
                } else if (result.video_url) {
                    // 使用原始URL播放
                    console.log('🌐 使用原始URL播放视频:', result.video_url);
                    displayGeneratedVideoFromUrl(result.video_url);
                } else {
                    console.error('❌ 无法获取视频:', result);
                    showToast('视频生成成功，但获取失败', 'warning');
                }
                
                updateStatus('视频生成', '完成 ✓', currentTaskId);
                showToast('视频生成成功!', 'success');
            } else if (result.status === 'FAILED') {
                // 任务失败
                clearInterval(pollTimer);
                updateStatus('生成视频', '失败 ✗', currentTaskId);
                showToast('生成失败: ' + (result.error || '未知错误'), 'error');
            } else {
                // 任务进行中
                updateStatus('生成视频', result.status, currentTaskId);
            }
        } catch (error) {
            console.error('轮询失败:', error);
        }
    }, POLL_INTERVAL);
}

/**
 * 显示生成的视频
 */
function displayGeneratedVideo(filename) {
    const videoResultCard = document.getElementById('video-result-card');
    const generatedVideo = document.getElementById('generated-video');
    const videoPlaceholder = document.getElementById('video-placeholder');
    
    const videoUrl = `/videos/${filename}`;
    
    // 显示视频
    generatedVideo.src = videoUrl;
    generatedVideo.style.display = 'block';
    videoPlaceholder.style.display = 'none';
    videoResultCard.style.display = 'block';
    
    currentVideoFilename = filename;
}

/**
 * 显示生成的视频（使用原始URL）
 */
function displayGeneratedVideoFromUrl(url) {
    const videoResultCard = document.getElementById('video-result-card');
    const generatedVideo = document.getElementById('generated-video');
    const videoPlaceholder = document.getElementById('video-placeholder');
    
    // 显示视频
    generatedVideo.src = url;
    generatedVideo.style.display = 'block';
    videoPlaceholder.style.display = 'none';
    videoResultCard.style.display = 'block';
}

// ==================== 一键生成 ====================

/**
 * 完整流程一键生成
 */
async function fullPipeline() {
    const imagePrompt = document.getElementById('image-prompt').value.trim();
    const videoPrompt = document.getElementById('video-prompt').value.trim();
    const negativePrompt = document.getElementById('negative-prompt').value.trim();
    const size = document.getElementById('image-size').value;
    const resolution = document.getElementById('video-resolution').value;
    const duration = parseInt(document.getElementById('video-duration').value);
    
    if (!imagePrompt || !videoPrompt) {
        showToast('请输入图片描述和视频描述', 'error');
        return;
    }
    
    // 收集参考图(如果有的话)
    const refImages = referenceImageUrl ? [referenceImageUrl] : [];
    
    // 更新UI
    updateStatus('一键生成', '生成图片中...');
    updateStepIndicator(1);
    
    try {
        showToast('开始一键生成流程...');
        
        const response = await fetch('/api/full-pipeline', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                image_prompt: imagePrompt,
                video_prompt: videoPrompt,
                negative_prompt: negativePrompt,
                size: size,
                resolution: resolution,
                duration: duration,
                reference_images: refImages
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            // 显示生成的图片（左侧）
            if (result.image_filename) {
                currentImageFilename = result.image_filename;
                displayGeneratedImage(result.image_filename, result.image_url);
            }
            
            // 开始轮询视频任务
            currentTaskId = result.task_id;
            updateStepIndicator(2);
            updateStatus('一键生成', '生成视频中...', currentTaskId);
            showToast('图片生成完成,正在生成视频...');
            
            startPolling();
        } else {
            updateStatus('一键生成', '失败 ✗');
            showToast(`${result.stage}阶段失败: ${result.error}`, 'error');
        }
    } catch (error) {
        updateStatus('一键生成', '失败 ✗');
        showToast('请求失败: ' + error.message, 'error');
    }
}

// ==================== 下载结果 ====================

/**
 * 下载生成的文件或视频
 */
function downloadResult(type) {
    if (type === 'image' && currentImageFilename) {
        const link = document.createElement('a');
        link.href = `/images/${currentImageFilename}`;
        link.download = currentImageFilename;
        link.click();
        showToast('开始下载图片', 'success');
    } else if (type === 'video' && currentVideoFilename) {
        const link = document.createElement('a');
        link.href = `/videos/${currentVideoFilename}`;
        link.download = currentVideoFilename;
        link.click();
        showToast('开始下载视频', 'success');
    } else {
        showToast('没有可下载的内容', 'error');
    }
}

// ==================== 事件监听 ====================

// 字符计数
document.getElementById('image-prompt').addEventListener('input', () => {
    updateCharCount('image-prompt', 'image-prompt-count');
});

document.getElementById('video-prompt').addEventListener('input', () => {
    updateCharCount('video-prompt', 'video-prompt-count');
});

// 页面加载完成提示
window.addEventListener('load', () => {
    console.log('通义万相2.7 视频生成器已加载');
    showToast('欢迎使用通义万相视频生成器!', 'info');
});
