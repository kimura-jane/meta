// ============================================
// メタバース空間 - メインスクリプト
// PartyKit リアルタイム同期対応版
// ============================================

// --------------------------------------------
// PartyKit接続設定
// --------------------------------------------
const PARTYKIT_HOST = 'meta-room.kimura-jane.partykit.dev';
const ROOM_ID = 'main-stage';

let socket = null;
let connected = false;
const remoteAvatars = new Map();

// --------------------------------------------
// 初期設定
// --------------------------------------------
let scene, camera, renderer;
let stage, floor;
let myAvatar;
let myPenlight;
let penlightOn = false;
let penlightColor = '#ff00ff';

// ユーザー情報
const myUserId = 'user-' + Math.random().toString(36).substr(2, 9);
const myUserName = 'ゲスト' + Math.floor(Math.random() * 1000);

// --------------------------------------------
// PartyKit接続
// --------------------------------------------
function connectToPartyKit() {
    const wsUrl = `wss://${PARTYKIT_HOST}/party/${ROOM_ID}?name=${encodeURIComponent(myUserName)}`;
    
    socket = new WebSocket(wsUrl);
    
    socket.onopen = () => {
        console.log('PartyKit接続成功！');
        connected = true;
        updateUserCount();
    };
    
    socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleServerMessage(data);
    };
    
    socket.onclose = () => {
        console.log('接続が切れました');
        connected = false;
        updateUserCount();
        setTimeout(connectToPartyKit, 3000);
    };
    
    socket.onerror = (error) => {
        console.error('WebSocketエラー:', error);
    };
}

function handleServerMessage(data) {
    switch(data.type) {
        case 'init':
            Object.values(data.users).forEach(user => {
                if (user.id !== myUserId) {
                    createRemoteAvatar(user);
                }
            });
            updateUserCount();
            break;
            
        case 'userJoin':
            if (data.user.id !== myUserId) {
                createRemoteAvatar(data.user);
                addChatMessage('システム', `${data.user.name || '誰か'}が入室しました`);
            }
            updateUserCount();
            break;
            
        case 'userLeave':
            removeRemoteAvatar(data.userId);
            addChatMessage('システム', '誰かが退室しました');
            updateUserCount();
            break;
            
        case 'position':
            updateRemoteAvatarPosition(data.userId, data.x, data.y, data.z);
            break;
            
        case 'reaction':
            playRemoteReaction(data.userId, data.reaction, data.color);
            break;
            
        case 'chat':
            addChatMessage(data.name, data.message);
            break;
    }
}

function createRemoteAvatar(user) {
    if (remoteAvatars.has(user.id)) return;
    
    const avatar = createAvatar(user.id, user.name, user.color || 0xff6b6b);
    avatar.position.set(user.x || 0, 0.5, user.z || 5);
    scene.add(avatar);
    remoteAvatars.set(user.id, avatar);
}

function removeRemoteAvatar(userId) {
    const avatar = remoteAvatars.get(userId);
    if (avatar) {
        scene.remove(avatar);
        remoteAvatars.delete(userId);
    }
}

function updateRemoteAvatarPosition(userId, x, y, z) {
    const avatar = remoteAvatars.get(userId);
    if (avatar) {
        avatar.position.x += (x - avatar.position.x) * 0.3;
        avatar.position.z += (z - avatar.position.z) * 0.3;
    }
}

function playRemoteReaction(userId, reaction, color) {
    const avatar = remoteAvatars.get(userId);
    if (!avatar) return;
    
    if (reaction === 'jump') {
        let progress = 0;
        function jumpAnim() {
            progress += 0.1;
            if (progress <= Math.PI) {
                avatar.position.y = 0.5 + Math.sin(progress) * 1;
                requestAnimationFrame(jumpAnim);
            } else {
                avatar.position.y = 0.5;
            }
        }
        jumpAnim();
    } else if (reaction === 'clap') {
        let progress = 0;
        function clapAnim() {
            progress += 0.2;
            if (progress <= Math.PI) {
                const scale = 1 + Math.sin(progress) * 0.1;
                avatar.scale.set(scale, scale, scale);
                requestAnimationFrame(clapAnim);
            } else {
                avatar.scale.set(1, 1, 1);
            }
        }
        clapAnim();
    }
}

function updateUserCount() {
    const count = remoteAvatars.size + (connected ? 1 : 0);
    document.getElementById('user-count').textContent = `${count}人`;
}

function sendPosition() {
    if (socket && socket.readyState === WebSocket.OPEN && myAvatar) {
        socket.send(JSON.stringify({
            type: 'position',
            x: myAvatar.position.x,
            y: myAvatar.position.y,
            z: myAvatar.position.z
        }));
    }
}

function sendReaction(reaction, color) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'reaction',
            reaction: reaction,
            color: color
        }));
    }
}

function sendChat(message) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'chat',
            message: message
        }));
    }
}

// --------------------------------------------
// Three.js 初期化
// --------------------------------------------
function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);

    camera = new THREE.PerspectiveCamera(
        60,
        window.innerWidth / window.innerHeight,
        0.1,
        1000
    );
    camera.position.set(0, 5, 10);
    camera.lookAt(0, 2, 0);

    renderer = new THREE.WebGLRenderer({
        antialias: false,
        powerPreference: 'low-power'
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    document.getElementById('canvas-container').appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(5, 10, 5);
    scene.add(directionalLight);

    const stageLight = new THREE.SpotLight(0xff66ff, 1);
    stageLight.position.set(0, 10, 0);
    stageLight.angle = Math.PI / 4;
    stageLight.penumbra = 0.5;
    scene.add(stageLight);

    createFloor();
    createStage();

    myAvatar = createAvatar(myUserId, myUserName, 0x4fc3f7);
    myAvatar.position.set(
        (Math.random() - 0.5) * 8,
        0.5,
        5 + Math.random() * 3
    );
    scene.add(myAvatar);

    myPenlight = createPenlight(penlightColor);
    myPenlight.visible = false;
    myAvatar.add(myPenlight);

    setupEventListeners();
    
    // PartyKit接続開始
    connectToPartyKit();
    
    // 定期的に位置を送信
    setInterval(sendPosition, 100);

    animate();
}

// --------------------------------------------
// 床の作成
// --------------------------------------------
function createFloor() {
    const geometry = new THREE.PlaneGeometry(30, 20);
    const material = new THREE.MeshStandardMaterial({
        color: 0x2d2d44,
        roughness: 0.8
    });
    floor = new THREE.Mesh(geometry, material);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    const grid = new THREE.GridHelper(30, 30, 0x444466, 0x333355);
    grid.position.y = 0.01;
    scene.add(grid);
}

// --------------------------------------------
// ステージの作成
// --------------------------------------------
function createStage() {
    const stageGeometry = new THREE.BoxGeometry(10, 1, 5);
    const stageMaterial = new THREE.MeshStandardMaterial({
        color: 0x4a4a6a,
        roughness: 0.5
    });
    stage = new THREE.Mesh(stageGeometry, stageMaterial);
    stage.position.set(0, 0.5, -5);
    scene.add(stage);

    const lineGeometry = new THREE.BoxGeometry(10, 0.05, 0.1);
    const lineMaterial = new THREE.MeshBasicMaterial({ color: 0xff66ff });
    const stageLine = new THREE.Mesh(lineGeometry, lineMaterial);
    stageLine.position.set(0, 1.01, -2.4);
    scene.add(stageLine);

    const screenGeometry = new THREE.PlaneGeometry(12, 5);
    const screenMaterial = new THREE.MeshBasicMaterial({
        color: 0x1a1a3e,
        side: THREE.DoubleSide
    });
    const screen = new THREE.Mesh(screenGeometry, screenMaterial);
    screen.position.set(0, 3.5, -7.4);
    scene.add(screen);
}

// --------------------------------------------
// アバター作成
// --------------------------------------------
function createAvatar(userId, userName, color) {
    const group = new THREE.Group();
    group.userData = { userId: userId, userName: userName };

    const bodyGeometry = new THREE.CylinderGeometry(0.3, 0.35, 1, 8);
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: color });
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    body.position.y = 0.5;
    group.add(body);

    const headGeometry = new THREE.SphereGeometry(0.25, 8, 8);
    const headMaterial = new THREE.MeshStandardMaterial({ color: color });
    const head = new THREE.Mesh(headGeometry, headMaterial);
    head.position.y = 1.2;
    group.add(head);

    return group;
}

// --------------------------------------------
// ペンライト作成
// --------------------------------------------
function createPenlight(color) {
    const group = new THREE.Group();

    const handleGeometry = new THREE.CylinderGeometry(0.03, 0.03, 0.2, 8);
    const handleMaterial = new THREE.MeshStandardMaterial({ color: 0x333333 });
    const handle = new THREE.Mesh(handleGeometry, handleMaterial);
    group.add(handle);

    const lightGeometry = new THREE.CylinderGeometry(0.05, 0.03, 0.3, 8);
    const lightMaterial = new THREE.MeshBasicMaterial({ 
        color: color,
        transparent: true,
        opacity: 0.9
    });
    const light = new THREE.Mesh(lightGeometry, lightMaterial);
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
// ペンライトの色を変更
// --------------------------------------------
function setPenlightColor(color) {
    penlightColor = color;
    
    const light = myPenlight.getObjectByName('penlightLight');
    if (light) {
        light.material.color.set(color);
    }
    
    const pointLight = myPenlight.getObjectByName('penlightPointLight');
    if (pointLight) {
        pointLight.color.set(color);
    }
}

// --------------------------------------------
// ペンライトを振る
// --------------------------------------------
function wavePenlight() {
    if (!penlightOn) return;
    
    const startRotation = myPenlight.rotation.z;
    const swingAmount = 0.3;
    let progress = 0;
    
    function swingAnimation() {
        progress += 0.15;
        if (progress <= Math.PI) {
            myPenlight.rotation.z = startRotation + Math.sin(progress) * swingAmount;
            requestAnimationFrame(swingAnimation);
        } else {
            myPenlight.rotation.z = startRotation;
        }
    }
    swingAnimation();
}

// --------------------------------------------
// ジャンプアニメーション
// --------------------------------------------
function doJump() {
    const startY = myAvatar.position.y;
    let progress = 0;
    
    function jumpAnimation() {
        progress += 0.1;
        if (progress <= Math.PI) {
            myAvatar.position.y = startY + Math.sin(progress) * 1;
            requestAnimationFrame(jumpAnimation);
        } else {
            myAvatar.position.y = startY;
        }
    }
    jumpAnimation();
    
    // 他のユーザーに送信
    sendReaction('jump', null);
}

// --------------------------------------------
// オタ芸アニメーション
// --------------------------------------------
function doOtagei(motionId) {
    let progress = 0;
    const duration = Math.PI * 2;
    
    function otageiAnimation() {
        progress += 0.12;
        if (progress <= duration) {
            myAvatar.rotation.z = Math.sin(progress * 3) * 0.2;
            if (myPenlight.visible) {
                myPenlight.rotation.z = Math.PI / 6 + Math.sin(progress * 5) * 0.5;
            }
            requestAnimationFrame(otageiAnimation);
        } else {
            myAvatar.rotation.z = 0;
            myPenlight.rotation.z = Math.PI / 6;
        }
    }
    otageiAnimation();
    
    sendReaction('otagei', penlightColor);
}

// --------------------------------------------
// 拍手エフェクト
// --------------------------------------------
function doClap() {
    const originalScale = myAvatar.scale.x;
    let progress = 0;
    
    function clapAnimation() {
        progress += 0.2;
        if (progress <= Math.PI) {
            const scale = originalScale + Math.sin(progress) * 0.1;
            myAvatar.scale.set(scale, scale, scale);
            requestAnimationFrame(clapAnimation);
        } else {
            myAvatar.scale.set(originalScale, originalScale, originalScale);
        }
    }
    clapAnimation();
    
    sendReaction('clap', null);
}

// --------------------------------------------
// イベントリスナー設定
// --------------------------------------------
function setupEventListeners() {
    window.addEventListener('resize', onWindowResize);

    document.querySelectorAll('.reaction-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const type = btn.dataset.type;
            
            switch(type) {
                case 'penlight':
                    penlightOn = !penlightOn;
                    myPenlight.visible = penlightOn;
                    document.getElementById('penlight-colors').classList.toggle('hidden', !penlightOn);
                    if (penlightOn) {
                        wavePenlight();
                        sendReaction('penlight', penlightColor);
                    }
                    break;
                case 'jump':
                    doJump();
                    break;
                case 'clap':
                    doClap();
                    break;
                case 'otagei':
                    doOtagei(btn.dataset.motion);
                    break;
            }
        });
    });

    document.querySelectorAll('.color-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            setPenlightColor(btn.dataset.color);
            wavePenlight();
        });
    });

    document.getElementById('chat-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const input = document.getElementById('chat-input');
        const message = input.value.trim();
        if (message) {
            addChatMessage(myUserName, message);
            sendChat(message);
            input.value = '';
        }
    });

    document.getElementById('request-stage-btn').addEventListener('click', () => {
        alert('登壇リクエストを送信しました（デモ）');
    });

    document.getElementById('mic-toggle-btn').addEventListener('click', (e) => {
        e.target.classList.toggle('muted');
        const isMuted = e.target.classList.contains('muted');
        e.target.textContent = isMuted ? '🎙️ マイク OFF' : '🎙️ マイク ON';
    });

    let touchStartX, touchStartY;
    renderer.domElement.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    });

    renderer.domElement.addEventListener('touchmove', (e) => {
        if (!touchStartX || !touchStartY) return;
        
        const deltaX = (e.touches[0].clientX - touchStartX) * 0.01;
        const deltaZ = (e.touches[0].clientY - touchStartY) * 0.01;
        
        myAvatar.position.x += deltaX;
        myAvatar.position.z += deltaZ;
        
        myAvatar.position.x = Math.max(-14, Math.min(14, myAvatar.position.x));
        myAvatar.position.z = Math.max(-2, Math.min(9, myAvatar.position.z));
        
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    });

    renderer.domElement.addEventListener('touchend', () => {
        touchStartX = null;
        touchStartY = null;
    });
}

// --------------------------------------------
// チャットメッセージ追加
// --------------------------------------------
function addChatMessage(name, message) {
    const container = document.getElementById('chat-messages');
    const div = document.createElement('div');
    div.className = 'chat-message';
    div.innerHTML = `<span class="name">${name}</span>${message}`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    
    while (container.children.length > 20) {
        container.removeChild(container.firstChild);
    }
}

// --------------------------------------------
// ウィンドウリサイズ
// --------------------------------------------
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// --------------------------------------------
// アニメーションループ
// --------------------------------------------
function animate() {
    requestAnimationFrame(animate);
    
    const targetX = myAvatar.position.x * 0.3;
    const targetZ = myAvatar.position.z + 8;
    camera.position.x += (targetX - camera.position.x) * 0.05;
    camera.position.z += (targetZ - camera.position.z) * 0.05;
    camera.lookAt(myAvatar.position.x * 0.5, 2, myAvatar.position.z - 5);
    
    renderer.render(scene, camera);
}

// --------------------------------------------
// 初期化実行
// --------------------------------------------
init();
