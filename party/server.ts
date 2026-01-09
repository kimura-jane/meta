// server.ts - PartyKit サーバー（主催者認証修正版）

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
  avatar: string | null;
}

interface Speaker {
  id: string;
  name: string;
  sessionId: string;
}

interface Track {
  speakerId: string;
  speakerName: string;
  trackName: string;
  sessionId: string;
}

interface SpeakRequest {
  id: string;
  name: string;
  timestamp: number;
}

export default class Server implements Party.Server {
  // ユーザー・登壇者
  users: Map<string, User> = new Map();
  speakers: Map<string, Speaker> = new Map();
  tracks: Map<string, Track> = new Map();
  sessions: Map<string, string> = new Map();           // oderId -> sessionId
  subscriberSessions: Map<string, string> = new Map(); // oderId -> subscriberSessionId
  speakRequests: Map<string, SpeakRequest> = new Map();

  // 主催者・認証
  hosts: Set<string> = new Set();
  secretMode: boolean = false;
  authed: Set<string> = new Set();
  joined: Set<string> = new Set();
  authFail: Map<string, number> = new Map();

  // 背景・明るさ
  brightness: number = 100;
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
      secretMode: this.secretMode,
      isAuthed: isAuthed,
      brightness: this.brightness,
      backgroundUrl: this.backgroundUrl
    });
  }

  // フル初期化（認証済み or secretMode OFF）
  sendFullInit(conn: Party.Connection, isAuthed: boolean = false) {
    this.send(conn, {
      type: "init",
      secretMode: this.secretMode,
      isAuthed: isAuthed,
      isHost: this.isHost(conn.id),
      users: this.buildVisibleUsers(conn.id),
      speakers: this.buildVisibleSpeakers(conn.id),
      tracks: this.buildVisibleTracks(conn.id),
      speakRequests: this.buildVisibleSpeakRequests(conn.id),
      brightness: this.brightness,
      backgroundUrl: this.backgroundUrl
    });
  }

  buildVisibleUsers(requesterId: string): User[] {
    return Array.from(this.users.values());
  }

  buildVisibleSpeakers(requesterId: string): Speaker[] {
    return Array.from(this.speakers.values());
  }

  buildVisibleTracks(requesterId: string): Track[] {
    return Array.from(this.tracks.values());
  }

  buildVisibleSpeakRequests(requesterId: string): SpeakRequest[] {
    if (!this.isHost(requesterId)) return [];
    return Array.from(this.speakRequests.values());
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
    // 初期化は requestInit で行う
  }

  onClose(conn: Party.Connection) {
    console.log(`[Server] onClose: ${conn.id}`);
    const user = this.users.get(conn.id);

    // 登壇者なら削除
    if (this.speakers.has(conn.id)) {
      this.speakers.delete(conn.id);
      this.broadcastAllowed({ type: "speakerLeft", oderId: conn.id });
    }

    // トラック削除
    for (const [trackName, track] of this.tracks) {
      if (track.speakerId === conn.id) {
        this.tracks.delete(trackName);
      }
    }

    // 登壇リクエスト削除
    this.speakRequests.delete(conn.id);

    // ユーザー削除
    if (user) {
      this.users.delete(conn.id);
      this.broadcastAllowed({ type: "userLeave", oderId: conn.id, userName: user.name });
    }

    // セッション削除
    this.sessions.delete(conn.id);
    this.subscriberSessions.delete(conn.id);

    // 認証・主催者状態削除
    this.authed.delete(conn.id);
    this.joined.delete(conn.id);
    this.hosts.delete(conn.id);
    this.authFail.delete(conn.id);
  }

  // === 入室完了 ===
  completeJoin(conn: Party.Connection, userName?: string) {
    console.log(`[Server] completeJoin: ${conn.id}, name=${userName}`);

    if (this.joined.has(conn.id)) {
      // 既に join 済みなら init だけ送り直す
      this.sendFullInit(conn, this.isAuthed(conn.id) || this.isHost(conn.id));
      return;
    }

    this.joined.add(conn.id);

    const name = userName || "ゲスト";
    const user: User = {
      id: conn.id,
      name: name,
      x: 400 + Math.random() * 200,
      y: 300 + Math.random() * 200,
      avatar: null
    };
    this.users.set(conn.id, user);

    // フル初期化を送信
    this.sendFullInit(conn, this.isAuthed(conn.id) || this.isHost(conn.id));

    // 他のユーザーに通知
    this.broadcastAllowed({
      type: "userJoin",
      oderId: conn.id,
      userName: name,
      x: user.x,
      y: user.y,
      avatar: user.avatar
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
    console.log(`[Server] onMessage: ${type} from ${sender.id}`);

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

      case "join":
        this.handleJoin(data, sender);
        break;

      case "position":
        this.handlePosition(data, sender);
        break;

      case "avatar":
        this.handleAvatar(data, sender);
        break;

      case "name":
        this.handleName(data, sender);
        break;

      case "reaction":
        this.handleReaction(data, sender);
        break;

      case "chat":
        this.handleChat(data, sender);
        break;

      case "requestSpeak":
        this.handleRequestSpeak(data, sender);
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

      case "setBackground":
        this.handleSetBackground(data, sender);
        break;

      case "setBrightness":
        this.handleSetBrightness(data, sender);
        break;

      default:
        console.log(`[Server] Unknown message type: ${type}`);
    }
  }

  // === 初期化リクエスト ===
  handleRequestInit(data: any, sender: Party.Connection) {
    console.log(`[Server] handleRequestInit: secretMode=${this.secretMode}`);

    if (this.secretMode) {
      // 秘密会議中は最小限の情報のみ
      this.sendInitMin(sender, this.isAuthed(sender.id) || this.isHost(sender.id));
    } else {
      // 通常モードなら即座に join
      this.completeJoin(sender, data.userName);
    }
  }

  // === 入室認証（参加者用） ===
  handleAuth(data: any, sender: Party.Connection) {
    const password = data.password || "";
    const roomPassword = this.getRoomPassword();

    console.log(`[Server] handleAuth: password=${password ? "***" : "(empty)"}`);

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

    console.log(`[Server] handleHostAuth: password=${password ? "***" : "(empty)"}, expected=${hostPassword ? "***" : "(empty)"}`);

    if (password === hostPassword) {
      this.hosts.add(sender.id);
      this.authed.add(sender.id);  // ★ 主催者は自動的に認証済み
      this.authFail.delete(sender.id);

      console.log(`[Server] Host auth SUCCESS for ${sender.id}`);

      // 成功レスポンス
      this.send(sender, {
        type: "hostAuthResult",
        ok: true,
        isHost: true,
        isAuthed: true  // ★ 認証状態も返す
      });

      // ★ 主催者はすぐに入室完了
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
    // 注: authed は残す（一般参加者として継続可能）

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
      this.send(sender, { type: "error", message: "権限がありません" });
      return;
    }

    console.log(`[Server] Disabling secret mode`);
    this.secretMode = false;

    // 全員に通知
    this.broadcastPublic({ type: "secretModeChanged", secretMode: false });

    // 未入室の人を入室させる
    for (const conn of this.room.getConnections()) {
      if (!this.joined.has(conn.id)) {
        this.completeJoin(conn);
      }
    }
  }

  handleSetSecretMode(data: any, sender: Party.Connection) {
    if (!this.isHost(sender.id)) {
      this.send(sender, { type: "error", message: "権限がありません" });
      return;
    }

    const enabled = !!data.enabled;
    console.log(`[Server] Setting secret mode: ${enabled}`);
    this.secretMode = enabled;

    this.broadcastPublic({ type: "secretModeChanged", secretMode: enabled });
  }

  // === 入室（join） ===
  handleJoin(data: any, sender: Party.Connection) {
    // secretMode 中で未認証なら拒否
    if (this.secretMode && !this.canAccessContent(sender.id)) {
      this.sendInitMin(sender, false);
      return;
    }

    this.completeJoin(sender, data.userName);
  }

  // === 位置更新 ===
  handlePosition(data: any, sender: Party.Connection) {
    const user = this.users.get(sender.id);
    if (!user) return;

    user.x = data.x;
    user.y = data.y;

    this.broadcastAllowed({
      type: "position",
      oderId: sender.id,
      x: data.x,
      y: data.y
    }, sender.id);
  }

  // === アバター変更 ===
  handleAvatar(data: any, sender: Party.Connection) {
    const user = this.users.get(sender.id);
    if (!user) return;

    user.avatar = data.avatar;

    this.broadcastAllowed({
      type: "avatarChange",
      oderId: sender.id,
      avatar: data.avatar
    }, sender.id);
  }

  // === 名前変更 ===
  handleName(data: any, sender: Party.Connection) {
    const user = this.users.get(sender.id);
    if (!user) return;

    const oldName = user.name;
    user.name = data.name || "ゲスト";

    this.broadcastAllowed({
      type: "nameChange",
      oderId: sender.id,
      oldName: oldName,
      newName: user.name
    }, sender.id);
  }

  // === リアクション ===
  handleReaction(data: any, sender: Party.Connection) {
    const user = this.users.get(sender.id);
    if (!user) return;

    this.broadcastAllowed({
      type: "reaction",
      oderId: sender.id,
      userName: user.name,
      emoji: data.emoji
    });
  }

  // === チャット ===
  handleChat(data: any, sender: Party.Connection) {
    const user = this.users.get(sender.id);
    if (!user) return;

    this.broadcastAllowed({
      type: "chat",
      oderId: sender.id,
      userName: user.name,
      text: data.text
    });
  }

  // === 登壇リクエスト ===
  handleRequestSpeak(data: any, sender: Party.Connection) {
    const user = this.users.get(sender.id);
    if (!user) return;

    // 既に登壇者なら無視
    if (this.speakers.has(sender.id)) {
      this.send(sender, { type: "error", message: "既に登壇中です" });
      return;
    }

    // リクエスト追加
    this.speakRequests.set(sender.id, {
      id: sender.id,
      name: user.name,
      timestamp: Date.now()
    });

    // 主催者に通知
    this.broadcastToHosts({
      type: "speakRequest",
      oderId: sender.id,
      userName: user.name
    });

    this.send(sender, { type: "speakRequestSent" });
  }

  // === 登壇承認 ===
  async handleApproveSpeak(data: any, sender: Party.Connection) {
    if (!this.isHost(sender.id)) {
      this.send(sender, { type: "error", message: "権限がありません" });
      return;
    }

    const targetId = data.oderId;
    const request = this.speakRequests.get(targetId);
    if (!request) {
      this.send(sender, { type: "error", message: "リクエストが見つかりません" });
      return;
    }

    // リクエスト削除
    this.speakRequests.delete(targetId);

    // セッション作成
    const sessionId = await this.createSession();
    if (!sessionId) {
      this.send(sender, { type: "error", message: "セッション作成に失敗しました" });
      return;
    }

    this.sessions.set(targetId, sessionId);

    // 登壇者に通知
    const targetConn = this.getConnection(targetId);
    if (targetConn) {
      this.send(targetConn, {
        type: "speakApproved",
        sessionId: sessionId
      });
    }

    // 主催者全員にリクエストリスト更新を通知
    this.broadcastToHosts({
      type: "speakRequestsUpdate",
      requests: this.buildVisibleSpeakRequests(sender.id)
    });
  }

  // === 登壇拒否 ===
  handleDenySpeak(data: any, sender: Party.Connection) {
    if (!this.isHost(sender.id)) {
      this.send(sender, { type: "error", message: "権限がありません" });
      return;
    }

    const targetId = data.oderId;
    this.speakRequests.delete(targetId);

    // 対象に通知
    const targetConn = this.getConnection(targetId);
    if (targetConn) {
      this.send(targetConn, { type: "speakDenied" });
    }

    // 主催者全員に更新通知
    this.broadcastToHosts({
      type: "speakRequestsUpdate",
      requests: this.buildVisibleSpeakRequests(sender.id)
    });
  }

  // === 登壇者キック ===
  handleKickSpeaker(data: any, sender: Party.Connection) {
    if (!this.isHost(sender.id)) {
      this.send(sender, { type: "error", message: "権限がありません" });
      return;
    }

    const targetId = data.oderId;
    const speaker = this.speakers.get(targetId);
    if (!speaker) return;

    // 登壇者削除
    this.speakers.delete(targetId);

    // トラック削除
    for (const [trackName, track] of this.tracks) {
      if (track.speakerId === targetId) {
        this.tracks.delete(trackName);
      }
    }

    // 対象に通知
    const targetConn = this.getConnection(targetId);
    if (targetConn) {
      this.send(targetConn, { type: "kicked" });
    }

    // 全員に通知
    this.broadcastAllowed({ type: "speakerLeft", oderId: targetId });
  }

  // === 登壇終了（自発） ===
  handleStopSpeak(sender: Party.Connection) {
    if (!this.speakers.has(sender.id)) return;

    this.speakers.delete(sender.id);

    // トラック削除
    for (const [trackName, track] of this.tracks) {
      if (track.speakerId === sender.id) {
        this.tracks.delete(trackName);
      }
    }

    this.broadcastAllowed({ type: "speakerLeft", oderId: sender.id });
  }

  // === Cloudflare Calls API ===
  async handlePublishTrack(data: any, sender: Party.Connection) {
    const sessionId = this.sessions.get(sender.id);
    if (!sessionId) {
      this.send(sender, { type: "error", message: "セッションがありません" });
      return;
    }

    const user = this.users.get(sender.id);
    const userName = user?.name || "Unknown";

    const result = await this.publishTrack(sessionId, data.offer);
    if (!result) {
      this.send(sender, { type: "error", message: "トラック公開に失敗しました" });
      return;
    }

    const { answer, trackName } = result;

    // 登壇者として登録
    this.speakers.set(sender.id, {
      id: sender.id,
      name: userName,
      sessionId: sessionId
    });

    // トラック登録
    this.tracks.set(trackName, {
      speakerId: sender.id,
      speakerName: userName,
      trackName: trackName,
      sessionId: sessionId
    });

    // 公開者に応答
    this.send(sender, {
      type: "trackPublished",
      answer: answer,
      trackName: trackName
    });

    // 全員にトラック通知
    this.broadcastAllowed({
      type: "newTrack",
      speakerId: sender.id,
      speakerName: userName,
      trackName: trackName,
      sessionId: sessionId
    }, sender.id);

    // 登壇者参加通知
    this.broadcastAllowed({
      type: "speakerJoined",
      oderId: sender.id,
      userName: userName
    }, sender.id);
  }

  async handleSubscribeTrack(data: any, sender: Party.Connection) {
    const track = this.tracks.get(data.trackName);
    if (!track) {
      this.send(sender, { type: "error", message: "トラックが見つかりません" });
      return;
    }

    // 購読用セッションを取得または作成
    let subSessionId = this.subscriberSessions.get(sender.id);
    if (!subSessionId) {
      subSessionId = await this.createSession();
      if (!subSessionId) {
        this.send(sender, { type: "error", message: "セッション作成に失敗しました" });
        return;
      }
      this.subscriberSessions.set(sender.id, subSessionId);
    }

    const result = await this.subscribeTrack(subSessionId, track.sessionId, data.trackName);
    if (!result) {
      this.send(sender, { type: "error", message: "購読に失敗しました" });
      return;
    }

    this.send(sender, {
      type: "subscribed",
      trackName: data.trackName,
      offer: result.offer,
      sessionId: subSessionId
    });
  }

  async handleSubscribeAnswer(data: any, sender: Party.Connection) {
    const subSessionId = this.subscriberSessions.get(sender.id);
    if (!subSessionId) {
      this.send(sender, { type: "error", message: "セッションがありません" });
      return;
    }

    const ok = await this.sendAnswer(subSessionId, data.answer);
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
        console.error("[Server] createSession failed:", res.status);
        return null;
      }

      const json = await res.json();
      return json.sessionId || null;
    } catch (e) {
      console.error("[Server] createSession error:", e);
      return null;
    }
  }

  async publishTrack(sessionId: string, offer: string): Promise<{ answer: string; trackName: string } | null> {
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
            sdp: offer
          }
        })
      });

      if (!res.ok) {
        console.error("[Server] publishTrack failed:", res.status);
        return null;
      }

      const json = await res.json();
      const track = json.tracks?.[0];
      if (!track) return null;

      return {
        answer: json.sessionDescription?.sdp || "",
        trackName: track.trackName
      };
    } catch (e) {
      console.error("[Server] publishTrack error:", e);
      return null;
    }
  }

  async subscribeTrack(subscriberSessionId: string, publisherSessionId: string, trackName: string): Promise<{ offer: string } | null> {
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
        console.error("[Server] subscribeTrack failed:", res.status);
        return null;
      }

      const json = await res.json();
      return {
        offer: json.sessionDescription?.sdp || ""
      };
    } catch (e) {
      console.error("[Server] subscribeTrack error:", e);
      return null;
    }
  }

  async sendAnswer(sessionId: string, answer: string): Promise<boolean> {
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
            sdp: answer
          }
        })
      });

      return res.ok;
    } catch (e) {
      console.error("[Server] sendAnswer error:", e);
      return false;
    }
  }

  // === アナウンス ===
  handleAnnounce(data: any, sender: Party.Connection) {
    if (!this.isHost(sender.id)) {
      this.send(sender, { type: "error", message: "権限がありません" });
      return;
    }

    this.broadcastPublic({
      type: "announce",
      text: data.text
    });
  }

  // === 背景設定 ===
  handleSetBackground(data: any, sender: Party.Connection) {
    if (!this.isHost(sender.id)) {
      this.send(sender, { type: "error", message: "権限がありません" });
      return;
    }

    this.backgroundUrl = data.url || "";

    this.broadcastPublic({
      type: "backgroundChange",
      url: this.backgroundUrl
    });
  }

  // === 明るさ設定 ===
  handleSetBrightness(data: any, sender: Party.Connection) {
    if (!this.isHost(sender.id)) {
      this.send(sender, { type: "error", message: "権限がありません" });
      return;
    }

    this.brightness = data.brightness || 100;

    this.broadcastPublic({
      type: "brightnessChange",
      brightness: this.brightness
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
