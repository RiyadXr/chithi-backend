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

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join_room', (data) => {
    const { pin } = data;
    
    // Leave any previous rooms
    if (socket.room) {
      socket.leave(socket.room);
    }
    
    // Join the new room
    socket.join(pin);
    socket.room = pin;
    
    // Add user to room
    if (!rooms.has(pin)) {
      rooms.set(pin, new Set());
    }
    rooms.get(pin).add(socket.id);
    
    // Notify others in the room
    socket.to(pin).emit('user_joined', { message: 'A user joined the chat' });
    
    console.log(`User ${socket.id} joined room ${pin}`);
  });

  socket.on('send_message', (data) => {
    const { pin, message, timestamp } = data;
    
    // Broadcast message to others in the room
    socket.to(pin).emit('message', {
      message: message,
      sender: 'Other User',
      timestamp: timestamp
    });
  });

  socket.on('typing_start', (data) => {
    const { pin } = data;
    socket.to(pin).emit('typing_start');
  });

  socket.on('typing_stop', (data) => {
    const { pin } = data;
    socket.to(pin).emit('typing_stop');
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    if (socket.room) {
      // Remove user from room
      if (rooms.has(socket.room)) {
        rooms.get(socket.room).delete(socket.id);
        
        // If room is empty, delete it
        if (rooms.get(socket.room).size === 0) {
          rooms.delete(socket.room);
        } else {
          // Notify others that user left
          socket.to(socket.room).emit('user_left', { message: 'A user left the chat' });
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
