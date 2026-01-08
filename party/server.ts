import type * as Party from "partykit/server";

const CLOUDFLARE_APP_ID = "137f0c04cc0e0dca2c59ecf740e8cb60";
const CLOUDFLARE_API_URL = "https://rtc.live.cloudflare.com/v1/apps";

interface User {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  avatarUrl: string | null;
  isSpeaker: boolean;
  sessionId: string | null;
}

interface SpeakRequest {
  userId: string;
  userName: string;
  timestamp: number;
}

type TurnCredentials = {
  username: string;
  credential: string;
};

export default class Server implements Party.Server {
  users: Record<string, User> = {};
  speakers: Set<string> = new Set();
  tracks: Map<string, string> = new Map();    // speakerUserId -> trackName
  sessions: Map<string, string> = new Map();  // speakerUserId -> sessionId
  subscriberSessions: Map<string, string> = new Map(); // `${subscriberId}-${trackName}` -> sessionId
  speakRequests: SpeakRequest[] = [];

  // ✅ 主催者認証済み connection.id
  hosts: Set<string> = new Set();

  // ✅ 秘密会議
  secretMode: boolean = false;         // ONなら未認証へ中身を送らない
  authed: Set<string> = new Set();     // 入室パス OK の connection.id
  joined: Set<string> = new Set();     // “中身世界”へ参加済み（userJoin発行済み）

  // ルーム共通（任意）
  brightness: number | null = null;
  backgroundUrl: string | null = null;

  constructor(readonly room: Party.Room) {}

  // --------------------------
  // Secrets / Tokens
  // --------------------------
  getToken(): string {
    return (this.room.env.CLOUDFLARE_CALLS_TOKEN as string) || "";
  }

  getHostPassword(): string {
    // PartyKit Secrets で HOST_PASSWORD を設定
    return (this.room.env.HOST_PASSWORD as string) || "";
  }

  getRoomPassword(): string {
    // PartyKit Secrets で ROOM_PASSWORD を設定（秘密会議の入室パス）
    return (this.room.env.ROOM_PASSWORD as string) || "";
  }

  isHost(connId: string): boolean {
    return this.hosts.has(connId);
  }

  isAuthed(connId: string): boolean {
    // host は入室パス無しでも通す（主催者は救済）
    return this.authed.has(connId) || this.isHost(connId);
  }

  canAccessContent(connId: string): boolean {
    return !this.secretMode || this.isAuthed(connId);
  }

  // --------------------------
  // Send Helpers
  // --------------------------
  send(conn: Party.Connection, payload: any) {
    conn.send(JSON.stringify(payload));
  }

  sendInitMin(conn: Party.Connection) {
    this.send(conn, {
      type: "initMin",
      yourId: conn.id,
      secretMode: this.secretMode,
      isHost: this.isHost(conn.id),
      isAuthed: this.isAuthed(conn.id),
      authRequired: this.secretMode, // secretModeの時は基本required
    });
  }

  buildVisibleUsers(): Record<string, User> {
    if (!this.secretMode) return this.users;

    const visible: Record<string, User> = {};
    for (const [id, u] of Object.entries(this.users)) {
      if (this.isAuthed(id)) visible[id] = u;
    }
    return visible;
  }

  buildVisibleSpeakers(): string[] {
    if (!this.secretMode) return Array.from(this.speakers);

    // secretMode時は authed speaker だけ
    return Array.from(this.speakers).filter((id) => this.isAuthed(id));
  }

  buildVisibleTracksEntries(): [string, string][] {
    const entries = Array.from(this.tracks.entries());
    if (!this.secretMode) return entries;
    return entries.filter(([speakerId]) => this.isAuthed(speakerId));
  }

  buildVisibleSessionsEntries(): [string, string][] {
    const entries = Array.from(this.sessions.entries());
    if (!this.secretMode) return entries;
    return entries.filter(([speakerId]) => this.isAuthed(speakerId));
  }

  buildVisibleSpeakRequests(): SpeakRequest[] {
    if (!this.secretMode) return this.speakRequests;
    return this.speakRequests.filter((r) => this.isAuthed(r.userId));
  }

  sendFullInit(conn: Party.Connection) {
    const payload: any = {
      type: "init",
      users: this.buildVisibleUsers(),
      yourId: conn.id,
      speakers: this.buildVisibleSpeakers(),
      tracks: this.buildVisibleTracksEntries(),
      sessions: this.buildVisibleSessionsEntries(),
      speakRequests: this.buildVisibleSpeakRequests(),
    };

    if (this.brightness !== null) payload.brightness = this.brightness;
    if (this.backgroundUrl) payload.backgroundUrl = this.backgroundUrl;

    // TURN は今は無し（必要なら追加）
    // payload.turnCredentials = ...;

    this.send(conn, payload);
  }

  broadcastAllowed(payload: any, excludeIds: string[] = []) {
    const json = JSON.stringify(payload);

    if (!this.secretMode) {
      this.room.broadcast(json, excludeIds);
      return;
    }

    // secretMode: authed/host のみへ送る
    for (const id of Object.keys(this.users)) {
      if (excludeIds.includes(id)) continue;
      if (!this.isAuthed(id)) continue;
      const c = this.room.getConnection(id);
      if (c) c.send(json);
    }
  }

  completeJoin(conn: Party.Connection) {
    // already joined
    if (this.joined.has(conn.id)) {
      // 参加済みでも、念のため full init は返して良い
      this.sendFullInit(conn);
      return;
    }

    this.joined.add(conn.id);

    // full init（中身）
    this.sendFullInit(conn);

    // 他の参加者へ userJoin（中身）
    const u = this.users[conn.id];
    if (u) {
      this.broadcastAllowed(
        {
          type: "userJoin",
          odUserId: conn.id,
          userName: u.name,
          user: u,
        },
        [conn.id]
      );
    }
  }

  // --------------------------
  // Connect / Close
  // --------------------------
  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    const url = new URL(ctx.request.url);
    const name = url.searchParams.get("name") || "匿名";

    const user: User = {
      id: conn.id,
      name,
      x: Math.random() * 10 - 5,
      y: 0,
      z: Math.random() * 10 - 5,
      avatarUrl: null,
      isSpeaker: false,
      sessionId: null,
    };

    this.users[conn.id] = user;

    // 秘密会議 ON の場合：まず initMin だけ（未認証は中身禁止）
    if (this.secretMode && !this.isAuthed(conn.id)) {
      this.sendInitMin(conn);
      console.log(`[onConnect] (secret) User ${conn.id} (${name}) joined as UNAUTH`);
      return;
    }

    // 通常 or 認証済み：中身へ参加
    this.completeJoin(conn);
    console.log(`[onConnect] User ${conn.id} (${name}) joined`);
  }

  onClose(conn: Party.Connection) {
    const user = this.users[conn.id];
    if (!user) return;

    console.log(`[onClose] User ${conn.id} (${user.name}) left`);

    // host / auth / joined から除外
    this.hosts.delete(conn.id);
    this.authed.delete(conn.id);
    this.joined.delete(conn.id);

    // speaker から除外
    this.speakers.delete(conn.id);
    this.tracks.delete(conn.id);
    this.sessions.delete(conn.id);

    // speakRequests から除外
    this.speakRequests = this.speakRequests.filter((r) => r.userId !== conn.id);

    // subscriber session cleanup
    for (const [key] of this.subscriberSessions) {
      if (key.startsWith(`${conn.id}-`)) {
        this.subscriberSessions.delete(key);
      }
    }

    delete this.users[conn.id];

    // secretMode中は「中身参加者にだけ」通知
    this.broadcastAllowed({
      type: "userLeave",
      odUserId: conn.id,
      speakers: this.buildVisibleSpeakers(),
    });

    this.broadcastAllowed({
      type: "speakRequestsUpdate",
      requests: this.buildVisibleSpeakRequests(),
    });
  }

  // --------------------------
  // Message Router
  // --------------------------
  async onMessage(message: string, sender: Party.Connection) {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        // --------------------
        // Secret Mode / Auth
        // --------------------
        case "requestInit": {
          // クライアントが authOk 後に叩く保険
          if (this.canAccessContent(sender.id)) this.completeJoin(sender);
          else this.sendInitMin(sender);
          break;
        }

        case "auth": {
          // 入室パス（秘密会議）
          const expected = this.getRoomPassword();
          if (!expected) {
            // パス未設定なら秘密会議を成立させない（事故防止）
            this.send(sender, { type: "authNg" });
            console.warn("[auth] ROOM_PASSWORD not set");
            break;
          }

          const ok = typeof data.password === "string" && data.password === expected;
          if (!ok) {
            this.send(sender, { type: "authNg" });
            break;
          }

          this.authed.add(sender.id);
          this.send(sender, { type: "authOk" });

          // 認証OKなら中身へ参加させる
          this.completeJoin(sender);

          console.log(`[auth] OK: ${sender.id}`);
          break;
        }

        case "disableSecretMode": {
          // 主催者だけ
          if (!this.isHost(sender.id)) {
            this.send(sender, { type: "error", code: "SRV_ERR_NOT_HOST" });
            break;
          }

          this.secretMode = false;

          // secretMode OFF なら全員が中身アクセス可能：joined を全員分にして init を再配布
          for (const id of Object.keys(this.users)) {
            this.joined.add(id);
          }

          this.broadcastAllowed({ type: "secretModeChanged", value: false });

          // 全員へ full init（今後の整合）
          for (const id of Object.keys(this.users)) {
            const c = this.room.getConnection(id);
            if (c) this.sendFullInit(c);
          }

          console.log(`[disableSecretMode] OFF by host ${sender.id}`);
          break;
        }

        // 任意：主催者が秘密会議を ON/OFF する拡張（settings.js から使える）
        case "setSecretMode": {
          if (!this.isHost(sender.id)) {
            this.send(sender, { type: "error", code: "SRV_ERR_NOT_HOST" });
            break;
          }
          const value = !!data.value;
          this.secretMode = value;

          if (value) {
            // 有効化時：今いる全員は継続して見れるように “既存参加者は自動認証” にする（現実運用向け）
            for (const id of Object.keys(this.users)) {
              this.authed.add(id);
              this.joined.add(id);
            }
          }

          // 状態通知
          const json = JSON.stringify({ type: "secretModeChanged", value });
          this.room.broadcast(json);

          // 誰かが未joinだったら join 扱いにして init を再配布
          for (const id of Object.keys(this.users)) {
            const c = this.room.getConnection(id);
            if (c && (!value || this.isAuthed(id))) {
              this.sendFullInit(c);
            } else if (c && value && !this.isAuthed(id)) {
              this.sendInitMin(c);
            }
          }

          console.log(`[setSecretMode] ${value} by host ${sender.id}`);
          break;
        }

        // --------------------
        // Host Auth
        // --------------------
        // connection.js は hostAuth / hostLogout / hostAuthResult を使う
        case "hostAuth":
        case "hostLogin": {
          this.handleHostAuth(sender, data.password);
          break;
        }

        case "hostLogout": {
          this.handleHostLogout(sender);
          break;
        }

        // --------------------
        // Content messages (blocked in secretMode if unauth)
        // --------------------
        case "position": {
          if (!this.canAccessContent(sender.id)) break;

          if (this.users[sender.id]) {
            this.users[sender.id].x = data.x;
            this.users[sender.id].y = data.y ?? 0;
            this.users[sender.id].z = data.z;

            this.broadcastAllowed(
              {
                type: "position",
                odUserId: sender.id,
                x: data.x,
                y: data.y ?? 0,
                z: data.z,
              },
              [sender.id]
            );
          }
          break;
        }

        case "avatarChange": {
          if (!this.canAccessContent(sender.id)) break;

          if (this.users[sender.id]) {
            this.users[sender.id].avatarUrl = data.imageUrl;
            this.broadcastAllowed(
              {
                type: "avatarChange",
                odUserId: sender.id,
                imageUrl: data.imageUrl,
              },
              [sender.id]
            );
          }
          break;
        }

        case "nameChange": {
          if (!this.canAccessContent(sender.id)) break;

          if (this.users[sender.id]) {
            this.users[sender.id].name = data.name;
            this.broadcastAllowed(
              {
                type: "nameChange",
                odUserId: sender.id,
                name: data.name,
              },
              [sender.id]
            );
          }
          break;
        }

        case "reaction": {
          if (!this.canAccessContent(sender.id)) break;

          this.broadcastAllowed({
            type: "reaction",
            odUserId: sender.id,
            reaction: data.reaction,
            color: data.color,
          });
          break;
        }

        case "chat": {
          if (!this.canAccessContent(sender.id)) break;

          this.broadcastAllowed({
            type: "chat",
            odUserId: sender.id,
            senderId: sender.id,
            name: this.users[sender.id]?.name || "匿名",
            message: data.message,
          });
          break;
        }

        // --------------------
        // Speak Request / Approve / Deny / Kick
        // --------------------
        case "requestSpeak": {
          if (!this.canAccessContent(sender.id)) {
            this.send(sender, { type: "speakDenied", reason: "入室認証が必要です" });
            break;
          }
          await this.handleRequestSpeak(sender);
          break;
        }

        case "approveSpeak": {
          if (!this.canAccessContent(sender.id)) {
            this.send(sender, { type: "error", code: "SRV_ERR_AUTH_REQUIRED" });
            break;
          }
          await this.handleApproveSpeak(sender, data.userId);
          break;
        }

        case "denySpeak": {
          if (!this.canAccessContent(sender.id)) {
            this.send(sender, { type: "error", code: "SRV_ERR_AUTH_REQUIRED" });
            break;
          }
          this.handleDenySpeak(sender, data.userId);
          break;
        }

        case "kickSpeaker": {
          if (!this.canAccessContent(sender.id)) {
            this.send(sender, { type: "error", code: "SRV_ERR_AUTH_REQUIRED" });
            break;
          }
          await this.handleKickSpeaker(sender, data.userId);
          break;
        }

        case "stopSpeak": {
          if (!this.canAccessContent(sender.id)) break;
          await this.handleStopSpeak(sender);
          break;
        }

        // --------------------
        // Cloudflare Calls (publish / subscribe)
        // --------------------
        case "publishTrack": {
          if (!this.canAccessContent(sender.id)) {
            this.send(sender, { type: "error", code: "SRV_ERR_AUTH_REQUIRED" });
            break;
          }
          await this.handlePublishTrack(sender, data);
          break;
        }

        case "subscribeTrack": {
          if (!this.canAccessContent(sender.id)) {
            this.send(sender, { type: "error", code: "SRV_ERR_AUTH_REQUIRED" });
            break;
          }
          await this.handleSubscribeTrack(sender, data);
          break;
        }

        case "subscribeAnswer": {
          if (!this.canAccessContent(sender.id)) {
            this.send(sender, { type: "error", code: "SRV_ERR_AUTH_REQUIRED" });
            break;
          }
          await this.handleSubscribeAnswer(sender, data);
          break;
        }

        // --------------------
        // Room UI state
        // --------------------
        case "backgroundChange": {
          if (!this.canAccessContent(sender.id)) break;

          this.backgroundUrl = data.url || null;
          this.broadcastAllowed({ type: "backgroundChange", url: data.url });
          break;
        }

        case "brightnessChange": {
          if (!this.canAccessContent(sender.id)) break;

          const v = Number(data.value);
          this.brightness = Number.isFinite(v) ? v : this.brightness;
          this.broadcastAllowed({ type: "brightnessChange", value: data.value });
          break;
        }

        case "announce": {
          if (!this.canAccessContent(sender.id)) break;

          this.broadcastAllowed({ type: "announce", message: data.message });
          break;
        }
      }
    } catch (e) {
      console.error("[onMessage] Error:", e);
    }
  }

  // --------------------------
  // Host Auth (connection.js互換: hostAuthResult)
  // --------------------------
  handleHostAuth(sender: Party.Connection, password?: string) {
    const expected = this.getHostPassword();

    if (!expected) {
      console.warn("[handleHostAuth] HOST_PASSWORD is not set");
      this.send(sender, { type: "hostAuthResult", ok: false, reason: "HOST_PASSWORD未設定" });
      return;
    }

    if (!password || password !== expected) {
      console.log(`[handleHostAuth] Host auth failed for ${sender.id}`);
      this.send(sender, { type: "hostAuthResult", ok: false, reason: "パスワード不一致" });
      return;
    }

    this.hosts.add(sender.id);
    console.log(`[handleHostAuth] Host auth OK: ${sender.id}`);

    // host は秘密会議でも中身へ入れる（救済）
    if (this.secretMode) this.authed.add(sender.id);

    this.send(sender, {
      type: "hostAuthResult",
      ok: true,
      reason: "",
      isHost: true,
    });

    // host が未join扱いだった場合はここで中身へ参加
    if (this.secretMode && !this.joined.has(sender.id)) {
      this.completeJoin(sender);
    }
  }

  handleHostLogout(sender: Party.Connection) {
    if (this.hosts.has(sender.id)) {
      this.hosts.delete(sender.id);
      console.log(`[handleHostLogout] Host logout: ${sender.id}`);
    }

    // host解除。secretMode中なら入室パスを持ってないと落ちる（安全側）
    if (this.secretMode && !this.authed.has(sender.id)) {
      this.joined.delete(sender.id);
      this.sendInitMin(sender);
    }

    this.send(sender, { type: "hostAuthResult", ok: false, reason: "logout", isHost: false });
  }

  // --------------------------
  // Speak Request / Approve / Deny / Kick
  // --------------------------
  async handleRequestSpeak(sender: Party.Connection) {
    console.log(`[handleRequestSpeak] User ${sender.id} requesting to speak`);

    if (this.speakers.size >= 5) {
      this.send(sender, { type: "speakDenied", reason: "満員です" });
      return;
    }

    if (this.speakRequests.find((r) => r.userId === sender.id)) {
      this.send(sender, { type: "speakDenied", reason: "既にリクエスト済みです" });
      return;
    }

    if (this.speakers.has(sender.id)) {
      this.send(sender, { type: "speakDenied", reason: "既に登壇中です" });
      return;
    }

    const request: SpeakRequest = {
      userId: sender.id,
      userName: this.users[sender.id]?.name || "匿名",
      timestamp: Date.now(),
    };
    this.speakRequests.push(request);

    // secretMode中は参加者（authed）にだけ投げる
    this.broadcastAllowed({
      type: "speakRequest",
      userId: sender.id,
      userName: request.userName,
    });

    this.broadcastAllowed({
      type: "speakRequestsUpdate",
      requests: this.buildVisibleSpeakRequests(),
    });

    console.log(`[handleRequestSpeak] Request added, total: ${this.speakRequests.length}`);
  }

  async handleApproveSpeak(sender: Party.Connection, targetUserId: string) {
    if (!this.isHost(sender.id)) {
      console.warn(`[handleApproveSpeak] BLOCKED: non-host ${sender.id} tried approve ${targetUserId}`);
      this.send(sender, { type: "error", code: "SRV_ERR_NOT_HOST" });
      return;
    }

    console.log(`[handleApproveSpeak] Approving user ${targetUserId} by host ${sender.id}`);

    const hasRequest = this.speakRequests.some((r) => r.userId === targetUserId);
    if (!hasRequest) {
      console.warn(`[handleApproveSpeak] BLOCKED: no speakRequest for ${targetUserId}`);
      this.send(sender, { type: "error", code: "SRV_ERR_NO_SPEAK_REQUEST" });
      return;
    }

    this.speakRequests = this.speakRequests.filter((r) => r.userId !== targetUserId);

    const targetConn = this.room.getConnection(targetUserId);
    if (!targetConn) {
      this.broadcastAllowed({ type: "speakRequestsUpdate", requests: this.buildVisibleSpeakRequests() });
      return;
    }

    if (this.speakers.size >= 5) {
      this.send(targetConn, { type: "speakDenied", reason: "満員です" });
      this.broadcastAllowed({ type: "speakRequestsUpdate", requests: this.buildVisibleSpeakRequests() });
      return;
    }

    const result = await this.createSession();
    if (!result.success || !result.sessionId) {
      this.send(targetConn, { type: "speakDenied", reason: result.error || "セッション作成失敗" });
      this.broadcastAllowed({ type: "speakRequestsUpdate", requests: this.buildVisibleSpeakRequests() });
      return;
    }

    // 登壇確定
    this.speakers.add(targetUserId);
    this.sessions.set(targetUserId, result.sessionId);

    if (this.users[targetUserId]) {
      this.users[targetUserId].isSpeaker = true;
      this.users[targetUserId].sessionId = result.sessionId;
    }

    // 承認は対象へ
    this.send(targetConn, { type: "speakApproved", sessionId: result.sessionId });

    // 参加者へ通知（target除外）
    this.broadcastAllowed(
      {
        type: "speakerJoined",
        odUserId: targetUserId,
        userName: this.users[targetUserId]?.name || "匿名",
        sessionId: result.sessionId,
        speakers: this.buildVisibleSpeakers(),
      },
      [targetUserId]
    );

    this.broadcastAllowed({ type: "speakRequestsUpdate", requests: this.buildVisibleSpeakRequests() });

    console.log(`[handleApproveSpeak] Approved ${targetUserId}, session=${result.sessionId}`);
  }

  handleDenySpeak(sender: Party.Connection, targetUserId: string) {
    if (!this.isHost(sender.id)) {
      console.warn(`[handleDenySpeak] BLOCKED: non-host ${sender.id} tried deny ${targetUserId}`);
      this.send(sender, { type: "error", code: "SRV_ERR_NOT_HOST" });
      return;
    }

    const hasRequest = this.speakRequests.some((r) => r.userId === targetUserId);
    if (!hasRequest) {
      this.send(sender, { type: "error", code: "SRV_ERR_NO_SPEAK_REQUEST" });
      return;
    }

    this.speakRequests = this.speakRequests.filter((r) => r.userId !== targetUserId);

    const targetConn = this.room.getConnection(targetUserId);
    if (targetConn) {
      this.send(targetConn, { type: "speakDenied", reason: "リクエストが却下されました" });
    }

    this.broadcastAllowed({ type: "speakRequestsUpdate", requests: this.buildVisibleSpeakRequests() });

    console.log(`[handleDenySpeak] Denied ${targetUserId}`);
  }

  async handleKickSpeaker(sender: Party.Connection, targetUserId: string) {
    if (!this.isHost(sender.id)) {
      console.warn(`[handleKickSpeaker] BLOCKED: non-host ${sender.id} tried kick ${targetUserId}`);
      this.send(sender, { type: "error", code: "SRV_ERR_NOT_HOST" });
      return;
    }

    if (!this.speakers.has(targetUserId)) return;

    this.speakers.delete(targetUserId);
    this.tracks.delete(targetUserId);
    this.sessions.delete(targetUserId);

    if (this.users[targetUserId]) {
      this.users[targetUserId].isSpeaker = false;
      this.users[targetUserId].sessionId = null;
    }

    const targetConn = this.room.getConnection(targetUserId);
    if (targetConn) {
      this.send(targetConn, { type: "kicked" });
    }

    this.broadcastAllowed({
      type: "speakerLeft",
      odUserId: targetUserId,
      speakers: this.buildVisibleSpeakers(),
    });

    console.log(`[handleKickSpeaker] Kicked ${targetUserId}`);
  }

  async handleStopSpeak(sender: Party.Connection) {
    this.speakers.delete(sender.id);
    this.tracks.delete(sender.id);
    this.sessions.delete(sender.id);

    if (this.users[sender.id]) {
      this.users[sender.id].isSpeaker = false;
      this.users[sender.id].sessionId = null;
    }

    this.broadcastAllowed({
      type: "speakerLeft",
      odUserId: sender.id,
      speakers: this.buildVisibleSpeakers(),
    });
  }

  // --------------------------
  // Cloudflare Calls (publish / subscribe)
  // --------------------------
  async handlePublishTrack(sender: Party.Connection, data: any) {
    const token = this.getToken();
    if (!token) {
      this.send(sender, { type: "error", code: "SRV_ERR_TOKEN_NOT_SET" });
      return;
    }

    // ✅ speaker 以外は publish 禁止
    if (!this.speakers.has(sender.id)) {
      this.send(sender, { type: "error", code: "SRV_ERR_NOT_SPEAKER" });
      return;
    }

    const expectedSessionId = this.sessions.get(sender.id);
    const sessionId = data.sessionId;

    // ✅ sessionId なりすまし防止
    if (!expectedSessionId || sessionId !== expectedSessionId) {
      this.send(sender, { type: "error", code: "SRV_ERR_SESSION_MISMATCH" });
      return;
    }

    const offer = data.offer;
    if (!offer || !offer.sdp) {
      this.send(sender, { type: "error", code: "SRV_ERR_NO_OFFER" });
      return;
    }

    const tracks = data.tracks;
    if (!tracks || !Array.isArray(tracks) || tracks.length === 0) {
      this.send(sender, { type: "error", code: "SRV_ERR_NO_TRACKS" });
      return;
    }

    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (!t.mid) {
        this.send(sender, { type: "error", code: `SRV_ERR_TRACK_${i}_NO_MID` });
        return;
      }
      if (!t.trackName) {
        this.send(sender, { type: "error", code: `SRV_ERR_TRACK_${i}_NO_NAME` });
        return;
      }
    }

    const result = await this.publishTrack(sessionId, offer, tracks);

    if (result.success && result.answer) {
      const trackName = tracks[0].trackName || `audio-${sender.id}`;
      this.tracks.set(sender.id, trackName);

      this.send(sender, { type: "trackPublished", answer: result.answer });

      this.broadcastAllowed(
        {
          type: "newTrack",
          odUserId: sender.id,
          trackName,
          sessionId,
        },
        [sender.id]
      );
    } else {
      this.send(sender, { type: "error", code: result.error || "SRV_ERR_PUBLISH_FAILED" });
    }
  }

  async handleSubscribeTrack(sender: Party.Connection, data: any) {
    const { remoteSessionId, trackName } = data;

    if (!remoteSessionId || !trackName) {
      this.send(sender, { type: "error", code: "SRV_ERR_BAD_SUBSCRIBE_REQ" });
      return;
    }

    // ✅ trackName が現在公開されているものかチェック（適当な trackName で subscribe させない）
    let speakerId: string | null = null;
    for (const [sid, tname] of this.tracks.entries()) {
      if (tname === trackName) {
        speakerId = sid;
        break;
      }
    }
    if (!speakerId) {
      this.send(sender, { type: "error", code: "SRV_ERR_TRACK_NOT_FOUND" });
      return;
    }

    // ✅ remoteSessionId の整合（speaker の session と一致するか）
    const expectedRemoteSession = this.sessions.get(speakerId);
    if (!expectedRemoteSession || expectedRemoteSession !== remoteSessionId) {
      this.send(sender, { type: "error", code: "SRV_ERR_REMOTE_SESSION_MISMATCH" });
      return;
    }

    // subscriber 用の新規セッション
    const result = await this.createSession();
    if (!result.success || !result.sessionId) {
      this.send(sender, { type: "error", code: "SRV_ERR_SESSION_CREATE_FAILED" });
      return;
    }

    const subscriberSessionId = result.sessionId;
    const subscriptionKey = `${sender.id}-${trackName}`;
    this.subscriberSessions.set(subscriptionKey, subscriberSessionId);

    const subscribeResult = await this.subscribeTrack(subscriberSessionId, remoteSessionId, trackName);

    if (subscribeResult.success && subscribeResult.offer) {
      this.send(sender, {
        type: "subscribed",
        offer: subscribeResult.offer,
        sessionId: subscriberSessionId,
        trackName,
        tracks: subscribeResult.tracks,
      });
    } else {
      this.send(sender, { type: "error", code: subscribeResult.error || "SRV_ERR_SUBSCRIBE_FAILED" });
    }
  }

  async handleSubscribeAnswer(sender: Party.Connection, data: any) {
    const { sessionId, answer } = data;

    if (!sessionId) {
      this.send(sender, { type: "error", code: "SRV_ERR_NO_SESSION_ID" });
      return;
    }
    if (!answer || !answer.sdp) {
      this.send(sender, { type: "error", code: "SRV_ERR_NO_ANSWER_SDP" });
      return;
    }

    const result = await this.sendAnswer(sessionId, answer);

    if (result.success) {
      this.send(sender, { type: "subscribeAnswerAck", sessionId });
    } else {
      this.send(sender, { type: "error", code: result.error || "SRV_ERR_RENEGOTIATE_FAILED" });
    }
  }

  // --------------------------
  // Cloudflare Calls API helpers
  // --------------------------
  async createSession(): Promise<{ success: boolean; sessionId?: string; error?: string }> {
    const token = this.getToken();
    if (!token) return { success: false, error: "SRV_ERR_TOKEN_NOT_SET" };

    try {
      const url = `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/new`;

      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      const responseText = await res.text();
      if (!res.ok) return { success: false, error: `SRV_ERR_HTTP_${res.status}` };

      const json = JSON.parse(responseText);
      if (!json.sessionId) return { success: false, error: "SRV_ERR_NO_SESSION_ID_IN_RESPONSE" };

      return { success: true, sessionId: json.sessionId };
    } catch (e) {
      console.error("[createSession] Exception:", e);
      return { success: false, error: "SRV_ERR_EXCEPTION" };
    }
  }

  async publishTrack(
    sessionId: string,
    offer: { type: string; sdp: string },
    tracks: any[]
  ): Promise<{ success: boolean; answer?: any; error?: string }> {
    const token = this.getToken();
    if (!token) return { success: false, error: "SRV_ERR_TOKEN_NOT_SET" };

    try {
      const url = `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${sessionId}/tracks/new`;
      const body = {
        sessionDescription: { type: "offer", sdp: offer.sdp },
        tracks,
      };

      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const responseText = await res.text();
      if (!res.ok) return { success: false, error: `SRV_ERR_HTTP_${res.status}` };

      const json = JSON.parse(responseText);
      if (!json.sessionDescription) return { success: false, error: "SRV_ERR_NO_ANSWER" };

      return { success: true, answer: json.sessionDescription };
    } catch (e) {
      console.error("[publishTrack] Exception:", e);
      return { success: false, error: "SRV_ERR_EXCEPTION" };
    }
  }

  async subscribeTrack(
    subscriberSessionId: string,
    remoteSessionId: string,
    trackName: string
  ): Promise<{ success: boolean; offer?: any; tracks?: any[]; error?: string }> {
    const token = this.getToken();
    if (!token) return { success: false, error: "SRV_ERR_TOKEN_NOT_SET" };

    try {
      const url = `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${subscriberSessionId}/tracks/new`;
      const body = {
        tracks: [{ location: "remote", sessionId: remoteSessionId, trackName }],
      };

      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const responseText = await res.text();
      if (!res.ok) return { success: false, error: `SRV_ERR_HTTP_${res.status}` };

      const json = JSON.parse(responseText);
      const offer = json.sessionDescription;

      return { success: true, offer, tracks: json.tracks };
    } catch (e) {
      console.error("[subscribeTrack] Exception:", e);
      return { success: false, error: "SRV_ERR_EXCEPTION" };
    }
  }

  async sendAnswer(
    sessionId: string,
    answer: { type: string; sdp: string }
  ): Promise<{ success: boolean; error?: string }> {
    const token = this.getToken();
    if (!token) return { success: false, error: "SRV_ERR_TOKEN_NOT_SET" };

    try {
      const url = `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${sessionId}/renegotiate`;
      const body = { sessionDescription: { type: "answer", sdp: answer.sdp } };

      const res = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) return { success: false, error: `SRV_ERR_HTTP_${res.status}` };

      return { success: true };
    } catch (e) {
      console.error("[sendAnswer] Exception:", e);
      return { success: false, error: "SRV_ERR_EXCEPTION" };
    }
  }
}
