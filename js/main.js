// ============================================
// メタバース空間 - メインスクリプト
// PartyKit + Cloudflare Calls 対応版
// iOS Safari 対応版 - 各トラック個別PeerConnection方式
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

// 購読トラック管理（各トラックごとに個別のPeerConnectionを持つ）
const subscribedTracks = new Map(); // trackName -> { odUserId, audio, pc, sessionId }
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

// Zepp風ライブハウス用
let movingLights = [];
let ledScreen;
let lightTime = 0;

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

// --------------------------------------------
// 全ての音声を再開
// --------------------------------------------
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
    
    if (isIOS()) {
        debugLog('iOS検出: 音声はタップで有効化が必要', 'warn');
    }
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
        
        // 全ての購読をクリーンアップ
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
        
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }, 
                video: false 
            });
            debugLog('Step1: マイク取得成功！', 'success');
            
            audioUnlocked = true;
            const unlockBtn = document.getElementById('audio-unlock-btn');
            if (unlockBtn) unlockBtn.remove();
            
        } catch (micError) {
            debugLog(`マイク取得失敗: ${micError.message}`, 'error');
            addChatMessage('システム', 'マイクにアクセスできませんでした');
            isSpeaker = false;
            mySessionId = null;
            updateSpeakerButton();
            socket.send(JSON.stringify({ type: 'stopSpeak' }));
            return;
        }
        
        setTimeout(resumeAllAudio, 100);
        
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
        
        const transceiver = peerConnection.addTransceiver(audioTrack, { 
            direction: 'sendonly' 
        });
        debugLog('Step3: トラック追加完了', 'success');
        
        debugLog('Step4: Offer作成中...', 'info');
        const offer = await peerConnection.createOffer();
        debugLog('Step4: Offer作成完了', 'success');
        
        debugLog('Step5: setLocalDescription中...', 'info');
        await peerConnection.setLocalDescription(offer);
        debugLog('Step5: setLocalDescription完了', 'success');
        
        let mid = transceiver.mid;
        if (!mid) {
            const sdp = peerConnection.localDescription?.sdp || '';
            const midMatch = sdp.match(/a=mid:(\S+)/);
            mid = midMatch ? midMatch[1] : "0";
        }
        debugLog(`Step6: mid="${mid}"`, 'success');
        
        const trackName = `audio-${myServerConnectionId}`;
        myPublishedTrackName = trackName;
        
        const tracks = [{
            location: 'local',
            mid: mid,
            trackName: trackName
        }];
        
        debugLog('Step7: publishTrack送信中...', 'info');
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
        
        setTimeout(resumeAllAudio, 100);
    } catch (e) {
        debugLog(`setRemoteDescriptionエラー: ${e.message}`, 'error');
    }
}

// --------------------------------------------
// トラック購読（リスナー用）- 各トラック個別PeerConnection方式
// --------------------------------------------
async function subscribeToTrack(odUserId, remoteSessionId, trackName) {
    if (odUserId === myServerConnectionId) {
        return;
    }
    
    if (trackName === myPublishedTrackName) {
        return;
    }
    
    if (subscribedTracks.has(trackName)) {
        debugLog(`既に購読中: ${trackName}`);
        return;
    }
    
    if (pendingSubscriptions.has(trackName)) {
        debugLog(`既に購読リクエスト中: ${trackName}`);
        return;
    }
    
    debugLog(`=== subscribeToTrack 開始: ${trackName} ===`, 'info');
    
    pendingSubscriptions.set(trackName, { odUserId, remoteSessionId });
    
    socket.send(JSON.stringify({
        type: 'subscribeTrack',
        visitorId: odUserId,
        remoteSessionId: remoteSessionId,
        trackName: trackName
    }));
    debugLog('subscribeTrack送信', 'info');
}

// --------------------------------------------
// 購読レスポンス処理（各トラックごとに個別のPeerConnection）
// --------------------------------------------
async function handleSubscribed(data) {
    debugLog('=== handleSubscribed 開始 ===', 'info');
    
    if (!data.offer) {
        debugLog('Offerがない！', 'error');
        return;
    }
    
    const trackName = data.trackName;
    const pendingInfo = pendingSubscriptions.get(trackName);
    
    if (!pendingInfo) {
        debugLog(`対応する購読待ちが見つからない: ${trackName}`, 'error');
        return;
    }
    
    try {
        // このトラック専用のPeerConnectionを作成
        debugLog(`${trackName}用の新しいPeerConnection作成`, 'info');
        
        const pc = new RTCPeerConnection({
            iceServers: getIceServers(),
            bundlePolicy: 'max-bundle'
        });
        
        // ontrackハンドラ（このPC専用）
        pc.ontrack = (event) => {
            debugLog(`ontrack発火！trackName=${trackName}, kind=${event.track.kind}`, 'success');
            
            const audio = new Audio();
            audio.srcObject = event.streams[0] || new MediaStream([event.track]);
            audio.autoplay = true;
            
            audio.play()
                .then(() => {
                    debugLog(`音声再生開始: ${trackName}`, 'success');
                    audioUnlocked = true;
                    const unlockBtn = document.getElementById('audio-unlock-btn');
                    if (unlockBtn) unlockBtn.remove();
                })
                .catch(e => {
                    debugLog(`再生失敗（タップ必要）: ${trackName}: ${e.message}`, 'warn');
                    if (isIOS()) {
                        showAudioUnlockButton();
                    }
                });
            
            // subscribedTracksに音声を保存
            const trackInfo = subscribedTracks.get(trackName);
            if (trackInfo) {
                trackInfo.audio = audio;
                debugLog(`${trackName}に音声を関連付け`, 'success');
                
                const avatar = remoteAvatars.get(trackInfo.odUserId);
                if (avatar) {
                    addSpeakerIndicator(avatar);
                }
            }
        };
        
        pc.oniceconnectionstatechange = () => {
            debugLog(`[${trackName}] ICE: ${pc.iceConnectionState}`);
            if (pc.iceConnectionState === 'failed') {
                debugLog(`[${trackName}] ICE失敗`, 'error');
            }
        };
        
        pc.onconnectionstatechange = () => {
            debugLog(`[${trackName}] 接続: ${pc.connectionState}`);
        };
        
        // Offer SDPを取得
        let offerSdp;
        if (typeof data.offer === 'string') {
            offerSdp = data.offer;
        } else if (data.offer.sdp) {
            offerSdp = data.offer.sdp;
        } else {
            debugLog('Offer SDPが見つからない', 'error');
            pc.close();
            return;
        }
        
        debugLog(`Offer SDP長さ: ${offerSdp.length}`, 'info');
        
        await pc.setRemoteDescription(
            new RTCSessionDescription({
                type: 'offer',
                sdp: offerSdp
            })
        );
        debugLog('setRemoteDescription成功', 'success');
        
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        debugLog('Answer作成完了', 'success');
        
        // ICE収集を待つ（200msに設定）
        await new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') {
                resolve();
                return;
            }
            const timeout = setTimeout(() => {
                debugLog('ICE収集タイムアウト', 'warn');
                resolve();
            }, 200);
            
            const checkComplete = () => {
                if (pc.iceGatheringState === 'complete') {
                    clearTimeout(timeout);
                    resolve();
                }
            };
            
            pc.onicegatheringstatechange = checkComplete;
            pc.onicecandidate = (e) => {
                if (e.candidate === null) {
                    clearTimeout(timeout);
                    resolve();
                }
            };
        });
        debugLog('ICE収集完了', 'success');
        
        const finalSdp = pc.localDescription?.sdp;
        if (!finalSdp) {
            debugLog('localDescription.sdpがない', 'error');
            pc.close();
            return;
        }
        
        socket.send(JSON.stringify({
            type: 'subscribeAnswer',
            sessionId: data.sessionId,
            answer: { 
                type: 'answer', 
                sdp: finalSdp 
            }
        }));
        debugLog('subscribeAnswer送信完了', 'success');
        
        pendingSubscriptions.delete(trackName);
        
        // トラック情報を保存（PCも含む）
        subscribedTracks.set(trackName, { 
            odUserId: pendingInfo.odUserId, 
            audio: null,
            pc: pc,
            sessionId: data.sessionId
        });
        debugLog(`購読登録完了: ${trackName}`, 'success');
        
    } catch (e) {
        debugLog(`handleSubscribedエラー: ${e.message}`, 'error');
        console.error(e);
        pendingSubscriptions.delete(trackName);
    }
}

function removeRemoteAudio(odUserId) {
    for (const [trackName, obj] of subscribedTracks) {
        if (obj.odUserId === odUserId) {
            if (obj.audio) {
                obj.audio.pause();
                obj.audio.srcObject = null;
            }
            if (obj.pc) {
                try { obj.pc.close(); } catch(e) {}
            }
            subscribedTracks.delete(trackName);
            debugLog(`音声削除: ${trackName}`, 'info');
        }
    }
    
    for (const [trackName, obj] of pendingSubscriptions) {
        if (obj.odUserId === odUserId) {
            pendingSubscriptions.delete(trackName);
        }
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
    scene.background = new THREE.Color(0x0a0a0f);
    scene.fog = new THREE.Fog(0x0a0a0f, 20, 50);

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 5, 12);
    camera.lookAt(0, 2, 0);

    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.getElementById('canvas-container').appendChild(renderer.domElement);

    // 環境光（暗め）
    const ambientLight = new THREE.AmbientLight(0x111122, 0.3);
    scene.add(ambientLight);

    // Zepp風のライブハウスを作成
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
    
    debugLog('PartyKit接続開始');
    connectToPartyKit();
    
    setInterval(sendPosition, 100);

    animate();
    debugLog('初期化完了', 'success');
}

// --------------------------------------------
// Zepp風フロア
// --------------------------------------------
function createZeppFloor() {
    // メインフロア（反射する黒い床）
    const floorGeometry = new THREE.PlaneGeometry(40, 30);
    const floorMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x0a0a0a,
        roughness: 0.2,
        metalness: 0.8
    });
    floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // ネオンライン（フロア装飾）
    const linePositions = [-8, -4, 0, 4, 8];
    linePositions.forEach((x, i) => {
        const lineGeometry = new THREE.PlaneGeometry(0.05, 25);
        const lineMaterial = new THREE.MeshBasicMaterial({ 
            color: i % 2 === 0 ? 0xff00ff : 0x00ffff,
            transparent: true,
            opacity: 0.3
        });
        const line = new THREE.Mesh(lineGeometry, lineMaterial);
        line.rotation.x = -Math.PI / 2;
        line.position.set(x, 0.01, 2);
        scene.add(line);
    });
}

// --------------------------------------------
// Zepp風ステージ
// --------------------------------------------
function createZeppStage() {
    // メインステージ（黒）
    const stageGeometry = new THREE.BoxGeometry(16, 1.2, 6);
    const stageMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x1a1a1a,
        roughness: 0.3,
        metalness: 0.5
    });
    stage = new THREE.Mesh(stageGeometry, stageMaterial);
    stage.position.set(0, 0.6, -6);
    stage.castShadow = true;
    stage.receiveShadow = true;
    scene.add(stage);

    // ステージ前面のネオンライン（ピンク）
    const edgeGeometry = new THREE.BoxGeometry(16, 0.1, 0.1);
    const edgeMaterial = new THREE.MeshBasicMaterial({ color: 0xff00ff });
    const stageEdge = new THREE.Mesh(edgeGeometry, edgeMaterial);
    stageEdge.position.set(0, 1.25, -3.05);
    scene.add(stageEdge);

    // ステージ下のアンダーライト
    const underLightGeometry = new THREE.PlaneGeometry(14, 0.5);
    const underLightMaterial = new THREE.MeshBasicMaterial({ 
        color: 0xff00ff,
        transparent: true,
        opacity: 0.5
    });
    const underLight = new THREE.Mesh(underLightGeometry, underLightMaterial);
    underLight.rotation.x = -Math.PI / 2;
    underLight.position.set(0, 0.02, -3.2);
    scene.add(underLight);

    // LEDスクリーン（背景）
    const screenGeometry = new THREE.PlaneGeometry(14, 6);
    
    // グラデーションテクスチャを作成
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0, '#1a0033');
    gradient.addColorStop(0.5, '#330066');
    gradient.addColorStop(1, '#1a0033');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 512, 256);
    
    // グリッドパターン
    ctx.strokeStyle = 'rgba(255, 0, 255, 0.1)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 512; i += 32) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, 256);
        ctx.stroke();
    }
    for (let i = 0; i < 256; i += 32) {
        ctx.beginPath();
        ctx.moveTo(0, i);
        ctx.lineTo(512, i);
        ctx.stroke();
    }
    
    const screenTexture = new THREE.CanvasTexture(canvas);
    const screenMaterial = new THREE.MeshBasicMaterial({ 
        map: screenTexture,
        side: THREE.DoubleSide
    });
    ledScreen = new THREE.Mesh(screenGeometry, screenMaterial);
    ledScreen.position.set(0, 4, -8.9);
    scene.add(ledScreen);

    // スクリーンフレーム
    const frameGeometry = new THREE.BoxGeometry(14.4, 6.4, 0.2);
    const frameMaterial = new THREE.MeshStandardMaterial({ color: 0x111111 });
    const frame = new THREE.Mesh(frameGeometry, frameMaterial);
    frame.position.set(0, 4, -9);
    scene.add(frame);
}

// --------------------------------------------
// トラス（照明骨組み）
// --------------------------------------------
function createTruss() {
    const trussMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x222222,
        roughness: 0.5,
        metalness: 0.8
    });

    // 横トラス（メイン）
    const mainTrussGeometry = new THREE.BoxGeometry(18, 0.3, 0.3);
    const mainTruss = new THREE.Mesh(mainTrussGeometry, trussMaterial);
    mainTruss.position.set(0, 8, -5);
    scene.add(mainTruss);

    // 横トラス（フロント）
    const frontTruss = new THREE.Mesh(mainTrussGeometry, trussMaterial);
    frontTruss.position.set(0, 7, 0);
    scene.add(frontTruss);

    // 縦トラス（左右）
    const sideTrussGeometry = new THREE.BoxGeometry(0.3, 8, 0.3);
    [-9, 9].forEach(x => {
        const sideTruss = new THREE.Mesh(sideTrussGeometry, trussMaterial);
        sideTruss.position.set(x, 4, -5);
        scene.add(sideTruss);
    });

    // 斜めサポート
    const supportGeometry = new THREE.BoxGeometry(0.15, 3, 0.15);
    [-8, 8].forEach(x => {
        const support = new THREE.Mesh(supportGeometry, trussMaterial);
        support.position.set(x, 6.5, -2.5);
        support.rotation.z = x > 0 ? -0.3 : 0.3;
        scene.add(support);
    });
}

// --------------------------------------------
// ムービングライト
// --------------------------------------------
function createMovingLights() {
    const lightColors = [0x9900ff, 0xff00ff, 0x00ffff, 0xff00ff, 0x9900ff];
    const positions = [-6, -3, 0, 3, 6];

    positions.forEach((x, i) => {
        // ライト本体（円柱）
        const bodyGeometry = new THREE.CylinderGeometry(0.2, 0.3, 0.5, 8);
        const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x111111 });
        const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
        body.position.set(x, 7.7, -5);
        scene.add(body);

        // スポットライト
        const spotLight = new THREE.SpotLight(lightColors[i], 2, 20, Math.PI / 6, 0.5, 1);
        spotLight.position.set(x, 7.5, -5);
        spotLight.target.position.set(x + (Math.random() - 0.5) * 4, 0, 2);
        spotLight.castShadow = true;
        scene.add(spotLight);
        scene.add(spotLight.target);

        // ライトコーン（視覚化）
        const coneGeometry = new THREE.ConeGeometry(0.15, 0.4, 8);
        const coneMaterial = new THREE.MeshBasicMaterial({ 
            color: lightColors[i],
            transparent: true,
            opacity: 0.8
        });
        const cone = new THREE.Mesh(coneGeometry, coneMaterial);
        cone.position.set(x, 7.3, -5);
        cone.rotation.x = Math.PI;
        scene.add(cone);

        movingLights.push({ 
            light: spotLight, 
            cone: cone,
            baseX: x, 
            phase: i * 0.5,
            color: lightColors[i]
        });
    });

    // フロントライト
    const frontColors = [0x00ffff, 0xff00ff, 0x00ffff];
    [-4, 0, 4].forEach((x, i) => {
        const spotLight = new THREE.SpotLight(frontColors[i], 1.5, 15, Math.PI / 8, 0.5, 1);
        spotLight.position.set(x, 6.8, 0);
        spotLight.target.position.set(x, 0, 5);
        scene.add(spotLight);
        scene.add(spotLight.target);

        // ライト本体
        const bodyGeometry = new THREE.CylinderGeometry(0.15, 0.2, 0.3, 8);
        const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x111111 });
        const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
        body.position.set(x, 6.85, 0);
        scene.add(body);
    });
}

// --------------------------------------------
// バリケード（柵）
// --------------------------------------------
function createBarrier() {
    const barrierMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x333333,
        roughness: 0.5,
        metalness: 0.7
    });

    // ステージ前の柵
    for (let x = -7; x <= 7; x += 2) {
        // 縦棒
        const postGeometry = new THREE.CylinderGeometry(0.05, 0.05, 1, 8);
        const post = new THREE.Mesh(postGeometry, barrierMaterial);
        post.position.set(x, 0.5, -2);
        scene.add(post);

        // 横棒
        if (x < 7) {
            const railGeometry = new THREE.CylinderGeometry(0.03, 0.03, 2, 8);
            const rail = new THREE.Mesh(railGeometry, barrierMaterial);
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
    const speakerMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x1a1a1a,
        roughness: 0.3
    });

    [-7.5, 7.5].forEach(x => {
        // スピーカー本体
        const speakerGeometry = new THREE.BoxGeometry(1.5, 2.5, 1);
        const speaker = new THREE.Mesh(speakerGeometry, speakerMaterial);
        speaker.position.set(x, 2.5, -4);
        scene.add(speaker);

        // スピーカーグリル
        const grillGeometry = new THREE.PlaneGeometry(1.3, 2.3);
        const grillMaterial = new THREE.MeshBasicMaterial({ 
            color: 0x0a0a0a,
            side: THREE.DoubleSide
        });
        const grill = new THREE.Mesh(grillGeometry, grillMaterial);
        grill.position.set(x, 2.5, -3.49);
        scene.add(grill);

        // サブウーファー
        const subGeometry = new THREE.BoxGeometry(1.8, 1.2, 1.2);
        const sub = new THREE.Mesh(subGeometry, speakerMaterial);
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

    const bodyGeometry = new THREE.CylinderGeometry(0.3, 0.35, 1, 8);
    const bodyMaterial = new THREE.MeshStandardMaterial({ color });
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    body.position.y = 0.5;
    body.castShadow = true;
    group.add(body);

    const headGeometry = new THREE.SphereGeometry(0.25, 8, 8);
    const headMaterial = new THREE.MeshStandardMaterial({ color });
    const head = new THREE.Mesh(headGeometry, headMaterial);
    head.position.y = 1.2;
    head.castShadow = true;
    group.add(head);

    return group;
}

function createPenlight(color) {
    const group = new THREE.Group();

    const handleGeometry = new THREE.CylinderGeometry(0.03, 0.03, 0.2, 8);
    const handleMaterial = new THREE.MeshStandardMaterial({ color: 0x333333 });
    const handle = new THREE.Mesh(handleGeometry, handleMaterial);
    group.add(handle);

    const lightGeometry = new THREE.CylinderGeometry(0.05, 0.03, 0.3, 8);
    const lightMaterial = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
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
    function swingAnimation() {
        progress += 0.15;
        if (progress <= Math.PI) {
            myPenlight.rotation.z = startRotation + Math.sin(progress) * 0.3;
            requestAnimationFrame(swingAnimation);
        } else {
            myPenlight.rotation.z = startRotation;
        }
    }
    swingAnimation();
}

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

function doOtagei(motionId) {
    let progress = 0;
    function otageiAnimation() {
        progress += 0.12;
        if (progress <= Math.PI * 2) {
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
                    if (colorPanel) colorPanel.classList.toggle('hidden', !penlightOn);
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
        myAvatar.position.z = Math.max(-1, Math.min(12, myAvatar.position.z));
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
    while (container.children.length > 20) {
        container.removeChild(container.firstChild);
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// --------------------------------------------
// ムービングライトアニメーション
// --------------------------------------------
function animateMovingLights() {
    lightTime += 0.02;
    
    movingLights.forEach((ml, i) => {
        // ライトの動き
        const swingX = Math.sin(lightTime + ml.phase) * 3;
        const swingZ = Math.cos(lightTime * 0.7 + ml.phase) * 2;
        
        ml.light.target.position.set(
            ml.baseX + swingX,
            0,
            2 + swingZ
        );
    });
}

function animate() {
    requestAnimationFrame(animate);
    
    // ムービングライトのアニメーション
    animateMovingLights();
    
    if (myAvatar) {
        const targetX = myAvatar.position.x * 0.3;
        const targetZ = myAvatar.position.z + 8;
        camera.position.x += (targetX - camera.position.x) * 0.05;
        camera.position.z += (targetZ - camera.position.z) * 0.05;
        camera.lookAt(myAvatar.position.x * 0.5, 2, myAvatar.position.z - 5);
    }
    renderer.render(scene, camera);
}

init();
