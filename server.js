const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Store active rooms and their users
const rooms = new Map();
// Store message reactions
const messageReactions = new Map();
// Store room themes
const roomThemes = new Map();
// Store chat history
const chatHistory = new Map();
// Store room users with names
const roomUsers = new Map();
// Store seen status for messages
const messageSeenStatus = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join_room', (data) => {
    const { pin, userName } = data;
    
    // Leave any previous rooms
    if (socket.room) {
      socket.leave(socket.room);
    }
    
    // Join the new room
    socket.join(pin);
    socket.room = pin;
    socket.userName = userName;
    
    // Add user to room
    if (!rooms.has(pin)) {
      rooms.set(pin, new Set());
    }
    rooms.get(pin).add(socket.id);
    
    // Add user to room users
    if (!roomUsers.has(pin)) {
      roomUsers.set(pin, []);
    }
    roomUsers.get(pin).push({ socketId: socket.id, userName: userName });
    
    // Send current theme if exists
    if (roomThemes.has(pin)) {
      socket.emit('theme_changed', { theme: roomThemes.get(pin) });
    }
    
    // Send user count update
    io.to(pin).emit('user_count_update', { count: rooms.get(pin).size });
    
    // Send current users list
    io.to(pin).emit('current_users', { users: roomUsers.get(pin) });
    
    // Send chat history if exists
    if (chatHistory.has(pin)) {
      socket.emit('chat_history', { messages: chatHistory.get(pin) });
    }
    
    // Notify others in the room
    socket.to(pin).emit('user_joined', { 
      message: 'A user joined the chat',
      userName: userName
    });

    // Update seen status for all messages when user joins
    if (chatHistory.has(pin)) {
      chatHistory.get(pin).forEach(message => {
        if (!messageSeenStatus.has(message.messageId)) {
          messageSeenStatus.set(message.messageId, new Set());
        }
        messageSeenStatus.get(message.messageId).add(socket.id);
      });
      
      // Notify about seen status updates
      io.to(pin).emit('message_seen_update', {
        messages: Array.from(messageSeenStatus.entries()).filter(([messageId, seenBy]) => {
          return chatHistory.get(pin).some(msg => msg.messageId === messageId);
        }).map(([messageId, seenBy]) => ({
          messageId,
          seenBy: Array.from(seenBy).map(socketId => {
            const user = roomUsers.get(pin).find(u => u.socketId === socketId);
            return user ? user.userName : 'Unknown';
          })
        }))
      });
    }
    
    console.log(`User ${socket.id} (${userName}) joined room ${pin}`);
  });

  socket.on('get_current_users', (data) => {
    const { pin } = data;
    if (roomUsers.has(pin)) {
      socket.emit('current_users', { users: roomUsers.get(pin) });
    }
  });

  socket.on('send_message', (data) => {
    const { pin, message, timestamp, messageId, sender, replyTo } = data;
    
    // Store message in history
    if (!chatHistory.has(pin)) {
      chatHistory.set(pin, []);
    }
    
    const messageData = {
      message, sender, timestamp, messageId, type: 'received', replyTo
    };
    
    chatHistory.get(pin).push(messageData);
    
    // Keep only last 100 messages
    if (chatHistory.get(pin).length > 100) {
      chatHistory.set(pin, chatHistory.get(pin).slice(-100));
    }

    // Initialize seen status for this message
    if (!messageSeenStatus.has(messageId)) {
      messageSeenStatus.set(messageId, new Set());
    }
    // Mark as seen by sender immediately
    messageSeenStatus.get(messageId).add(socket.id);
    
    // Broadcast message to others in the room
    socket.to(pin).emit('message', {
      message: message,
      sender: sender,
      timestamp: timestamp,
      messageId: messageId,
      replyTo: replyTo
    });

    // Send immediate seen status update
    io.to(pin).emit('message_seen_update', {
      messages: [{
        messageId,
        seenBy: Array.from(messageSeenStatus.get(messageId)).map(socketId => {
          const user = roomUsers.get(pin).find(u => u.socketId === socketId);
          return user ? user.userName : 'Unknown';
        })
      }]
    });
  });

  socket.on('message_reaction', (data) => {
    const { pin, messageId, reaction } = data;
    
    // Store reaction
    const reactionKey = `${pin}-${messageId}`;
    if (!messageReactions.has(reactionKey)) {
      messageReactions.set(reactionKey, {});
    }
    
    const reactions = messageReactions.get(reactionKey);
    reactions[reaction] = (reactions[reaction] || 0) + 1;
    
    // Broadcast reaction to room
    io.to(pin).emit('message_reaction', {
      messageId: messageId,
      reaction: reaction
    });
  });

  socket.on('message_seen', (data) => {
    const { pin, messageId } = data;
    
    if (messageSeenStatus.has(messageId)) {
      messageSeenStatus.get(messageId).add(socket.id);
      
      // Broadcast seen status update
      io.to(pin).emit('message_seen_update', {
        messages: [{
          messageId,
          seenBy: Array.from(messageSeenStatus.get(messageId)).map(socketId => {
            const user = roomUsers.get(pin).find(u => u.socketId === socketId);
            return user ? user.userName : 'Unknown';
          })
        }]
      });
    }
  });

  socket.on('typing_start', (data) => {
    const { pin, userName } = data;
    socket.to(pin).emit('typing_start', { userName: userName });
  });

  socket.on('typing_stop', (data) => {
    const { pin } = data;
    socket.to(pin).emit('typing_stop');
  });

  socket.on('change_theme', (data) => {
    const { pin, theme } = data;
    
    // Store theme for the room
    roomThemes.set(pin, theme);
    
    // Broadcast theme change to all users in the room
    io.to(pin).emit('theme_changed', { theme: theme });
  });

  socket.on('delete_room', (data) => {
    const { pin } = data;
    
    // Clear room data
    if (rooms.has(pin)) {
      rooms.delete(pin);
    }
    if (roomThemes.has(pin)) {
      roomThemes.delete(pin);
    }
    if (chatHistory.has(pin)) {
      chatHistory.delete(pin);
    }
    if (roomUsers.has(pin)) {
      roomUsers.delete(pin);
    }
    
    // Clear message seen status for this room
    Array.from(messageSeenStatus.keys()).forEach(messageId => {
      messageSeenStatus.delete(messageId);
    });
    
    // Notify all users in the room
    io.to(pin).emit('room_deleted');
    
    console.log(`Room ${pin} deleted`);
  });

  socket.on('leave_room', (data) => {
    const { pin } = data;
    
    if (socket.room === pin) {
      // Remove user from room
      if (rooms.has(pin)) {
        rooms.get(pin).delete(socket.id);
        
        // Remove user from room users
        if (roomUsers.has(pin)) {
          roomUsers.set(pin, roomUsers.get(pin).filter(user => user.socketId !== socket.id));
          
          // Update current users list
          io.to(pin).emit('current_users', { users: roomUsers.get(pin) });
        }
        
        // Update user count
        io.to(pin).emit('user_count_update', { count: rooms.get(pin).size });
        
        // If room is empty, delete it after a delay
        if (rooms.get(pin).size === 0) {
          setTimeout(() => {
            if (rooms.has(pin) && rooms.get(pin).size === 0) {
              rooms.delete(pin);
              if (roomThemes.has(pin)) {
                roomThemes.delete(pin);
              }
              if (roomUsers.has(pin)) {
                roomUsers.delete(pin);
              }
              console.log(`Room ${pin} cleared (no users)`);
            }
          }, 30000); // Wait 30 seconds before clearing empty room
        } else {
          // Notify others that user left
          socket.to(pin).emit('user_left', { 
            message: 'A user left the chat',
            userName: socket.userName
          });
        }
      }
      
      socket.leave(pin);
      socket.room = null;
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    if (socket.room) {
      // Remove user from room
      if (rooms.has(socket.room)) {
        rooms.get(socket.room).delete(socket.id);
        
        // Remove user from room users
        if (roomUsers.has(socket.room)) {
          roomUsers.set(socket.room, roomUsers.get(socket.room).filter(user => user.socketId !== socket.id));
          
          // Update current users list
          io.to(socket.room).emit('current_users', { users: roomUsers.get(socket.room) });
        }
        
        // Update user count
        io.to(socket.room).emit('user_count_update', { count: rooms.get(socket.room).size });
        
        // If room is empty, delete it after a delay
        if (rooms.get(socket.room).size === 0) {
          setTimeout(() => {
            if (rooms.has(socket.room) && rooms.get(socket.room).size === 0) {
              rooms.delete(socket.room);
              if (roomThemes.has(socket.room)) {
                roomThemes.delete(socket.room);
              }
              if (roomUsers.has(socket.room)) {
                roomUsers.delete(socket.room);
              }
              console.log(`Room ${socket.room} cleared (no users)`);
            }
          }, 30000); // Wait 30 seconds before clearing empty room
        } else {
          // Notify others that user left
          socket.to(socket.room).emit('user_left', { 
            message: 'A user left the chat',
            userName: socket.userName
          });
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
