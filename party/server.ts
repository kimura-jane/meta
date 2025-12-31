import type * as Party from "partykit/server";

const CLOUDFLARE_APP_ID = "137f0c04cc0e0dca2c59ecf740e8cb60";
const CLOUDFLARE_API_URL = "https://rtc.live.cloudflare.com/v1/apps";

interface User {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
}

export default class Server implements Party.Server {
  users: Map<string, User> = new Map();
  speakers: Set<string> = new Set();
  tracks: Map<string, string> = new Map();
  sessions: Map<string, string> = new Map();
  subscriberSessions: Map<string, string> = new Map();

  constructor(readonly room: Party.Room) {}

  getToken(): string {
    return (this.room.env as any).CLOUDFLARE_CALLS_TOKEN || "";
  }

  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    const url = new URL(ctx.request.url);
    const name = url.searchParams.get("name") || "ゲスト";

    const user: User = {
      id: conn.id,
      name,
      x: 0,
      y: 0,
      z: 0,
    };
    this.users.set(conn.id, user);

    conn.send(
      JSON.stringify({
        type: "init",
        users: Object.fromEntries(this.users),
        yourId: conn.id,
        speakers: Array.from(this.speakers),
        tracks: Array.from(this.tracks.entries()),
        sessions: Array.from(this.sessions.entries()),
      })
    );

    this.room.broadcast(
      JSON.stringify({
        type: "userJoin",
        user,
      }),
      [conn.id]
    );

    console.log(`User connected: ${conn.id} (${name})`);
  }

  onClose(conn: Party.Connection) {
    this.users.delete(conn.id);
    this.speakers.delete(conn.id);
    this.tracks.delete(conn.id);
    this.sessions.delete(conn.id);
    this.subscriberSessions.delete(conn.id);

    this.room.broadcast(
      JSON.stringify({
        type: "userLeave",
        odUserId: conn.id,
        speakers: Array.from(this.speakers),
      })
    );

    console.log(`User disconnected: ${conn.id}`);
  }

  async onMessage(message: string, sender: Party.Connection) {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case "position":
          this.handlePosition(data, sender);
          break;
        case "reaction":
          this.handleReaction(data, sender);
          break;
        case "chat":
          this.handleChat(data, sender);
          break;
        case "requestSpeak":
          await this.handleRequestSpeak(sender);
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
      }
    } catch (e) {
      console.error("Message handling error:", e);
    }
  }

  handlePosition(data: any, sender: Party.Connection) {
    const user = this.users.get(sender.id);
    if (user) {
      user.x = data.x;
      user.y = data.y;
      user.z = data.z;

      this.room.broadcast(
        JSON.stringify({
          type: "position",
          odUserId: sender.id,
          x: data.x,
          y: data.y,
          z: data.z,
        }),
        [sender.id]
      );
    }
  }

  handleReaction(data: any, sender: Party.Connection) {
    this.room.broadcast(
      JSON.stringify({
        type: "reaction",
        odUserId: sender.id,
        reaction: data.reaction,
        color: data.color,
      }),
      [sender.id]
    );
  }

  handleChat(data: any, sender: Party.Connection) {
    const user = this.users.get(sender.id);
    this.room.broadcast(
      JSON.stringify({
        type: "chat",
        name: user?.name || "ゲスト",
        message: data.message,
      })
    );
  }

  async handleRequestSpeak(sender: Party.Connection) {
    console.log(`[requestSpeak] from ${sender.id}`);

    if (this.speakers.size >= 5) {
      sender.send(
        JSON.stringify({
          type: "speakDenied",
          reason: "登壇者が上限（5人）に達しています",
        })
      );
      return;
    }

    if (this.speakers.has(sender.id)) {
      sender.send(
        JSON.stringify({
          type: "speakDenied",
          reason: "既に登壇中です",
        })
      );
      return;
    }

    const token = this.getToken();
    if (!token) {
      console.error("[requestSpeak] No token available");
      sender.send(
        JSON.stringify({
          type: "speakDenied",
          reason: "セッション作成に失敗しました",
        })
      );
      return;
    }

    try {
      const response = await fetch(
        `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/new`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        }
      );

      const result = await response.json() as any;
      console.log(`[createSession] response:`, JSON.stringify(result));

      if (!response.ok || result.errorCode || !result.sessionId) {
        console.error("[createSession] Failed:", result);
        sender.send(
          JSON.stringify({
            type: "speakDenied",
            reason: "セッション作成に失敗しました",
          })
        );
        return;
      }

      this.speakers.add(sender.id);
      this.sessions.set(sender.id, result.sessionId);

      sender.send(
        JSON.stringify({
          type: "speakApproved",
          sessionId: result.sessionId,
        })
      );

      this.room.broadcast(
        JSON.stringify({
          type: "speakerJoined",
          odUserId: sender.id,
          speakers: Array.from(this.speakers),
        }),
        [sender.id]
      );

      console.log(`[speakApproved] ${sender.id}, sessionId: ${result.sessionId}`);
    } catch (e) {
      console.error("[requestSpeak] Error:", e);
      sender.send(
        JSON.stringify({
          type: "speakDenied",
          reason: "セッション作成に失敗しました",
        })
      );
    }
  }

  handleStopSpeak(sender: Party.Connection) {
    console.log(`[stopSpeak] from ${sender.id}`);

    this.speakers.delete(sender.id);
    this.tracks.delete(sender.id);
    this.sessions.delete(sender.id);

    this.room.broadcast(
      JSON.stringify({
        type: "speakerLeft",
        odUserId: sender.id,
        speakers: Array.from(this.speakers),
      })
    );
  }

  async handlePublishTrack(data: any, sender: Party.Connection) {
    console.log(`[publishTrack] from ${sender.id}`);

    const token = this.getToken();
    if (!token) {
      sender.send(JSON.stringify({ type: "error", code: "NO_TOKEN" }));
      return;
    }

    try {
      const response = await fetch(
        `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${data.sessionId}/tracks/new`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sessionDescription: {
              type: "offer",
              sdp: data.offer.sdp,
            },
            tracks: data.tracks,
          }),
        }
      );

      const result = await response.json() as any;
      console.log(`[publishTrack] response:`, JSON.stringify(result));

      if (!response.ok || result.errorCode) {
        sender.send(
          JSON.stringify({
            type: "error",
            code: result.errorCode || "PUBLISH_FAILED",
          })
        );
        return;
      }

      const trackName = data.tracks[0]?.trackName;
      if (trackName) {
        this.tracks.set(sender.id, trackName);
      }

      sender.send(
        JSON.stringify({
          type: "trackPublished",
          answer: result.sessionDescription,
          tracks: result.tracks,
        })
      );

      this.room.broadcast(
        JSON.stringify({
          type: "newTrack",
          odUserId: sender.id,
          sessionId: data.sessionId,
          trackName: trackName,
        }),
        [sender.id]
      );

      console.log(`[trackPublished] ${sender.id}, trackName: ${trackName}`);
    } catch (e) {
      console.error("[publishTrack] Error:", e);
      sender.send(JSON.stringify({ type: "error", code: "PUBLISH_ERROR" }));
    }
  }

  async handleSubscribeTrack(data: any, sender: Party.Connection) {
    console.log(`[subscribeTrack] from ${sender.id}, trackName: ${data.trackName}`);

    const token = this.getToken();
    if (!token) {
      sender.send(JSON.stringify({ type: "error", code: "NO_TOKEN" }));
      return;
    }

    try {
      // 購読者用セッションを取得または作成
      let subscriberSessionId = this.subscriberSessions.get(sender.id);
      let isNewSession = false;

      if (!subscriberSessionId) {
        const sessionResponse = await fetch(
          `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/new`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
          }
        );

        const sessionResult = await sessionResponse.json() as any;
        console.log(`[subscribeTrack] new session:`, JSON.stringify(sessionResult));

        if (!sessionResponse.ok || !sessionResult.sessionId) {
          sender.send(JSON.stringify({ type: "error", code: "SESSION_CREATE_FAILED" }));
          return;
        }

        subscriberSessionId = sessionResult.sessionId;
        this.subscriberSessions.set(sender.id, subscriberSessionId);
        isNewSession = true;
      }

      // トラックを購読
      const response = await fetch(
        `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${subscriberSessionId}/tracks/new`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            tracks: [
              {
                location: "remote",
                sessionId: data.remoteSessionId,
                trackName: data.trackName,
              },
            ],
          }),
        }
      );

      const result = await response.json() as any;
      console.log(`[subscribeTrack] response:`, JSON.stringify(result));

      if (!response.ok || result.errorCode) {
        sender.send(
          JSON.stringify({
            type: "error",
            code: result.errorCode || "SUBSCRIBE_FAILED",
          })
        );
        return;
      }

      sender.send(
        JSON.stringify({
          type: "subscribed",
          sessionId: subscriberSessionId,
          offer: result.sessionDescription,
          tracks: result.tracks,
          trackName: data.trackName,
          requiresImmediateRenegotiation: result.requiresImmediateRenegotiation ?? true,
          isNewSession: isNewSession,
        })
      );

      console.log(`[subscribed] sent to ${sender.id}`);
    } catch (e) {
      console.error("[subscribeTrack] Error:", e);
      sender.send(JSON.stringify({ type: "error", code: "SUBSCRIBE_ERROR" }));
    }
  }

  async handleSubscribeAnswer(data: any, sender: Party.Connection) {
    console.log(`[subscribeAnswer] from ${sender.id}`);

    const token = this.getToken();
    if (!token) {
      sender.send(JSON.stringify({ type: "error", code: "NO_TOKEN" }));
      return;
    }

    try {
      const response = await fetch(
        `${CLOUDFLARE_API_URL}/${CLOUDFLARE_APP_ID}/sessions/${data.sessionId}/renegotiate`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sessionDescription: {
              type: "answer",
              sdp: data.answer.sdp,
            },
          }),
        }
      );

      const result = await response.json() as any;
      console.log(`[subscribeAnswer] response:`, JSON.stringify(result));

      sender.send(JSON.stringify({ type: "subscribeAnswerAck" }));
    } catch (e) {
      console.error("[subscribeAnswer] Error:", e);
    }
  }
}
