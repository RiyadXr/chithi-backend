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
    
    // Send current theme if exists
    if (roomThemes.has(pin)) {
      socket.emit('theme_changed', { theme: roomThemes.get(pin) });
    }
    
    // Notify others in the room
    socket.to(pin).emit('user_joined', { 
      message: 'A user joined the chat',
      userName: userName
    });
    
    console.log(`User ${socket.id} (${userName}) joined room ${pin}`);
  });

  socket.on('send_message', (data) => {
    const { pin, message, timestamp, messageId, sender } = data;
    
    // Broadcast message to others in the room
    socket.to(pin).emit('message', {
      message: message,
      sender: sender,
      timestamp: timestamp,
      messageId: messageId
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
    
    // Notify all users in the room
    io.to(pin).emit('room_deleted');
    
    // Clear room data after a delay (to allow clients to receive the message)
    setTimeout(() => {
      if (rooms.has(pin)) {
        rooms.delete(pin);
      }
      if (roomThemes.has(pin)) {
        roomThemes.delete(pin);
      }
      console.log(`Room ${pin} deleted`);
    }, 5000);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    if (socket.room) {
      // Remove user from room
      if (rooms.has(socket.room)) {
        rooms.get(socket.room).delete(socket.id);
        
        // If room is empty, delete it after a delay
        if (rooms.get(socket.room).size === 0) {
          setTimeout(() => {
            if (rooms.has(socket.room) && rooms.get(socket.room).size === 0) {
              rooms.delete(socket.room);
              if (roomThemes.has(socket.room)) {
                roomThemes.delete(socket.room);
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
