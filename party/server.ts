import type * as Party from "partykit/server";

const CLOUDFLARE_APP_ID = "137f0c04cc0e0dca2c59ecf740e8cb60";

export default class Server implements Party.Server {
  constructor(readonly room: Party.Room) {}

  users: Record<string, any> = {};
  speakers: Set<string> = new Set(); // 登壇者リスト

  async onConnect(connection: Party.Connection, ctx: Party.ConnectionContext) {
    const userId = connection.id;
    
    this.users[userId] = {
      id: userId,
      x: (Math.random() - 0.5) * 8,
      y: 0.5,
      z: 5 + Math.random() * 3,
      isSpeaker: false,
      sessionId: null
    };

    connection.send(JSON.stringify({
      type: 'init',
      users: this.users,
      yourId: userId,
      speakers: Array.from(this.speakers)
    }));

    this.room.broadcast(JSON.stringify({
      type: 'userJoin',
      user: this.users[userId]
    }), [connection.id]);
  }

  async onMessage(message: string, sender: Party.Connection) {
    const data = JSON.parse(message);

    switch (data.type) {
      case 'position':
        if (this.users[sender.id]) {
          this.users[sender.id].x = data.x;
          this.users[sender.id].y = data.y;
          this.users[sender.id].z = data.z;
        }
        this.room.broadcast(JSON.stringify({
          type: 'position',
          userId: sender.id,
          x: data.x,
          y: data.y,
          z: data.z
        }), [sender.id]);
        break;

      case 'reaction':
        this.room.broadcast(JSON.stringify({
          type: 'reaction',
          userId: sender.id,
          reaction: data.reaction,
          color: data.color
        }), [sender.id]);
        break;

      case 'chat':
        this.room.broadcast(JSON.stringify({
          type: 'chat',
          userId: sender.id,
          name: data.name,
          message: data.message
        }));
        break;

      // === 音声通話関連 ===
      case 'requestSpeak':
        // 登壇リクエスト
        if (this.speakers.size < 5) {
          this.speakers.add(sender.id);
          this.users[sender.id].isSpeaker = true;
          
          // Cloudflare Callsセッション作成
          const session = await this.createCallSession();
          if (session) {
            this.users[sender.id].sessionId = session.sessionId;
            sender.send(JSON.stringify({
              type: 'speakApproved',
              sessionId: session.sessionId
            }));
          }
          
          this.room.broadcast(JSON.stringify({
            type: 'speakerJoined',
            userId: sender.id,
            speakers: Array.from(this.speakers)
          }));
        } else {
          sender.send(JSON.stringify({
            type: 'speakDenied',
            reason: '登壇者は最大5人までです'
          }));
        }
        break;

      case 'stopSpeak':
        // 登壇終了
        this.speakers.delete(sender.id);
        this.users[sender.id].isSpeaker = false;
        this.users[sender.id].sessionId = null;
        
        this.room.broadcast(JSON.stringify({
          type: 'speakerLeft',
          userId: sender.id,
          speakers: Array.from(this.speakers)
        }));
        break;

      case 'offer':
        // WebRTC Offer を Cloudflare に転送
        const offerResponse = await this.sendOfferToCloudflare(data.sessionId, data.offer, data.trackInfo);
        if (offerResponse) {
          sender.send(JSON.stringify({
            type: 'answer',
            answer: offerResponse.answer,
            trackInfo: offerResponse.trackInfo
          }));
        }
        break;

      case 'subscribeTrack':
        // 他の登壇者のトラックを購読
        const subscribeResponse = await this.subscribeToTrack(data.sessionId, data.trackId);
        if (subscribeResponse) {
          sender.send(JSON.stringify({
            type: 'subscribeAnswer',
            answer: subscribeResponse.answer
          }));
        }
        break;
    }
  }

  async onClose(connection: Party.Connection) {
    this.speakers.delete(connection.id);
    delete this.users[connection.id];
    
    this.room.broadcast(JSON.stringify({
      type: 'userLeave',
      userId: connection.id,
      speakers: Array.from(this.speakers)
    }));
  }

  // Cloudflare Calls APIメソッド
  private async createCallSession(): Promise<{ sessionId: string } | null> {
    try {
      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/apps/${CLOUDFLARE_APP_ID}/sessions/new`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.room.env.CLOUDFLARE_CALLS_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({})
        }
      );
      const result = await response.json() as any;
      return { sessionId: result.sessionId };
    } catch (error) {
      console.error('Failed to create session:', error);
      return null;
    }
  }

  private async sendOfferToCloudflare(
    sessionId: string, 
    offer: RTCSessionDescriptionInit,
    trackInfo: { trackName: string; mid: string }
  ): Promise<any> {
    try {
      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/apps/${CLOUDFLARE_APP_ID}/sessions/${sessionId}/tracks/new`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.room.env.CLOUDFLARE_CALLS_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            sessionDescription: {
              type: 'offer',
              sdp: offer.sdp
            },
            tracks: [{
              location: 'local',
              trackName: trackInfo.trackName,
              mid: trackInfo.mid
            }]
          })
        }
      );
      const result = await response.json() as any;
      return {
        answer: result.sessionDescription,
        trackInfo: result.tracks
      };
    } catch (error) {
      console.error('Failed to send offer:', error);
      return null;
    }
  }

  private async subscribeToTrack(sessionId: string, trackId: string): Promise<any> {
    try {
      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/apps/${CLOUDFLARE_APP_ID}/sessions/${sessionId}/tracks/new`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.room.env.CLOUDFLARE_CALLS_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            tracks: [{
              location: 'remote',
              trackName: trackId,
              sessionId: sessionId
            }]
          })
        }
      );
      const result = await response.json() as any;
      return { answer: result.sessionDescription };
    } catch (error) {
      console.error('Failed to subscribe:', error);
      return null;
    }
  }
}
