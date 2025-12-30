export default {
  async onConnect(connection, room) {
    const userId = connection.id;
    
    // ユーザー情報を保存
    const users = JSON.parse(await room.storage.get("users") || "{}");
    users[userId] = {
      id: userId,
      x: (Math.random() - 0.5) * 8,
      y: 0.5,
      z: 5 + Math.random() * 3
    };
    await room.storage.put("users", JSON.stringify(users));

    // 初期化メッセージ送信
    connection.send(JSON.stringify({
      type: 'init',
      users: users,
      yourId: userId
    }));

    // 他のユーザーに通知
    room.broadcast(JSON.stringify({
      type: 'userJoin',
      user: users[userId]
    }), [connection.id]);
  },

  async onMessage(message, connection, room) {
    const data = JSON.parse(message);
    const users = JSON.parse(await room.storage.get("users") || "{}");

    switch (data.type) {
      case 'position':
        if (users[connection.id]) {
          users[connection.id].x = data.x;
          users[connection.id].y = data.y;
          users[connection.id].z = data.z;
          await room.storage.put("users", JSON.stringify(users));
        }
        room.broadcast(JSON.stringify({
          type: 'position',
          userId: connection.id,
          x: data.x,
          y: data.y,
          z: data.z
        }), [connection.id]);
        break;

      case 'reaction':
        room.broadcast(JSON.stringify({
          type: 'reaction',
          userId: connection.id,
          reaction: data.reaction,
          color: data.color
        }), [connection.id]);
        break;

      case 'chat':
        room.broadcast(JSON.stringify({
          type: 'chat',
          userId: connection.id,
          name: data.name,
          message: data.message
        }));
        break;
    }
  },

  async onClose(connection, room) {
    const users = JSON.parse(await room.storage.get("users") || "{}");
    delete users[connection.id];
    await room.storage.put("users", JSON.stringify(users));
    
    room.broadcast(JSON.stringify({
      type: 'userLeave',
      userId: connection.id
    }));
  }
};
