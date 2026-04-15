// 全局状态
let currentTaskId = null;
let currentImageFilename = null;
let currentVideoFilename = null;
let videoSourceImageUrl = null;    // 右侧视频生成使用的图片URL
let lastGeneratedImageUrl = null;  // 左侧最近生成的图片URL（公网可访问）
let lastGeneratedImageFilename = null; // 左侧最近生成图片的文件名
let referenceImageUrls = [null, null, null]; // 左侧文生图使用的参考图Base64 URL，最多3张
let pollTimer = null;
let pollStartTime = null;

// 新建人物表单中的临时图片数据 [{filename, base64_url}, ...]
let newCharImages = [null, null, null];
// 当前已选中的人物ID数组（支持多选）
let selectedCharIds = [];
// 人物数据缓存 { charId: characterObject }
let selectedCharsCache = {};

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
 * 处理参考图上传（支持多插槽，以索引区分）
 */
async function handleReferenceUpload(input, index) {
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
    const preview = document.getElementById(`preview-ref-${index}`);
    const placeholder = document.getElementById(`placeholder-ref-${index}`);
    const clearBtn = document.getElementById(`clear-ref-${index}`);
    const reader = new FileReader();
    reader.onload = function(e) {
        preview.src = e.target.result;
        preview.style.display = 'block';
        placeholder.style.display = 'none';
        if (clearBtn) clearBtn.style.display = 'flex';
    };
    reader.readAsDataURL(file);
    
    // 上传到服务器
    const formData = new FormData();
    formData.append('image', file);
    
    try {
        showToast(`正在上传参考图${index + 1}...`);
        const response = await fetch('/api/upload-image', {
            method: 'POST',
            body: formData
        });
        const result = await response.json();
        
        if (result.success) {
            referenceImageUrls[index] = result.base64_url;
            const uploaded = referenceImageUrls.filter(u => u !== null).length;
            showToast(`参考图${index + 1}上传成功（已上传${uploaded}张）`, 'success');
        } else {
            showToast('上传失败: ' + result.error, 'error');
            clearRefImage(null, index); // 失败则清除预览
        }
    } catch (error) {
        showToast('上传失败: ' + error.message, 'error');
        clearRefImage(null, index);
    }
    input.value = ''; // 允许重复选择相同文件
}

/**
 * 清除单个参考图插槽
 */
function clearRefImage(event, index) {
    if (event) event.stopPropagation(); // 防止触发upload-box的click
    
    referenceImageUrls[index] = null;
    
    const preview = document.getElementById(`preview-ref-${index}`);
    const placeholder = document.getElementById(`placeholder-ref-${index}`);
    const clearBtn = document.getElementById(`clear-ref-${index}`);
    const fileInput = document.getElementById(`ref-image-${index}`);
    
    preview.src = '';
    preview.style.display = 'none';
    placeholder.style.display = 'flex';
    if (clearBtn) clearBtn.style.display = 'none';
    if (fileInput) fileInput.value = '';
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
    const refImages = referenceImageUrls.filter(url => url !== null);
    
    // 获取页面API配置
    const apiCfg = getApiConfig();
    
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
                reference_images: refImages,
                ...apiCfg.image  // 包含页面自定义的api_key和base_url
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
 * 显示生成的图片（仅更新左侧区域）并启用右侧「使用已生成图片」按钮
 */
function displayGeneratedImage(filename, aliUrl) {
    const imageResultCard = document.getElementById('image-result-card');
    const generatedImage = document.getElementById('generated-image');
    const imagePlaceholder = document.getElementById('image-placeholder');
    
    const localUrl = `/images/${filename}`;
    
    // 左侧结果区显示本地图片
    generatedImage.src = localUrl;
    generatedImage.style.display = 'block';
    imagePlaceholder.style.display = 'none';
    imageResultCard.style.display = 'block';
    
    // 保存左侧生成的图片信息，供右侧使用
    lastGeneratedImageUrl = aliUrl;
    lastGeneratedImageFilename = filename;
    
    // 启用「使用已生成图片」按钮
    const btnUseGenerated = document.getElementById('btn-use-generated');
    if (btnUseGenerated) {
        btnUseGenerated.disabled = false;
        btnUseGenerated.title = `使用左侧已生成的图片：${filename}`;
    }
}

/**
 * 使用左侧已生成的图片作为视频首帧
 */
function useGeneratedImage() {
    if (!lastGeneratedImageUrl) {
        showToast('请先在左侧生成一张图片', 'error');
        return;
    }
    
    // 设置视频图片源
    videoSourceImageUrl = lastGeneratedImageUrl;
    
    // 在预览框显示图片
    const selectedVideoImage = document.getElementById('selected-video-image');
    const selectedImageBox = document.getElementById('selected-image-box');
    selectedVideoImage.src = `/images/${lastGeneratedImageFilename}`;
    selectedVideoImage.style.display = 'block';
    selectedImageBox.querySelector('.placeholder-text').style.display = 'none';
    
    // 禁用并清空URL输入框
    setUrlInputState('disabled', '已使用左侧生成的图片');
    
    // 显示状态和清除按钮
    const statusDiv = document.getElementById('local-upload-status');
    const progressText = document.getElementById('upload-progress-text');
    const btnClear = document.getElementById('btn-clear-upload');
    statusDiv.style.display = 'block';
    progressText.textContent = `✨ 已选择左侧生成的图片`;
    progressText.style.color = '#4caf50';
    btnClear.style.display = 'inline-block';
    document.getElementById('btn-generate-video').disabled = false;  // 确保视频按钮可用
    
    showToast('已选择左侧生成的图片，可以生成视频了', 'success');
}

/**
 * 设置URL输入框的启用/禁用状态
 */
function setUrlInputState(state, placeholder) {
    const input = document.getElementById('image-url-input');
    if (state === 'disabled') {
        input.disabled = true;
        input.value = '';
        input.placeholder = placeholder || '已选择图片源';
        input.classList.add('url-input-locked');
    } else {
        input.disabled = false;
        input.placeholder = '输入公网图片URL (https://...)';
        input.classList.remove('url-input-locked');
    }
}

/**
 * 清除已选择的图片源（恢复空状态）
 */
function clearImageSource() {
    videoSourceImageUrl = null;
    
    // 清除预览
    const selectedVideoImage = document.getElementById('selected-video-image');
    const selectedImageBox = document.getElementById('selected-image-box');
    selectedVideoImage.src = '';
    selectedVideoImage.style.display = 'none';
    selectedImageBox.querySelector('.placeholder-text').style.display = 'block';
    
    // 隐藏状态区
    document.getElementById('local-upload-status').style.display = 'none';
    document.getElementById('btn-clear-upload').style.display = 'none';
    
    // 恢复URL输入框
    setUrlInputState('enabled');
    
    // 重置文件输入框
    const fileInput = document.getElementById('local-image-input');
    if (fileInput) fileInput.value = '';
    
    showToast('已清除图片选择', 'info');
}

/**
 * 处理URL输入（清除上传的图片，以URL为准）
 */
function handleUrlInput(value) {
    if (value.trim()) {
        // 用户输入了URL，清除之前的选择状态
        videoSourceImageUrl = null;
        // 隐藏上传状态
        document.getElementById('local-upload-status').style.display = 'none';
        document.getElementById('btn-clear-upload').style.display = 'none';
        // 隐藏预览
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
            // 禁用URL输入框，明确显示当前图片源
            setUrlInputState('disabled', '已使用本地上传的图片');
            progressText.textContent = `✅ 上传成功！有效期48小时`;
            progressText.style.color = '#4caf50';
            document.getElementById('btn-clear-upload').style.display = 'inline-block';
            document.getElementById('btn-generate-video').disabled = false;  // 恢复视频按钮
            showToast('本地图片上传成功，可以生成视频了！', 'success');
        } else {
            progressText.textContent = `❌ 上传失败: ${result.error}`;
            progressText.style.color = '#f44336';
            // 失败时恢复URL输入框
            setUrlInputState('enabled');
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
    
    // 获取页面API配置
    const apiCfg = getApiConfig();
    
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
                duration: duration,
                ...apiCfg.video  // 包含页面自定义的api_key和base_url
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
    const refImages = referenceImageUrls.filter(url => url !== null);
    
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
    loadSettings();      // 加载API设置
    loadCharacters();    // 加载人物库
});


// ==================== API 设置 ====================

const SETTINGS_KEY = 'wanx_api_settings';

/**
 * 保存设置到 localStorage
 */
function saveSettings() {
    const settings = {
        imageKey: document.getElementById('cfg-image-key').value.trim(),
        videoKey: document.getElementById('cfg-video-key').value.trim(),
        baseUrl: document.getElementById('cfg-base-url').value.trim()
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    
    const tip = document.getElementById('settings-save-tip');
    tip.textContent = '已自动保存';
    setTimeout(() => { tip.textContent = ''; }, 1500);
}

/**
 * 从 localStorage 加载设置
 */
function loadSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return;
        const settings = JSON.parse(raw);
        if (settings.imageKey) document.getElementById('cfg-image-key').value = settings.imageKey;
        if (settings.videoKey) document.getElementById('cfg-video-key').value = settings.videoKey;
        if (settings.baseUrl)  document.getElementById('cfg-base-url').value  = settings.baseUrl;
    } catch(e) {}
}

/**
 * 清除所有设置
 */
function clearSettings() {
    localStorage.removeItem(SETTINGS_KEY);
    document.getElementById('cfg-image-key').value = '';
    document.getElementById('cfg-video-key').value = '';
    document.getElementById('cfg-base-url').value  = '';
    showToast('设置已清除，将使用服务器默认配置', 'info');
}

/**
 * 切换设置面板显示/隐藏
 */
function toggleSettings() {
    const panel = document.getElementById('settings-panel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

/**
 * 获取当前页面配置（空则返回空对象，后端会自动fallback到默认）
 */
function getApiConfig() {
    const imageKey = document.getElementById('cfg-image-key').value.trim();
    const videoKey = document.getElementById('cfg-video-key').value.trim();
    const baseUrl  = document.getElementById('cfg-base-url').value.trim();
    
    return {
        image: {
            ...(imageKey ? { api_key: imageKey } : {}),
            ...(baseUrl  ? { base_url: baseUrl  } : {})
        },
        video: {
            ...(videoKey ? { api_key: videoKey } : {}),
            ...(baseUrl  ? { base_url: baseUrl  } : {})
        }
    };
}


// ==================== 人物库 ====================

/**
 * 加载并渲染人物库
 */
async function loadCharacters() {
    try {
        const resp = await fetch('/api/characters');
        const data = await resp.json();
        if (data.success) renderCharacterList(data.characters);
    } catch(e) {
        console.error('加载人物库失败', e);
    }
}

/**
 * 渲染人物列表
 */
function renderCharacterList(characters) {
    const list = document.getElementById('char-list');
    const empty = document.getElementById('char-empty');
    
    // 清除除了 empty 之外的内容
    Array.from(list.children).forEach(el => {
        if (el.id !== 'char-empty') el.remove();
    });
    
    if (!characters || characters.length === 0) {
        empty.style.display = 'block';
        return;
    }
    empty.style.display = 'none';
    
    characters.forEach(char => {
        const card = document.createElement('div');
        card.className = 'char-card';
        card.dataset.charId = char.id;
        card.innerHTML = `
            <div class="char-thumb" onclick="selectCharacter('${char.id}')">
                ${char.thumbnail 
                    ? `<img src="${char.thumbnail}" alt="${char.name}">` 
                    : `<div class="char-thumb-placeholder">👤</div>`}
            </div>
            <div class="char-info" onclick="selectCharacter('${char.id}')">
                <div class="char-name">${char.name}</div>
                <div class="char-meta">${char.image_count}张图</div>
            </div>
            <button class="char-delete-btn" onclick="deleteCharacter('${char.id}', '${char.name}')" title="删除">×</button>
        `;
        list.appendChild(card);
    });
}

/**
 * 选择/取消人物（支持多选）
 * - 未选中时：加入选中列表
 * - 已选中时：从列表移除（反选）
 * 最终将所有已选人物的参考图按顺序填入插槽（最多3张）
 */
async function selectCharacter(charId) {
    const idx = selectedCharIds.indexOf(charId);
    if (idx !== -1) {
        // 反选
        selectedCharIds.splice(idx, 1);
        delete selectedCharsCache[charId];
    } else {
        // 新增选择，获取详情
        try {
            showToast('加载人物参考图...');
            const resp = await fetch(`/api/characters/${charId}`);
            const data = await resp.json();
            if (!data.success) { showToast('加载失败', 'error'); return; }
            selectedCharsCache[charId] = data.character;
            selectedCharIds.push(charId);
        } catch(e) {
            showToast('加载人物失败: ' + e.message, 'error');
            return;
        }
    }

    // 更新高亮状态
    document.querySelectorAll('.char-card').forEach(el => {
        el.classList.toggle('char-card-selected', selectedCharIds.includes(el.dataset.charId));
    });

    // 重新计算参考图插槽
    reloadRefSlotsFromChars();
}

/**
 * 根据当前已选人物重新填充参考图插槽
 */
function reloadRefSlotsFromChars() {
    // 清除全部插槽
    for (let i = 0; i < 3; i++) clearRefImage(null, i);

    if (selectedCharIds.length === 0) {
        showToast('已取消所有人物选择', 'info');
        return;
    }

    // 收集所有已选人物的图片，按选择顺序展平
    const allImages = [];
    selectedCharIds.forEach(id => {
        const char = selectedCharsCache[id];
        if (char && char.images) allImages.push(...char.images);
    });

    if (allImages.length > 3) {
        showToast(`参考图共${allImages.length}张，插槽上限为3，取前3张`, 'info');
    }

    allImages.slice(0, 3).forEach((img, i) => {
        referenceImageUrls[i] = img.base64_url;
        const preview = document.getElementById(`preview-ref-${i}`);
        const placeholder = document.getElementById(`placeholder-ref-${i}`);
        const clearBtn = document.getElementById(`clear-ref-${i}`);
        preview.src = img.base64_url;
        preview.style.display = 'block';
        placeholder.style.display = 'none';
        if (clearBtn) clearBtn.style.display = 'flex';
    });

    const names = selectedCharIds.map(id => selectedCharsCache[id]?.name).filter(Boolean).join('、');
    showToast(`已加载「${names}」共${Math.min(allImages.length, 3)}张参考图`, 'success');
}


// ==================== Tab 切换 ====================

/**
 * 切换主 Tab
 */
function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.style.display = panel.id === `tab-${tabId}` ? 'block' : 'none';
    });
}


// ==================== 分镜规划 ====================

/**
 * 调用后端拆分分镜
 */
async function splitScenes() {
    const description = document.getElementById('scene-description').value.trim();
    if (!description) { showToast('请输入场景描述', 'error'); return; }

    const style     = document.getElementById('scene-style').value;
    const numScenes = document.getElementById('scene-num').value;
    const sceneModel = document.getElementById('scene-model').value;
    const apiCfg    = getApiConfig();

    // 更新UI状态
    const btn = document.getElementById('btn-split-scenes');
    btn.disabled = true;
    btn.textContent = '正在构思分镜…';
    document.getElementById('scene-loading').style.display = 'flex';
    document.getElementById('scene-empty').style.display   = 'none';
    document.getElementById('story-summary-card').style.display = 'none';
    // 清除旧卡片
    const cardsEl = document.getElementById('scene-cards');
    Array.from(cardsEl.children).forEach(el => { if (!el.id) el.remove(); });

    try {
        const resp = await fetch('/api/split-scenes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                description,
                style,
                num_scenes: numScenes,
                model: sceneModel,
                api_key: apiCfg.image.api_key || ''
            })
        });
        const result = await resp.json();

        if (result.success) {
            renderScenes(result.data);
        } else {
            showToast('分镜失败: ' + result.error, 'error');
            document.getElementById('scene-empty').style.display = 'block';
        }
    } catch(e) {
        showToast('请求失败: ' + e.message, 'error');
        document.getElementById('scene-empty').style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.textContent = '✨ AI 拆分分镜';
        document.getElementById('scene-loading').style.display = 'none';
    }
}

/**
 * 渲染分镜卡片
 */
function renderScenes(data) {
    const cardsEl = document.getElementById('scene-cards');
    // 清除除 empty 外的旧卡片
    Array.from(cardsEl.children).forEach(el => { if (!el.id) el.remove(); });

    // 显示故事摘要
    if (data.story_summary) {
        document.getElementById('story-summary-card').style.display = 'block';
        document.getElementById('story-summary-text').textContent = data.story_summary;
        document.getElementById('summary-total').textContent = `共 ${data.total_scenes} 个分镜`;
    }

    const scenes = data.scenes || [];
    if (scenes.length === 0) {
        document.getElementById('scene-empty').style.display = 'block';
        return;
    }

    scenes.forEach(scene => {
        const card = document.createElement('div');
        card.className = 'scene-card';
        card.innerHTML = `
            <div class="scene-card-header">
                <div class="scene-card-meta">
                    <span class="scene-num-badge">分镜 ${scene.scene_number}</span>
                    <span class="scene-shot-badge">${scene.shot_type || ''}</span>
                    <span class="scene-mood-badge">${scene.mood || ''}</span>
                </div>
                <div class="scene-card-title">${scene.scene_title}</div>
            </div>
            <p class="scene-desc">${scene.scene_desc}</p>

            <div class="prompt-block">
                <div class="prompt-label">
                    <span>🖼️ 文生图提示词</span>
                    <button class="btn-copy" onclick="copyText(this, 'img-prompt-${scene.scene_number}')">&#x2398; 复制</button>
                </div>
                <textarea class="prompt-textarea" id="img-prompt-${scene.scene_number}" rows="4">${scene.image_prompt}</textarea>
            </div>

            <div class="prompt-block">
                <div class="prompt-label">
                    <span>🎬 视频提示词</span>
                    <button class="btn-copy" onclick="copyText(this, 'vid-prompt-${scene.scene_number}')">&#x2398; 复制</button>
                </div>
                <textarea class="prompt-textarea" id="vid-prompt-${scene.scene_number}" rows="3">${scene.video_prompt}</textarea>
            </div>

            <button class="btn btn-sm btn-success btn-send-to-studio"
                onclick="sendToStudio(${scene.scene_number})">
                → 发送到创作工作台
            </button>
        `;
        cardsEl.appendChild(card);
    });

    showToast(`分镜生成完成，共 ${scenes.length} 个`, 'success');
}

/**
 * 复制指定 textarea 的内容
 */
function copyText(btn, textareaId) {
    const el = document.getElementById(textareaId);
    if (!el) return;
    navigator.clipboard.writeText(el.value).then(() => {
        btn.textContent = '✔ 已复制';
        setTimeout(() => { btn.innerHTML = '&#x2398; 复制'; }, 1500);
    });
}

/**
 * 将分镜提示词发送到创作工作台
 */
function sendToStudio(sceneNumber) {
    const imgPrompt = document.getElementById(`img-prompt-${sceneNumber}`)?.value || '';
    const vidPrompt = document.getElementById(`vid-prompt-${sceneNumber}`)?.value || '';

    // 填入左侧文生图提示词
    const imagePromptEl = document.getElementById('image-prompt');
    if (imagePromptEl) {
        imagePromptEl.value = imgPrompt;
        updateCharCount('image-prompt', 'image-prompt-count');
    }
    // 填入右侧视频提示词
    const videoPromptEl = document.getElementById('video-prompt');
    if (videoPromptEl) {
        videoPromptEl.value = vidPrompt;
        updateCharCount('video-prompt', 'video-prompt-count');
    }

    // 切换到工作台 Tab
    switchTab('studio');
    showToast(`分镜 ${sceneNumber} 已发送到创作工作台`, 'success');
    // 滑动到顶部
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

/**
 * 删除人物
 */
async function deleteCharacter(charId, charName) {
    if (!confirm(`确定删除人物「${charName}」？`)) return;
    try {
        const resp = await fetch(`/api/characters/${charId}`, { method: 'DELETE' });
        const data = await resp.json();
        if (data.success) {
            showToast(`人物「${charName}」已删除`, 'success');
            // 如果删除的是当前选中的人物，从选中列表中移除并重载插槽
            if (selectedCharIds.includes(charId)) {
                selectedCharIds = selectedCharIds.filter(id => id !== charId);
                delete selectedCharsCache[charId];
                reloadRefSlotsFromChars();
            }
            loadCharacters();
        } else {
            showToast('删除失败: ' + data.error, 'error');
        }
    } catch(e) {
        showToast('删除失败', 'error');
    }
}

/**
 * 打开新建人物表单
 */
function openCreateCharacter() {
    // 重置表单
    document.getElementById('new-char-name').value = '';
    newCharImages = [null, null, null];
    for (let i = 0; i < 3; i++) {
        const preview = document.getElementById(`new-char-preview-${i}`);
        const ph = document.getElementById(`new-char-ph-${i}`);
        const clearBtn = document.getElementById(`new-char-clear-${i}`);
        const input = document.getElementById(`new-char-img-${i}`);
        preview.src = ''; preview.style.display = 'none';
        ph.style.display = 'flex';
        clearBtn.style.display = 'none';
        if (input) input.value = '';
    }
    document.getElementById('create-char-form').style.display = 'block';
    document.getElementById('new-char-name').focus();
}

/**
 * 取消新建人物
 */
function cancelCreateCharacter() {
    document.getElementById('create-char-form').style.display = 'none';
    newCharImages = [null, null, null];
}

/**
 * 处理新建人物表单中的图片上传
 */
async function handleNewCharImg(input, index) {
    const file = input.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { showToast('请上传图片文件', 'error'); return; }
    if (file.size > 20 * 1024 * 1024) { showToast('图片不能超过20MB', 'error'); return; }
    
    // 展示本地预览
    const preview = document.getElementById(`new-char-preview-${index}`);
    const ph = document.getElementById(`new-char-ph-${index}`);
    const clearBtn = document.getElementById(`new-char-clear-${index}`);
    const reader = new FileReader();
    reader.onload = e => {
        preview.src = e.target.result;
        preview.style.display = 'block';
        ph.style.display = 'none';
        clearBtn.style.display = 'flex';
    };
    reader.readAsDataURL(file);
    
    // 上传到服务器
    const formData = new FormData();
    formData.append('image', file);
    try {
        showToast(`上传参考图${index + 1}...`);
        const resp = await fetch('/api/upload-image', { method: 'POST', body: formData });
        const result = await resp.json();
        if (result.success) {
            newCharImages[index] = { filename: result.filename, base64_url: result.base64_url };
            showToast(`图${index + 1}上传成功`, 'success');
        } else {
            showToast('上传失败: ' + result.error, 'error');
            clearNewCharImg(null, index);
        }
    } catch(e) {
        showToast('上传失败: ' + e.message, 'error');
        clearNewCharImg(null, index);
    }
    input.value = '';
}

/**
 * 清除新建人物表单中的单张图
 */
function clearNewCharImg(event, index) {
    if (event) event.stopPropagation();
    newCharImages[index] = null;
    const preview = document.getElementById(`new-char-preview-${index}`);
    const ph = document.getElementById(`new-char-ph-${index}`);
    const clearBtn = document.getElementById(`new-char-clear-${index}`);
    const input = document.getElementById(`new-char-img-${index}`);
    preview.src = ''; preview.style.display = 'none';
    ph.style.display = 'flex';
    clearBtn.style.display = 'none';
    if (input) input.value = '';
}

/**
 * 保存新建人物
 */
async function saveCharacter() {
    const name = document.getElementById('new-char-name').value.trim();
    if (!name) { showToast('请输入人物名称', 'error'); return; }
    
    const validImages = newCharImages.filter(img => img !== null);
    if (validImages.length === 0) { showToast('请至少上传一张参考图', 'error'); return; }
    
    const btn = document.getElementById('btn-save-char');
    btn.disabled = true;
    btn.textContent = '保存中...';
    
    try {
        const resp = await fetch('/api/characters', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, images: validImages })
        });
        const data = await resp.json();
        if (data.success) {
            showToast(`人物「${name}」已保存`, 'success');
            cancelCreateCharacter();
            loadCharacters();
        } else {
            showToast('保存失败: ' + data.error, 'error');
        }
    } catch(e) {
        showToast('保存失败: ' + e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '💾 保存人物';
    }
}
