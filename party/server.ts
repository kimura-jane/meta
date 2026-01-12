// server.ts - PartyKit サーバー（修正版）

import type * as Party from "partykit/server";

const CLOUDFLARE_APP_ID = "137f0c04cc0e0dca2c59ecf740e8cb60";
const CLOUDFLARE_API_URL = "https://rtc.live.cloudflare.com/v1/apps";

// 開発用フォールバック（本番では party.json の vars/secrets を使う）
const DEV_FALLBACK_HOST_PASSWORD = "jomon2026";
const DEV_FALLBACK_ROOM_PASSWORD = "jomon2026";

interface User {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  avatarUrl: string | null;
}

interface Speaker {
  id: string;
  name: string;
  sessionId: string;
}

interface Track {
  odUserId: string;
  userName: string;
  trackName: string;
  sessionId: string;
}

interface SpeakRequest {
  userId: string;
  userName: string;
  timestamp: number;
}

export default class Server implements Party.Server {
  // ユーザー・登壇者
  users: Map<string, User> = new Map();
  speakers: Map<string, Speaker> = new Map();
  tracks: Map<string, Track> = new Map();
  sessions: Map<string, string> = new Map();
  subscriberSessions: Map<string, string> = new Map();
  speakRequests: Map<string, SpeakRequest> = new Map();

  // 主催者・認証
  hosts: Set<string> = new Set();
  secretMode: boolean = false;
  authed: Set<string> = new Set();
  joined: Set<string> = new Set();
  authFail: Map<string, number> = new Map();

  // 背景・明るさ
  brightness: number = 0.6;
  backgroundUrl: string = "";

  constructor(readonly room: Party.Room) {}

  // === トークン・パスワード取得 ===
  getToken(): string {
    return (this.room as any).env?.CLOUDFLARE_API_TOKEN
      || (this.room as any).CLOUDFLARE_API_TOKEN
      || "";
  }

  getHostPassword(): string {
    return (this.room as any).env?.HOST_PASSWORD
      || (this.room as any).HOST_PASSWORD
      || DEV_FALLBACK_HOST_PASSWORD;
  }

  getRoomPassword(): string {
    return (this.room as any).env?.ROOM_PASSWORD
      || (this.room as any).ROOM_PASSWORD
      || DEV_FALLBACK_ROOM_PASSWORD;
  }

  // === 認証判定 ===
  isHost(id: string): boolean {
    return this.hosts.has(id);
  }

  isAuthed(id: string): boolean {
    return this.authed.has(id);
  }

  canAccessContent(id: string): boolean {
    if (!this.secretMode) return true;
    return this.isAuthed(id) || this.isHost(id);
  }

  // === 送信ヘルパー ===
  send(conn: Party.Connection, data: object) {
    conn.send(JSON.stringify(data));
  }

  // 最小限の初期化（secretMode 時、未認証ユーザー向け）
  sendInitMin(conn: Party.Connection, isAuthed: boolean = false) {
    this.send(conn, {
      type: "initMin",
      yourId: conn.id,
      secretMode: this.secretMode,
      isAuthed: isAuthed,
      isHost: this.isHost(conn.id),
      authRequired: this.secretMode && !isAuthed && !this.isHost(conn.id),
      brightness: this.brightness,
      backgroundUrl: this.backgroundUrl
    });
  }

  // フル初期化（認証済み or secretMode OFF）
  sendFullInit(conn: Party.Connection, isAuthed: boolean = false) {
    const usersObj: Record<string, any> = {};
    this.users.forEach((user, odUserId) => {
      if (odUserId !== conn.id) {
        usersObj[odUserId] = {
          name: user.name,
          userName: user.name,
          x: user.x,
          y: user.y,
          z: user.z,
          avatarUrl: user.avatarUrl
        };
      }
    });

    const speakersArray = Array.from(this.speakers.keys());

    const tracksArray: [string, string][] = [];
    const sessionsArray: [string, string][] = [];
    this.tracks.forEach((track, trackName) => {
      tracksArray.push([track.odUserId, trackName]);
    });
    this.sessions.forEach((sessionId, odUserId) => {
      sessionsArray.push([odUserId, sessionId]);
    });

    const speakRequestsArray = this.isHost(conn.id)
      ? Array.from(this.speakRequests.values())
      : [];

    this.send(conn, {
      type: "init",
      yourId: conn.id,
      secretMode: this.secretMode,
      isAuthed: isAuthed,
      isHost: this.isHost(conn.id),
      users: usersObj,
      speakers: speakersArray,
      tracks: tracksArray,
      sessions: sessionsArray,
      speakRequests: speakRequestsArray,
      brightness: this.brightness,
      backgroundUrl: this.backgroundUrl
    });
  }

  // === ブロードキャスト ===
  broadcastAllowed(data: object, excludeId?: string) {
    for (const conn of this.room.getConnections()) {
      if (excludeId && conn.id === excludeId) continue;
      if (this.canAccessContent(conn.id)) {
        this.send(conn, data);
      }
    }
  }

  broadcastPublic(data: object, excludeId?: string) {
    for (const conn of this.room.getConnections()) {
      if (excludeId && conn.id === excludeId) continue;
      this.send(conn, data);
    }
  }

  broadcastToHosts(data: object) {
    for (const conn of this.room.getConnections()) {
      if (this.isHost(conn.id)) {
        this.send(conn, data);
      }
    }
  }

  // === 接続ライフサイクル ===
  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    console.log(`[Server] onConnect: ${conn.id}`);
  }

  onClose(conn: Party.Connection) {
    console.log(`[Server] onClose: ${conn.id}`);
    const user = this.users.get(conn.id);

    if (this.speakers.has(conn.id)) {
      this.speakers.delete(conn.id);
      this.broadcastAllowed({
        type: "speakerLeft",
        odUserId: conn.id,
        speakers: Array.from(this.speakers.keys())
      });
    }

    for (const [trackName, track] of this.tracks) {
      if (track.odUserId === conn.id) {
        this.tracks.delete(trackName);
      }
    }

    this.speakRequests.delete(conn.id);

    if (user) {
      this.users.delete(conn.id);
      this.broadcastAllowed({
        type: "userLeave",
        odUserId: conn.id,
        userName: user.name,
        speakers: Array.from(this.speakers.keys())
      });
    }

    this.sessions.delete(conn.id);
    this.subscriberSessions.delete(conn.id);
    this.authed.delete(conn.id);
    this.joined.delete(conn.id);
    this.hosts.delete(conn.id);
    this.authFail.delete(conn.id);
  }

  // === 入室完了 ===
  completeJoin(conn: Party.Connection, userName?: string) {
    console.log(`[Server] completeJoin: ${conn.id}, name=${userName}`);

    if (this.joined.has(conn.id)) {
      this.sendFullInit(conn, this.isAuthed(conn.id) || this.isHost(conn.id));
      return;
    }

    this.joined.add(conn.id);

    const name = userName || "ゲスト";
    const user: User = {
      id: conn.id,
      name: name,
      x: (Math.random() - 0.5) * 10,
      y: 0,
      z: 5 + Math.random() * 5,
      avatarUrl: null
    };
    this.users.set(conn.id, user);

    this.sendFullInit(conn, this.isAuthed(conn.id) || this.isHost(conn.id));

    this.broadcastAllowed({
      type: "userJoin",
      odUserId: conn.id,
      userName: name,
      x: user.x,
      y: user.y,
      z: user.z,
      avatarUrl: user.avatarUrl
    }, conn.id);
  }

  // === メッセージハンドラ ===
  async onMessage(message: string, sender: Party.Connection) {
    let data: any;
    try {
      data = JSON.parse(message);
    } catch {
      console.error("[Server] Invalid JSON:", message);
      return;
    }

    const type = data.type;
    if (type !== "position") {
      console.log(`[Server] onMessage: ${type} from ${sender.id}`);
    }

    switch (type) {
      case "requestInit":
        this.handleRequestInit(data, sender);
        break;

      case "auth":
        this.handleAuth(data, sender);
        break;

      case "hostAuth":
      case "hostLogin":
        this.handleHostAuth(data, sender);
        break;

      case "hostLogout":
        this.handleHostLogout(sender);
        break;

      case "disableSecretMode":
        this.handleDisableSecretMode(sender);
        break;

      case "setSecretMode":
        this.handleSetSecretMode(data, sender);
        break;

      case "position":
        this.handlePosition(data, sender);
        break;

      case "avatarChange":
        this.handleAvatarChange(data, sender);
        break;

      case "nameChange":
        this.handleNameChange(data, sender);
        break;

      case "reaction":
        this.handleReaction(data, sender);
        break;

      case "chat":
        this.handleChat(data, sender);
        break;

      case "requestSpeak":
        this.handleRequestSpeak(sender);
        break;

      case "approveSpeak":
        this.handleApproveSpeak(data, sender);
        break;

      case "denySpeak":
        this.handleDenySpeak(data, sender);
        break;

      case "kickSpeaker":
        this.handleKickSpeaker(data, sender);
        break;

      case "stopSpeak":
        this.handleStopSpeak(sender);
        break;

      case "publishTrack":
        await this.handlePublishTrack(data, sender);
        break;

      case "subscribeTrack":
        await this.handleSubscribeTrack(data, sender);
        break;

      case "subscribeAnswer":
        await this.handleSubscribeAnswer(data, sender);
        break;

      case "announce":
        this.handleAnnounce(data, sender);
        break;

      case "backgroundChange":
        this.handleBackgroundChange(data, sender);
        break;

      case "brightnessChange":
        this.handleBrightnessChange(data, sender);
        break;

      default:
        console.log(`[Server] Unknown message type: ${type}`);
    }
  }

  // === 初期化リクエスト ===
  handleRequestInit(data: any, sender: Party.Connection) {
    console.log(`[Server] handleRequestInit: secretMode=${this.secretMode}, isHost=${this.isHost(sender.id)}, isAuthed=${this.isAuthed(sender.id)}`);

    if (this.secretMode && !this.canAccessContent(sender.id)) {
      this.sendInitMin(sender, false);
    } else {
      this.completeJoin(sender, data.userName);
    }
  }

  // === 入室認証（参加者用） ===
  handleAuth(data: any, sender: Party.Connection) {
    const password = data.password || "";
    const roomPassword = this.getRoomPassword();

    console.log(`[Server] handleAuth: sender=${sender.id}`);

    if (password === roomPassword) {
      this.authed.add(sender.id);
      this.authFail.delete(sender.id);
      this.send(sender, { type: "authOk" });
      this.completeJoin(sender, data.userName);
    } else {
      const fails = (this.authFail.get(sender.id) || 0) + 1;
      this.authFail.set(sender.id, fails);
      this.send(sender, { type: "authNg", reason: "パスワードが違います", fails });
    }
  }

  // === 主催者認証 ===
  handleHostAuth(data: any, sender: Party.Connection) {
    const password = data.password || "";
    const hostPassword = this.getHostPassword();

    console.log(`[Server] handleHostAuth: sender=${sender.id}`);

    if (password === hostPassword) {
      this.hosts.add(sender.id);
      this.authed.add(sender.id);
      this.authFail.delete(sender.id);

      console.log(`[Server] Host auth SUCCESS for ${sender.id}`);

      this.send(sender, {
        type: "hostAuthResult",
        ok: true,
        isHost: true,
        isAuthed: true
      });

      this.completeJoin(sender, data.userName);
    } else {
      const fails = (this.authFail.get(sender.id) || 0) + 1;
      this.authFail.set(sender.id, fails);

      console.log(`[Server] Host auth FAILED for ${sender.id}, fails=${fails}`);

      this.send(sender, {
        type: "hostAuthResult",
        ok: false,
        reason: "主催者パスワードが違います",
        fails: fails,
        isHost: false,
        isAuthed: this.isAuthed(sender.id)
      });
    }
  }

  // === 主催者ログアウト ===
  handleHostLogout(sender: Party.Connection) {
    console.log(`[Server] handleHostLogout: ${sender.id}`);

    this.hosts.delete(sender.id);

    this.send(sender, {
      type: "hostAuthResult",
      ok: false,
      reason: "ログアウトしました",
      isHost: false,
      isAuthed: this.isAuthed(sender.id)
    });
  }

  // === 秘密会議モード ===
  handleDisableSecretMode(sender: Party.Connection) {
    if (!this.isHost(sender.id)) {
      this.send(sender, { type: "error", code: "NOT_HOST", message: "権限がありません" });
      return;
    }

    console.log(`[Server] Disabling secret mode by ${sender.id}`);
    this.secretMode = false;

    this.broadcastPublic({
      type: "secretModeChanged",
      value: false
    });

    for (const conn of this.room.getConnections()) {
      if (!this.joined.has(conn.id)) {
        this.completeJoin(conn);
      }
    }
  }

  handleSetSecretMode(data: any, sender: Party.Connection) {
    if (!this.isHost(sender.id)) {
      this.send(sender, { type: "error", code: "NOT_HOST", message: "権限がありません" });
      return;
    }

    const enabled = !!data.value;
    console.log(`[Server] Setting secret mode: ${enabled} by ${sender.id}`);
    this.secretMode = enabled;

    this.broadcastPublic({
      type: "secretModeChanged",
      value: enabled
    });
  }

  // === 位置更新 ===
  handlePosition(data: any, sender: Party.Connection) {
    if (!this.canAccessContent(sender.id)) return;

    const user = this.users.get(sender.id);
    if (!user) return;

    user.x = data.x;
    user.y = data.y ?? 0;
    user.z = data.z;

    this.broadcastAllowed({
      type: "position",
      odUserId: sender.id,
      x: data.x,
      y: data.y ?? 0,
      z: data.z
    }, sender.id);
  }

  // === アバター変更 ===
  handleAvatarChange(data: any, sender: Party.Connection) {
    if (!this.canAccessContent(sender.id)) return;

    const user = this.users.get(sender.id);
    if (!user) return;

    user.avatarUrl = data.imageUrl;

    this.broadcastAllowed({
      type: "avatarChange",
      odUserId: sender.id,
      imageUrl: data.imageUrl
    }, sender.id);
  }

  // === 名前変更 ===
  handleNameChange(data: any, sender: Party.Connection) {
    if (!this.canAccessContent(sender.id)) return;

    const user = this.users.get(sender.id);
    if (!user) return;

    user.name = data.name || "ゲスト";

    this.broadcastAllowed({
      type: "nameChange",
      odUserId: sender.id,
      name: user.name
    }, sender.id);
  }

  // === リアクション ===
  handleReaction(data: any, sender: Party.Connection) {
    if (!this.canAccessContent(sender.id)) return;

    this.broadcastAllowed({
      type: "reaction",
      odUserId: sender.id,
      reaction: data.reaction,
      color: data.color
    });
  }

  // === チャット ===
  handleChat(data: any, sender: Party.Connection) {
    if (!this.canAccessContent(sender.id)) return;

    const user = this.users.get(sender.id);

    this.broadcastAllowed({
      type: "chat",
      senderId: sender.id,
      odUserId: sender.id,
      name: data.name || user?.name || "ゲスト",
      message: data.message
    });
  }

  // === 登壇リクエスト ===
  handleRequestSpeak(sender: Party.Connection) {
    if (!this.canAccessContent(sender.id)) return;

    const user = this.users.get(sender.id);
    if (!user) return;

    if (this.speakers.has(sender.id)) {
      this.send(sender, { type: "error", code: "ALREADY_SPEAKER", message: "既に登壇中です" });
      return;
    }

    if (this.speakRequests.has(sender.id)) {
      this.send(sender, { type: "error", code: "ALREADY_REQUESTED", message: "既にリクエスト済みです" });
      return;
    }

    console.log(`[Server] Speak request from ${sender.id} (${user.name})`);

    this.speakRequests.set(sender.id, {
      userId: sender.id,
      userName: user.name,
      timestamp: Date.now()
    });

    // 主催者全員に通知
    this.broadcastToHosts({
      type: "speakRequest",
      userId: sender.id,
      userName: user.name
    });

    // リクエスト一覧を更新
    this.broadcastToHosts({
      type: "speakRequestsUpdate",
      requests: Array.from(this.speakRequests.values())
    });

    this.send(sender, { type: "speakRequestSent" });
  }

  // === 登壇承認 ===
  async handleApproveSpeak(data: any, sender: Party.Connection) {
    if (!this.isHost(sender.id)) {
      this.send(sender, { type: "error", code: "NOT_HOST", message: "権限がありません" });
      return;
    }

    const targetId = data.userId;
    const request = this.speakRequests.get(targetId);
    if (!request) {
      this.send(sender, { type: "error", code: "NOT_FOUND", message: "リクエストが見つかりません" });
      return;
    }

    console.log(`[Server] Approving speak for ${targetId}`);

    this.speakRequests.delete(targetId);

    // Cloudflare Calls セッション作成
    const sessionId = await this.createSession();
    if (!sessionId) {
      this.send(sender, { type: "error", code: "SESSION_ERROR", message: "セッション作成に失敗しました" });
      return;
    }

    this.sessions.set(targetId, sessionId);

    // 登壇者として登録
    this.speakers.set(targetId, {
      id: targetId,
      name: request.userName,
      sessionId: sessionId
    });

    // 対象者に通知
    const targetConn = this.getConnection(targetId);
    if (targetConn) {
      this.send(targetConn, {
        type: "speakApproved",
        sessionId: sessionId
      });
    }

    // 全員に登壇者参加を通知
    this.broadcastAllowed({
      type: "speakerJoined",
      odUserId: targetId,
      userName: request.userName,
      speakers: Array.from(this.speakers.keys())
    });

    // 主催者全員にリクエストリスト更新を通知
    this.broadcastToHosts({
      type: "speakRequestsUpdate",
      requests: Array.from(this.speakRequests.values())
    });
  }

  // === 登壇拒否 ===
  handleDenySpeak(data: any, sender: Party.Connection) {
    if (!this.isHost(sender.id)) {
      this.send(sender, { type: "error", code: "NOT_HOST", message: "権限がありません" });
      return;
    }

    const targetId = data.userId;
    const request = this.speakRequests.get(targetId);
    if (!request) {
      this.send(sender, { type: "error", code: "NOT_FOUND", message: "リクエストが見つかりません" });
      return;
    }

    console.log(`[Server] Denying speak for ${targetId}`);

    this.speakRequests.delete(targetId);

    // 対象者に通知
    const targetConn = this.getConnection(targetId);
    if (targetConn) {
      this.send(targetConn, {
        type: "speakDenied",
        reason: "主催者によって却下されました"
      });
    }

    // 主催者全員に更新通知
    this.broadcastToHosts({
      type: "speakRequestsUpdate",
      requests: Array.from(this.speakRequests.values())
    });
  }

  // === 登壇者キック ===
  handleKickSpeaker(data: any, sender: Party.Connection) {
    if (!this.isHost(sender.id)) {
      this.send(sender, { type: "error", code: "NOT_HOST", message: "権限がありません" });
      return;
    }

    const targetId = data.userId;
    const speaker = this.speakers.get(targetId);
    if (!speaker) {
      this.send(sender, { type: "error", code: "NOT_FOUND", message: "登壇者が見つかりません" });
      return;
    }

    console.log(`[Server] Kicking speaker ${targetId}`);

    this.speakers.delete(targetId);
    this.sessions.delete(targetId);

    for (const [trackName, track] of this.tracks) {
      if (track.odUserId === targetId) {
        this.tracks.delete(trackName);
      }
    }

    // 対象者に通知
    const targetConn = this.getConnection(targetId);
    if (targetConn) {
      this.send(targetConn, { type: "kicked" });
    }

    // 全員に通知
    this.broadcastAllowed({
      type: "speakerLeft",
      odUserId: targetId,
      speakers: Array.from(this.speakers.keys())
    });
  }

  // === 登壇終了（自発） ===
  handleStopSpeak(sender: Party.Connection) {
    if (!this.speakers.has(sender.id)) return;

    console.log(`[Server] Speaker ${sender.id} stopping`);

    this.speakers.delete(sender.id);
    this.sessions.delete(sender.id);

    for (const [trackName, track] of this.tracks) {
      if (track.odUserId === sender.id) {
        this.tracks.delete(trackName);
      }
    }

    this.broadcastAllowed({
      type: "speakerLeft",
      odUserId: sender.id,
      speakers: Array.from(this.speakers.keys())
    });
  }

  // === Cloudflare Calls API ===
  async handlePublishTrack(data: any, sender: Party.Connection) {
    if (!this.canAccessContent(sender.id)) return;

    const sessionId = this.sessions.get(sender.id);
    if (!sessionId) {
      this.send(sender, { type: "error", code: "NO_SESSION", message: "セッションがありません" });
      return;
    }

    const user = this.users.get(sender.id);
    const userName = user?.name || "Unknown";

    console.log(`[Server] Publishing track for ${sender.id}`);

    const result = await this.publishTrack(sessionId, data.offer?.sdp || data.offer);
    if (!result) {
      this.send(sender, { type: "error", code: "PUBLISH_ERROR", message: "トラック公開に失敗しました" });
      return;
    }

    const { answer, trackName } = result;

    // トラック登録
    this.tracks.set(trackName, {
      odUserId: sender.id,
      userName: userName,
      trackName: trackName,
      sessionId: sessionId
    });

    // 公開者に応答
    this.send(sender, {
      type: "trackPublished",
      answer: { type: "answer", sdp: answer },
      trackName: trackName
    });

    // 全員にトラック通知
    this.broadcastAllowed({
      type: "newTrack",
      odUserId: sender.id,
      userName: userName,
      trackName: trackName,
      sessionId: sessionId
    }, sender.id);
  }

  async handleSubscribeTrack(data: any, sender: Party.Connection) {
    if (!this.canAccessContent(sender.id)) return;

    const trackName = data.trackName;
    const track = this.tracks.get(trackName);
    if (!track) {
      this.send(sender, { type: "error", code: "TRACK_NOT_FOUND", message: "トラックが見つかりません" });
      return;
    }

    console.log(`[Server] Subscribing to track ${trackName} for ${sender.id}`);

    let subSessionId = this.subscriberSessions.get(sender.id);
    if (!subSessionId) {
      subSessionId = await this.createSession();
      if (!subSessionId) {
        this.send(sender, { type: "error", code: "SESSION_ERROR", message: "セッション作成に失敗しました" });
        return;
      }
      this.subscriberSessions.set(sender.id, subSessionId);
    }

    const result = await this.pullTrack(subSessionId, track.sessionId, trackName);
    if (!result) {
      this.send(sender, { type: "error", code: "SUBSCRIBE_ERROR", message: "購読に失敗しました" });
      return;
    }

    this.send(sender, {
      type: "subscribed",
      trackName: trackName,
      offer: result.offer,
      sessionId: subSessionId
    });
  }

  async handleSubscribeAnswer(data: any, sender: Party.Connection) {
    if (!this.canAccessContent(sender.id)) return;

    const subSessionId = this.subscriberSessions.get(sender.id);
    if (!subSessionId) {
      this.send(sender, { type: "error", code: "NO_SESSION", message: "セッションがありません" });
      return;
    }

    const answerSdp = data.answer?.sdp || data.answer;
    const ok = await this.sendAnswer(subSessionId, answerSdp);

    this.send(sender, {
      type: "subscribeAnswerAck",
      trackName: data.trackName,
      ok: ok
    });
  }

  // === Cloudflare API 呼び出し ===
  async createSession(): Promise<string | null> {
    const token = this.getToken();
    if (!token) {
      console.error("[Server] No Cloudflare API token");
      return null;
    }

    try {
      const res = await fetch(`${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/new`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      });

      if (!res.ok) {
        console.error("[Server] createSession failed:", res.status, await res.text());
        return null;
      }

      const json = await res.json() as any;
      console.log(`[Server] Session created: ${json.sessionId}`);
      return json.sessionId || null;
    } catch (e) {
      console.error("[Server] createSession error:", e);
      return null;
    }
  }

  async publishTrack(sessionId: string, offerSdp: string): Promise<{ answer: string; trackName: string } | null> {
    const token = this.getToken();
    if (!token) return null;

    try {
      const res = await fetch(`${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${sessionId}/tracks/new`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          sessionDescription: {
            type: "offer",
            sdp: offerSdp
          },
          tracks: [{
            location: "local",
            trackName: `audio-${sessionId}-${Date.now()}`
          }]
        })
      });

      if (!res.ok) {
        console.error("[Server] publishTrack failed:", res.status, await res.text());
        return null;
      }

      const json = await res.json() as any;
      const track = json.tracks?.[0];
      if (!track) {
        console.error("[Server] publishTrack: no track in response");
        return null;
      }

      return {
        answer: json.sessionDescription?.sdp || "",
        trackName: track.trackName
      };
    } catch (e) {
      console.error("[Server] publishTrack error:", e);
      return null;
    }
  }

  async pullTrack(subscriberSessionId: string, publisherSessionId: string, trackName: string): Promise<{ offer: string } | null> {
    const token = this.getToken();
    if (!token) return null;

    try {
      const res = await fetch(`${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${subscriberSessionId}/tracks/new`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          tracks: [{
            location: "remote",
            sessionId: publisherSessionId,
            trackName: trackName
          }]
        })
      });

      if (!res.ok) {
        console.error("[Server] pullTrack failed:", res.status, await res.text());
        return null;
      }

      const json = await res.json() as any;
      return {
        offer: json.sessionDescription?.sdp || ""
      };
    } catch (e) {
      console.error("[Server] pullTrack error:", e);
      return null;
    }
  }

  async sendAnswer(sessionId: string, answerSdp: string): Promise<boolean> {
    const token = this.getToken();
    if (!token) return false;

    try {
      const res = await fetch(`${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${sessionId}/renegotiate`, {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          sessionDescription: {
            type: "answer",
            sdp: answerSdp
          }
        })
      });

      if (!res.ok) {
        console.error("[Server] sendAnswer failed:", res.status, await res.text());
        return false;
      }

      return true;
    } catch (e) {
      console.error("[Server] sendAnswer error:", e);
      return false;
    }
  }

  // === アナウンス ===
  handleAnnounce(data: any, sender: Party.Connection) {
    if (!this.isHost(sender.id)) {
      this.send(sender, { type: "error", code: "NOT_HOST", message: "権限がありません" });
      return;
    }

    console.log(`[Server] Announce from ${sender.id}: ${data.message}`);

    this.broadcastAllowed({
      type: "announce",
      message: data.message
    });
  }

  // === 背景設定 ===
  handleBackgroundChange(data: any, sender: Party.Connection) {
    if (!this.isHost(sender.id)) {
      this.send(sender, { type: "error", code: "NOT_HOST", message: "権限がありません" });
      return;
    }

    this.backgroundUrl = data.url || "";
    console.log(`[Server] Background changed to: ${this.backgroundUrl}`);

    this.broadcastAllowed({
      type: "backgroundChange",
      url: this.backgroundUrl
    });
  }

  // === 明るさ設定 ===
  handleBrightnessChange(data: any, sender: Party.Connection) {
    if (!this.isHost(sender.id)) {
      this.send(sender, { type: "error", code: "NOT_HOST", message: "権限がありません" });
      return;
    }

    this.brightness = data.value ?? 0.6;
    console.log(`[Server] Brightness changed to: ${this.brightness}`);

    this.broadcastAllowed({
      type: "brightnessChange",
      value: this.brightness
    });
  }

  // === ヘルパー ===
  getConnection(id: string): Party.Connection | null {
    for (const conn of this.room.getConnections()) {
      if (conn.id === id) return conn;
    }
    return null;
  }
}
