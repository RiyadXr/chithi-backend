const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve uploaded images statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 1e8 // 100MB limit for file uploads
});

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'image-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: function (req, file, cb) {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
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
// Store message status (sent, delivered, seen)
const messageStatus = new Map();

// HTTP route for image upload
app.post('/upload-image', upload.single('image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    
    res.json({
      success: true,
      imageUrl: imageUrl,
      filename: req.file.filename
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// Clean up old files periodically (optional)
setInterval(() => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  
  fs.readdir(uploadsDir, (err, files) => {
    if (err) return;
    
    files.forEach(file => {
      const filePath = path.join(uploadsDir, file);
      fs.stat(filePath, (err, stat) => {
        if (err) return;
        
        if (now - stat.mtime.getTime() > maxAge) {
          fs.unlink(filePath, err => {
            if (!err) console.log('Cleaned up old file:', file);
          });
        }
      });
    });
  });
}, 60 * 60 * 1000); // Run every hour

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

    // Update message status for all messages when user joins
    if (chatHistory.has(pin)) {
      chatHistory.get(pin).forEach(message => {
        if (message.type === 'received') {
          // Update status to delivered for all received messages
          if (!messageStatus.has(message.messageId)) {
            messageStatus.set(message.messageId, {});
          }
          messageStatus.get(message.messageId).delivered = true;
          
          // Notify sender about delivery
          const sender = roomUsers.get(pin).find(user => user.userName === message.sender);
          if (sender) {
            io.to(sender.socketId).emit('message_status_update', {
              messageId: message.messageId,
              status: 'delivered'
            });
          }
        }
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
    const { pin, message, timestamp, messageId, sender, replyTo, imageUrl, imageCaption } = data;
    
    // Store message in history
    if (!chatHistory.has(pin)) {
      chatHistory.set(pin, []);
    }
    
    const messageData = {
      message, 
      sender, 
      timestamp, 
      messageId, 
      type: 'received', 
      replyTo,
      imageUrl,
      imageCaption
    };
    
    chatHistory.get(pin).push(messageData);
    
    // Keep only last 100 messages
    if (chatHistory.get(pin).length > 100) {
      chatHistory.set(pin, chatHistory.get(pin).slice(-100));
    }

    // Initialize status for this message
    if (!messageStatus.has(messageId)) {
      messageStatus.set(messageId, {});
    }
    
    // Broadcast message to others in the room
    socket.to(pin).emit('message', {
      message: message,
      sender: sender,
      timestamp: timestamp,
      messageId: messageId,
      replyTo: replyTo,
      imageUrl: imageUrl,
      imageCaption: imageCaption
    });

    // Update status to delivered if there are other users
    if (rooms.has(pin) && rooms.get(pin).size > 1) {
      messageStatus.get(messageId).delivered = true;
      socket.emit('message_status_update', {
        messageId: messageId,
        status: 'delivered'
      });
    }
  });

  // Handle base64 image upload (fallback)
  socket.on('send_image_message', (data) => {
    const { pin, imageData, imageCaption, timestamp, messageId, sender } = data;
    
    // Store message in history
    if (!chatHistory.has(pin)) {
      chatHistory.set(pin, []);
    }
    
    const messageData = {
      message: imageCaption || '📷 Image',
      sender: sender,
      timestamp: timestamp,
      messageId: messageId,
      type: 'received',
      imageUrl: imageData, // base64 data
      imageCaption: imageCaption,
      isBase64: true
    };
    
    chatHistory.get(pin).push(messageData);
    
    // Keep only last 100 messages
    if (chatHistory.get(pin).length > 100) {
      chatHistory.set(pin, chatHistory.get(pin).slice(-100));
    }

    // Broadcast image message to others in the room
    socket.to(pin).emit('image_message', {
      sender: sender,
      timestamp: timestamp,
      messageId: messageId,
      imageData: imageData,
      imageCaption: imageCaption,
      isBase64: true
    });
  });

  socket.on('message_delivered', (data) => {
    const { pin, messageId } = data;
    
    if (messageStatus.has(messageId)) {
      messageStatus.get(messageId).delivered = true;
      
      // Notify sender about delivery
      const message = chatHistory.get(pin)?.find(msg => msg.messageId === messageId);
      if (message) {
        const sender = roomUsers.get(pin)?.find(user => user.userName === message.sender);
        if (sender) {
          io.to(sender.socketId).emit('message_status_update', {
            messageId: messageId,
            status: 'delivered'
          });
        }
      }
    }
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

  socket.on('unsend_message', (data) => {
    const { pin, messageId } = data;
    
    // Remove message from history
    if (chatHistory.has(pin)) {
      const message = chatHistory.get(pin).find(msg => msg.messageId === messageId);
      chatHistory.set(pin, chatHistory.get(pin).filter(msg => msg.messageId !== messageId));
      
      // Delete image file if it exists
      if (message && message.imageUrl && !message.isBase64) {
        const filename = path.basename(message.imageUrl);
        const filePath = path.join(uploadsDir, filename);
        
        fs.unlink(filePath, (err) => {
          if (err) console.error('Error deleting image file:', err);
          else console.log('Deleted image file:', filename);
        });
      }
    }
    
    // Remove message status
    if (messageStatus.has(messageId)) {
      messageStatus.delete(messageId);
    }
    
    // Broadcast unsend to all users in the room
    io.to(pin).emit('message_unsent', {
      messageId: messageId
    });
    
    console.log(`Message ${messageId} unsent in room ${pin}`);
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
    
    // Clear all image files for this room
    if (chatHistory.has(pin)) {
      chatHistory.get(pin).forEach(message => {
        if (message.imageUrl && !message.isBase64) {
          const filename = path.basename(message.imageUrl);
          const filePath = path.join(uploadsDir, filename);
          
          fs.unlink(filePath, (err) => {
            if (!err) console.log('Deleted room image:', filename);
          });
        }
      });
    }
    
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
    
    // Clear message status for this room
    Array.from(messageStatus.keys()).forEach(messageId => {
      messageStatus.delete(messageId);
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
  console.log(`Image uploads directory: ${uploadsDir}`);
});
