// ============================================
// server.ts - PartyKit サーバー（Agora対応版）
// ============================================

import type * as Party from "partykit/server";

// --------------------------------------------
// 定数
// --------------------------------------------
const DEV_FALLBACK_HOST_PASSWORD = "jomon2026";
const DEV_FALLBACK_ROOM_PASSWORD = "jomon2026";

// --------------------------------------------
// 型定義
// --------------------------------------------
interface User {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  avatarUrl?: string;
}

interface Speaker {
  id: string;
  name: string;
}

interface SpeakRequest {
  userId: string;
  userName: string;
  timestamp: number;
}

interface PinnedComment {
  senderId: string;
  senderName: string;
  message: string;
}

// --------------------------------------------
// サーバークラス
// --------------------------------------------
export default class Server implements Party.Server {
  constructor(readonly room: Party.Room) {}

  // 状態
  users: Map<string, User> = new Map();
  speakers: Map<string, Speaker> = new Map();
  speakRequests: Map<string, SpeakRequest> = new Map();
  
  hosts: Set<string> = new Set();
  secretMode: boolean = false;
  authed: Set<string> = new Set();
  joined: Set<string> = new Set();
  authFail: Map<string, number> = new Map();
  
  brightness: number = 0.6;
  backgroundUrl: string = "";
  
  pinnedComment: PinnedComment | null = null;

  // --------------------------------------------
  // パスワード取得
  // --------------------------------------------
  getHostPassword(): string {
    const env = this.room.env as Record<string, string | undefined>;
    return env.HOST_PASSWORD || env["HOST_PASSWORD"] || DEV_FALLBACK_HOST_PASSWORD;
  }

  getRoomPassword(): string {
    const env = this.room.env as Record<string, string | undefined>;
    return env.ROOM_PASSWORD || env["ROOM_PASSWORD"] || DEV_FALLBACK_ROOM_PASSWORD;
  }

  // --------------------------------------------
  // 認証ヘルパー
  // --------------------------------------------
  isHost(id: string): boolean {
    return this.hosts.has(id);
  }

  isAuthed(id: string): boolean {
    return this.authed.has(id);
  }

  canAccessContent(id: string): boolean {
    if (!this.secretMode) return true;
    return this.isAuthed(id);
  }

  // --------------------------------------------
  // メッセージ送信
  // --------------------------------------------
  send(conn: Party.Connection, data: object) {
    conn.send(JSON.stringify(data));
  }

  sendInitMin(conn: Party.Connection) {
    this.send(conn, {
      type: "initMin",
      yourId: conn.id,
      secretMode: this.secretMode,
      isHost: this.isHost(conn.id),
      isAuthed: this.isAuthed(conn.id),
      authRequired: this.secretMode && !this.isAuthed(conn.id)
    });
  }

  sendFullInit(conn: Party.Connection) {
    const usersObj: Record<string, User> = {};
    this.users.forEach((u, id) => { usersObj[id] = u; });

    const speakersArray = Array.from(this.speakers.keys());
    const speakRequestsArray = Array.from(this.speakRequests.values());

    this.send(conn, {
      type: "init",
      yourId: conn.id,
      users: usersObj,
      speakers: speakersArray,
      speakRequests: this.isHost(conn.id) ? speakRequestsArray : [],
      brightness: this.brightness,
      backgroundUrl: this.backgroundUrl,
      secretMode: this.secretMode,
      isHost: this.isHost(conn.id),
      isAuthed: this.isAuthed(conn.id),
      pinnedComment: this.pinnedComment
    });
  }

  // --------------------------------------------
  // ブロードキャスト
  // --------------------------------------------
  broadcastAllowed(data: object, excludeId?: string) {
    const msg = JSON.stringify(data);
    for (const conn of this.room.getConnections()) {
      if (conn.id === excludeId) continue;
      if (!this.canAccessContent(conn.id)) continue;
      conn.send(msg);
    }
  }

  broadcastPublic(data: object, excludeId?: string) {
    const msg = JSON.stringify(data);
    for (const conn of this.room.getConnections()) {
      if (conn.id === excludeId) continue;
      conn.send(msg);
    }
  }

  broadcastToHosts(data: object) {
    const msg = JSON.stringify(data);
    for (const conn of this.room.getConnections()) {
      if (this.isHost(conn.id)) {
        conn.send(msg);
      }
    }
  }

  // --------------------------------------------
  // 接続ヘルパー
  // --------------------------------------------
  getConnection(id: string): Party.Connection | undefined {
    for (const conn of this.room.getConnections()) {
      if (conn.id === id) return conn;
    }
    return undefined;
  }

  // --------------------------------------------
  // 参加処理
  // --------------------------------------------
  completeJoin(conn: Party.Connection, userName: string) {
    if (this.joined.has(conn.id)) {
      this.sendFullInit(conn);
      return;
    }

    const user: User = {
      id: conn.id,
      name: userName || "ゲスト",
      x: Math.random() * 10 - 5,
      y: 0,
      z: Math.random() * 10 - 5
    };

    this.users.set(conn.id, user);
    this.joined.add(conn.id);

    this.sendFullInit(conn);

    this.broadcastAllowed({
      type: "userJoin",
      odUserId: conn.id,
      userName: user.name
    }, conn.id);
  }

  // --------------------------------------------
  // ライフサイクル
  // --------------------------------------------
  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    const url = new URL(ctx.request.url);
    const userName = url.searchParams.get("name") || "ゲスト";

    console.log(`[Server] 接続: ${conn.id} (${userName})`);

    this.sendInitMin(conn);

    if (!this.secretMode) {
      this.authed.add(conn.id);
      this.completeJoin(conn, userName);
    }
  }

  onClose(conn: Party.Connection) {
    console.log(`[Server] 切断: ${conn.id}`);

    const user = this.users.get(conn.id);
    this.users.delete(conn.id);
    this.speakers.delete(conn.id);
    this.speakRequests.delete(conn.id);
    this.authed.delete(conn.id);
    this.joined.delete(conn.id);
    this.hosts.delete(conn.id);
    this.authFail.delete(conn.id);

    if (user) {
      this.broadcastAllowed({
        type: "userLeave",
        odUserId: conn.id,
        speakers: Array.from(this.speakers.keys())
      });
    }
  }

  // --------------------------------------------
  // メッセージ受信
  // --------------------------------------------
  onMessage(message: string, sender: Party.Connection) {
    let data: any;
    try {
      data = JSON.parse(message);
    } catch {
      console.error("[Server] JSON解析エラー");
      return;
    }

    const type = data.type;

    switch (type) {
      case "requestInit":
        this.handleRequestInit(sender, data);
        break;
      case "auth":
        this.handleAuth(sender, data);
        break;
      case "hostAuth":
      case "hostLogin":
        this.handleHostAuth(sender, data);
        break;
      case "hostLogout":
        this.handleHostLogout(sender);
        break;
      case "disableSecretMode":
        this.handleDisableSecretMode(sender);
        break;
      case "setSecretMode":
        this.handleSetSecretMode(sender, data);
        break;
      case "position":
        this.handlePosition(sender, data);
        break;
      case "avatarChange":
        this.handleAvatarChange(sender, data);
        break;
      case "nameChange":
        this.handleNameChange(sender, data);
        break;
      case "reaction":
        this.handleReaction(sender, data);
        break;
      case "chat":
        this.handleChat(sender, data);
        break;
      case "emojiThrow":
        this.handleEmojiThrow(sender, data);
        break;
      case "pinComment":
        this.handlePinComment(sender, data);
        break;
      case "unpinComment":
        this.handleUnpinComment(sender);
        break;
      case "requestSpeak":
        this.handleRequestSpeak(sender);
        break;
      case "approveSpeak":
        this.handleApproveSpeak(sender, data);
        break;
      case "denySpeak":
        this.handleDenySpeak(sender, data);
        break;
      case "kickSpeaker":
        this.handleKickSpeaker(sender, data);
        break;
      case "stopSpeak":
        this.handleStopSpeak(sender);
        break;
      case "announce":
        this.handleAnnounce(sender, data);
        break;
      case "backgroundChange":
        this.handleBackgroundChange(sender, data);
        break;
      case "brightnessChange":
        this.handleBrightnessChange(sender, data);
        break;
      default:
        console.log(`[Server] 未知のメッセージタイプ: ${type}`);
    }
  }

  // --------------------------------------------
  // ハンドラー: 初期化リクエスト
  // --------------------------------------------
  handleRequestInit(conn: Party.Connection, data: any) {
    const userName = data.userName || "ゲスト";

    if (this.secretMode && !this.isAuthed(conn.id)) {
      this.sendInitMin(conn);
      return;
    }

    this.completeJoin(conn, userName);
  }

  // --------------------------------------------
  // ハンドラー: 入室認証
  // --------------------------------------------
  handleAuth(conn: Party.Connection, data: any) {
    const password = data.password || "";
    const roomPassword = this.getRoomPassword();

    if (password === roomPassword) {
      this.authed.add(conn.id);
      this.send(conn, { type: "authOk" });
      console.log(`[Server] 入室認証成功: ${conn.id}`);
    } else {
      this.send(conn, { type: "authNg" });
      console.log(`[Server] 入室認証失敗: ${conn.id}`);
    }
  }

  // --------------------------------------------
  // ハンドラー: 主催者認証
  // --------------------------------------------
  handleHostAuth(conn: Party.Connection, data: any) {
    const password = data.password || "";
    const hostPassword = this.getHostPassword();

    const fails = this.authFail.get(conn.id) || 0;

    if (password === hostPassword) {
      this.hosts.add(conn.id);
      this.authed.add(conn.id);
      this.authFail.delete(conn.id);

      this.send(conn, {
        type: "hostAuthResult",
        ok: true,
        isHost: true,
        isAuthed: true
      });

      console.log(`[Server] 主催者認証成功: ${conn.id}`);

      const url = new URL("https://dummy.com");
      const userName = this.users.get(conn.id)?.name || "主催者";
      this.completeJoin(conn, userName);

    } else {
      const newFails = fails + 1;
      this.authFail.set(conn.id, newFails);

      this.send(conn, {
        type: "hostAuthResult",
        ok: false,
        reason: "パスワードが違います",
        fails: newFails,
        isHost: false,
        isAuthed: this.isAuthed(conn.id)
      });

      console.log(`[Server] 主催者認証失敗: ${conn.id} (${newFails}回目)`);
    }
  }

  // --------------------------------------------
  // ハンドラー: 主催者ログアウト
  // --------------------------------------------
  handleHostLogout(conn: Party.Connection) {
    this.hosts.delete(conn.id);

    this.send(conn, {
      type: "hostAuthResult",
      ok: false,
      reason: "ログアウトしました",
      isHost: false,
      isAuthed: this.isAuthed(conn.id)
    });

    console.log(`[Server] 主催者ログアウト: ${conn.id}`);
  }

  // --------------------------------------------
  // ハンドラー: 秘密会議モード解除
  // --------------------------------------------
  handleDisableSecretMode(conn: Party.Connection) {
    if (!this.isHost(conn.id)) {
      this.send(conn, { type: "error", code: "NOT_HOST" });
      return;
    }

    this.secretMode = false;

    this.broadcastPublic({
      type: "secretModeChanged",
      value: false
    });

    // 未参加者を参加させる
    for (const c of this.room.getConnections()) {
      if (!this.joined.has(c.id)) {
        this.authed.add(c.id);
        this.completeJoin(c, "ゲスト");
      }
    }

    console.log(`[Server] 秘密会議モード解除: ${conn.id}`);
  }

  // --------------------------------------------
  // ハンドラー: 秘密会議モード設定
  // --------------------------------------------
  handleSetSecretMode(conn: Party.Connection, data: any) {
    if (!this.isHost(conn.id)) {
      this.send(conn, { type: "error", code: "NOT_HOST" });
      return;
    }

    const newValue = !!data.value;
    this.secretMode = newValue;

    if (newValue) {
      // 秘密会議モードON: 主催者以外の認証を解除
      for (const c of this.room.getConnections()) {
        if (!this.isHost(c.id)) {
          this.authed.delete(c.id);
          this.joined.delete(c.id);
          this.users.delete(c.id);
        }
      }
    }

    this.broadcastPublic({
      type: "secretModeChanged",
      value: newValue
    });

    console.log(`[Server] 秘密会議モード変更: ${newValue}`);
  }

  // --------------------------------------------
  // ハンドラー: 位置更新
  // --------------------------------------------
  handlePosition(conn: Party.Connection, data: any) {
    if (!this.canAccessContent(conn.id)) return;

    const user = this.users.get(conn.id);
    if (user) {
      user.x = data.x ?? user.x;
      user.y = data.y ?? user.y;
      user.z = data.z ?? user.z;
    }

    this.broadcastAllowed({
      type: "position",
      odUserId: conn.id,
      x: data.x,
      y: data.y,
      z: data.z
    }, conn.id);
  }

  // --------------------------------------------
  // ハンドラー: アバター変更
  // --------------------------------------------
  handleAvatarChange(conn: Party.Connection, data: any) {
    if (!this.canAccessContent(conn.id)) return;

    const user = this.users.get(conn.id);
    if (user) {
      user.avatarUrl = data.imageUrl;
    }

    this.broadcastAllowed({
      type: "avatarChange",
      odUserId: conn.id,
      imageUrl: data.imageUrl
    }, conn.id);
  }

  // --------------------------------------------
  // ハンドラー: 名前変更
  // --------------------------------------------
  handleNameChange(conn: Party.Connection, data: any) {
    if (!this.canAccessContent(conn.id)) return;

    const user = this.users.get(conn.id);
    if (user) {
      user.name = data.name || user.name;
    }

    this.broadcastAllowed({
      type: "nameChange",
      odUserId: conn.id,
      name: data.name
    }, conn.id);
  }

  // --------------------------------------------
  // ハンドラー: リアクション
  // --------------------------------------------
  handleReaction(conn: Party.Connection, data: any) {
    if (!this.canAccessContent(conn.id)) return;

    this.broadcastAllowed({
      type: "reaction",
      odUserId: conn.id,
      reaction: data.reaction,
      color: data.color
    });
  }

  // --------------------------------------------
  // ハンドラー: チャット
  // --------------------------------------------
  handleChat(conn: Party.Connection, data: any) {
    if (!this.canAccessContent(conn.id)) return;

    this.broadcastAllowed({
      type: "chat",
      senderId: conn.id,
      name: data.name,
      message: data.message
    });
  }

  // --------------------------------------------
  // ハンドラー: 絵文字投げ
  // --------------------------------------------
  handleEmojiThrow(conn: Party.Connection, data: any) {
    if (!this.canAccessContent(conn.id)) return;

    const user = this.users.get(conn.id);
    
    this.broadcastAllowed({
      type: "emojiThrow",
      emoji: data.emoji,
      senderId: conn.id,
      senderName: user?.name || data.senderName || "ゲスト"
    });

    console.log(`[Server] 絵文字投げ: ${data.emoji} from ${conn.id}`);
  }

  // --------------------------------------------
  // ハンドラー: コメントピン留め
  // --------------------------------------------
  handlePinComment(conn: Party.Connection, data: any) {
    if (!this.isHost(conn.id)) {
      this.send(conn, { type: "error", code: "NOT_HOST" });
      return;
    }

    this.pinnedComment = data.comment;

    this.broadcastAllowed({
      type: "pinComment",
      comment: this.pinnedComment
    });

    console.log(`[Server] ピン留め: ${JSON.stringify(this.pinnedComment)}`);
  }

  // --------------------------------------------
  // ハンドラー: ピン留め解除
  // --------------------------------------------
  handleUnpinComment(conn: Party.Connection) {
    if (!this.isHost(conn.id)) {
      this.send(conn, { type: "error", code: "NOT_HOST" });
      return;
    }

    this.pinnedComment = null;

    this.broadcastAllowed({
      type: "unpinComment"
    });

    console.log(`[Server] ピン留め解除`);
  }

  // --------------------------------------------
  // ハンドラー: 登壇リクエスト
  // --------------------------------------------
  handleRequestSpeak(conn: Party.Connection) {
    if (!this.canAccessContent(conn.id)) return;

    if (this.speakers.has(conn.id)) {
      this.send(conn, { type: "error", code: "ALREADY_SPEAKER" });
      return;
    }

    if (this.speakRequests.has(conn.id)) {
      this.send(conn, { type: "error", code: "ALREADY_REQUESTED" });
      return;
    }

    const user = this.users.get(conn.id);
    const request: SpeakRequest = {
      userId: conn.id,
      userName: user?.name || "ゲスト",
      timestamp: Date.now()
    };

    this.speakRequests.set(conn.id, request);

    this.broadcastToHosts({
      type: "speakRequest",
      userId: conn.id,
      userName: request.userName
    });

    this.broadcastToHosts({
      type: "speakRequestsUpdate",
      requests: Array.from(this.speakRequests.values())
    });

    this.send(conn, { type: "speakRequestSent" });

    console.log(`[Server] 登壇リクエスト: ${conn.id}`);
  }

  // --------------------------------------------
  // ハンドラー: 登壇承認
  // --------------------------------------------
  handleApproveSpeak(conn: Party.Connection, data: any) {
    if (!this.isHost(conn.id)) {
      this.send(conn, { type: "error", code: "NOT_HOST" });
      return;
    }

    const userId = data.userId;
    const request = this.speakRequests.get(userId);

    if (!request) {
      this.send(conn, { type: "error", code: "NOT_FOUND" });
      return;
    }

    this.speakRequests.delete(userId);

    const speaker: Speaker = {
      id: userId,
      name: request.userName
    };
    this.speakers.set(userId, speaker);

    const targetConn = this.getConnection(userId);
    if (targetConn) {
      this.send(targetConn, { type: "speakApproved" });
    }

    this.broadcastAllowed({
      type: "speakerJoined",
      odUserId: userId,
      userName: speaker.name,
      speakers: Array.from(this.speakers.keys())
    });

    this.broadcastToHosts({
      type: "speakRequestsUpdate",
      requests: Array.from(this.speakRequests.values())
    });

    console.log(`[Server] 登壇承認: ${userId}`);
  }

  // --------------------------------------------
  // ハンドラー: 登壇拒否
  // --------------------------------------------
  handleDenySpeak(conn: Party.Connection, data: any) {
    if (!this.isHost(conn.id)) {
      this.send(conn, { type: "error", code: "NOT_HOST" });
      return;
    }

    const userId = data.userId;
    this.speakRequests.delete(userId);

    const targetConn = this.getConnection(userId);
    if (targetConn) {
      this.send(targetConn, {
        type: "speakDenied",
        reason: "主催者により却下されました"
      });
    }

    this.broadcastToHosts({
      type: "speakRequestsUpdate",
      requests: Array.from(this.speakRequests.values())
    });

    console.log(`[Server] 登壇拒否: ${userId}`);
  }

  // --------------------------------------------
  // ハンドラー: 登壇者キック
  // --------------------------------------------
  handleKickSpeaker(conn: Party.Connection, data: any) {
    if (!this.isHost(conn.id)) {
      this.send(conn, { type: "error", code: "NOT_HOST" });
      return;
    }

    const userId = data.userId;
    this.speakers.delete(userId);

    const targetConn = this.getConnection(userId);
    if (targetConn) {
      this.send(targetConn, { type: "kicked" });
    }

    this.broadcastAllowed({
      type: "speakerLeft",
      odUserId: userId,
      speakers: Array.from(this.speakers.keys())
    });

    console.log(`[Server] 登壇者キック: ${userId}`);
  }

  // --------------------------------------------
  // ハンドラー: 登壇終了
  // --------------------------------------------
  handleStopSpeak(conn: Party.Connection) {
    if (!this.speakers.has(conn.id)) return;

    this.speakers.delete(conn.id);

    this.broadcastAllowed({
      type: "speakerLeft",
      odUserId: conn.id,
      speakers: Array.from(this.speakers.keys())
    });

    console.log(`[Server] 登壇終了: ${conn.id}`);
  }

  // --------------------------------------------
  // ハンドラー: アナウンス
  // --------------------------------------------
  handleAnnounce(conn: Party.Connection, data: any) {
    if (!this.isHost(conn.id)) {
      this.send(conn, { type: "error", code: "NOT_HOST" });
      return;
    }

    this.broadcastAllowed({
      type: "announce",
      message: data.message
    });

    console.log(`[Server] アナウンス: ${data.message}`);
  }

  // --------------------------------------------
  // ハンドラー: 背景変更
  // --------------------------------------------
  handleBackgroundChange(conn: Party.Connection, data: any) {
    if (!this.isHost(conn.id)) {
      this.send(conn, { type: "error", code: "NOT_HOST" });
      return;
    }

    this.backgroundUrl = data.url || "";

    this.broadcastAllowed({
      type: "backgroundChange",
      url: this.backgroundUrl
    });

    console.log(`[Server] 背景変更: ${this.backgroundUrl}`);
  }

  // --------------------------------------------
  // ハンドラー: 明るさ変更
  // --------------------------------------------
  handleBrightnessChange(conn: Party.Connection, data: any) {
    if (!this.isHost(conn.id)) {
      this.send(conn, { type: "error", code: "NOT_HOST" });
      return;
    }

    this.brightness = data.value ?? 0.6;

    this.broadcastAllowed({
      type: "brightnessChange",
      value: this.brightness
    });

    console.log(`[Server] 明るさ変更: ${this.brightness}`);
  }
}
