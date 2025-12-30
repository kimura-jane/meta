export default class Room {
  constructor(party) {
    this.party = party;
    this.users = {};
  }

  onConnect(conn, ctx) {
    const userId = conn.id;
    this.users[userId] = {
      id: userId,
      x: (Math.random() - 0.5) * 8,
      y: 0.5,
      z: 5 + Math.random() * 3,
      color: this.getRandomColor()
    };

    conn.send(JSON.stringify({
      type: 'init',
      users: this.users,
      yourId: userId
    }));

    this.party.broadcast(JSON.stringify({
      type: 'userJoin',
      user: this.users[userId]
    }), [conn.id]);
  }

  onMessage(message, sender) {
    const data = JSON.parse(message);

    switch (data.type) {
      case 'position':
        if (this.users[sender.id]) {
          this.users[sender.id].x = data.x;
          this.users[sender.id].y = data.y;
          this.users[sender.id].z = data.z;
        }
        this.party.broadcast(JSON.stringify({
          type: 'position',
          userId: sender.id,
          x: data.x,
          y: data.y,
          z: data.z
        }), [sender.id]);
        break;

      case 'reaction':
        this.party.broadcast(JSON.stringify({
          type: 'reaction',
          userId: sender.id,
          reaction: data.reaction,
          color: data.color
        }), [sender.id]);
        break;

      case 'chat':
        this.party.broadcast(JSON.stringify({
          type: 'chat',
          userId: sender.id,
          name: data.name,
          message: data.message
        }));
        break;
    }
  }

  onClose(conn) {
    delete this.users[conn.id];
    this.party.broadcast(JSON.stringify({
      type: 'userLeave',
      userId: conn.id
    }));
  }

  getRandomColor() {
    const colors = [0x4fc3f7, 0xff6b6b, 0x98d8aa, 0xffd93d, 0xc9b1ff, 0xff9ff3];
    return colors[Math.floor(Math.random() * colors.length)];
  }
}
