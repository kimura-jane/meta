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
// アバター作成（画像対応版）
// --------------------------------------------
export function createAvatar(userId, userName, color) {
    const group = new THREE.Group();
    group.userData = { odUserId: userId, userName, onStage: false, baseColor: color, hasImage: false };

    // 体（カプセル型）
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

    // 頭（球体）
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

    // 画像用プレーン（初期は非表示）
    const imagePlane = new THREE.Mesh(
        new THREE.PlaneGeometry(1.2, 2),
        new THREE.MeshBasicMaterial({ 
            transparent: true, 
            opacity: 1,
            side: THREE.DoubleSide
        })
    );
    imagePlane.position.y = 1;
    imagePlane.name = 'avatarImage';
    imagePlane.visible = false;
    group.add(imagePlane);

    return group;
}

// --------------------------------------------
// アバター画像を設定
// --------------------------------------------
export function setAvatarImage(avatar, imageUrl) {
    const imagePlane = avatar.getObjectByName('avatarImage');
    const body = avatar.getObjectByName('avatarBody');
    const head = avatar.getObjectByName('avatarHead');
    
    if (!imagePlane) return;
    
    const loader = new THREE.TextureLoader();
    loader.load(
        imageUrl,
        (texture) => {
            texture.colorSpace = THREE.SRGBColorSpace;
            
            // アスペクト比を計算
            const aspect = texture.image.width / texture.image.height;
            const height = 2;
            const width = height * aspect;
            
            // ジオメトリを更新
            imagePlane.geometry.dispose();
            imagePlane.geometry = new THREE.PlaneGeometry(width, height);
            
            // マテリアルを更新
            imagePlane.material.map = texture;
            imagePlane.material.needsUpdate = true;
            
            // 画像を表示、3Dボディを非表示
            imagePlane.visible = true;
            if (body) body.visible = false;
            if (head) head.visible = false;
            
            avatar.userData.hasImage = true;
            debugLog(`アバター画像設定完了: ${imageUrl}`, 'success');
        },
        undefined,
        (error) => {
            debugLog(`アバター画像読み込み失敗: ${error}`, 'warn');
        }
    );
}

// --------------------------------------------
// アバターをスポットライトで照らす
// --------------------------------------------
export function setAvatarSpotlight(avatar, isLit) {
    const body = avatar.getObjectByName('avatarBody');
    const head = avatar.getObjectByName('avatarHead');
    const imagePlane = avatar.getObjectByName('avatarImage');
    
    if (body && body.material) {
        if (isLit) {
            body.material.emissive.setHex(avatar.userData.baseColor || 0x4fc3f7);
            body.material.emissiveIntensity = 0.4;
        } else {
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
    
    // 画像アバターの場合は明るさを調整
    if (imagePlane && imagePlane.visible && imagePlane.material) {
        if (isLit) {
            imagePlane.material.color = new THREE.Color(1.5, 1.5, 1.5);
        } else {
            imagePlane.material.color = new THREE.Color(1, 1, 1);
        }
    }
}

// --------------------------------------------
// ペンライト作成
// --------------------------------------------
export function createPenlight(color) {
    const group = new THREE.Group();

    // 持ち手（もう少し大きく）
    const handle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.05, 0.4, 8),
        new THREE.MeshStandardMaterial({ color: 0x333333 })
    );
    handle.name = 'penlightHandle';
    group.add(handle);

    // 発光部分（大きく、目立つように）
    const lightGeometry = new THREE.CylinderGeometry(0.08, 0.05, 0.5, 8);
    const lightMaterial = new THREE.MeshStandardMaterial({ 
        color: color,
        emissive: color,
        emissiveIntensity: 1,
        transparent: true, 
        opacity: 0.95 
    });
    const light = new THREE.Mesh(lightGeometry, lightMaterial);
    light.position.y = 0.45;
    light.name = 'penlightLight';
    group.add(light);

    // グロー効果（外側の光）
    const glowGeometry = new THREE.CylinderGeometry(0.12, 0.08, 0.6, 8);
    const glowMaterial = new THREE.MeshBasicMaterial({ 
        color: color,
        transparent: true, 
        opacity: 0.3 
    });
    const glow = new THREE.Mesh(glowGeometry, glowMaterial);
    glow.position.y = 0.45;
    glow.name = 'penlightGlow';
    group.add(glow);

    // ポイントライト（周囲を照らす）
    const pointLight = new THREE.PointLight(color, 1, 5);
    pointLight.position.y = 0.5;
    pointLight.name = 'penlightPointLight';
    group.add(pointLight);

    return group;
}

// --------------------------------------------
// ペンライト色更新（エクスポート用）
// --------------------------------------------
export function updatePenlightColor(penlight, color) {
    if (!penlight) return;
    
    const colorValue = new THREE.Color(color);
    
    penlight.traverse((child) => {
        if (child.isMesh && child.material) {
            // 持ち手以外の色を更新
            if (child.name !== 'penlightHandle') {
                child.material.color.copy(colorValue);
                if (child.material.emissive) {
                    child.material.emissive.copy(colorValue);
                }
            }
        }
        if (child.isPointLight) {
            child.color.copy(colorValue);
        }
    });
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
