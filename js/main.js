// ============================================
// メタバース空間 - メインスクリプト
// PartyKit + Cloudflare Calls 対応版
// デバッグコンソール付き
// ============================================

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

window.onerror = (msg, url, line) => {
    debugLog(`JS ERROR: ${msg} (line ${line})`, 'error');
};
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
const remoteAudios = new Map();
let speakerCount = 0;

// TURN認証情報（サーバーから取得）
let turnCredentials = null;

// --------------------------------------------
// 初期設定
// --------------------------------------------
let scene, camera, renderer;
let stage, floor;
let myAvatar;
let myPenlight;
let penlightOn = false;
let penlightColor = '#ff00ff';

const myUserId = 'user-' + Math.random().toString(36).substr(2, 9);
const myUserName = 'ゲスト' + Math.floor(Math.random() * 1000);

// --------------------------------------------
// ICE サーバー設定を取得
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
// 全ての音声を再開
// --------------------------------------------
function resumeAllAudio() {
    debugLog('全音声再開処理', 'info');
    remoteAudios.forEach((obj, odUserId) => {
        if (obj.audio) {
            obj.audio.play()
                .then(() => debugLog(`音声再開: ${odUserId}`, 'success'))
                .catch(e => debugLog(`音声再開失敗: ${odUserId}`, 'warn'));
        }
    });
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
                            debugLog(`自分のトラックはスキップ: ${trackName}`);
                            return;
                        }
                        const speakerSessionId = sessionsMap.get(odUserId);
                        if (speakerSessionId) {
                            debugLog(`既存トラック購読: ${odUserId}`);
                            subscribeToTrack(odUserId, speakerSessionId, trackName);
                        }
                    });
                }, 1000);
            }
            break;
            
        case 'userJoin':
            debugLog(`参加: ${data.user.id}`);
            if (data.user.id !== myServerConnectionId) {
                createRemoteAvatar(data.user);
                addChatMessage('システム', `${data.user.name || '誰か'}が入室しました`);
            }
            updateUserCount();
            break;
            
        case 'userLeave':
            const leaveUserId = data.odUserId || data.userId;
            debugLog(`退出: ${leaveUserId}`);
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
            debugLog(`登壇承認！sessionId: ${data.sessionId}`, 'success');
            mySessionId = data.sessionId;
            isSpeaker = true;
            speakerCount++;
            updateSpeakerButton();
            startPublishing();
            addChatMessage('システム', '登壇が承認されました！');
            break;

        case 'speakDenied':
            debugLog(`登壇拒否: ${data.reason}`, 'warn');
            addChatMessage('システム', data.reason);
            break;

        case 'speakerJoined':
            const joinedUserId = data.odUserId || data.userId;
            debugLog(`登壇者追加: ${joinedUserId}`);
            if (data.speakers) {
                updateSpeakerList(data.speakers);
            }
            addChatMessage('システム', '新しい登壇者が参加しました');
            break;

        case 'speakerLeft':
            const leftUserId = data.odUserId || data.userId;
            debugLog(`登壇者退出: ${leftUserId}`);
            if (data.speakers) {
                updateSpeakerList(data.speakers);
            }
            removeRemoteAudio(leftUserId);
            break;

        case 'trackPublished':
            debugLog(`トラック公開成功！`, 'success');
            handleTrackPublished(data);
            break;

        case 'newTrack':
            const trackUserId = data.odUserId || data.userId;
            const newTrackName = data.trackName;
            debugLog(`新トラック: ${trackUserId} - ${newTrackName}`);
            
            if (trackUserId === myServerConnectionId) {
                debugLog(`自分のトラックなのでスキップ`);
                return;
            }
            
            if (myPublishedTrackName && newTrackName === myPublishedTrackName) {
                debugLog(`自分が公開したトラック名なのでスキップ`);
                return;
            }
            
            setTimeout(() => {
                subscribeToTrack(trackUserId, data.sessionId, newTrackName);
            }, 500);
            break;

        case 'subscribed':
            debugLog(`購読レスポンス受信: ${data.trackName}`);
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
// 音声通話機能
// --------------------------------------------
async function requestSpeak() {
    if (isSpeaker) {
        debugLog('登壇終了');
        stopSpeaking();
        return;
    }
    
    debugLog('登壇リクエスト送信');
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
    
    socket.send(JSON.stringify({ type: 'stopSpeak' }));
    addChatMessage('システム', '登壇を終了しました');
}

async function startPublishing() {
    debugLog('=== startPublishing 開始 ===', 'info');
    
    try {
        debugLog('Step1: マイク取得中...', 'info');
        localStream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }, 
            video: false 
        });
        debugLog('Step1: マイク取得成功！', 'success');
        
        // マイク許可後、他の音声を再開
        resumeAllAudio();
        
        debugLog('Step2: PeerConnection作成中...', 'info');
        peerConnection = new RTCPeerConnection({
            iceServers: getIceServers(),
            bundlePolicy: 'max-bundle'
        });
        
        peerConnection.oniceconnectionstatechange = () => {
            debugLog(`ICE状態: ${peerConnection.iceConnectionState}`);
        };
        
        peerConnection.onconnectionstatechange = () => {
            debugLog(`接続状態: ${peerConnection.connectionState}`);
        };
        debugLog('Step2: PeerConnection作成完了', 'success');
        
        debugLog('Step3: トラック追加中...', 'info');
        const audioTrack = localStream.getAudioTracks()[0];
        if (!audioTrack) {
            throw new Error('CLIENT_ERR_NO_AUDIO_TRACK');
        }
        debugLog(`Step3: トラック: ${audioTrack.kind}`, 'info');
        
        const transceiver = peerConnection.addTransceiver(audioTrack, { 
            direction: 'sendonly' 
        });
        debugLog('Step3: トラック追加完了', 'success');
        
        debugLog('Step4: Offer作成中...', 'info');
        const offer = await peerConnection.createOffer();
        if (!offer || !offer.sdp) {
            throw new Error('CLIENT_ERR_NO_OFFER');
        }
        debugLog('Step4: Offer作成完了', 'success');
        
        debugLog('Step5: setLocalDescription中...', 'info');
        await peerConnection.setLocalDescription(offer);
        debugLog('Step5: setLocalDescription完了', 'success');
        
        debugLog('Step6: mid取得中...', 'info');
        let mid = transceiver.mid;
        if (!mid) {
            const sdp = peerConnection.localDescription?.sdp || '';
            const midMatch = sdp.match(/a=mid:(\S+)/);
            mid = midMatch ? midMatch[1] : "0";
            debugLog(`Step6: SDP から mid 抽出: "${mid}"`, 'warn');
        }
        debugLog(`Step6: mid="${mid}"`, 'success');
        
        const trackName = `audio-${myServerConnectionId}`;
        myPublishedTrackName = trackName;
        
        const tracks = [{
            location: 'local',
            mid: mid,
            trackName: trackName
        }];
        
        if (!mySessionId) {
            throw new Error('CLIENT_ERR_NO_SESSION_ID');
        }
        
        debugLog('Step7: publishTrack送信中...', 'info');
        debugLog(`trackName: ${trackName}`, 'info');
        socket.send(JSON.stringify({
            type: 'publishTrack',
            sessionId: mySessionId,
            offer: { 
                sdp: peerConnection.localDescription.sdp, 
                type: 'offer' 
            },
            tracks: tracks
        }));
        debugLog('Step7: publishTrack送信完了！', 'success');
        
    } catch (error) {
        debugLog(`publishエラー: ${error.message}`, 'error');
        addChatMessage('システム', 'マイクにアクセスできませんでした');
        stopSpeaking();
    }
}

async function handleTrackPublished(data) {
    debugLog('=== handleTrackPublished 開始 ===', 'info');
    
    if (!peerConnection) {
        debugLog('エラー: peerConnectionがない', 'error');
        return;
    }
    
    if (!data.answer) {
        debugLog('エラー: answerがない', 'error');
        return;
    }
    
    try {
        await peerConnection.setRemoteDescription(
            new RTCSessionDescription(data.answer)
        );
        debugLog('setRemoteDescription成功！', 'success');
        addChatMessage('システム', '音声配信を開始しました');
    } catch (e) {
        debugLog(`setRemoteDescriptionエラー: ${e.message}`, 'error');
    }
}

// --------------------------------------------
// トラック購読（リスナー用）
// --------------------------------------------
async function subscribeToTrack(odUserId, remoteSessionId, trackName) {
    if (odUserId === myServerConnectionId) {
        debugLog(`自分(${myServerConnectionId})のトラックはスキップ`);
        return;
    }
    
    if (trackName === myPublishedTrackName) {
        debugLog(`自分のトラック名(${myPublishedTrackName})はスキップ`);
        return;
    }
    
    const existing = remoteAudios.get(odUserId);
    if (existing && existing.pc && existing.pc.connectionState !== 'failed' && existing.pc.connectionState !== 'closed') {
        debugLog(`既に購読中: ${odUserId}`);
        return;
    }
    
    if (existing) {
        removeRemoteAudio(odUserId);
    }
    
    debugLog(`=== subscribeToTrack 開始: ${odUserId} ===`, 'info');
    debugLog(`remoteSessionId: ${remoteSessionId}, trackName: ${trackName}`, 'info');
    
    const pc = new RTCPeerConnection({
        iceServers: getIceServers(),
        bundlePolicy: 'max-bundle'
    });
    
    pc.addTransceiver('audio', { direction: 'recvonly' });
    debugLog('recvonly transceiver 追加', 'info');
    
    pc.ontrack = (event) => {
        debugLog(`ontrack発火！: ${odUserId}`, 'success');
        const audio = new Audio();
        audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        audio.autoplay = true;
        audio.play()
            .then(() => debugLog(`再生開始: ${odUserId}`, 'success'))
            .catch(e => {
                debugLog(`再生待機（タップで再生）: ${e.message}`, 'warn');
                document.addEventListener('click', function playOnClick() {
                    audio.play().then(() => debugLog(`タップ後再生: ${odUserId}`, 'success'));
                    document.removeEventListener('click', playOnClick);
                }, { once: true });
            });
        
        const obj = remoteAudios.get(odUserId);
        if (obj) {
            obj.audio = audio;
        }
        
        const avatar = remoteAvatars.get(odUserId);
        if (avatar) {
            addSpeakerIndicator(avatar);
        }
    };
    
    pc.oniceconnectionstatechange = () => {
        debugLog(`[${odUserId}] ICE: ${pc.iceConnectionState}`);
        
        if (pc.iceConnectionState === 'failed') {
            debugLog(`[${odUserId}] ICE再接続試行...`, 'warn');
            pc.restartIce();
        }
    };
    
    pc.onconnectionstatechange = () => {
        debugLog(`[${odUserId}] 接続: ${pc.connectionState}`);
    };
    
    remoteAudios.set(odUserId, { 
        pc: pc, 
        audio: null,
        visitorId: odUserId,
        trackName: trackName,
        remoteSessionId: remoteSessionId
    });
    
    socket.send(JSON.stringify({
        type: 'subscribeTrack',
        visitorId: odUserId,
        remoteSessionId: remoteSessionId,
        trackName: trackName
    }));
    debugLog('subscribeTrack送信', 'info');
}

async function handleSubscribed(data) {
    debugLog('=== handleSubscribed 開始 ===', 'info');
    
    if (!data.offer) {
        debugLog('Offerがない！', 'error');
        return;
    }
    
    let targetUserId = null;
    let targetObj = null;
    
    for (const [odUserId, obj] of remoteAudios) {
        if (obj.trackName === data.trackName) {
            targetUserId = odUserId;
            targetObj = obj;
            break;
        }
    }
    
    if (!targetObj || !targetObj.pc) {
        debugLog(`対応するPCが見つからない: ${data.trackName}`, 'error');
        return;
    }
    
    debugLog(`${targetUserId}のPC処理`, 'info');
    
    const pc = targetObj.pc;
    
    try {
        debugLog('Offer受信、Answer作成開始', 'info');
        debugLog(`Offer SDP length: ${data.offer.sdp?.length || 0}`, 'info');
        
        await pc.setRemoteDescription(
            new RTCSessionDescription({
                type: 'offer',
                sdp: data.offer.sdp
            })
        );
        debugLog('setRemoteDescription成功', 'success');
        
        const answer = await pc.createAnswer();
        debugLog('createAnswer成功', 'success');
        
        await pc.setLocalDescription(answer);
        debugLog('setLocalDescription成功', 'success');
        
        await new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') {
                resolve();
                return;
            }
            
            const timeout = setTimeout(() => {
                debugLog('ICE収集タイムアウト（続行）', 'warn');
                resolve();
            }, 2000);
            
            pc.onicegatheringstatechange = () => {
                if (pc.iceGatheringState === 'complete') {
                    clearTimeout(timeout);
                    resolve();
                }
            };
            
            pc.onicecandidate = (event) => {
                if (event.candidate === null) {
                    clearTimeout(timeout);
                    resolve();
                }
            };
        });
        
        debugLog('ICE収集完了', 'success');
        
        const finalSdp = pc.localDescription?.sdp || answer.sdp;
        debugLog(`Answer SDP length: ${finalSdp?.length || 0}`, 'info');
        
        socket.send(JSON.stringify({
            type: 'subscribeAnswer',
            sessionId: data.sessionId,
            answer: { 
                type: 'answer', 
                sdp: finalSdp
            }
        }));
        debugLog('subscribeAnswer送信', 'success');
        
    } catch (e) {
        debugLog(`handleSubscribedエラー: ${e.message}`, 'error');
    }
}

function removeRemoteAudio(odUserId) {
    const obj = remoteAudios.get(odUserId);
    if (obj) {
        if (obj.audio) {
            obj.audio.pause();
            obj.audio.srcObject = null;
        }
        if (obj.pc) {
            obj.pc.close();
        }
        remoteAudios.delete(odUserId);
        debugLog(`音声削除: ${odUserId}`);
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
    if (indicator) {
        avatar.remove(indicator);
    }
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
    if (el) {
        el.textContent = `${count}人`;
    }
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
            name: myUserName,
            message: message
        }));
    }
}

// --------------------------------------------
// Three.js 初期化
// --------------------------------------------
function init() {
    createDebugUI();
    debugLog('Three.js初期化開始');
    
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
    
    debugLog('PartyKit接続開始');
    connectToPartyKit();
    
    setInterval(sendPosition, 100);

    animate();
    debugLog('初期化完了', 'success');
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
function createAvatar(odUserId, userName, color) {
    const group = new THREE.Group();
    group.userData = { odUserId: odUserId, userName: userName };

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
                    const colorPanel = document.getElementById('penlight-colors');
                    if (colorPanel) {
                        colorPanel.classList.toggle('hidden', !penlightOn);
                    }
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
        stageBtn.addEventListener('click', () => {
            debugLog('登壇ボタンクリック');
            requestSpeak();
        });
    }

    const micBtn = document.getElementById('mic-toggle-btn');
    if (micBtn) {
        micBtn.addEventListener('click', () => {
            if (isSpeaker && localStream) {
                const audioTrack = localStream.getAudioTracks()[0];
                if (audioTrack) {
                    audioTrack.enabled = !audioTrack.enabled;
                    updateMicButton(audioTrack.enabled);
                    debugLog(`マイク: ${audioTrack.enabled ? 'ON' : 'OFF'}`);
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
    if (!container) return;
    
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
    
    if (myAvatar) {
        const targetX = myAvatar.position.x * 0.3;
        const targetZ = myAvatar.position.z + 8;
        camera.position.x += (targetX - camera.position.x) * 0.05;
        camera.position.z += (targetZ - camera.position.z) * 0.05;
        camera.lookAt(myAvatar.position.x * 0.5, 2, myAvatar.position.z - 5);
    }
    
    renderer.render(scene, camera);
}

// --------------------------------------------
// 初期化実行
// --------------------------------------------
init();
