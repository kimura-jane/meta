// ============================================
// メタバース空間 - メインスクリプト
// エントリーポイント
// ============================================

const THREE = window.THREE;

import { debugLog, createDebugUI, setupErrorHandlers, addChatMessage, createAvatar, createPenlight, setAvatarSpotlight, setAvatarImage } from './utils.js';
import { connectToPartyKit, setCallbacks, getState, requestSpeak, toggleMic, sendPosition, sendReaction, sendChat, sendNameChange, sendBackgroundChange, sendAnnounce, sendBrightness, approveSpeak, denySpeak, kickSpeaker } from './connection.js';
import { initVenue, createAllVenue, animateVenue, changeStageBackground, updateSpeakerSpotlights, setRoomBrightness } from './venue.js';
import { initSettings, getSettings, updateSpeakRequests, updateCurrentSpeakers, showNotification, updateUserCount as updateSettingsUserCount } from './settings.js';

// --------------------------------------------
// 状態
// --------------------------------------------
let scene, camera, renderer;
let myAvatar, myPenlight;
let penlightOn = false;
let penlightColor = '#ff00ff';
let otageiOn = false;

let penlightAnimationId = null;
let otageiAnimationId = null;

let isOnStage = false;
let originalPosition = null;

const remoteAvatars = new Map();

const myUserId = 'user-' + Math.random().toString(36).substr(2, 9);
let myUserName = 'ゲスト' + Math.floor(Math.random() * 1000);

// アバター画像リスト
const CHARA_LIST = [
    '12555',
    'IMG_1677',
    'IMG_1861',
    'IMG_1889',
    'IMG_2958',
    'IMG_3264',
    'IMG_3267',
    'IMG_3269',
    'IMG_7483',
    'onigiriya_kanatake_512'
];

const CHARA_EXTENSIONS = {
    '12555': 'png',
    'IMG_1677': 'jpeg',
    'IMG_1861': 'png',
    'IMG_1889': 'png',
    'IMG_2958': 'png',
    'IMG_3264': 'png',
    'IMG_3267': 'png',
    'IMG_3269': 'png',
    'IMG_7483': 'png',
    'onigiriya_kanatake_512': 'png'
};

// --------------------------------------------
// 初期化
// --------------------------------------------
function init() {
    setupErrorHandlers();
    createDebugUI();
    debugLog('Three.js初期化開始');
    
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050508);
    scene.fog = new THREE.Fog(0x050508, 20, 50);

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 5, 12);
    camera.lookAt(0, 2, 0);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    
    const container = document.getElementById('canvas-container');
    if (container) {
        container.appendChild(renderer.domElement);
        debugLog('canvas-container にレンダラー追加', 'success');
    } else {
        debugLog('canvas-container が見つからない！', 'error');
        document.body.appendChild(renderer.domElement);
    }

    // 会場作成
    initVenue(scene);
    createAllVenue();

    // 自分のアバター
    myAvatar = createAvatar(myUserId, myUserName, 0x4fc3f7);
    myAvatar.position.set((Math.random() - 0.5) * 8, 0.5, 5 + Math.random() * 3);
    scene.add(myAvatar);

    myPenlight = createPenlight(penlightColor);
    myPenlight.visible = false;
    myAvatar.add(myPenlight);

    // 設定画面初期化
    initSettings(myUserName, {
        onNameChange: (newName) => {
            myUserName = newName;
            myAvatar.userData.userName = newName;
            
            // 名前に対応するアバター画像があるかチェック
            checkAndApplyAvatarImage(myAvatar, newName);
            
            sendNameChange(newName);
            showNotification(`名前を「${newName}」に変更しました`);
        },
        onResetCamera: () => {
            if (isOnStage) {
                camera.position.set(myAvatar.position.x * 0.5, 3.5, -2);
                camera.lookAt(myAvatar.position.x * 0.3, 1.5, 10);
            } else {
                camera.position.set(0, 5, 12);
                camera.lookAt(0, 2, 0);
            }
            showNotification('カメラ視点をリセットしました');
        },
        onApproveSpeak: (userId) => {
            approveSpeak(userId);
        },
        onDenySpeak: (userId) => {
            denySpeak(userId);
        },
        onKickSpeaker: (userId) => {
            kickSpeaker(userId);
        },
        onChangeBackground: (url) => {
            changeStageBackground(url);
            sendBackgroundChange(url);
            showNotification('背景を変更しました');
        },
        onAnnounce: (text) => {
            sendAnnounce(text);
            showNotification(`📢 ${text}`, 'announce');
        },
        onShowNamesChange: (show) => {
            updateNameVisibility(show);
        },
        onBrightnessChange: (value) => {
            setRoomBrightness(value);
            sendBrightness(value);
        },
        onRequestSpeak: () => {
            requestSpeak();
        }
    });

    // コールバック設定
    setCallbacks({
        onUserJoin: handleUserJoin,
        onUserLeave: handleUserLeave,
        onPosition: handlePosition,
        onReaction: handleReaction,
        onSpeakApproved: handleSpeakApproved,
        onSpeakerJoined: handleSpeakerJoined,
        onSpeakerLeft: handleSpeakerLeft,
        onConnectedChange: handleConnectedChange,
        onSpeakRequestsUpdate: updateSpeakRequests,
        onCurrentSpeakersUpdate: (speakers) => {
            updateCurrentSpeakers(speakers);
            updateSpeakerCount();
        },
        onAnnounce: (message) => {
            showNotification(`📢 ${message}`, 'announce');
            addChatMessage('📢 アナウンス', message);
        },
        onBackgroundChange: (url) => {
            changeStageBackground(url);
        },
        onBrightnessChange: (value) => {
            setRoomBrightness(value);
        },
        onChat: (name, message, senderId) => {
            const state = getState();
            if (senderId !== state.myServerConnectionId) {
                addChatMessage(name, message);
            }
        },
        remoteAvatars: remoteAvatars
    });

    setupEventListeners();
    connectToPartyKit(myUserName);
    
    // 初期の人数表示
    updateUserCount();
    updateSpeakerCount();
    
    setInterval(() => {
        if (myAvatar) {
            sendPosition(myAvatar.position.x, myAvatar.position.y, myAvatar.position.z);
        }
    }, 100);

    animate();
    debugLog('初期化完了', 'success');

    // グローバルに公開
    window.changeStageBackground = changeStageBackground;
}

// --------------------------------------------
// アバター画像チェック・適用
// --------------------------------------------
function checkAndApplyAvatarImage(avatar, userName) {
    if (CHARA_LIST.includes(userName)) {
        const ext = CHARA_EXTENSIONS[userName] || 'png';
        const imageUrl = `https://raw.githubusercontent.com/kimura-jane/meta/main/chara/${userName}.${ext}`;
        setAvatarImage(avatar, imageUrl);
        debugLog(`アバター画像適用: ${userName}`, 'success');
    }
}

// --------------------------------------------
// 名前表示切替
// --------------------------------------------
function updateNameVisibility(show) {
    debugLog(`名前表示: ${show ? 'ON' : 'OFF'}`, 'info');
}

// --------------------------------------------
// コールバックハンドラー
// --------------------------------------------
function handleUserJoin(user) {
    if (remoteAvatars.has(user.id)) return;
    const avatar = createAvatar(user.id, user.name, user.color || 0xff6b6b);
    avatar.position.set(user.x || 0, 0.5, user.z || 5);
    avatar.userData.onStage = false;
    avatar.userData.userName = user.name;
    scene.add(avatar);
    remoteAvatars.set(user.id, avatar);
    
    // アバター画像チェック
    checkAndApplyAvatarImage(avatar, user.name);
    
    updateUserCount();
    showNotification(`${user.name || '誰か'} が参加しました`, 'join-leave');
}

function handleUserLeave(userId) {
    const avatar = remoteAvatars.get(userId);
    if (avatar) {
        showNotification(`${avatar.userData?.userName || '誰か'} が退出しました`, 'join-leave');
        scene.remove(avatar);
        remoteAvatars.delete(userId);
    }
    updateUserCount();
}

function handlePosition(userId, x, y, z) {
    const avatar = remoteAvatars.get(userId);
    if (avatar) {
        avatar.position.x += (x - avatar.position.x) * 0.3;
        avatar.position.z += (z - avatar.position.z) * 0.3;
    }
}

function handleReaction(userId, reaction, color) {
    const avatar = remoteAvatars.get(userId);
    if (!avatar) return;
    
    if (reaction === 'penlight') {
        // リモートユーザーのペンライト表示
        let penlight = avatar.getObjectByName('remotePenlight');
        if (!penlight) {
            penlight = createPenlight(color || '#ff00ff');
            penlight.name = 'remotePenlight';
            avatar.add(penlight);
        }
        penlight.visible = true;
        
        // 振るアニメーション
        let progress = 0;
        function swing() {
            progress += 0.15;
            if (progress <= Math.PI * 4) {
                penlight.rotation.z = Math.PI / 6 + Math.sin(progress) * 0.3;
                requestAnimationFrame(swing);
            }
        }
        swing();
    } else if (reaction === 'otagei') {
        let progress = 0;
        function otageiAnim() {
            progress += 0.12;
            if (progress <= Math.PI * 4) {
                avatar.rotation.z = Math.sin(progress * 3) * 0.2;
                requestAnimationFrame(otageiAnim);
            } else {
                avatar.rotation.z = 0;
            }
        }
        otageiAnim();
    }
}

function handleSpeakApproved() {
    moveToStage();
    addChatMessage('システム', '登壇が承認されました！');
    updateSpeakerCount();
}

function handleSpeakerJoined(userId) {
    moveRemoteToStage(userId);
    addChatMessage('システム', '新しい登壇者が参加しました');
    updateSpeakerCount();
}

function handleSpeakerLeft(userId) {
    const state = getState();
    if (userId === state.myServerConnectionId) {
        moveOffStage();
        addChatMessage('システム', '登壇を終了しました');
    } else {
        moveRemoteToAudience(userId);
    }
    updateSpeakerCount();
}

function handleConnectedChange(connected) {
    updateUserCount();
}

// --------------------------------------------
// 人数更新
// --------------------------------------------
function updateUserCount() {
    const state = getState();
    const count = remoteAvatars.size + (state.connected ? 1 : 0);
    
    const numEl = document.getElementById('user-count-num');
    if (numEl) {
        numEl.textContent = count;
    }
    
    if (typeof updateSettingsUserCount === 'function') {
        updateSettingsUserCount(count);
    }
}

function updateSpeakerCount() {
    let speakerCount = isOnStage ? 1 : 0;
    
    remoteAvatars.forEach((avatar) => {
        if (avatar.userData && avatar.userData.onStage) {
            speakerCount++;
        }
    });
    
    const speakerCountEl = document.getElementById('speaker-count');
    if (speakerCountEl) {
        speakerCountEl.textContent = speakerCount;
    }
}

// --------------------------------------------
// 登壇者スポットライト更新
// --------------------------------------------
function updateStageSpeakers() {
    const speakers = [];
    
    if (isOnStage && myAvatar) {
        speakers.push({
            x: myAvatar.position.x,
            y: myAvatar.position.y,
            z: myAvatar.position.z
        });
    }
    
    remoteAvatars.forEach((avatar) => {
        if (avatar.userData && avatar.userData.onStage) {
            speakers.push({
                x: avatar.position.x,
                y: avatar.position.y,
                z: avatar.position.z
            });
        }
    });
    
    updateSpeakerSpotlights(speakers);
}

// --------------------------------------------
// ステージ移動
// --------------------------------------------
function moveToStage() {
    if (isOnStage) return;
    
    originalPosition = {
        x: myAvatar.position.x,
        z: myAvatar.position.z
    };
    
    const state = getState();
    const stageX = (state.speakerCount - 1) * 2 - 4;
    const stageZ = -4;
    const stageY = 1.7;
    
    animateToPosition(myAvatar, stageX, stageY, stageZ, () => {
        isOnStage = true;
        myAvatar.rotation.y = Math.PI;
        myAvatar.userData.onStage = true;
        setAvatarSpotlight(myAvatar, true);
        updateSpeakerCount();
        debugLog('ステージに移動完了', 'success');
    });
}

function moveOffStage() {
    if (!isOnStage) return;
    
    const targetX = originalPosition ? originalPosition.x : (Math.random() - 0.5) * 8;
    const targetZ = originalPosition ? originalPosition.z : 5 + Math.random() * 3;
    
    animateToPosition(myAvatar, targetX, 0.5, targetZ, () => {
        isOnStage = false;
        myAvatar.rotation.y = 0;
        myAvatar.userData.onStage = false;
        setAvatarSpotlight(myAvatar, false);
        originalPosition = null;
        updateSpeakerCount();
        debugLog('フロアに戻りました', 'info');
    });
}

function moveRemoteToStage(userId) {
    const avatar = remoteAvatars.get(userId);
    if (!avatar) return;
    
    const stageX = (Math.random() - 0.5) * 8;
    animateToPosition(avatar, stageX, 1.7, -4, () => {
        avatar.rotation.y = Math.PI;
        avatar.userData = avatar.userData || {};
        avatar.userData.onStage = true;
        setAvatarSpotlight(avatar, true);
        updateSpeakerCount();
    });
}

function moveRemoteToAudience(userId) {
    const avatar = remoteAvatars.get(userId);
    if (!avatar) return;
    
    const targetX = (Math.random() - 0.5) * 8;
    const targetZ = 5 + Math.random() * 3;
    
    animateToPosition(avatar, targetX, 0.5, targetZ, () => {
        avatar.rotation.y = 0;
        if (avatar.userData) {
            avatar.userData.onStage = false;
        }
        setAvatarSpotlight(avatar, false);
        updateSpeakerCount();
    });
}

function animateToPosition(obj, targetX, targetY, targetZ, onComplete) {
    const startX = obj.position.x;
    const startY = obj.position.y;
    const startZ = obj.position.z;
    const duration = 1000;
    const startTime = Date.now();
    
    function doAnimate() {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        
        obj.position.x = startX + (targetX - startX) * eased;
        obj.position.y = startY + (targetY - startY) * eased;
        obj.position.z = startZ + (targetZ - startZ) * eased;
        
        if (progress < 1) {
            requestAnimationFrame(doAnimate);
        } else if (onComplete) {
            onComplete();
        }
    }
    doAnimate();
}

// --------------------------------------------
// ペンライト
// --------------------------------------------
function setPenlightColor(color) {
    penlightColor = color;
    const light = myPenlight.getObjectByName('penlightLight');
    if (light) light.material.color.set(color);
    const pointLight = myPenlight.getObjectByName('penlightPointLight');
    if (pointLight) pointLight.color.set(color);
    
    // ボタンの光る色も更新
    const penlightBtn = document.getElementById('penlight-btn');
    if (penlightBtn && penlightOn) {
        penlightBtn.style.setProperty('--glow-color', color);
    }
}

function startPenlightLoop() {
    if (penlightAnimationId) return;
    
    function swing() {
        if (!penlightOn) {
            penlightAnimationId = null;
            return;
        }
        
        const time = Date.now() * 0.005;
        myPenlight.rotation.z = Math.PI / 6 + Math.sin(time) * 0.3;
        
        penlightAnimationId = requestAnimationFrame(swing);
    }
    swing();
    sendReaction('penlight', penlightColor);
}

function stopPenlightLoop() {
    if (penlightAnimationId) {
        cancelAnimationFrame(penlightAnimationId);
        penlightAnimationId = null;
    }
    myPenlight.rotation.z = Math.PI / 6;
}

function togglePenlight() {
    penlightOn = !penlightOn;
    myPenlight.visible = penlightOn;
    
    const penlightBtn = document.getElementById('penlight-btn');
    if (penlightBtn) {
        if (penlightOn) {
            penlightBtn.classList.add('active');
            penlightBtn.style.setProperty('--glow-color', penlightColor);
            startPenlightLoop();
        } else {
            penlightBtn.classList.remove('active');
            stopPenlightLoop();
        }
    }
}

// --------------------------------------------
// オタ芸
// --------------------------------------------
function startOtageiLoop() {
    if (otageiAnimationId) return;
    
    function otagei() {
        if (!otageiOn) {
            otageiAnimationId = null;
            myAvatar.rotation.z = 0;
            if (myPenlight.visible) {
                myPenlight.rotation.z = Math.PI / 6;
            }
            return;
        }
        
        const time = Date.now() * 0.008;
        myAvatar.rotation.z = Math.sin(time * 3) * 0.2;
        if (myPenlight.visible) {
            myPenlight.rotation.z = Math.PI / 6 + Math.sin(time * 5) * 0.5;
        }
        
        otageiAnimationId = requestAnimationFrame(otagei);
    }
    otagei();
    sendReaction('otagei', penlightColor);
}

function stopOtageiLoop() {
    if (otageiAnimationId) {
        cancelAnimationFrame(otageiAnimationId);
        otageiAnimationId = null;
    }
    myAvatar.rotation.z = 0;
}

function toggleOtagei() {
    otageiOn = !otageiOn;
    
    const otageiBtn = document.getElementById('otagei-btn');
    if (otageiBtn) {
        if (otageiOn) {
            otageiBtn.classList.add('active');
            otageiBtn.style.setProperty('--glow-color', '#ff66ff');
            startOtageiLoop();
        } else {
            otageiBtn.classList.remove('active');
            stopOtageiLoop();
        }
    }
}

// --------------------------------------------
// イベントリスナー
// --------------------------------------------
function setupEventListeners() {
    window.addEventListener('resize', onWindowResize);

    // ペンライトボタン
    const penlightBtn = document.getElementById('penlight-btn');
    if (penlightBtn) {
        let pressTimer = null;
        let isLongPress = false;
        
        const startPress = (e) => {
            e.preventDefault();
            isLongPress = false;
            pressTimer = setTimeout(() => {
                isLongPress = true;
                // 長押し: 色選択パネル表示
                const colorPanel = document.getElementById('penlight-colors');
                if (colorPanel) {
                    colorPanel.classList.toggle('hidden');
                }
            }, 500);
        };
        
        const endPress = (e) => {
            e.preventDefault();
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
            if (!isLongPress) {
                // 短押し: ON/OFF切替
                togglePenlight();
            }
        };
        
        penlightBtn.addEventListener('mousedown', startPress);
        penlightBtn.addEventListener('mouseup', endPress);
        penlightBtn.addEventListener('mouseleave', () => {
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
        });
        penlightBtn.addEventListener('touchstart', startPress);
        penlightBtn.addEventListener('touchend', endPress);
    }

    // オタ芸ボタン
    const otageiBtn = document.getElementById('otagei-btn');
    if (otageiBtn) {
        otageiBtn.addEventListener('click', toggleOtagei);
    }

    // 色選択ボタン
    document.querySelectorAll('.color-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            setPenlightColor(btn.dataset.color);
            
            // 色選択後にパネルを閉じる
            const colorPanel = document.getElementById('penlight-colors');
            if (colorPanel) {
                colorPanel.classList.add('hidden');
            }
        });
    });

    // チャットフォーム
    const chatForm = document.getElementById('chat-form');
    if (chatForm) {
        chatForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const input = document.getElementById('chat-input');
            const message = input.value.trim();
            if (message) {
                addChatMessage(myUserName, message);
                sendChat(myUserName, message);
                input.value = '';
            }
        });
    }

    // マイクボタン
    const micBtn = document.getElementById('mic-toggle-btn');
    if (micBtn) {
        micBtn.addEventListener('click', () => {
            const isOn = toggleMic();
            micBtn.textContent = isOn ? '🎙️ 配信中' : '🎙️ マイク OFF';
            micBtn.classList.toggle('speaking', isOn);
        });
    }

    // タッチ操作
    let touchStartX, touchStartY;
    renderer.domElement.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    });

    renderer.domElement.addEventListener('touchmove', (e) => {
        if (!touchStartX || !touchStartY) return;
        
        if (isOnStage) {
            const deltaX = (e.touches[0].clientX - touchStartX) * 0.02;
            myAvatar.position.x += deltaX;
            myAvatar.position.x = Math.max(-6, Math.min(6, myAvatar.position.x));
        } else {
            const deltaX = (e.touches[0].clientX - touchStartX) * 0.01;
            const deltaZ = (e.touches[0].clientY - touchStartY) * 0.01;
            myAvatar.position.x += deltaX;
            myAvatar.position.z += deltaZ;
            myAvatar.position.x = Math.max(-12, Math.min(12, myAvatar.position.x));
            myAvatar.position.z = Math.max(-1, Math.min(10, myAvatar.position.z));
        }
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    });

    renderer.domElement.addEventListener('touchend', () => {
        touchStartX = null;
        touchStartY = null;
    });
}

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
    
    updateStageSpeakers();
    animateVenue();
    
    if (myAvatar) {
        if (isOnStage) {
            camera.position.x += (myAvatar.position.x * 0.5 - camera.position.x) * 0.05;
            camera.position.y += (3.5 - camera.position.y) * 0.05;
            camera.position.z += (-2 - camera.position.z) * 0.05;
            camera.lookAt(myAvatar.position.x * 0.3, 1.5, 10);
        } else {
            camera.position.x += (myAvatar.position.x * 0.3 - camera.position.x) * 0.05;
            camera.position.z += (myAvatar.position.z + 8 - camera.position.z) * 0.05;
            camera.position.y += (5 - camera.position.y) * 0.05;
            camera.lookAt(myAvatar.position.x * 0.5, 2, myAvatar.position.z - 5);
        }
    }
    renderer.render(scene, camera);
}

// --------------------------------------------
// 起動
// --------------------------------------------
init();
