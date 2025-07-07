// 全局变量
let dp;
let videoUrl = '';
let danmuList = []; // 存储弹幕
let loadingWorker = null;
let isCancelled = false;
let isLiveStream = false; // 标记是否为直播流

updateStatus('请选择视频文件和弹幕文件');

// 修改 initPlayer：选择视频或直播源后初始化 DPlayer，并隐藏占位层
function initPlayer() {
    // 新增：如果已存在 DPlayer 实例，先销毁它
    if (dp) {
        dp.destroy();
        dp = null; // 将 dp 设为 null，确保旧实例被垃圾回收
    }

    // 隐藏占位层
    const placeholder = document.getElementById('video-placeholder');
    if (placeholder) placeholder.style.display = 'none';

    // 获取当前设置的弹幕速度
    const speedRate = parseFloat(document.getElementById('speedSlider').value);

    // 添加全局样式控制弹幕速度
    let speedStyle = document.getElementById('danmu-speed-style');
    if (!speedStyle) {
        speedStyle = document.createElement('style');
        speedStyle.id = 'danmu-speed-style';
        document.head.appendChild(speedStyle);
    }

    // 计算动画时间
    const baseDuration = 8.5;
    const newDuration = baseDuration / speedRate;

    // 更新全局样式
    speedStyle.textContent = `.dplayer-danmaku-item { animation-duration: ${newDuration}s !important; }`;

    // 确保 dplayer 容器存在且干净 (destroy 应该会处理，但可以加一层保险)
    const container = document.getElementById('dplayer');
    // container.innerHTML = ''; // 通常 destroy 后不需要手动清空

    // 配置播放器选项
    const playerOptions = {
        container: container, // 使用获取到的容器
        autoplay: isLiveStream, // 直播流自动播放
        theme: '#FADFA3',
        video: {
            url: videoUrl,
            type: isLiveStream ? 'hls' : 'auto', // 直播流使用HLS类型
            live: isLiveStream // 设置是否为直播
        },
        danmaku: {
            id: 'local-danmu',
            api: '',
            maximum: 1000,
            addition: [],
            user: '观众',
            speedRate: speedRate,
        },
        contextmenu: []
    };

    // 如果是直播流，添加HLS配置
    if (isLiveStream) {
        playerOptions.video.customType = {
            hls: function(video, player) {
                const hls = new Hls();
                hls.loadSource(video.src);
                hls.attachMedia(video);
                hls.on(Hls.Events.MANIFEST_PARSED, function() {
                    player.play();
                });
            }
        };
    }

    dp = new DPlayer(playerOptions);
    
    if (!isLiveStream) {
        dp.seek(0);
    }
    
    updateStatus(`播放器已初始化，${isLiveStream ? '正在加载直播流...' : '等待加载弹幕...'}`);

    // 新增：如果弹幕列表已有数据（弹幕先于视频加载），则设置实时加载器
    if (danmuList.length > 0 && !isLiveStream) {
        setupDanmuRealtimeLoader();
        updateStatus("播放器和弹幕均已准备就绪"); // 更新状态
    }
}

// 更新状态显示
function updateStatus(message) {
    document.getElementById('status').textContent = message;
}

// 批量加载弹幕
function batchLoadDanmus(danmus, batchSize = 100) {
    const progressContainer = document.getElementById('progressContainer');
    const progressBar = document.getElementById('loadProgress');
    const progressText = document.getElementById('progressText');

    progressContainer.style.display = 'block';
    progressBar.value = 0;
    progressText.textContent = '加载中: 0%';

    let loaded = 0;
    const total = danmus.length;
    isCancelled = false;

    document.getElementById('cancelLoad').disabled = false;

    function loadNextBatch() {
        if (isCancelled) {
            updateStatus(`已取消加载，已加载 ${loaded}/${total} 条弹幕`);
            progressContainer.style.display = 'none';
            document.getElementById('cancelLoad').disabled = true;
            return;
        }

        const batchEnd = Math.min(loaded + batchSize, total);

        // 修改：逐条添加弹幕
        for (let i = loaded; i < batchEnd; i++) {
            const danmu = danmus[i];
            dp.danmaku && dp.danmaku.draw({
                text: danmu.text,
                color: danmu.color || '#ffffff',
                type: danmu.type || 'right',
                time: danmu.time
            });
        }

        loaded = batchEnd;
        const percent = Math.round((loaded / total) * 100);
        progressBar.value = percent;
        progressText.textContent = `加载中: ${percent}% (${loaded}/${total})`;

        if (loaded < total) {
            setTimeout(loadNextBatch, 0);
        } else {
            updateStatus(`成功加载 ${total} 条弹幕`);
            progressContainer.style.display = 'none';
            document.getElementById('cancelLoad').disabled = true;
        }
    }

    loadNextBatch();
}

// 使用正则表达式解析XML (兼容Web Worker环境)
function parseDanmuWithRegex(xmlText) {
    const danmuRegex = /<d p="([^"]+)">([^<]+)<\/d>/g;
    const result = [];
    let match;

    while ((match = danmuRegex.exec(xmlText)) !== null) {
        const attrs = match[1].split(',');
        const text = match[2];

        if (attrs.length >= 8) {
            const time = parseFloat(attrs[0]);
            const type = parseInt(attrs[1]);
            const color = parseInt(attrs[3]);

            if (type === 1) { // 只处理滚动弹幕
                result.push({
                    text: text,
                    color: '#' + color.toString(16).padStart(6, '0'),
                    type: 'right',
                    time: time
                });
            }
        }
    }

    return result;
}

// 使用Web Worker解析XML (使用正则表达式替代DOMParser)
function parseDanmuWithWorker(xmlText) {
    return new Promise((resolve, reject) => {
        if (window.Worker) {
            const worker = new Worker(URL.createObjectURL(
                new Blob([`
                    function parseDanmuXML(xmlText) {
                        try {
                            const danmuRegex = /<d p="([^"]+)">([^<]+)<\\/d>/g;
                            const result = [];
                            let match;
                            
                            while ((match = danmuRegex.exec(xmlText)) !== null) {
                                const attrs = match[1].split(',');
                                const text = match[2];
                                
                                if (attrs.length >= 8) {
                                    const time = parseFloat(attrs[0]);
                                    const type = parseInt(attrs[1]);
                                    const color = parseInt(attrs[3]);
                                    
                                    if (type === 1) {
                                        result.push({
                                            text: text,
                                            color: '#' + color.toString(16).padStart(6, '0'),
                                            type: 'right',
                                            time: time
                                        });
                                    }
                                }
                            }
                            return result;
                        } catch (error) {
                            throw error;
                        }
                    }
                    
                    self.onmessage = function(e) {
                        try {
                            const result = parseDanmuXML(e.data);
                            self.postMessage({ success: true, data: result });
                        } catch (error) {
                            self.postMessage({ success: false, error: error.message });
                        }
                    };
                `], { type: 'application/javascript' })
            ));

            worker.onmessage = function (e) {
                if (e.data.success) {
                    resolve(e.data.data);
                } else {
                    reject(new Error(e.data.error));
                }
                worker.terminate();
            };

            worker.onerror = function (error) {
                reject(error);
                worker.terminate();
            };

            worker.postMessage(xmlText);
        } else {
            // 浏览器不支持Web Worker，回退到主线程解析
            try {
                const result = parseDanmuWithRegex(xmlText);
                resolve(result);
            } catch (error) {
                reject(error);
            }
        }
    });
}

// 主线程解析XML (使用DOMParser)
function parseDanmuXML(xmlText) {
    try {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, "text/xml");
        const danmus = xmlDoc.getElementsByTagName('d');
        const result = [];

        for (let i = 0; i < danmus.length; i++) {
            const danmu = danmus[i];
            const attrs = danmu.getAttribute('p').split(',');

            if (attrs.length >= 8) {
                const time = parseFloat(attrs[0]);
                const type = parseInt(attrs[1]);
                const color = parseInt(attrs[3]);

                if (type === 1) {
                    result.push({
                        text: danmu.textContent,
                        color: '#' + color.toString(16).padStart(6, '0'),
                        type: 'right',
                        time: time
                    });
                }
            }
        }

        return result;
    } catch (error) {
        updateStatus(`弹幕解析失败: ${error.message}`);
        console.error('XML解析错误:', error);
        return [];
    }
}

// 事件监听
document.getElementById('sendDanmu').addEventListener('click', function () {
    const text = document.getElementById('danmuInput').value;
    if (text.trim() !== '' && dp) {
        // 获取当前速度设置
        const currentSpeed = dp.danmaku.speedRate;

        dp.danmaku.draw({
            text: text,
            color: '#ffffff',
            type: 'right'
        });

        // 确保新发送的弹幕使用当前速度
        setTimeout(() => {
            const danmuItems = document.querySelectorAll('.dplayer-danmaku-item');
            if (danmuItems.length > 0) {
                const lastItem = danmuItems[danmuItems.length - 1];
                const baseDuration = 8.5;
                lastItem.style.animationDuration = `${baseDuration / currentSpeed}s`;
            }
        }, 10);

        document.getElementById('danmuInput').value = '';
        updateStatus(`已发送弹幕: ${text}`);
    }
});

// 新增：弹幕速度调节滑块事件监听
document.getElementById('speedSlider').addEventListener('input', function () {
    const speedValue = parseFloat(this.value);
    document.getElementById('speedValue').textContent = speedValue.toFixed(1);
    if (dp && dp.danmaku) {
        // 保存当前速度设置
        dp.danmaku.speedRate = speedValue;

        // 清除所有现有弹幕
        dp.danmaku.clear();

        // 重置所有弹幕的sent标记，以便重新加载
        if (danmuList && danmuList.length > 0) {
            danmuList.forEach(danmu => {
                danmu.sent = false;
            });
        }

        // 添加一个全局样式来控制所有弹幕的速度
        let speedStyle = document.getElementById('danmu-speed-style');
        if (!speedStyle) {
            speedStyle = document.createElement('style');
            speedStyle.id = 'danmu-speed-style';
            document.head.appendChild(speedStyle);
        }

        // 计算新的动画时间（基于默认速度1.0）
        const baseDuration = 8.5; // DPlayer默认动画时间
        const newDuration = baseDuration / speedValue;

        // 更新全局样式
        speedStyle.textContent = `.dplayer-danmaku-item { animation-duration: ${newDuration}s !important; }`;

        updateStatus(`弹幕速度已调整为: ${speedValue.toFixed(1)}`);
    }
});

document.getElementById('danmuInput').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
        document.getElementById('sendDanmu').click();
    }
});

document.getElementById('videoFile').addEventListener('change', function (e) {
    const file = e.target.files[0];
    const videoLabel = document.querySelector('label[for="videoFile"]');
    if (file) {
        isLiveStream = false; // 设置为本地视频模式
        videoUrl = URL.createObjectURL(file);
        document.querySelector('.player-card h1').textContent = file.name;
        updateStatus(`已加载视频文件: ${file.name}`);
        initPlayer();
        // 修改按钮文字
        if (videoLabel) videoLabel.textContent = `视频：${file.name}`;
        // 清空直播源输入框
        document.getElementById('liveStreamInput').value = '';
    } else {
        if (videoLabel) videoLabel.textContent = '选择视频';
    }
});

// 新增：根据时间戳实时加载弹幕
function setupDanmuRealtimeLoader() {
    if (!dp || !dp.danmaku) return; // 增加对 dp.danmaku 的检查

    // 新增：清除当前显示的弹幕，为加载新列表做准备
    dp.danmaku.clear();

    // 重置所有弹幕的 sent 标记
    danmuList.forEach(d => d.sent = false);

    // 移除可能存在的旧监听器，避免重复添加 (可选但推荐)
    // 注意：DPlayer 的 on/off 可能需要具体函数引用，匿名函数较难移除
    // 如果遇到性能问题或重复触发，需要重构此部分以保存和移除监听器引用
    // dp.off('timeupdate', timeUpdateHandler); // 假设 timeUpdateHandler 是保存的函数
    // dp.off('seeked', seekedHandler);       // 假设 seekedHandler 是保存的函数

    dp.on('timeupdate', function () { // timeUpdateHandler
        const currentTime = dp.video.currentTime;
        const currentSpeed = dp.danmaku.speedRate; // 获取当前速度设置

        // 只绘制当前时间±0.3秒内且未发送过的弹幕
        danmuList.forEach(danmu => {
            if (!danmu.sent && Math.abs(danmu.time - currentTime) < 0.3) {
                dp.danmaku.draw({
                    text: danmu.text,
                    color: danmu.color || '#ffffff',
                    type: danmu.type || 'right',
                    time: danmu.time
                });

                // 找到刚添加的弹幕并应用当前速度
                setTimeout(() => {
                    const danmuItems = document.querySelectorAll('.dplayer-danmaku-item');
                    if (danmuItems.length > 0) {
                        const lastItem = danmuItems[danmuItems.length - 1];
                        const baseDuration = 8.5;
                        lastItem.style.animationDuration = `${baseDuration / currentSpeed}s`;
                    }
                }, 0);

                danmu.sent = true;
            }
        });
    });

    // 当 seek 时，重置 sent 标记
    dp.on('seeked', function () { // seekedHandler
        const currentTime = dp.video.currentTime;
        danmuList.forEach(danmu => {
            danmu.sent = danmu.time < currentTime - 0.3;
        });
    });
}

// 新增：标准XML弹幕监听
document.getElementById('danmuFileXml').addEventListener('change', function (e) {
    const file = e.target.files[0];
    const danmuLabel = document.querySelector('label[for="danmuFileXml"]');
    if (file) {
        if (danmuLabel) danmuLabel.textContent = `标准XML弹幕：${file.name}`;
        updateStatus(`正在解析弹幕文件: ${file.name}...`);
        const reader = new FileReader();
        reader.onload = async function (e) {
            try {
                updateStatus("正在解析弹幕(后台处理)...");
                const startTime = performance.now();
                const parsedDanmus = await parseDanmuWithWorker(e.target.result);
                const endTime = performance.now();
                updateStatus(`解析完成，耗时 ${(endTime - startTime).toFixed(2)}ms，共 ${parsedDanmus.length} 条弹幕`);
                danmuList = parsedDanmus; // 先更新弹幕列表

                // 修改：检查 dp 是否已初始化
                if (dp) {
                    setupDanmuRealtimeLoader(); // 如果播放器已在，则设置加载器
                } else {
                    updateStatus('弹幕已获取，请加载视频文件'); // 如果播放器不在，提示用户
                }
            } catch (error) {
                updateStatus("弹幕解析失败: " + error.message);
                console.error(error);
            }
        };
        reader.onerror = function () {
            updateStatus('弹幕文件读取失败');
        };
        reader.readAsText(file);
    }
});

// 新增：人人视频弹幕监听
document.getElementById('danmuFileJson').addEventListener('change', function (e) {
    const file = e.target.files[0];
    const danmuLabel = document.querySelector('label[for="danmuFileJson"]');
    if (file) {
        if (danmuLabel) danmuLabel.textContent = `人人视频JSON弹幕：${file.name}`;
        updateStatus(`正在解析人人视频JSON弹幕文件: ${file.name}...`);
        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                updateStatus("正在解析人人视频JSON弹幕...");
                const startTime = performance.now();
                const parsedDanmus = parseDanmuJSON(e.target.result);
                const endTime = performance.now();
                updateStatus(`人人视频JSON弹幕解析完成，耗时 ${(endTime - startTime).toFixed(2)}ms，共 ${parsedDanmus.length} 条弹幕`);
                danmuList = parsedDanmus; // 先更新弹幕列表

                // 修改：检查 dp 是否已初始化
                if (dp) {
                    setupDanmuRealtimeLoader(); // 如果播放器已在，则设置加载器
                } else {
                    updateStatus('弹幕已解析，请加载视频文件'); // 如果播放器不在，提示用户
                }
            } catch (error) {
                updateStatus("人人视频JSON弹幕解析失败: " + error.message);
                console.error(error);
            }
        };
        reader.onerror = function () {
            updateStatus('弹幕文件读取失败');
        };
        reader.readAsText(file);
    }
});

// 直播源加载按钮事件监听
document.getElementById('loadLiveStreamBtn').addEventListener('click', function() {
    const liveStreamUrl = document.getElementById('liveStreamInput').value.trim();
    if (!liveStreamUrl) {
        updateStatus('请输入有效的m3u8直播源地址');
        return;
    }
    
    // 验证URL是否为m3u8格式
    if (!liveStreamUrl.endsWith('.m3u8') && !liveStreamUrl.includes('.m3u8?')) {
        updateStatus('请输入有效的m3u8格式直播源地址');
        return;
    }
    
    isLiveStream = true; // 设置为直播模式
    videoUrl = liveStreamUrl;
    document.querySelector('.player-card h1').textContent = '直播流';
    updateStatus(`正在加载直播源...`);
    
    // 清空本地视频选择
    document.getElementById('videoFile').value = '';
    const videoLabel = document.querySelector('label[for="videoFile"]');
    if (videoLabel) videoLabel.textContent = '选择本地视频文件';
    
    // 检查HLS.js支持
    if (Hls.isSupported()) {
        initPlayer();
    } else {
        updateStatus('您的浏览器不支持HLS直播流');
    }
});

// 初始化
updateStatus('请选择视频文件和弹幕文件或输入直播源');

// 新增：解析 JSON 弹幕
function parseDanmuJSON(jsonText) {
    let result = [];
    try {
        const arr = JSON.parse(jsonText);
        for (const item of arr) {
            if (item.p && item.d) {
                const attrs = item.p.split(',');
                if (attrs.length >= 8) {
                    const time = parseFloat(attrs[0]);
                    const type = parseInt(attrs[1]);
                    const color = parseInt(attrs[3]);
                    if (type === 1) {
                        result.push({
                            text: item.d,
                            color: '#' + color.toString(16).padStart(6, '0'),
                            type: 'right',
                            time: time
                        });
                    }
                }
            }
        }
    } catch (e) {
        updateStatus('人人视频弹幕解析失败: ' + e.message);
        console.error(e);
    }
    return result;
}
// 新增：人人视频弹幕ID获取功能
document.getElementById('rrmjDanmuFetchBtn').addEventListener('click', async function () {
    const id = document.getElementById('rrmjDanmuIdInput').value.trim();
    if (!id) {
        updateStatus('请输入人人视频弹幕ID');
        return;
    }
    updateStatus('正在从人人视频接口获取弹幕...');
    try {
        const url = `https://static-dm.rrmj.plus/v1/produce/danmu/EPISODE/${id}`;
        const resp = await fetch(url);
        if (!resp.ok) {
            updateStatus('弹幕接口请求失败');
            return;
        }
        const json = await resp.json();
        // 人人视频接口返回格式通常为 { code: 0, data: [...] }
        let danmuArr = [];
        if (Array.isArray(json)) {
            danmuArr = json;
        } else if (json && Array.isArray(json.data)) {
            danmuArr = json.data;
        }
        if (danmuArr.length === 0) {
            updateStatus('未获取到弹幕数据');
            return;
        }
        const parsedDanmus = parseDanmuJSON(JSON.stringify(danmuArr));
        danmuList = parsedDanmus; // 先更新弹幕列表

        // 修改：检查 dp 是否已初始化
        if (dp) {
            setupDanmuRealtimeLoader(); // 如果播放器已在，则设置加载器
        } else {
            updateStatus('弹幕已获取，请加载视频文件'); // 如果播放器不在，提示用户
        }
    } catch (e) {
        updateStatus('获取人人视频弹幕失败: ' + e.message);
        console.error(e);
    }
});