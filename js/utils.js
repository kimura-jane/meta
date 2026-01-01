// ============================================
// ユーティリティ・UI・アバター
// ============================================

const THREE = window.THREE;

// --------------------------------------------
// デバッグログ
// --------------------------------------------
const debugLogs = [];

export function debugLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const entry = { time, msg, type };
    debugLogs.push(entry);
    if (debugLogs.length > 100) debugLogs.shift();
    
    console.log(`[${time}] ${msg}`);
    updateDebugUI();
}

function updateDebugUI() {
    const container = document.getElementById('debug-console');
    if (!container) return;
    
    container.innerHTML = debugLogs.slice(-20).map(log => {
        const color = log.type === 'error' ? '#ff6b6b' : 
                      log.type === 'success' ? '#51cf66' : 
                      log.type === 'warn' ? '#ffd43b' : '#aaa';
        return `<div style="color:${color};font-size:11px;margin:2px 0;">[${log.time}] ${log.msg}</div>`;
    }).join('');
    container.scrollTop = container.scrollHeight;
}

export function createDebugUI() {
    const div = document.createElement('div');
    div.id = 'debug-console';
    div.style.cssText = `
        position: fixed;
        bottom: 60px;
        left: 10px;
        width: 320px;
        max-height: 180px;
        background: rgba(0,0,0,0.85);
        border: 1px solid #444;
        border-radius: 8px;
        padding: 8px;
        overflow-y: auto;
        z-index: 10000;
        font-family: monospace;
        display: none;
    `;
    document.body.appendChild(div);
    
    const btn = document.createElement('button');
    btn.textContent = '🔧 Debug';
    btn.style.cssText = `
        position: fixed;
        bottom: 10px;
        left: 10px;
        padding: 8px 16px;
        background: #333;
        color: #fff;
        border: none;
        border-radius: 4px;
        z-index: 10001;
        font-size: 12px;
    `;
    btn.onclick = () => {
        div.style.display = div.style.display === 'none' ? 'block' : 'none';
    };
    document.body.appendChild(btn);
    
    debugLog('デバッグコンソール初期化', 'success');
}

// --------------------------------------------
// エラーハンドラー設定
// --------------------------------------------
export function setupErrorHandlers() {
    window.onerror = function(msg, url, line, col, error) {
        const div = document.createElement('div');
        div.style.cssText = 'position:fixed;top:0;left:0;right:0;background:red;color:white;padding:10px;z-index:99999;font-size:12px;';
        div.textContent = `ERROR: ${msg} (line ${line})`;
        document.body.appendChild(div);
        return false;
    };

    window.onunhandledrejection = (e) => {
        debugLog(`Promise ERROR: ${e.reason}`, 'error');
    };
}

// --------------------------------------------
// iOS検出
// --------------------------------------------
export function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || 
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// --------------------------------------------
// チャット
// --------------------------------------------
export function addChatMessage(name, message) {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'chat-message';
    div.innerHTML = `<span class="name">${name}</span>${message}`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    while (container.children.length > 20) container.removeChild(container.firstChild);
}

// --------------------------------------------
// アバター作成（スポットライト対応版）
// --------------------------------------------
export function createAvatar(userId, userName, color) {
    const group = new THREE.Group();
    group.userData = { odUserId: userId, userName, onStage: false, baseColor: color };

    // 通常時のマテリアル
    const bodyMaterial = new THREE.MeshStandardMaterial({ 
        color,
        emissive: 0x000000,
        emissiveIntensity: 0
    });
    const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.35, 1, 8),
        bodyMaterial
    );
    body.position.y = 0.5;
    body.castShadow = true;
    body.name = 'avatarBody';
    group.add(body);

    const headMaterial = new THREE.MeshStandardMaterial({ 
        color,
        emissive: 0x000000,
        emissiveIntensity: 0
    });
    const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.25, 8, 8),
        headMaterial
    );
    head.position.y = 1.2;
    head.castShadow = true;
    head.name = 'avatarHead';
    group.add(head);

    return group;
}

// --------------------------------------------
// アバターをスポットライトで照らす
// --------------------------------------------
export function setAvatarSpotlight(avatar, isLit) {
    const body = avatar.getObjectByName('avatarBody');
    const head = avatar.getObjectByName('avatarHead');
    
    if (body && body.material) {
        if (isLit) {
            // 明るく光らせる
            body.material.emissive.setHex(avatar.userData.baseColor || 0x4fc3f7);
            body.material.emissiveIntensity = 0.4;
        } else {
            // 通常に戻す
            body.material.emissive.setHex(0x000000);
            body.material.emissiveIntensity = 0;
        }
    }
    
    if (head && head.material) {
        if (isLit) {
            head.material.emissive.setHex(avatar.userData.baseColor || 0x4fc3f7);
            head.material.emissiveIntensity = 0.4;
        } else {
            head.material.emissive.setHex(0x000000);
            head.material.emissiveIntensity = 0;
        }
    }
}

// --------------------------------------------
// ペンライト作成
// --------------------------------------------
export function createPenlight(color) {
    const group = new THREE.Group();

    const handle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.03, 0.2, 8),
        new THREE.MeshStandardMaterial({ color: 0x333333 })
    );
    group.add(handle);

    const light = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.03, 0.3, 8),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 })
    );
    light.position.y = 0.25;
    light.name = 'penlightLight';
    group.add(light);

    const pointLight = new THREE.PointLight(color, 0.5, 3);
    pointLight.position.y = 0.3;
    pointLight.name = 'penlightPointLight';
    group.add(pointLight);

    group.position.set(0.4, 1.3, 0.2);
    group.rotation.z = Math.PI / 6;

    return group;
}

// --------------------------------------------
// スピーカーインジケーター
// --------------------------------------------
export function addSpeakerIndicator(avatar) {
    if (avatar.getObjectByName('speakerIndicator')) return;
    const indicator = new THREE.Mesh(
        new THREE.RingGeometry(0.4, 0.45, 32),
        new THREE.MeshBasicMaterial({ color: 0x00ff00, side: THREE.DoubleSide })
    );
    indicator.name = 'speakerIndicator';
    indicator.rotation.x = -Math.PI / 2;
    indicator.position.y = 0.01;
    avatar.add(indicator);
}

export function removeSpeakerIndicator(avatar) {
    const indicator = avatar.getObjectByName('speakerIndicator');
    if (indicator) avatar.remove(indicator);
}
