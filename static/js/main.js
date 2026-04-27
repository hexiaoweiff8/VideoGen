// 全局状态
let currentTaskId = null;
let currentImageFilename = null;
let currentVideoFilename = null;
let videoSourceImageUrl = null;    // 右侧视频生成使用的图片URL（oss:// 供通义万相）
let videoSourceHttpsUrl = null;    // MinIO公网URL，供即梦使用
let lastGeneratedImageUrl = null;  // 左侧最近生成的图片URL（公网可访问）
let lastGeneratedImageFilename = null; // 左侧最近生成图片的文件名
let referenceImageUrls = [null, null, null, null, null, null, null, null, null]; // 左侧文生图使用的参考图Base64 URL，最多9张
let videoRefImageUrls = [null, null, null, null, null]; // 右侧视频r2v参考图Base64 URL，最多5张
let pollTimer = null;
let pollStartTime = null;
let lastVideoUrl = null;    // 最近生成的视频CDN URL（供 VLM 评审）
let lastVideoPrompt = null; // 最近视频生成的提示词

// 新建人物表单中的临时图片数据 [{filename, base64_url}, ...]
let newCharImages = [null, null, null, null, null, null, null, null, null];
// 当前已选中的人物ID数组（支持多选）
let selectedCharIds = [];
// 人物数据缓存 { charId: characterObject }
let selectedCharsCache = {};
// 分镜Tab已选人物ID数组
let sceneCharIds = [];
// 分镜Tab人物数据缓存
let sceneCharsCache = {};

const POLL_INTERVAL = 5000; // 5秒
const POLL_TIMEOUT = 3600000; // 1小时

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
 * 更新状态显示（已用面板遮罩层替代，保留函数以兼容旧调用）
 */
function updateStatus(stage, status, taskId = null) {
    // no-op: 状态显示已迁移至面板遮罩层
}

/**
 * 更新进度条（已用面板遮罩层替代，保留函数以兼容旧调用）
 */
function updateProgress(status) {
    // no-op: 进度显示已迁移至面板遮罩层
}

/**
 * 显示面板生成中遮罩
 * @param {string} sectionId - 'image' 或 'video'
 * @param {string} text - 显示文案
 * @param {number} progressPct - 进度百分比
 */
function showSectionLoading(sectionId, text, progressPct = 10) {
    const overlay = document.getElementById(`${sectionId}-loading-overlay`);
    const textEl  = document.getElementById(`${sectionId}-loading-text`);
    const barEl   = document.getElementById(`${sectionId}-loading-bar`);
    if (textEl) textEl.textContent = text;
    if (barEl)  barEl.style.width  = progressPct + '%';
    if (overlay) overlay.style.display = 'flex';
}

/**
 * 更新面板生成中遮罩的文案和进度
 */
function updateSectionLoading(sectionId, text, progressPct) {
    const textEl = document.getElementById(`${sectionId}-loading-text`);
    const barEl  = document.getElementById(`${sectionId}-loading-bar`);
    if (textEl && text !== undefined)        textEl.textContent = text;
    if (barEl  && progressPct !== undefined) barEl.style.width  = progressPct + '%';
}

/**
 * 隐藏面板生成中遮罩
 * @param {string} sectionId - 'image' 或 'video'
 * @param {number} delay - 延迟毫秒数，默认0（立即隐藏）
 */
function hideSectionLoading(sectionId, delay = 0) {
    const fn = () => {
        const overlay = document.getElementById(`${sectionId}-loading-overlay`);
        if (overlay) overlay.style.display = 'none';
    };
    delay > 0 ? setTimeout(fn, delay) : fn();
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

/**
 * 初始化视频参考图插槽（r2v模式）
 */
function initVideoRefSlots() {
    const container = document.getElementById('video-ref-slots');
    if (!container) return;
    container.innerHTML = '';
    for (let i = 0; i < 5; i++) {
        const slot = document.createElement('div');
        slot.className = 'upload-slot';
        slot.innerHTML = `
            <div class="slot-label">图${i + 1}</div>
            <div class="upload-box" onclick="document.getElementById('vref-image-${i}').click()">
                <div class="upload-placeholder" id="placeholder-vref-${i}">
                    <div class="upload-icon">+</div>
                    <small>上传参考图</small>
                </div>
                <img class="preview-img" id="preview-vref-${i}" src="" style="display:none;">
                <button class="ref-clear-btn" id="clear-vref-${i}" onclick="clearVideoRefImage(event, ${i})" style="display:none;">×</button>
                <input type="file" id="vref-image-${i}" accept="image/*" style="display:none;" onchange="handleVideoRefUpload(this, ${i})">
            </div>
        `;
        container.appendChild(slot);
    }
}

/**
 * 处理视频参考图上传
 */
async function handleVideoRefUpload(input, index) {
    const file = input.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
        showToast('请上传图片文件', 'error');
        return;
    }
    if (file.size > 20 * 1024 * 1024) {
        showToast('图片大小不能超过20MB', 'error');
        return;
    }
    // 立即显示本地预览
    const preview = document.getElementById(`preview-vref-${index}`);
    const placeholder = document.getElementById(`placeholder-vref-${index}`);
    const clearBtn = document.getElementById(`clear-vref-${index}`);
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
        showToast(`正在上传视频参考图${index + 1}...`);
        const response = await fetch('/api/upload-image', {
            method: 'POST',
            body: formData
        });
        const result = await response.json();
        if (result.success) {
            videoRefImageUrls[index] = result.base64_url;
            const uploaded = videoRefImageUrls.filter(u => u !== null).length;
            showToast(`视频参考图${index + 1}上传成功（已上传${uploaded}张）`, 'success');
        } else {
            showToast('上传失败: ' + result.error, 'error');
            clearVideoRefImage(null, index);
        }
    } catch (error) {
        showToast('上传失败: ' + error.message, 'error');
        clearVideoRefImage(null, index);
    }
    input.value = '';
}

/**
 * 清除视频参考图
 */
function clearVideoRefImage(event, index) {
    if (event) event.stopPropagation();
    videoRefImageUrls[index] = null;
    const preview = document.getElementById(`preview-vref-${index}`);
    const placeholder = document.getElementById(`placeholder-vref-${index}`);
    const clearBtn = document.getElementById(`clear-vref-${index}`);
    const fileInput = document.getElementById(`vref-image-${index}`);
    preview.src = '';
    preview.style.display = 'none';
    placeholder.style.display = 'flex';
    if (clearBtn) clearBtn.style.display = 'none';
    if (fileInput) fileInput.value = '';
}

/**
 * 生成图片
 */
async function generateImage() {
    const prompt = document.getElementById('image-prompt').value.trim();
    const negativePrompt = document.getElementById('negative-prompt').value.trim();
    const size = document.getElementById('image-size').value;
    const model = document.getElementById('image-model').value;  // 获取选择的模型
    
    if (!prompt) {
        showToast('请输入图片描述', 'error');
        return;
    }
    
    // 收集参考图(如果有的话)
    const refImages = referenceImageUrls.filter(url => url !== null);
    
    // 获取页面API配置
    const apiCfg = getApiConfig();
    
    // 更新UI
    showSectionLoading('image', '正在生成图片...', 30);
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
                model: model,  // 传递模型参数
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
            updateSectionLoading('image', '图片生成完成 ✓', 100);
            hideSectionLoading('image', 1500);
            
            showToast('图片生成成功!', 'success');
        } else {
            hideSectionLoading('image');
            showToast('生成失败: ' + result.error, 'error');
        }
    } catch (error) {
        hideSectionLoading('image');
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
    videoSourceHttpsUrl = null;
    
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
        videoSourceHttpsUrl = null;
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
            // oss:// URL 供通义万相；https:// URL 供即梦
            videoSourceImageUrl = result.oss_url;
            videoSourceHttpsUrl = result.https_url || null;
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
    const model = document.getElementById('video-model').value;
    const isR2v = (model === 'r2v');
    
    // 即梦使用MinIO https URL；通义万相使用 oss:// URL
    const imageUrlInput = document.getElementById('image-url-input').value.trim();
    const imageUrl = (model === 'jimeng')
        ? (videoSourceHttpsUrl || videoSourceImageUrl || imageUrlInput)
        : (videoSourceImageUrl || imageUrlInput);
    
    // r2v模式：首帧图可选（可以是纯背景），但必须有参考图或首帧图至少一个
    // i2v模式：首帧图必填
    if (!imageUrl) {
        if (model === 'jimeng') {
            // 即梦支持纯文生视频
        } else if (isR2v) {
            // r2v 可以没有首帧图，但检查是否有参考图
            const videoRefs = videoRefImageUrls.filter(u => u !== null);
            if (videoRefs.length === 0) {
                showToast('参考生视频需要至少上传一张人物参考图或首帧图', 'error');
                return;
            }
        } else {
            showToast('请上传图片或输入图片URL', 'error');
            return;
        }
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
    
    // 保存当前提示词供评审使用
    lastVideoPrompt = prompt;
    
    // 验证时长范围
    const maxDuration = isR2v ? 10 : 15;
    if (duration < 2 || duration > maxDuration) {
        showToast(`视频时长必须在2-${maxDuration}秒之间`, 'error');
        return;
    }
    
    // 收集r2v参考图
    const videoRefs = isR2v ? videoRefImageUrls.filter(u => u !== null) : [];
    
    // 更新UI
    showSectionLoading('video', '创建视频任务中...', 20);
    
    // 获取页面API配置
    const apiCfg = getApiConfig();
    
    try {
        showToast('正在创建视频任务...');
        
        const reqBody = {
            image_url: imageUrl || '',
            prompt: prompt,
            resolution: resolution,
            duration: Math.min(duration, maxDuration),
            model: model,
            ...apiCfg.video
        };
        
        // r2v 模式发送参考图
        if (isR2v && videoRefs.length > 0) {
            reqBody.reference_images = videoRefs;
        }
        
        console.log('发送视频生成请求:', {
            model: model,
            has_image: !!imageUrl,
            ref_count: videoRefs.length,
            prompt: prompt.substring(0, 50) + '...',
            resolution: resolution,
            duration: duration
        });
        
        const response = await fetch('/api/generate-video', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(reqBody)
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
            hideSectionLoading('video');
        }
    } catch (error) {
        console.error('请求失败:', error);
        showToast('请求失败: ' + error.message, 'error');
        hideSectionLoading('video');
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
            updateSectionLoading('video', '任务超时 ✗', 100);
            hideSectionLoading('video', 2000);
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
                
                // 保存 CDN URL 供评审使用
                lastVideoUrl = result.video_url || null;
                
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
                
                updateSectionLoading('video', '视频生成完成 ✓', 100);
                hideSectionLoading('video', 1500);
                showToast('视频生成成功!', 'success');
            } else if (result.status === 'FAILED') {
                // 任务失败
                clearInterval(pollTimer);
                updateSectionLoading('video', '生成失败 ✗', 100);
                hideSectionLoading('video', 2000);
                showToast('生成失败: ' + (result.error || '未知错误'), 'error');
            } else {
                // 任务进行中
                if (result.status === 'PENDING') {
                    updateSectionLoading('video', '任务排队中...', 25);
                } else {
                    updateSectionLoading('video', '视频生成中...', 60);
                }
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

    // 显示评审按钮，重置上次评审结果
    document.getElementById('btn-review-video').style.display = 'inline-block';
    document.getElementById('video-review-result').style.display = 'none';
    document.getElementById('review-content').innerHTML = '';
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

    // 显示评审按钮，重置上次评审结果
    document.getElementById('btn-review-video').style.display = 'inline-block';
    document.getElementById('video-review-result').style.display = 'none';
    document.getElementById('review-content').innerHTML = '';
}

// ==================== 一键生成 ====================

/**
 * VLM 视频内容评审
 */
async function reviewVideoWithVLM() {
    if (!lastVideoUrl) {
        showToast('暂无视频CDN URL，无法评审（尝试在视频生成后立即评审）', 'error');
        return;
    }
    const scenePrompt = lastVideoPrompt || document.getElementById('video-prompt').value.trim();

    const loadingEl  = document.getElementById('review-loading');
    const contentEl  = document.getElementById('review-content');
    const resultArea = document.getElementById('video-review-result');
    const btn        = document.getElementById('btn-review-video');

    // 显示 loading
    resultArea.style.display = 'block';
    loadingEl.style.display  = 'flex';
    contentEl.innerHTML      = '';
    btn.disabled             = true;
    btn.textContent          = '评审中...';

    try {
        const resp = await fetch('/api/review-video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ video_url: lastVideoUrl, scene_prompt: scenePrompt })
        });
        const data = await resp.json();
        loadingEl.style.display = 'none';

        if (data.success) {
            renderReviewResult(data.review);
        } else {
            contentEl.innerHTML = `<p class="review-error">评审失败：${data.error}</p>`;
        }
    } catch (e) {
        loadingEl.style.display = 'none';
        contentEl.innerHTML = `<p class="review-error">请求异常：${e.message}</p>`;
    } finally {
        btn.disabled    = false;
        btn.textContent = '🔍 VLM评审';
    }
}

/**
 * 渲染评审结果卡片
 */
function renderReviewResult(review) {
    const contentEl = document.getElementById('review-content');

    const scoreColor = (s) => s >= 8 ? '#52c41a' : s >= 6 ? '#faad14' : '#ff4d4f';
    const scoreBar   = (s) => `<div class="review-score-bar"><div class="review-score-fill" style="width:${s*10}%;background:${scoreColor(s)}"></div></div>`;

    const dims = [
        { key: 'scene_match',      label: '场景匹配' },
        { key: 'motion_quality',   label: '动作质量' },
        { key: 'visual_quality',   label: '画面质量' },
        { key: 'consistency',      label: '人物一致性' },
    ];

    let dimsHtml = dims.map(d => {
        const dim = review[d.key] || {};
        const s   = dim.score || 0;
        return `
        <div class="review-dim">
            <div class="review-dim-header">
                <span class="review-dim-label">${d.label}</span>
                <span class="review-dim-score" style="color:${scoreColor(s)}">${s}/10</span>
            </div>
            ${scoreBar(s)}
            <p class="review-dim-comment">${dim.comment || ''}</p>
        </div>`;
    }).join('');

    const overall = review.overall_score || 0;
    contentEl.innerHTML = `
        <div class="review-overall">
            <span class="review-overall-label">综合评分</span>
            <span class="review-overall-score" style="color:${scoreColor(overall)}">${overall}</span>
            <span class="review-overall-unit">/10</span>
        </div>
        <div class="review-dims">${dimsHtml}</div>
        ${review.suggestion ? `<div class="review-suggestion"><span>💡 改进建议：</span>${review.suggestion}</div>` : ''}
    `;

    // 保存这次 vlm 输出，并显示反馈输入区
    lastVlmOutput = review;
    const fbArea = document.getElementById('review-feedback-area');
    if (fbArea) {
        fbArea.style.display = 'block';
        document.getElementById('review-feedback-text').value = '';
        document.getElementById('feedback-submit-status').textContent = '';
    }
}

let lastVlmOutput = null; // 最近VLM评审输出，供反馈存储使用

/**
 * 提交用户反馈
 */
async function submitReviewFeedback() {
    const text = document.getElementById('review-feedback-text').value.trim();
    if (!text) { showToast('请先写下你的看法', 'error'); return; }

    const btn       = document.getElementById('btn-submit-feedback');
    const statusEl  = document.getElementById('feedback-submit-status');
    btn.disabled    = true;
    statusEl.style.color = '';
    statusEl.textContent = '提交中...';

    try {
        const resp = await fetch('/api/review-feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                video_url:     lastVideoUrl || '',
                scene_prompt:  lastVideoPrompt || '',
                vlm_output:    lastVlmOutput || {},
                user_feedback: text
            })
        });
        const data = await resp.json();
        if (data.success) {
            statusEl.style.color = '#52c41a';
            statusEl.textContent = `已保存，共 ${data.total_feedbacks} 条反馈`;
            document.getElementById('review-feedback-text').value = '';
            // 更新进化面板
            loadReviewStatus();
        } else {
            statusEl.style.color = '#ff4d4f';
            statusEl.textContent = '保存失败：' + data.error;
        }
    } catch (e) {
        statusEl.style.color = '#ff4d4f';
        statusEl.textContent = '请求异常：' + e.message;
    } finally {
        btn.disabled = false;
    }
}

/**
 * 触发提示词进化
 */
async function evolveReviewPrompt() {
    const btn      = document.getElementById('btn-evolve');
    const statusEl = document.getElementById('evolve-status');
    btn.disabled   = true;
    btn.textContent = '分析中...';
    statusEl.style.color = '';
    statusEl.textContent = '千问正在分析反馈并重写评审标准，请稍候...';

    try {
        const resp = await fetch('/api/evolve-review-prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        const data = await resp.json();
        if (data.success) {
            statusEl.style.color = '#52c41a';
            statusEl.textContent = `进化成功！新版本 ${data.new_version}，基于 ${data.feedback_count} 条反馈生成`;
            loadReviewStatus();
            showToast(`评审标准已进化到 ${data.new_version}`, 'success');
        } else {
            statusEl.style.color = '#ff4d4f';
            statusEl.textContent = '进化失败：' + data.error;
        }
    } catch (e) {
        statusEl.style.color = '#ff4d4f';
        statusEl.textContent = '请求异常：' + e.message;
    } finally {
        btn.disabled    = false;
        btn.textContent = '✨ 优化评审标准（千问分析反馈）';
    }
}

/**
 * 加载评审进化状态
 */
async function loadReviewStatus() {
    try {
        const resp = await fetch('/api/review-status');
        const data = await resp.json();
        if (!data.success) return;

        const card = document.getElementById('review-evolution-card');
        // 有反馈或多个版本时才显示进化面板
        if (data.feedback_count > 0 || data.versions.length > 1) {
            card.style.display = 'block';
        }

        document.getElementById('review-version-badge').textContent = data.current_version;
        document.getElementById('feedback-count').textContent = data.feedback_count;

        // 渲染版本历史
        const historyEl = document.getElementById('evolve-history');
        if (data.versions.length > 0) {
            historyEl.innerHTML = '<div class="evolve-history-title">版本历史</div>' +
                data.versions.map(v => {
                    const isLatest = v.version === data.current_version;
                    const dt = v.created_at ? v.created_at.replace('T', ' ').substring(0, 16) : '';
                    const label = v.feedback_count_at_creation === 0
                        ? '初始版本'
                        : `基于 ${v.feedback_count_at_creation} 条反馈`;
                    return `<div class="evolve-version-item ${isLatest ? 'is-current' : ''}">
                        <div class="evolve-version-header">
                            <span class="evolve-version-num">${v.version}</span>
                            <span class="evolve-version-meta">${dt} &nbsp; ${label}</span>
                            ${isLatest ? '<span class="evolve-current-tag">当前</span>' : ''}
                        </div>
                        <div class="evolve-version-preview" id="preview-${v.version}" style="display:none;">${v.prompt_preview}...</div>
                        <button class="evolve-version-toggle" onclick="togglePromptPreview('${v.version}')">查看提示词</button>
                    </div>`;
                }).join('');
        } else {
            historyEl.innerHTML = '';
        }
    } catch (e) {
        console.warn('加载评审状态失败:', e.message);
    }
}

/**
 * 展开/折叠提示词预览
 */
function togglePromptPreview(version) {
    const el = document.getElementById(`preview-${version}`);
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// ==================== 一键生成 ==================== (second)
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
    showSectionLoading('image', '正在生成图片...', 20);
    showSectionLoading('video', '等待图片生成...', 10);
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
            updateSectionLoading('image', '图片已生成 ✓', 100);
            hideSectionLoading('image', 1500);
            updateSectionLoading('video', '正在生成视频...', 40);
            showToast('图片生成完成,正在生成视频...');
            
            startPolling();
        } else {
            hideSectionLoading('image');
            hideSectionLoading('video');
            showToast(`${result.stage}阶段失败: ${result.error}`, 'error');
        }
    } catch (error) {
        hideSectionLoading('image');
        hideSectionLoading('video');
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
    initVideoRefSlots(); // 初始化视频参考图插槽
});

/**
 * 视频模型切换时的 UI 联动
 */
function onVideoModelChange(model) {
    const firstFrameReq = document.getElementById('first-frame-required');
    const firstFrameHint = document.getElementById('first-frame-hint');
    const refHint = document.getElementById('ref-hint');
    const refSlots = document.getElementById('video-ref-slots');
    const durationHint = document.getElementById('duration-hint');
    const durationInput = document.getElementById('video-duration');

    if (model === 'r2v') {
        // r2v 模式：首帧图变为可选，参考图生效，时长上限10秒
        firstFrameReq.style.display = 'none';
        firstFrameHint.textContent = '首帧图可选（r2v支持纯参考图生成人物入场）';
        refHint.textContent = '当前生效：人物三视图/道具/场景，提示词中用“图1”“图2”指代';
        refHint.style.color = '';
        refSlots.style.opacity = '1';
        refSlots.style.pointerEvents = 'auto';
        durationHint.textContent = '2-10秒（r2v最长10秒）';
        durationInput.max = 10;
        if (parseInt(durationInput.value) > 10) durationInput.value = 10;
    } else {
        // i2v / 即梦模式：参考图不生效，视觉上灰化提示
        firstFrameReq.style.display = 'inline';
        firstFrameHint.textContent = '视频第一帧的画面，可以是含人物的图或纯背景场景';
        refHint.textContent = '当前模型不支持参考图，请切换到 r2v 模型';
        refHint.style.color = '#e74c3c';
        refSlots.style.opacity = '0.4';
        refSlots.style.pointerEvents = 'none';
        durationHint.textContent = '2-15秒';
        durationInput.max = 15;
    }
}


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
    for (let i = 0; i < 9; i++) clearRefImage(null, i);

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

    if (allImages.length > 9) {
        showToast(`参考图共${allImages.length}张，插槽上限为9，取前9张`, 'info');
    }

    allImages.slice(0, 9).forEach((img, i) => {
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
    showToast(`已加载「${names}」共${Math.min(allImages.length, 9)}张参考图`, 'success');
}


// ==================== 分镜人物选择 ====================

/**
 * 加载分镜Tab人物列表
 */
async function loadSceneCharacters() {
    try {
        const resp = await fetch('/api/characters');
        const data = await resp.json();
        if (data.success) renderSceneCharList(data.characters);
    } catch(e) {
        console.error('加载分镜人物列表失败', e);
    }
}

/**
 * 渲染分镜人物选择列表
 */
function renderSceneCharList(characters) {
    const select = document.getElementById('scene-char-select');
    const empty = document.getElementById('scene-char-empty');

    // 清空
    select.innerHTML = '';

    if (!characters || characters.length === 0) {
        empty.style.display = 'block';
        return;
    }
    empty.style.display = 'none';

    characters.forEach(char => {
        const card = document.createElement('div');
        card.className = 'char-card' + (sceneCharIds.includes(char.id) ? ' char-card-selected' : '');
        card.dataset.charId = char.id;
        card.innerHTML = `
            <div class="char-thumb" onclick="toggleSceneChar('${char.id}')">
                ${char.thumbnail
                    ? `<img src="${char.thumbnail}" alt="${char.name}">`
                    : `<div class="char-thumb-placeholder">👤</div>`}
            </div>
            <div class="char-info" onclick="toggleSceneChar('${char.id}')">
                <span class="char-name">${char.name}</span>
                <span class="char-count">${char.image_count || 0} 张图</span>
            </div>
        `;
        select.appendChild(card);
    });
}

/**
 * 勾选/取消勾选分镜人物
 */
async function toggleSceneChar(charId) {
    const idx = sceneCharIds.indexOf(charId);
    if (idx !== -1) {
        sceneCharIds.splice(idx, 1);
        delete sceneCharsCache[charId];
    } else {
        try {
            const resp = await fetch(`/api/characters/${charId}`);
            const data = await resp.json();
            if (!data.success) return;
            sceneCharsCache[charId] = data.character;
            sceneCharIds.push(charId);
        } catch(e) {
            showToast('加载人物失败: ' + e.message, 'error');
            return;
        }
    }

    // 更新高亮
    document.querySelectorAll('#scene-char-select .char-card').forEach(el => {
        el.classList.toggle('char-card-selected', sceneCharIds.includes(el.dataset.charId));
    });

    const names = sceneCharIds.map(id => sceneCharsCache[id]?.name).filter(Boolean).join('、');
    if (names) showToast(`已选择：${names}`, 'info');
    else showToast('已取消人物选择', 'info');
}

/**
 * 获取已选分镜人物列表
 */
function getSelectedSceneChars() {
    return sceneCharIds.map(id => {
        const c = sceneCharsCache[id];
        return c ? { id: c.id, name: c.name } : null;
    }).filter(Boolean);
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
                api_key: apiCfg.image.api_key || '',
                characters: getSelectedSceneChars()
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

    scenes.forEach((scene, idx) => {
        // === 格式兼容：确保 transition 是字符串 ===
        let transitionText = scene.transition || '';
        if (typeof transitionText === 'object') {
            const parts = [transitionText.type, transitionText.logic, transitionText.emotion].filter(Boolean);
            transitionText = parts.join('——');
        }

        const card = document.createElement('div');
        card.className = 'scene-card';

        // 衔接提示（非第一个分镜）
        let transitionHtml = '';
        if (idx > 0 && transitionText) {
            transitionHtml = `
            <div class="scene-transition-banner">
                <span class="transition-icon">⇣</span>
                <span class="transition-text">衔接：${transitionText}</span>
            </div>`;
        }

        // 时长与节奏
        let durationHtml = '';
        if (scene.duration) {
            durationHtml = `<span class="scene-duration-badge">⏱ ${scene.duration}</span>`;
        }

        card.innerHTML = `
            ${transitionHtml}
            <div class="scene-card-header">
                <div class="scene-card-meta">
                    <span class="scene-num-badge">分镜 ${scene.scene_number}</span>
                    <span class="scene-shot-badge">${scene.shot_type || ''}</span>
                    <span class="scene-mood-badge">${scene.mood || ''}</span>
                    ${durationHtml}
                </div>
                <div class="scene-card-title">${scene.scene_title}</div>
            </div>
            ${sceneCharIds.length > 0 ? `<div class="scene-chars-tags">${sceneCharIds.map(id => `<span class="scene-char-tag">${sceneCharsCache[id]?.name || ''}</span>`).join('')}</div>` : ''}
            <p class="scene-desc">${scene.scene_desc}</p>

            <div class="prompt-block">
                <div class="prompt-label">
                    <span>🖼️ 文生图提示词</span>
                    <div style="display:flex;gap:6px;align-items:center;">
                        <span class="prompt-editable-hint">可直接编辑</span>
                        <button class="btn-copy" onclick="copyText(this, 'img-prompt-${scene.scene_number}')">&#x2398; 复制</button>
                    </div>
                </div>
                <textarea class="prompt-textarea prompt-textarea-editable" id="img-prompt-${scene.scene_number}" rows="6" placeholder="文生图提示词..."></textarea>
            </div>

            <div class="prompt-block">
                <div class="prompt-label">
                    <span>🎬 视频提示词</span>
                    <div style="display:flex;gap:6px;align-items:center;">
                        <span class="prompt-editable-hint">可直接编辑</span>
                        <button class="btn-copy" onclick="copyText(this, 'vid-prompt-${scene.scene_number}')">&#x2398; 复制</button>
                    </div>
                </div>
                <textarea class="prompt-textarea prompt-textarea-editable" id="vid-prompt-${scene.scene_number}" rows="5" placeholder="视频提示词..."></textarea>
            </div>

            <button class="btn btn-sm btn-success btn-send-to-studio"
                onclick="sendToStudio(${scene.scene_number})">
                → 发送到创作工作台
            </button>

            <!-- 评审结果区（评审后注入） -->
            <div class="scene-review-inline" id="scene-review-inline-${scene.scene_number}" style="display:none;"></div>
        `;

        // 缓存分镜数据，供评审使用
        sceneDataCache[scene.scene_number] = scene;
        // 用 DOM value 赋值，避免 HTML 特殊字符导致 textarea 损坏
        card.querySelector(`#img-prompt-${scene.scene_number}`).value = scene.image_prompt || '';
        card.querySelector(`#vid-prompt-${scene.scene_number}`).value = scene.video_prompt || '';
        cardsEl.appendChild(card);
    });

    // 显示全局评审卡片
    const reviewCard = document.getElementById('scene-review-global-card');
    if (reviewCard) reviewCard.style.display = 'block';
    // 重置评审结果
    const resultEl = document.getElementById('scene-review-global-result');
    if (resultEl) { resultEl.style.display = 'none'; resultEl.innerHTML = ''; }
    const statusEl = document.getElementById('review-all-status');
    if (statusEl) statusEl.textContent = '';

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

// ==================== 分镜评审与进化 ====================

// 内存中缓存各分镜数据（供反馈提交使用）
let sceneDataCache = {}; // { scene_number: sceneObject }

/**
 * 全局评审全部分镜
 */
async function reviewAllScenes() {
    const btn = document.getElementById('btn-review-all-scenes');
    const statusEl = document.getElementById('review-all-status');
    const resultEl = document.getElementById('scene-review-global-result');

    const scenes = Object.values(sceneDataCache).sort((a, b) => a.scene_number - b.scene_number);
    if (scenes.length === 0) { showToast('没有分镜数据', 'error'); return; }

    btn.disabled = true;
    btn.textContent = '全局评审中...';
    statusEl.textContent = '';
    resultEl.style.display = 'block';
    resultEl.innerHTML = '<div class="scene-review-loading">千问正在对全部分镜做全局评审，请稍候...</div>';

    try {
        const apiCfg = getApiConfig();
        const resp = await fetch('/api/review-scene', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scenes, api_key: apiCfg.image.api_key || '' })
        });
        const data = await resp.json();
        if (data.success) {
            renderAllSceneReviews(data.review);
        } else {
            resultEl.innerHTML = `<div class="scene-review-error">评审失败：${data.error}</div>`;
        }
    } catch (e) {
        resultEl.innerHTML = `<div class="scene-review-error">请求异常：${e.message}</div>`;
    } finally {
        btn.disabled = false;
        btn.textContent = '🔍 全局评审全部分镜';
    }
}

/**
 * 渲染全局评审结果（注入到各分镜卡片内）
 */
function renderAllSceneReviews(review) {
    const overall = review.overall_score || 0;
    const scoreColor = s => s >= 8 ? '#52c41a' : s >= 6 ? '#faad14' : '#ff4d4f';
    const sceneReviews = review.scenes || [];

    // 在每个分镜卡片内注入评审结果
    sceneReviews.forEach(sr => {
        const container = document.getElementById(`scene-review-inline-${sr.scene_number}`);
        if (!container) return;
        container.style.display = 'block';

        const dims = [
            { key: 'narrative',          label: '叙事' },
            { key: 'image_prompt_score', label: '图片提示词' },
            { key: 'video_prompt_score', label: '视频提示词' },
            { key: 'transition_score',   label: '衔接' }
        ];
        const dimsHtml = dims.map(d => {
            const s = sr[d.key] ?? '-';
            return `<span class="scene-review-dim"><span class="scene-review-dim-label">${d.label}</span><span class="scene-review-dim-score" style="color:${scoreColor(s)}">${s}</span></span>`;
        }).join('');

        const scene = sceneDataCache[sr.scene_number];
        const duration = scene?.duration ? ` ⏱${scene.duration}` : '';

        container.innerHTML = `
            <div class="scene-review-inline-inner">
                <div class="scene-review-inline-header">
                    <span class="scene-review-inline-score" style="color:${scoreColor(sr.score)}">${sr.score}/10</span>
                    <span class="scene-review-inline-title">分镜 ${sr.scene_number}：${scene?.scene_title || ''}${duration}</span>
                </div>
                <div class="scene-review-dims">${dimsHtml}</div>
                ${sr.suggestion ? `<div class="scene-review-suggestion">💡 ${sr.suggestion}</div>` : ''}
                <div class="scene-feedback-area">
                    <textarea id="scene-fb-text-${sr.scene_number}" class="scene-fb-textarea" rows="2" placeholder="对这个分镜的改进意见..."></textarea>
                    <div style="display:flex;align-items:center;gap:6px;margin-top:4px;">
                        <button class="btn btn-sm btn-primary" id="btn-scene-fb-${sr.scene_number}"
                            onclick="submitSceneFeedback(${sr.scene_number})">💾 提交反馈</button>
                        <span id="scene-fb-status-${sr.scene_number}" style="font-size:12px;"></span>
                    </div>
                </div>
            </div>
        `;
    });

    // 在顶部按钮旁边显示整体评分
    const statusEl = document.getElementById('review-all-status');
    if (statusEl) {
        statusEl.style.color = scoreColor(overall);
        statusEl.innerHTML = `<b>${overall}/10</b> — ${review.overall_comment || ''}`;
    }
}

/**
 * 提交单个分镜反馈
 */
async function submitSceneFeedback(sceneNumber) {
    const text = document.getElementById(`scene-fb-text-${sceneNumber}`)?.value.trim();
    if (!text) { showToast('请先写下你的反馈', 'error'); return; }

    const btn      = document.getElementById(`btn-scene-fb-${sceneNumber}`);
    const statusEl = document.getElementById(`scene-fb-status-${sceneNumber}`);
    btn.disabled   = true;
    statusEl.textContent = '提交中...';

    const scene  = sceneDataCache[sceneNumber] || {};

    try {
        const resp = await fetch('/api/scene-feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                scene_number:  sceneNumber,
                scene_title:   scene.scene_title || '',
                scene_data:    scene,
                review_output: {},
                user_feedback: text
            })
        });
        const data = await resp.json();
        if (data.success) {
            statusEl.style.color = '#52c41a';
            statusEl.textContent = `已保存，共 ${data.total_feedbacks} 条`;
            document.getElementById(`scene-fb-text-${sceneNumber}`).value = '';
            loadSceneStatus();
        } else {
            statusEl.style.color = '#ff4d4f';
            statusEl.textContent = '保存失败：' + data.error;
        }
    } catch (e) {
        statusEl.style.color = '#ff4d4f';
        statusEl.textContent = '请求异常：' + e.message;
    } finally {
        btn.disabled = false;
    }
}

/**
 * 触发分镜生成提示词进化
 */
async function evolveScenePrompt() {
    const btn      = document.getElementById('btn-evolve-scene');
    const statusEl = document.getElementById('scene-evolve-status');
    btn.disabled   = true;
    btn.textContent = '分析中...';
    statusEl.style.color = '';
    statusEl.textContent = '千问正在分析反馈并重写分镜生成标准，请稍候...';

    try {
        const resp = await fetch('/api/evolve-scene-prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        const data = await resp.json();
        if (data.success) {
            statusEl.style.color = '#52c41a';
            statusEl.textContent = `进化成功！新版本 ${data.new_version}，基于 ${data.feedback_count} 条反馈生成`;
            loadSceneStatus();
            showToast(`分镜生成标准已进化到 ${data.new_version}`, 'success');
        } else {
            statusEl.style.color = '#ff4d4f';
            statusEl.textContent = '进化失败：' + data.error;
        }
    } catch (e) {
        statusEl.style.color = '#ff4d4f';
        statusEl.textContent = '请求异常：' + e.message;
    } finally {
        btn.disabled    = false;
        btn.textContent = '✨ 优化生成标准（千问分析反馈）';
    }
}

/**
 * 加载分镜进化面板状态
 */
async function loadSceneStatus() {
    try {
        const resp = await fetch('/api/scene-status');
        const data = await resp.json();
        if (!data.success) return;

        const card = document.getElementById('scene-evolution-card');
        if (data.feedback_count > 0 || data.versions.length > 1) {
            card.style.display = 'block';
        }
        document.getElementById('scene-version-badge').textContent = data.current_version;
        document.getElementById('scene-feedback-count').textContent = data.feedback_count;

        const historyEl = document.getElementById('scene-evolve-history');
        if (data.versions.length > 0) {
            historyEl.innerHTML = '<div class="evolve-history-title">版本历史</div>' +
                data.versions.map(v => {
                    const isLatest = v.version === data.current_version;
                    const dt = v.created_at ? v.created_at.replace('T', ' ').substring(0, 16) : '';
                    const label = v.feedback_count_at_creation === 0
                        ? '初始版本'
                        : `基于 ${v.feedback_count_at_creation} 条反馈`;
                    return `<div class="evolve-version-item ${isLatest ? 'is-current' : ''}">
                        <div class="evolve-version-header">
                            <span class="evolve-version-num">${v.version}</span>
                            <span class="evolve-version-meta">${dt} &nbsp; ${label}</span>
                            ${isLatest ? '<span class="evolve-current-tag">当前</span>' : ''}
                        </div>
                        <div class="evolve-version-preview" id="scene-preview-${v.version}" style="display:none;">${v.prompt_preview}...</div>
                        <button class="evolve-version-toggle" onclick="toggleScenePromptPreview('${v.version}')">查看提示词</button>
                    </div>`;
                }).join('');
        } else {
            historyEl.innerHTML = '';
        }
    } catch (e) {
        console.warn('加载分镜状态失败:', e.message);
    }
}

/**
 * 展开/折叠分镜提示词预览
 */
function toggleScenePromptPreview(version) {
    const el = document.getElementById(`scene-preview-${version}`);
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}
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
    newCharImages = [null, null, null, null, null, null, null, null, null];
    for (let i = 0; i < 9; i++) {
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
    newCharImages = [null, null, null, null, null, null, null, null, null];
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

// 页面加载时初始化视频模型状态
(function initVideoModel() {
    const videoModel = document.getElementById('video-model');
    if (videoModel) onVideoModelChange(videoModel.value);
})();

// 页面加载时初始化评审进化面板状态
loadReviewStatus();

// 页面加载时初始化分镜进化面板状态
loadSceneStatus();

// 页面加载时初始化分镜人物列表
loadSceneCharacters();

// ==================== 全自动工作流 ====================

let autoTaskId = null;
let autoPollTimer = null;
let autoLogIndex = 0;
let autoWorkflowMode = 'auto'; // 'auto' | 'step'
let autoWorkflowPaused = false;
let autoScenesData = []; // 分镜数据缓存
let autoSceneCharacters = {}; // 每个分镜的人物选择 {sceneIndex: [charId, ...]}
let autoCharactersList = []; // 人物列表缓存

/**
 * 加载人物列表（用于分镜选择）
 */
async function loadAutoCharactersForScenes() {
    try {
        const resp = await fetch('/api/characters');
        const data = await resp.json();
        if (data.success) {
            autoCharactersList = data.characters;
        }
    } catch (e) {
        console.error('加载人物失败:', e);
    }
}

/**
 * 切换分镜人物选择
 */
async function toggleAutoSceneChar(sceneIndex, charId) {
    if (!autoSceneCharacters[sceneIndex]) {
        autoSceneCharacters[sceneIndex] = [];
    }
    
    const idx = autoSceneCharacters[sceneIndex].indexOf(charId);
    if (idx !== -1) {
        autoSceneCharacters[sceneIndex].splice(idx, 1);
    } else {
        autoSceneCharacters[sceneIndex].push(charId);
    }
    
    // 更新UI
    renderSceneCharSelector(sceneIndex);
    
    // 同步到后端
    if (autoTaskId) {
        await fetch(`/api/auto-scene-characters/${autoTaskId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                scene_index: sceneIndex,
                char_ids: autoSceneCharacters[sceneIndex]
            })
        });
    }
}

/**
 * 渲染分镜人物选择器
 */
function renderSceneCharSelector(sceneIndex) {
    const container = document.getElementById(`auto-scene-char-${sceneIndex}`);
    if (!container || !autoCharactersList.length) return;
    
    const selectedIds = autoSceneCharacters[sceneIndex] || [];
    
    container.innerHTML = autoCharactersList.map(char => `
        <div class="char-card ${selectedIds.includes(char.id) ? 'char-card-selected' : ''}"
             onclick="toggleAutoSceneChar(${sceneIndex}, '${char.id}')">
            <div class="char-thumb">
                ${char.thumbnail ? `<img src="${char.thumbnail}" alt="${char.name}">` : '?'}
            </div>
            <div class="char-info">
                <div class="char-name">${char.name}</div>
                <div class="char-count">${char.image_count || 0} 图</div>
            </div>
        </div>
    `).join('');
}

/**
 * 切换全自动/单步模式
 */
async function toggleAutoMode() {
    const checkbox = document.getElementById('auto-mode-toggle');
    autoWorkflowMode = checkbox.checked ? 'step' : 'auto';
    document.getElementById('auto-mode-label').textContent = 
        autoWorkflowMode === 'auto' ? '全自动' : '单步';
    
    if (autoTaskId) {
        await fetch(`/api/auto-control/${autoTaskId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'toggle_mode' })
        });
    }
}

/**
 * 控制全自动工作流
 */
async function controlAutoWorkflow(action) {
    if (!autoTaskId) return;
    
    try {
        const resp = await fetch(`/api/auto-control/${autoTaskId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action })
        });
        const data = await resp.json();
        
        if (data.success) {
            if (action === 'pause') {
                autoWorkflowPaused = true;
                document.getElementById('btn-auto-pause').style.display = 'none';
                document.getElementById('btn-auto-resume').style.display = 'inline-block';
                showToast('任务已暂停', 'info');
            } else if (action === 'resume') {
                autoWorkflowPaused = false;
                document.getElementById('btn-auto-pause').style.display = 'inline-block';
                document.getElementById('btn-auto-resume').style.display = 'none';
                showToast('任务已继续', 'success');
            } else if (action === 'stop') {
                clearInterval(autoPollTimer);
                document.getElementById('btn-auto-start').disabled = false;
                document.getElementById('btn-auto-pause').style.display = 'none';
                document.getElementById('btn-auto-resume').style.display = 'none';
                document.getElementById('btn-auto-stop').style.display = 'none';
                showToast('任务已停止', 'warning');
            }
        }
    } catch (e) {
        showToast('控制失败: ' + e.message, 'error');
    }
}

/**
 * 开始全自动工作流
 */
async function startAutoWorkflow() {
    const description = document.getElementById('auto-description').value.trim();
    if (!description) {
        showToast('请输入场景描述', 'error');
        return;
    }
    
    const style = document.getElementById('auto-style').value;
    const numScenes = document.getElementById('auto-num-scenes').value;
    const imageModel = document.getElementById('auto-image-model').value;
    const videoModel = document.getElementById('auto-video-model').value;
    const scoreThreshold = parseInt(document.getElementById('auto-score-threshold').value) || 7;
    const maxCycles = parseInt(document.getElementById('auto-max-cycles').value) || 3;
    
    // 重置状态
    autoScenesData = [];
    autoSceneCharacters = {};
    autoLogIndex = 0;
    
    // 禁用开始按钮，显示控制栏
    document.getElementById('btn-auto-start').disabled = true;
    document.getElementById('btn-auto-pause').style.display = 'inline-block';
    document.getElementById('btn-auto-resume').style.display = 'none';
    document.getElementById('btn-auto-stop').style.display = 'inline-block';
    document.getElementById('auto-control-bar').style.display = 'flex';
    document.getElementById('auto-progress-card').style.display = 'block';
    document.getElementById('auto-log-card').style.display = 'block';
    document.getElementById('auto-result-section').style.display = 'none';
    
    // 清空日志
    document.getElementById('auto-log-output').innerHTML = '';
    
    addAutoLog('info', '正在启动全自动工作流...');
    
    try {
        const apiCfg = getApiConfig();
        const resp = await fetch('/api/auto-workflow', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                description, style, num_scenes: numScenes,
                image_model: imageModel, video_model: videoModel,
                score_threshold: scoreThreshold, max_cycles: maxCycles,
                mode: autoWorkflowMode,
                api_key: apiCfg.image.api_key || ''
            })
        });
        const data = await resp.json();
        
        if (!data.success) {
            showToast('启动失败: ' + data.error, 'error');
            addAutoLog('error', '启动失败: ' + data.error);
            resetAutoControls();
            return;
        }
        
        autoTaskId = data.task_id;
        addAutoLog('success', `任务已启动 (ID: ${autoTaskId})`);
        
        // 加载人物列表
        await loadAutoCharactersForScenes();
        
        // 开始轮询
        pollAutoStatus();
        
    } catch (e) {
        showToast('请求异常: ' + e.message, 'error');
        addAutoLog('error', '请求异常: ' + e.message);
        resetAutoControls();
    }
}

function resetAutoControls() {
    document.getElementById('btn-auto-start').disabled = false;
    document.getElementById('btn-auto-pause').style.display = 'none';
    document.getElementById('btn-auto-resume').style.display = 'none';
    document.getElementById('btn-auto-stop').style.display = 'none';
}

/**
 * 轮询全自动任务状态
 */
function pollAutoStatus() {
    if (autoPollTimer) clearInterval(autoPollTimer);
    
    autoPollTimer = setInterval(async () => {
        try {
            const resp = await fetch(`/api/auto-status/${autoTaskId}`);
            const data = await resp.json();
            
            if (!data.success) return;
            
            // 更新进度
            updateAutoProgress(data.stage, data.stage_progress, data.total_progress, data.current_action);
            
            // 追加新日志
            if (data.logs && data.logs.length > autoLogIndex) {
                const newLogs = data.logs.slice(autoLogIndex);
                appendAutoLogs(newLogs);
                autoLogIndex = data.logs.length;
            }
            
            // 保存分镜数据
            if (data.result && data.result.scenes && data.result.scenes.length > 0 && autoScenesData.length === 0) {
                autoScenesData = data.result.scenes;
                renderAutoScenesList();
            }
            
            // 检查完成
            if (data.status === 'completed') {
                clearInterval(autoPollTimer);
                renderFinalResults(data.result);
                resetAutoControls();
                showToast('全自动流程完成！', 'success');
            } else if (data.status === 'failed') {
                clearInterval(autoPollTimer);
                addAutoLog('error', '流程失败');
                resetAutoControls();
            }
        } catch (e) {
            console.error('轮询失败:', e);
        }
    }, 3000);
}

/**
 * 更新全自动进度
 */
function updateAutoProgress(stage, stageProgress, totalProgress, action) {
    // 更新阶段指示器
    document.querySelectorAll('.stage-badge').forEach(badge => {
        const badgeStage = badge.dataset.stage;
        badge.classList.remove('active', 'completed');
        
        if (badgeStage === stage) {
            badge.classList.add('active');
        } else {
            const stages = ['storyboard', 'review', 'image', 'video', 'final_review', 'done'];
            const currentIndex = stages.indexOf(stage);
            const badgeIndex = stages.indexOf(badgeStage);
            if (badgeIndex < currentIndex) {
                badge.classList.add('completed');
            }
        }
    });
    
    // 更新阶段进度条
    const stageBar = document.getElementById('auto-stage-progress-bar');
    if (stageBar) stageBar.style.width = stageProgress + '%';
    
    // 更新总进度条
    const totalBar = document.getElementById('auto-total-progress-bar');
    const totalText = document.getElementById('auto-total-progress-text');
    if (totalBar) totalBar.style.width = totalProgress + '%';
    if (totalText) totalText.textContent = Math.round(totalProgress) + '%';
    
    // 更新当前操作
    const actionEl = document.getElementById('auto-stage-action');
    if (actionEl && action) actionEl.textContent = action;
}

/**
 * 添加单条日志
 */
function addAutoLog(level, message) {
    const now = new Date();
    const time = now.toLocaleTimeString('zh-CN', { hour12: false });
    appendAutoLogs([{ time, message, level }]);
}

/**
 * 追加日志条目
 */
function appendAutoLogs(logs) {
    const output = document.getElementById('auto-log-output');
    if (!output) return;
    
    logs.forEach(log => {
        const entry = document.createElement('div');
        entry.className = `auto-log-entry ${log.level}`;
        entry.innerHTML = `<span class="log-time">${log.time}</span><span class="log-message">${log.message}</span>`;
        output.appendChild(entry);
    });
    
    // 自动滚动到底部
    output.scrollTop = output.scrollHeight;
}

/**
 * 渲染分镜列表
 */
function renderAutoScenesList() {
    const container = document.getElementById('auto-scenes-list');
    if (!container || !autoScenesData.length) return;
    
    container.innerHTML = autoScenesData.map((scene, index) => `
        <div class="auto-scene-card" id="auto-scene-card-${index}" data-status="pending">
            <div class="scene-card-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <div>
                    <span class="scene-num-badge">分镜 ${scene.scene_number || index + 1}</span>
                    <span class="scene-shot-badge">${scene.shot_type || ''}</span>
                </div>
                <span class="scene-status-badge" id="auto-scene-status-${index}" data-status="pending">待处理</span>
            </div>
            
            <p class="scene-desc" style="margin-bottom:12px;">${scene.scene_desc || ''}</p>
            
            <!-- 人物选择器 -->
            <div class="auto-scene-char-select" id="auto-scene-char-${index}"></div>
            
            <!-- 提示词编辑区 -->
            <div class="prompt-block" style="margin:12px 0;">
                <label style="font-size:13px;font-weight:600;">文生图提示词（可编辑）</label>
                <textarea class="prompt-textarea" id="auto-scene-img-prompt-${index}" rows="4">${scene.image_prompt || ''}</textarea>
            </div>
            
            <div class="prompt-block" style="margin:12px 0;">
                <label style="font-size:13px;font-weight:600;">视频提示词（可编辑）</label>
                <textarea class="prompt-textarea" id="auto-scene-vid-prompt-${index}" rows="3">${scene.video_prompt || ''}</textarea>
            </div>
            
            <!-- 结果展示 -->
            <div class="auto-scene-result" id="auto-scene-result-${index}"></div>
            
            <!-- 评审结果 -->
            <div class="auto-scene-review" id="auto-scene-review-${index}" style="display:none;"></div>
        </div>
    `).join('');
    
    // 渲染人物选择器
    autoScenesData.forEach((_, index) => {
        renderSceneCharSelector(index);
    });
    
    document.getElementById('auto-scenes-card').style.display = 'block';
}

/**
 * 更新单个分镜状态
 */
function updateSceneStatus(sceneIndex, status, imageData = null, videoData = null, reviewData = null) {
    const card = document.getElementById(`auto-scene-card-${sceneIndex}`);
    const statusBadge = document.getElementById(`auto-scene-status-${sceneIndex}`);
    const resultDiv = document.getElementById(`auto-scene-result-${sceneIndex}`);
    const reviewDiv = document.getElementById(`auto-scene-review-${sceneIndex}`);
    
    if (!card || !statusBadge) return;
    
    // 更新状态徽章
    statusBadge.dataset.status = status;
    statusBadge.textContent = status === 'pending' ? '待处理' : 
                              status === 'processing' ? '处理中' :
                              status === 'completed' ? '已完成' : '失败';
    
    // 更新卡片样式
    card.classList.remove('active', 'completed', 'failed');
    if (status === 'processing') card.classList.add('active');
    else if (status === 'completed') card.classList.add('completed');
    else if (status === 'failed') card.classList.add('failed');
    
    // 更新结果展示
    if (resultDiv && (imageData || videoData)) {
        let html = '';
        if (imageData && imageData.success) {
            html += `<div><img src="${imageData.url}" alt="分镜${sceneIndex+1}图片"></div>`;
        }
        if (videoData && videoData.success) {
            html += `<div><video src="${videoData.url}" controls style="max-width:300px;"></video></div>`;
        }
        resultDiv.innerHTML = html;
    }
    
    // 更新评审结果
    if (reviewDiv && reviewData) {
        reviewDiv.style.display = 'block';
        reviewDiv.innerHTML = `
            <div class="review-score">评分：<b>${reviewData.overall_score || 0}/10</b></div>
            <div class="review-comment">${reviewData.comment || reviewData.overall_comment || ''}</div>
            <div class="review-feedback-area">
                <textarea id="auto-scene-feedback-${sceneIndex}" placeholder="输入你的意见，AI会修正提示词..."></textarea>
                <button class="btn btn-sm btn-primary" onclick="submitSceneFeedback(${sceneIndex})">
                    📝 提交反馈并修正
                </button>
            </div>
        `;
    }
}

/**
 * 提交分镜评审反馈
 */
async function submitSceneFeedback(sceneIndex) {
    const feedback = document.getElementById(`auto-scene-feedback-${sceneIndex}`).value.trim();
    if (!feedback) {
        showToast('请输入反馈意见', 'error');
        return;
    }
    
    try {
        const resp = await fetch(`/api/auto-submit-feedback/${autoTaskId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scene_index: sceneIndex, feedback })
        });
        const data = await resp.json();
        
        if (data.success) {
            showToast('反馈已提交，AI正在修正...', 'success');
            // 更新提示词显示
            if (data.correction.image_prompt) {
                document.getElementById(`auto-scene-img-prompt-${sceneIndex}`).value = data.correction.image_prompt;
            }
            if (data.correction.video_prompt) {
                document.getElementById(`auto-scene-vid-prompt-${sceneIndex}`).value = data.correction.video_prompt;
            }
        } else {
            showToast('提交失败: ' + data.error, 'error');
        }
    } catch (e) {
        showToast('请求异常: ' + e.message, 'error');
    }
}

/**
 * 渲染最终结果
 */
function renderFinalResults(result) {
    if (!result) return;
    
    document.getElementById('auto-result-section').style.display = 'block';
    
    // 渲染评审汇总
    if (result.final_review) {
        document.getElementById('auto-reviews-card').style.display = 'block';
        const summaryEl = document.getElementById('auto-reviews-summary');
        const avgScore = result.final_review.overall_score || 0;
        
        summaryEl.innerHTML = `
            <div style="text-align:center;padding:20px;">
                <div style="font-size:48px;font-weight:bold;color:var(--primary-color);">${avgScore.toFixed(1)}</div>
                <div style="font-size:14px;color:#666;margin-top:8px;">完整视频平均得分 / 10</div>
                <div style="margin-top:12px;font-size:13px;color:#666;">${result.final_review.comment || ''}</div>
            </div>
            ${result.scene_reviews ? result.scene_reviews.map((review, i) => `
                <div style="padding:12px;border-top:1px solid var(--border-color);">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <strong>分镜${i+1}</strong>
                        <span style="font-size:18px;font-weight:bold;color:${(review.overall_score || 0) >= 7 ? '#10b981' : '#f59e0b'};">
                            ${review.overall_score || 0}/10
                        </span>
                    </div>
                    <p style="font-size:13px;color:#666;margin-top:8px;">${review.comment || ''}</p>
                </div>
            `).join('') : ''}
        `;
    }
}

