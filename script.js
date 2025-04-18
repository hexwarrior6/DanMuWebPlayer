// 全局变量
let dp;
let videoUrl = '';
let danmuList = []; // 存储弹幕
let loadingWorker = null;
let isCancelled = false;

updateStatus('请选择视频文件和弹幕文件');

// 修改 initPlayer：选择视频后初始化 DPlayer，并隐藏占位层
function initPlayer() {
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

    dp = new DPlayer({
        container: document.getElementById('dplayer'),
        autoplay: false,
        theme: '#FADFA3',
        video: {
            url: videoUrl,
            type: 'auto'
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
    });
    dp.seek(0);
    updateStatus(`播放器已初始化，等待加载弹幕...`);
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
        videoUrl = URL.createObjectURL(file);
        document.querySelector('.player-card h1').textContent = file.name;
        updateStatus(`已加载视频文件: ${file.name}`);
        initPlayer();
        // 修改按钮文字
        if (videoLabel) videoLabel.textContent = `视频：${file.name}`;
    } else {
        if (videoLabel) videoLabel.textContent = '选择视频';
    }
});

// 新增：根据时间戳实时加载弹幕
function setupDanmuRealtimeLoader() {
    if (!dp) return;
    // 重置所有弹幕的 sent 标记
    danmuList.forEach(d => d.sent = false);

    dp.on('timeupdate', function () {
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
    dp.on('seeked', function () {
        const currentTime = dp.video.currentTime;
        danmuList.forEach(danmu => {
            danmu.sent = danmu.time < currentTime - 0.3;
        });
    });
}

// 删除原有的 danmuFile 相关监听
// document.getElementById('danmuFile').addEventListener(...);  // ← 删除这一段

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
                if (dp) {
                    danmuList = parsedDanmus;
                    setupDanmuRealtimeLoader();
                    updateStatus("弹幕已准备，将随视频播放实时加载");
                } else {
                    updateStatus('请先加载视频文件');
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
                if (dp) {
                    danmuList = parsedDanmus;
                    setupDanmuRealtimeLoader();
                    updateStatus("弹幕已准备，将随视频播放实时加载");
                } else {
                    updateStatus('请先加载视频文件');
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

// 初始化
updateStatus('请选择视频文件和弹幕文件');

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
        if (dp) {
            danmuList = parsedDanmus;
            setupDanmuRealtimeLoader();
            updateStatus("弹幕已准备，将随视频播放实时加载");
        } else {
            updateStatus('请先加载视频文件');
        }
    } catch (e) {
        updateStatus('获取人人视频弹幕失败: ' + e.message);
        console.error(e);
    }
});