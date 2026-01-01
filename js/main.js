// ============================================
// メタバース空間 - メインスクリプト
// PartyKit + Cloudflare Calls 対応版
// iOS Safari 対応版 - 各トラック個別PeerConnection方式
// ============================================

// エラーを画面に表示
window.onerror = function(msg, url, line, col, error) {
    const div = document.createElement('div');
    div.style.cssText = 'position:fixed;top:0;left:0;right:0;background:red;color:white;padding:10px;z-index:99999;font-size:12px;';
    div.textContent = `ERROR: ${msg} (line ${line})`;
    document.body.appendChild(div);
    return false;
};

// --------------------------------------------
// デバッグログ機能
// --------------------------------------------
const debugLogs = [];
function debugLog(msg, type = 'info') {
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

window.onunhandledrejection = (e) => {
    debugLog(`Promise ERROR: ${e.reason}`, 'error');
};

// --------------------------------------------
// PartyKit接続設定
// --------------------------------------------
const PARTYKIT_HOST = 'kimurameta.kimura-jane.partykit.dev';
const ROOM_ID = 'main-stage';

let socket = null;
let connected = false;
let myServerConnectionId = null;
const remoteAvatars = new Map();

// --------------------------------------------
// 音声通話設定
// --------------------------------------------
let localStream = null;
let peerConnection = null;
let mySessionId = null;
let isSpeaker = false;
let myPublishedTrackName = null;

const subscribedTracks = new Map();
const pendingSubscriptions = new Map();

let speakerCount = 0;
let turnCredentials = null;
let audioUnlocked = false;

// --------------------------------------------
// 初期設定
// --------------------------------------------
let scene, camera, renderer;
let stage, floor;
let myAvatar;
let myPenlight;
let penlightOn = false;
let penlightColor = '#ff00ff';

let movingLights = [];
let ledScreen;
let lightTime = 0;

let stageBackgroundUrl = 'https://raw.githubusercontent.com/kimura-jane/meta/main/IMG_3206.jpeg';

let isOnStage = false;
let originalPosition = null;

const myUserId = 'user-' + Math.random().toString(36).substr(2, 9);
const myUserName = 'ゲスト' + Math.floor(Math.random() * 1000);

// --------------------------------------------
// iOS検出
// --------------------------------------------
function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || 
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// --------------------------------------------
// ICE サーバー設定
// --------------------------------------------
function getIceServers() {
    const servers = [
        { urls: 'stun:stun.cloudflare.com:3478' }
    ];
    
    if (turnCredentials) {
        servers.push({
            urls: 'turn:turn.cloudflare.com:3478?transport=udp',
            username: turnCredentials.username,
            credential: turnCredentials.credential
        });
        servers.push({
            urls: 'turn:turn.cloudflare.com:3478?transport=tcp',
            username: turnCredentials.username,
            credential: turnCredentials.credential
        });
    }
    
    return servers;
}

// --------------------------------------------
// 音声アンロック（iOS Safari用）
// --------------------------------------------
function showAudioUnlockButton() {
    if (audioUnlocked) return;
    
    const existing = document.getElementById('audio-unlock-btn');
    if (existing) existing.remove();
    
    const btn = document.createElement('button');
    btn.id = 'audio-unlock-btn';
    btn.textContent = '🔊 タップして音声を有効化';
    btn.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        padding: 20px 40px;
        font-size: 18px;
        background: #ff6b6b;
        color: white;
        border: none;
        border-radius: 10px;
        z-index: 20000;
        cursor: pointer;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    `;
    
    btn.onclick = async () => {
        debugLog('音声アンロック開始', 'info');
        
        for (const [trackName, obj] of subscribedTracks) {
            if (obj.audio) {
                try {
                    await obj.audio.play();
                    debugLog(`音声再生成功: ${trackName}`, 'success');
                } catch (e) {
                    debugLog(`音声再生失敗: ${trackName}: ${e.message}`, 'warn');
                }
            }
        }
        
        audioUnlocked = true;
        btn.remove();
        debugLog('音声アンロック完了', 'success');
    };
    
    document.body.appendChild(btn);
    debugLog('音声アンロックボタン表示', 'warn');
}

function resumeAllAudio() {
    debugLog('全音声再開処理', 'info');
    
    let hasAudio = false;
    subscribedTracks.forEach((obj, trackName) => {
        if (obj.audio) {
            hasAudio = true;
            obj.audio.play()
                .then(() => debugLog(`音声再開: ${trackName}`, 'success'))
                .catch(e => {
                    debugLog(`音声再開失敗: ${trackName}: ${e.message}`, 'warn');
                    if (isIOS() && !audioUnlocked) {
                        showAudioUnlockButton();
                    }
                });
        }
    });
    
    if (hasAudio && isIOS() && !audioUnlocked) {
        showAudioUnlockButton();
    }
}

// --------------------------------------------
// デバッグUIを作成
// --------------------------------------------
function createDebugUI() {
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
// PartyKit接続
// --------------------------------------------
function connectToPartyKit() {
    const wsUrl = `wss://${PARTYKIT_HOST}/party/${ROOM_ID}?name=${encodeURIComponent(myUserName)}`;
    debugLog(`接続開始: ${PARTYKIT_HOST}`);
    
    try {
        socket = new WebSocket(wsUrl);
    } catch (e) {
        debugLog(`WebSocket作成エラー: ${e}`, 'error');
        return;
    }
    
    socket.onopen = () => {
        debugLog('PartyKit接続成功！', 'success');
        connected = true;
        updateUserCount();
    };
    
    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type !== 'position') {
                debugLog(`受信: ${data.type}`);
            }
            handleServerMessage(data);
        } catch (e) {
            debugLog(`メッセージ解析エラー: ${e}`, 'error');
        }
    };
    
    socket.onclose = () => {
        debugLog('接続切断 - 3秒後再接続', 'warn');
        connected = false;
        updateUserCount();
        
        subscribedTracks.forEach((obj, trackName) => {
            if (obj.pc) {
                try { obj.pc.close(); } catch(e) {}
            }
            if (obj.audio) {
                obj.audio.pause();
                obj.audio.srcObject = null;
            }
        });
        subscribedTracks.clear();
        pendingSubscriptions.clear();
        
        setTimeout(connectToPartyKit, 3000);
    };
    
    socket.onerror = (error) => {
        debugLog(`WebSocketエラー`, 'error');
    };
}

function handleServerMessage(data) {
    switch(data.type) {
        case 'init':
            myServerConnectionId = data.yourId;
            debugLog(`初期化: ID=${myServerConnectionId}, ${Object.keys(data.users).length}人`);
            
            if (data.turnCredentials) {
                turnCredentials = data.turnCredentials;
                debugLog('TURN認証情報取得', 'success');
            }
            
            Object.values(data.users).forEach(user => {
                if (user.id !== myServerConnectionId) {
                    createRemoteAvatar(user);
                }
            });
            updateUserCount();
            updateSpeakerList(data.speakers || []);
            
            if (data.tracks && data.sessions) {
                const tracksArray = Array.isArray(data.tracks) ? data.tracks : [];
                const sessionsArray = Array.isArray(data.sessions) ? data.sessions : [];
                const sessionsMap = new Map(sessionsArray);
                
                setTimeout(() => {
                    tracksArray.forEach(([odUserId, trackName]) => {
                        if (odUserId === myServerConnectionId) {
                            return;
                        }
                        const speakerSessionId = sessionsMap.get(odUserId);
                        if (speakerSessionId) {
                            subscribeToTrack(odUserId, speakerSessionId, trackName);
                        }
                    });
                }, 1000);
            }
            break;
            
        case 'userJoin':
            if (data.user.id !== myServerConnectionId) {
                createRemoteAvatar(data.user);
                addChatMessage('システム', `${data.user.name || '誰か'}が入室しました`);
            }
            updateUserCount();
            break;
            
        case 'userLeave':
            const leaveUserId = data.odUserId || data.userId;
            removeRemoteAvatar(leaveUserId);
            removeRemoteAudio(leaveUserId);
            addChatMessage('システム', '誰かが退室しました');
            updateUserCount();
            if (data.speakers) {
                updateSpeakerList(data.speakers);
            }
            break;
            
        case 'position':
            const posUserId = data.odUserId || data.userId;
            updateRemoteAvatarPosition(posUserId, data.x, data.y, data.z);
            break;
            
        case 'reaction':
            const reactUserId = data.odUserId || data.userId;
            playRemoteReaction(reactUserId, data.reaction, data.color);
            break;
            
        case 'chat':
            addChatMessage(data.name, data.message);
            break;

        case 'speakApproved':
            mySessionId = data.sessionId;
            isSpeaker = true;
            speakerCount++;
            updateSpeakerButton();
            startPublishing();
            moveToStage();
            addChatMessage('システム', '登壇が承認されました！');
            break;

        case 'speakDenied':
            addChatMessage('システム', data.reason);
            break;

        case 'speakerJoined':
            const joinedUserId = data.odUserId || data.userId;
            if (data.speakers) {
                updateSpeakerList(data.speakers);
            }
            moveRemoteToStage(joinedUserId);
            addChatMessage('システム', '新しい登壇者が参加しました');
            break;

        case 'speakerLeft':
            const leftUserId = data.odUserId || data.userId;
            if (data.speakers) {
                updateSpeakerList(data.speakers);
            }
            removeRemoteAudio(leftUserId);
            moveRemoteToAudience(leftUserId);
            break;

        case 'trackPublished':
            handleTrackPublished(data);
            break;

        case 'newTrack':
            const trackUserId = data.odUserId || data.userId;
            const newTrackName = data.trackName;
            
            if (trackUserId === myServerConnectionId) return;
            if (myPublishedTrackName && newTrackName === myPublishedTrackName) return;
            
            setTimeout(() => {
                subscribeToTrack(trackUserId, data.sessionId, newTrackName);
            }, 500);
            break;

        case 'subscribed':
            handleSubscribed(data);
            break;
            
        case 'subscribeAnswerAck':
            debugLog('Answer確認OK', 'success');
            break;
            
        case 'error':
            debugLog(`サーバーエラー: ${data.code || data.message}`, 'error');
            break;
    }
}

// --------------------------------------------
// ステージ移動機能（修正版）
// --------------------------------------------
function moveToStage() {
    if (isOnStage) return;
    
    originalPosition = {
        x: myAvatar.position.x,
        z: myAvatar.position.z
    };
    
    // ステージ上の位置（観客側を向く位置）
    const stageX = (speakerCount - 1) * 2 - 4;
    const stageZ = -4; // ステージ前方（LEDスクリーンより手前）
    const stageY = 1.7;
    
    animateToPosition(myAvatar, stageX, stageY, stageZ, () => {
        isOnStage = true;
        myAvatar.rotation.y = Math.PI; // 観客側を向く
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
        originalPosition = null;
        debugLog('フロアに戻りました', 'info');
    });
}

function moveRemoteToStage(odUserId) {
    const avatar = remoteAvatars.get(odUserId);
    if (!avatar) return;
    
    const stageX = (Math.random() - 0.5) * 8;
    animateToPosition(avatar, stageX, 1.7, -4, () => {
        avatar.rotation.y = Math.PI;
    });
}

function moveRemoteToAudience(odUserId) {
    const avatar = remoteAvatars.get(odUserId);
    if (!avatar) return;
    
    const targetX = (Math.random() - 0.5) * 8;
    const targetZ = 5 + Math.random() * 3;
    
    animateToPosition(avatar, targetX, 0.5, targetZ, () => {
        avatar.rotation.y = 0;
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
// 音声通話機能
// --------------------------------------------
async function requestSpeak() {
    if (isSpeaker) {
        stopSpeaking();
        return;
    }
    socket.send(JSON.stringify({ type: 'requestSpeak' }));
}

function stopSpeaking() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    isSpeaker = false;
    mySessionId = null;
    myPublishedTrackName = null;
    updateSpeakerButton();
    moveOffStage();
    
    socket.send(JSON.stringify({ type: 'stopSpeak' }));
    addChatMessage('システム', '登壇を終了しました');
}

async function startPublishing() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }, 
            video: false 
        });
        
        audioUnlocked = true;
        const unlockBtn = document.getElementById('audio-unlock-btn');
        if (unlockBtn) unlockBtn.remove();
        
        setTimeout(resumeAllAudio, 100);
        
        peerConnection = new RTCPeerConnection({
            iceServers: getIceServers(),
            bundlePolicy: 'max-bundle'
        });
        
        const audioTrack = localStream.getAudioTracks()[0];
        if (!audioTrack) throw new Error('No audio track');
        
        const transceiver = peerConnection.addTransceiver(audioTrack, { direction: 'sendonly' });
        
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        let mid = transceiver.mid;
        if (!mid) {
            const sdp = peerConnection.localDescription?.sdp || '';
            const midMatch = sdp.match(/a=mid:(\S+)/);
            mid = midMatch ? midMatch[1] : "0";
        }
        
        const trackName = `audio-${myServerConnectionId}`;
        myPublishedTrackName = trackName;
        
        socket.send(JSON.stringify({
            type: 'publishTrack',
            sessionId: mySessionId,
            offer: { sdp: peerConnection.localDescription.sdp, type: 'offer' },
            tracks: [{ location: 'local', mid: mid, trackName: trackName }]
        }));
        
    } catch (error) {
        debugLog(`publishエラー: ${error.message}`, 'error');
        addChatMessage('システム', 'マイクにアクセスできませんでした');
        stopSpeaking();
    }
}

async function handleTrackPublished(data) {
    if (!peerConnection || !data.answer) return;
    
    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        addChatMessage('システム', '音声配信を開始しました');
        setTimeout(resumeAllAudio, 100);
    } catch (e) {
        debugLog(`setRemoteDescriptionエラー: ${e.message}`, 'error');
    }
}

async function subscribeToTrack(odUserId, remoteSessionId, trackName) {
    if (odUserId === myServerConnectionId) return;
    if (trackName === myPublishedTrackName) return;
    if (subscribedTracks.has(trackName)) return;
    if (pendingSubscriptions.has(trackName)) return;
    
    pendingSubscriptions.set(trackName, { odUserId, remoteSessionId });
    
    socket.send(JSON.stringify({
        type: 'subscribeTrack',
        visitorId: odUserId,
        remoteSessionId: remoteSessionId,
        trackName: trackName
    }));
}

async function handleSubscribed(data) {
    if (!data.offer) return;
    
    const trackName = data.trackName;
    const pendingInfo = pendingSubscriptions.get(trackName);
    if (!pendingInfo) return;
    
    try {
        const pc = new RTCPeerConnection({
            iceServers: getIceServers(),
            bundlePolicy: 'max-bundle'
        });
        
        pc.ontrack = (event) => {
            const audio = new Audio();
            audio.srcObject = event.streams[0] || new MediaStream([event.track]);
            audio.autoplay = true;
            
            audio.play().catch(e => {
                if (isIOS()) showAudioUnlockButton();
            });
            
            const trackInfo = subscribedTracks.get(trackName);
            if (trackInfo) {
                trackInfo.audio = audio;
                const avatar = remoteAvatars.get(trackInfo.odUserId);
                if (avatar) addSpeakerIndicator(avatar);
            }
        };
        
        let offerSdp = typeof data.offer === 'string' ? data.offer : data.offer.sdp;
        
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offerSdp }));
        
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        await new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') { resolve(); return; }
            const timeout = setTimeout(resolve, 200);
            pc.onicecandidate = (e) => { if (!e.candidate) { clearTimeout(timeout); resolve(); } };
        });
        
        socket.send(JSON.stringify({
            type: 'subscribeAnswer',
            sessionId: data.sessionId,
            answer: { type: 'answer', sdp: pc.localDescription.sdp }
        }));
        
        pendingSubscriptions.delete(trackName);
        subscribedTracks.set(trackName, { odUserId: pendingInfo.odUserId, audio: null, pc: pc, sessionId: data.sessionId });
        
    } catch (e) {
        debugLog(`handleSubscribedエラー: ${e.message}`, 'error');
        pendingSubscriptions.delete(trackName);
    }
}

function removeRemoteAudio(odUserId) {
    for (const [trackName, obj] of subscribedTracks) {
        if (obj.odUserId === odUserId) {
            if (obj.audio) { obj.audio.pause(); obj.audio.srcObject = null; }
            if (obj.pc) { try { obj.pc.close(); } catch(e) {} }
            subscribedTracks.delete(trackName);
        }
    }
    for (const [trackName, obj] of pendingSubscriptions) {
        if (obj.odUserId === odUserId) pendingSubscriptions.delete(trackName);
    }
}

function updateSpeakerList(speakers) {
    const speakersArray = Array.isArray(speakers) ? speakers : [];
    speakerCount = speakersArray.length;
    updateSpeakerButton();
    
    remoteAvatars.forEach((avatar, odUserId) => {
        if (speakersArray.includes(odUserId)) {
            addSpeakerIndicator(avatar);
        } else {
            removeSpeakerIndicator(avatar);
        }
    });
}

function updateSpeakerButton() {
    const btn = document.getElementById('request-stage-btn');
    if (btn) {
        if (isSpeaker) {
            btn.textContent = `🎤 登壇中 (${speakerCount}/5)`;
            btn.style.background = '#51cf66';
        } else {
            btn.textContent = `🎤 登壇リクエスト (${speakerCount}/5)`;
            btn.style.background = '';
        }
    }
}

function addSpeakerIndicator(avatar) {
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

function removeSpeakerIndicator(avatar) {
    const indicator = avatar.getObjectByName('speakerIndicator');
    if (indicator) avatar.remove(indicator);
}

function updateMicButton(isSpeaking) {
    const btn = document.getElementById('mic-toggle-btn');
    if (btn) {
        btn.textContent = isSpeaking ? '🎙️ 配信中' : '🎙️ マイク OFF';
        btn.classList.toggle('speaking', isSpeaking);
    }
}

// --------------------------------------------
// リモートアバター管理
// --------------------------------------------
function createRemoteAvatar(user) {
    if (remoteAvatars.has(user.id)) return;
    const avatar = createAvatar(user.id, user.name, user.color || 0xff6b6b);
    avatar.position.set(user.x || 0, 0.5, user.z || 5);
    scene.add(avatar);
    remoteAvatars.set(user.id, avatar);
}

function removeRemoteAvatar(odUserId) {
    const avatar = remoteAvatars.get(odUserId);
    if (avatar) {
        scene.remove(avatar);
        remoteAvatars.delete(odUserId);
    }
}

function updateRemoteAvatarPosition(odUserId, x, y, z) {
    const avatar = remoteAvatars.get(odUserId);
    if (avatar) {
        avatar.position.x += (x - avatar.position.x) * 0.3;
        avatar.position.z += (z - avatar.position.z) * 0.3;
    }
}

function playRemoteReaction(odUserId, reaction, color) {
    const avatar = remoteAvatars.get(odUserId);
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
    const el = document.getElementById('user-count');
    if (el) el.textContent = `${count}人`;
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
        socket.send(JSON.stringify({ type: 'reaction', reaction: reaction, color: color }));
    }
}

function sendChat(message) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'chat', name: myUserName, message: message }));
    }
}

// --------------------------------------------
// Three.js 初期化
// --------------------------------------------
function init() {
    createDebugUI();
    debugLog('Three.js初期化開始');
    
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0f);
    scene.fog = new THREE.Fog(0x0a0a0f, 20, 50);

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

    const ambientLight = new THREE.AmbientLight(0x111122, 0.3);
    scene.add(ambientLight);

    createZeppFloor();
    createZeppStage();
    createTruss();
    createMovingLights();
    createBarrier();
    createSideSpeakers();

    myAvatar = createAvatar(myUserId, myUserName, 0x4fc3f7);
    myAvatar.position.set((Math.random() - 0.5) * 8, 0.5, 5 + Math.random() * 3);
    scene.add(myAvatar);

    myPenlight = createPenlight(penlightColor);
    myPenlight.visible = false;
    myAvatar.add(myPenlight);

    setupEventListeners();
    connectToPartyKit();
    setInterval(sendPosition, 100);

    animate();
    debugLog('初期化完了', 'success');
}

// --------------------------------------------
// Zepp風フロア
// --------------------------------------------
function createZeppFloor() {
    const floorGeometry = new THREE.PlaneGeometry(40, 30);
    const floorMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x0a0a0a, roughness: 0.2, metalness: 0.8
    });
    floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    [-8, -4, 0, 4, 8].forEach((x, i) => {
        const lineGeometry = new THREE.PlaneGeometry(0.05, 25);
        const lineMaterial = new THREE.MeshBasicMaterial({ 
            color: i % 2 === 0 ? 0xff00ff : 0x00ffff, transparent: true, opacity: 0.3
        });
        const line = new THREE.Mesh(lineGeometry, lineMaterial);
        line.rotation.x = -Math.PI / 2;
        line.position.set(x, 0.01, 2);
        scene.add(line);
    });
}

// --------------------------------------------
// Zepp風ステージ（モザイク修正版）
// --------------------------------------------
function createZeppStage() {
    const stageGeometry = new THREE.BoxGeometry(16, 1.2, 6);
    const stageMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x1a1a1a, roughness: 0.3, metalness: 0.5
    });
    stage = new THREE.Mesh(stageGeometry, stageMaterial);
    stage.position.set(0, 0.6, -6);
    stage.castShadow = true;
    stage.receiveShadow = true;
    scene.add(stage);

    const edgeMaterial = new THREE.MeshBasicMaterial({ color: 0xff00ff });
    const stageEdge = new THREE.Mesh(new THREE.BoxGeometry(16, 0.1, 0.1), edgeMaterial);
    stageEdge.position.set(0, 1.25, -3.05);
    scene.add(stageEdge);

    const underLight = new THREE.Mesh(
        new THREE.PlaneGeometry(14, 0.5),
        new THREE.MeshBasicMaterial({ color: 0xff00ff, transparent: true, opacity: 0.5 })
    );
    underLight.rotation.x = -Math.PI / 2;
    underLight.position.set(0, 0.02, -3.2);
    scene.add(underLight);

    // LEDスクリーン（サイズ調整・位置をステージ後方に）
    const screenGeometry = new THREE.PlaneGeometry(14, 6);
    const screenMaterial = new THREE.MeshBasicMaterial({ color: 0x330066, side: THREE.DoubleSide });
    ledScreen = new THREE.Mesh(screenGeometry, screenMaterial);
    ledScreen.position.set(0, 4, -8.5);
    scene.add(ledScreen);
    
    // 背景画像を非同期ロード（モザイク修正版）
    const loader = new THREE.TextureLoader();
    loader.load(stageBackgroundUrl, function(texture) {
        // モザイク防止のためのテクスチャ設定
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        
        ledScreen.material.dispose();
        ledScreen.material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
        debugLog('背景画像ロード成功', 'success');
    }, undefined, function(err) {
        debugLog('背景画像ロード失敗: ' + err, 'warn');
    });

    // フレーム（LEDスクリーンの後ろ）
    const frame = new THREE.Mesh(
        new THREE.BoxGeometry(14.4, 6.4, 0.2),
        new THREE.MeshStandardMaterial({ color: 0x111111 })
    );
    frame.position.set(0, 4, -8.6);
    scene.add(frame);
}

function changeStageBackground(imageUrl) {
    stageBackgroundUrl = imageUrl;
    const loader = new THREE.TextureLoader();
    loader.load(imageUrl, function(texture) {
        // モザイク防止のためのテクスチャ設定
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        
        if (ledScreen) {
            ledScreen.material.dispose();
            ledScreen.material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
            debugLog('背景変更成功', 'success');
        }
    }, undefined, function(err) {
        debugLog('背景変更失敗: ' + err, 'warn');
    });
}
window.changeStageBackground = changeStageBackground;

// --------------------------------------------
// トラス
// --------------------------------------------
function createTruss() {
    const trussMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x222222, roughness: 0.5, metalness: 0.8
    });

    const mainTruss = new THREE.Mesh(new THREE.BoxGeometry(18, 0.3, 0.3), trussMaterial);
    mainTruss.position.set(0, 8, -5);
    scene.add(mainTruss);

    const frontTruss = new THREE.Mesh(new THREE.BoxGeometry(18, 0.3, 0.3), trussMaterial);
    frontTruss.position.set(0, 7, 0);
    scene.add(frontTruss);

    [-9, 9].forEach(x => {
        const sideTruss = new THREE.Mesh(new THREE.BoxGeometry(0.3, 8, 0.3), trussMaterial);
        sideTruss.position.set(x, 4, -5);
        scene.add(sideTruss);
    });
}

// --------------------------------------------
// ムービングライト
// --------------------------------------------
function createMovingLights() {
    const colors = [0x9900ff, 0xff00ff, 0x00ffff, 0xff00ff, 0x9900ff];
    [-6, -3, 0, 3, 6].forEach((x, i) => {
        const body = new THREE.Mesh(
            new THREE.CylinderGeometry(0.2, 0.3, 0.5, 8),
            new THREE.MeshStandardMaterial({ color: 0x111111 })
        );
        body.position.set(x, 7.7, -5);
        scene.add(body);

        const spotLight = new THREE.SpotLight(colors[i], 2, 20, Math.PI / 6, 0.5, 1);
        spotLight.position.set(x, 7.5, -5);
        spotLight.target.position.set(x, 0, 2);
        spotLight.castShadow = true;
        scene.add(spotLight);
        scene.add(spotLight.target);

        const cone = new THREE.Mesh(
            new THREE.ConeGeometry(0.15, 0.4, 8),
            new THREE.MeshBasicMaterial({ color: colors[i], transparent: true, opacity: 0.8 })
        );
        cone.position.set(x, 7.3, -5);
        cone.rotation.x = Math.PI;
        scene.add(cone);

        movingLights.push({ light: spotLight, baseX: x, phase: i * 0.5 });
    });

    [-4, 0, 4].forEach((x, i) => {
        const spotLight = new THREE.SpotLight([0x00ffff, 0xff00ff, 0x00ffff][i], 1.5, 15, Math.PI / 8, 0.5, 1);
        spotLight.position.set(x, 6.8, 0);
        spotLight.target.position.set(x, 0, 5);
        scene.add(spotLight);
        scene.add(spotLight.target);
    });
}

// --------------------------------------------
// バリケード
// --------------------------------------------
function createBarrier() {
    const mat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.5, metalness: 0.7 });
    for (let x = -7; x <= 7; x += 2) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 8), mat);
        post.position.set(x, 0.5, -2);
        scene.add(post);
        if (x < 7) {
            const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2, 8), mat);
            rail.rotation.z = Math.PI / 2;
            rail.position.set(x + 1, 0.8, -2);
            scene.add(rail);
        }
    }
}

// --------------------------------------------
// サイドスピーカー
// --------------------------------------------
function createSideSpeakers() {
    const mat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.3 });
    [-7.5, 7.5].forEach(x => {
        const speaker = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.5, 1), mat);
        speaker.position.set(x, 2.5, -4);
        scene.add(speaker);

        const grill = new THREE.Mesh(
            new THREE.PlaneGeometry(1.3, 2.3),
            new THREE.MeshBasicMaterial({ color: 0x0a0a0a, side: THREE.DoubleSide })
        );
        grill.position.set(x, 2.5, -3.49);
        scene.add(grill);

        const sub = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.2, 1.2), mat);
        sub.position.set(x, 0.6, -4);
        scene.add(sub);
    });
}

// --------------------------------------------
// アバター作成
// --------------------------------------------
function createAvatar(odUserId, userName, color) {
    const group = new THREE.Group();
    group.userData = { odUserId, userName };

    const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.35, 1, 8),
        new THREE.MeshStandardMaterial({ color })
    );
    body.position.y = 0.5;
    body.castShadow = true;
    group.add(body);

    const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.25, 8, 8),
        new THREE.MeshStandardMaterial({ color })
    );
    head.position.y = 1.2;
    head.castShadow = true;
    group.add(head);

    return group;
}

function createPenlight(color) {
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

function setPenlightColor(color) {
    penlightColor = color;
    const light = myPenlight.getObjectByName('penlightLight');
    if (light) light.material.color.set(color);
    const pointLight = myPenlight.getObjectByName('penlightPointLight');
    if (pointLight) pointLight.color.set(color);
}

function wavePenlight() {
    if (!penlightOn) return;
    const startRotation = myPenlight.rotation.z;
    let progress = 0;
    function swing() {
        progress += 0.15;
        if (progress <= Math.PI) {
            myPenlight.rotation.z = startRotation + Math.sin(progress) * 0.3;
            requestAnimationFrame(swing);
        } else {
            myPenlight.rotation.z = startRotation;
        }
    }
    swing();
}

function doJump() {
    const startY = myAvatar.position.y;
    let progress = 0;
    function jump() {
        progress += 0.1;
        if (progress <= Math.PI) {
            myAvatar.position.y = startY + Math.sin(progress) * 1;
            requestAnimationFrame(jump);
        } else {
            myAvatar.position.y = startY;
        }
    }
    jump();
    sendReaction('jump', null);
}

function doOtagei() {
    let progress = 0;
    function otagei() {
        progress += 0.12;
        if (progress <= Math.PI * 2) {
            myAvatar.rotation.z = Math.sin(progress * 3) * 0.2;
            if (myPenlight.visible) {
                myPenlight.rotation.z = Math.PI / 6 + Math.sin(progress * 5) * 0.5;
            }
            requestAnimationFrame(otagei);
        } else {
            myAvatar.rotation.z = 0;
            myPenlight.rotation.z = Math.PI / 6;
        }
    }
    otagei();
    sendReaction('otagei', penlightColor);
}

function doClap() {
    const originalScale = myAvatar.scale.x;
    let progress = 0;
    function clap() {
        progress += 0.2;
        if (progress <= Math.PI) {
            const scale = originalScale + Math.sin(progress) * 0.1;
            myAvatar.scale.set(scale, scale, scale);
            requestAnimationFrame(clap);
        } else {
            myAvatar.scale.set(originalScale, originalScale, originalScale);
        }
    }
    clap();
    sendReaction('clap', null);
}

function setupEventListeners() {
    window.addEventListener('resize', onWindowResize);

    document.querySelectorAll('.reaction-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const type = btn.dataset.type;
            if (type === 'penlight') {
                penlightOn = !penlightOn;
                myPenlight.visible = penlightOn;
                const colorPanel = document.getElementById('penlight-colors');
                if (colorPanel) colorPanel.classList.toggle('hidden', !penlightOn);
                if (penlightOn) { wavePenlight(); sendReaction('penlight', penlightColor); }
            } else if (type === 'jump') {
                doJump();
            } else if (type === 'clap') {
                doClap();
            } else if (type === 'otagei') {
                doOtagei();
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

    const chatForm = document.getElementById('chat-form');
    if (chatForm) {
        chatForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const input = document.getElementById('chat-input');
            const message = input.value.trim();
            if (message) {
                addChatMessage(myUserName, message);
                sendChat(message);
                input.value = '';
            }
        });
    }

    const stageBtn = document.getElementById('request-stage-btn');
    if (stageBtn) {
        stageBtn.addEventListener('click', () => requestSpeak());
    }

    const micBtn = document.getElementById('mic-toggle-btn');
    if (micBtn) {
        micBtn.addEventListener('click', () => {
            if (isSpeaker && localStream) {
                const audioTrack = localStream.getAudioTracks()[0];
                if (audioTrack) {
                    audioTrack.enabled = !audioTrack.enabled;
                    updateMicButton(audioTrack.enabled);
                }
            }
        });
    }

    let touchStartX, touchStartY;
    renderer.domElement.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    });

    renderer.domElement.addEventListener('touchmove', (e) => {
        if (!touchStartX || !touchStartY) return;
        
        if (isOnStage) {
            // ステージ上では左右移動のみ
            const deltaX = (e.touches[0].clientX - touchStartX) * 0.02;
            myAvatar.position.x += deltaX;
            myAvatar.position.x = Math.max(-6, Math.min(6, myAvatar.position.x));
        } else {
            const deltaX = (e.touches[0].clientX - touchStartX) * 0.01;
            const deltaZ = (e.touches[0].clientY - touchStartY) * 0.01;
            myAvatar.position.x += deltaX;
            myAvatar.position.z += deltaZ;
            myAvatar.position.x = Math.max(-14, Math.min(14, myAvatar.position.x));
            myAvatar.position.z = Math.max(-1, Math.min(12, myAvatar.position.z));
        }
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    });

    renderer.domElement.addEventListener('touchend', () => {
        touchStartX = null;
        touchStartY = null;
    });
}

function addChatMessage(name, message) {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'chat-message';
    div.innerHTML = `<span class="name">${name}</span>${message}`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    while (container.children.length > 20) container.removeChild(container.firstChild);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animateMovingLights() {
    lightTime += 0.02;
    movingLights.forEach((ml) => {
        const swingX = Math.sin(lightTime + ml.phase) * 3;
        const swingZ = Math.cos(lightTime * 0.7 + ml.phase) * 2;
        ml.light.target.position.set(ml.baseX + swingX, 0, 2 + swingZ);
    });
}

function animate() {
    requestAnimationFrame(animate);
    animateMovingLights();
    
    if (myAvatar) {
        if (isOnStage) {
            // ステージ上：カメラはアバターの後ろから客席を見る
            camera.position.x += (myAvatar.position.x * 0.5 - camera.position.x) * 0.05;
            camera.position.y += (3.5 - camera.position.y) * 0.05;
            camera.position.z += (-2 - camera.position.z) * 0.05; // アバターより少し手前
            camera.lookAt(myAvatar.position.x * 0.3, 1.5, 10); // 客席方向を見る
        } else {
            // フロア：通常のカメラ追従
            camera.position.x += (myAvatar.position.x * 0.3 - camera.position.x) * 0.05;
            camera.position.z += (myAvatar.position.z + 8 - camera.position.z) * 0.05;
            camera.position.y += (5 - camera.position.y) * 0.05;
            camera.lookAt(myAvatar.position.x * 0.5, 2, myAvatar.position.z - 5);
        }
    }
    renderer.render(scene, camera);
}

init();
