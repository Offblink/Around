const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const DATA_DIR = './data';
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MSG_DIR = path.join(DATA_DIR, 'messages');
const AES_KEY = Buffer.from('zy142857'.padEnd(32, '0').slice(0, 32));

// 🔥 修正：文件上传配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // 先上传到临时目录，路由中再移动到用户目录
    fs.mkdir(UPLOADS_DIR, { recursive: true }).then(() => {
      cb(null, UPLOADS_DIR);
    }).catch(err => cb(err));
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage
  // 完全移除文件大小和类型限制
});

// 🗂️ 初始化
async function initDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.mkdir(MSG_DIR, { recursive: true });
  try { await fs.access(USERS_FILE); } catch {
    await fs.writeFile(USERS_FILE, '[]');
  }
}

// 🔐 AES加密
async function encryptAndSave(userId, data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', AES_KEY, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, authTag, enc]);
  await fs.writeFile(path.join(MSG_DIR, `${userId}.dat`), blob);
}

// 🔓 AES解密
async function decryptFromFile(userId) {
  try {
    const blob = await fs.readFile(path.join(MSG_DIR, `${userId}.dat`));
    const iv = blob.slice(0, 12);
    const authTag = blob.slice(12, 28);
    const enc = blob.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', AES_KEY, iv);
    decipher.setAuthTag(authTag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return JSON.parse(dec.toString());
  } catch {
    return [];
  }
}

// 📁 用户存储
let users = [];
let connections = {};
let pendingMessages = new Map();

async function loadUsers() {
  const buf = await fs.readFile(USERS_FILE);
  users = JSON.parse(buf.toString());
}

async function saveUsers() {
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

initDataDir().then(loadUsers).catch(console.error);

// 中间件
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 📌 API路由
app.get('/api/user/:id', async (req, res) => {
  const { id } = req.params;
  const user = users.find(u => u.id === id);
  if (!user) return res.status(410).json({ error: '用户档案已失效' });
  res.json(user);
});

app.get('/api/users', async (req, res) => {
  const enriched = users.map(u => ({ ...u, online: !!connections[u.id] }));
  res.json(enriched);
});

// 🔥 新增：文件上传API
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const { userId, toId, quoteId, tempId } = req.body;
    const file = req.file;
    
    if (!userId || !toId) {
      // 删除已上传的文件
      if (file) await fs.unlink(file.path).catch(console.error);
      return res.status(400).json({ error: '缺少必要参数' });
    }
    
    if (!file) {
      return res.status(400).json({ error: '文件上传失败' });
    }
    
    // 验证用户
    const user = users.find(u => u.id === userId);
    const targetUser = users.find(u => u.id === toId);
    if (!user || !targetUser) {
      // 删除已上传的文件
      if (file) await fs.unlink(file.path).catch(console.error);
      return res.status(404).json({ error: '用户不存在' });
    }
    
    // 创建用户目录
    const userUploadDir = path.join(UPLOADS_DIR, userId);
    await fs.mkdir(userUploadDir, { recursive: true });
    
    // 移动文件到用户目录
    const newFilePath = path.join(userUploadDir, path.basename(file.path));
    await fs.rename(file.path, newFilePath);
    
    const fileInfo = {
      id: generateMsgId(),
      fromId: userId,
      toId: toId,
      fileName: file.originalname,
      filePath: path.relative(DATA_DIR, newFilePath),
      fileSize: file.size,
      mimeType: file.mimetype,
      timestamp: Date.now(),
      quoteId: quoteId || null,
      type: 'file'
    };
    
    // 存储到双方消息历史
    const [senderHistory, receiverHistory] = await Promise.all([
      decryptFromFile(userId),
      decryptFromFile(toId)
    ]);
    
    senderHistory.push({ ...fileInfo, fromSelf: true });
    receiverHistory.push({ ...fileInfo, fromSelf: false });
    
    await Promise.all([
      encryptAndSave(userId, senderHistory),
      encryptAndSave(toId, receiverHistory)
    ]);
    
    // 向发送方确认
    const senderWs = connections[userId];
    if (senderWs && senderWs.readyState === WebSocket.OPEN) {
      senderWs.send(JSON.stringify({ 
        type: 'MESSAGE_CONFIRMED', 
        payload: { 
          tempId,
          realId: fileInfo.id,
          timestamp: fileInfo.timestamp,
          fromId: userId,
          toId 
        }
      }));
    }
    
    // 实时或离线投递
    const targetWs = connections[toId];
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(JSON.stringify({ 
        type: 'NEW_MESSAGE', 
        payload: fileInfo 
      }));
    } else {
      if (!pendingMessages.has(toId)) pendingMessages.set(toId, []);
      pendingMessages.get(toId).push(fileInfo);
    }
    
    res.json({ 
      success: true, 
      messageId: fileInfo.id,
      fileName: file.originalname,
      fileSize: file.size
    });
    
  } catch (error) {
    console.error('文件上传错误:', error);
    // 清理上传的文件
    if (req.file) await fs.unlink(req.file.path).catch(console.error);
    res.status(500).json({ error: '服务器处理文件时出错' });
  }
});

// 🔥 新增：文件下载API
app.get('/api/download/:userId/:fileId', async (req, res) => {
  try {
    const { userId, fileId } = req.params;
    const requestingUserId = req.query.requester;
    
    if (!requestingUserId) {
      return res.status(401).json({ error: '未授权访问' });
    }
    
    // 验证请求者是否有权限访问这个文件
    const userHistory = await decryptFromFile(requestingUserId);
    const fileMessage = userHistory.find(m => m.id === fileId && m.type === 'file');
    
    if (!fileMessage) {
      return res.status(403).json({ error: '无权访问此文件' });
    }
    
    const filePath = path.join(DATA_DIR, fileMessage.filePath);
    
    // 检查文件是否存在
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ error: '文件不存在' });
    }
    
    // 设置下载头
    res.download(filePath, fileMessage.fileName, (err) => {
      if (err) {
        console.error('文件下载错误:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: '文件下载失败' });
        }
      }
    });
    
  } catch (error) {
    console.error('下载API错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

app.post('/api/register', async (req, res) => {
  const { nickname } = req.body;
  const ip = req.ip.replace(/^::ffff:/, '');
  const cleanName = nickname?.trim();
  if (!cleanName || cleanName.length < 2 || cleanName.length > 12) {
    return res.status(400).json({ error: '昵称2~12字符' });
  }
  if (users.some(u => u.nickname === cleanName)) {
    return res.status(409).json({ error: '昵称已存在' });
  }

  const user = { id: generateId(), nickname: cleanName, ip, online: true };
  users.push(user);
  await saveUsers();
  broadcast({ type: 'USER_JOINED', payload: user });
  res.json({ success: true, user });
});

app.put('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  const { nickname } = req.body;
  const user = users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  const cleanNew = nickname?.trim();
  if (!cleanNew || cleanNew.length < 2 || cleanNew.length > 12) {
    return res.status(400).json({ error: '昵称无效' });
  }
  if (users.some(u => u.nickname === cleanNew && u.id !== id)) {
    return res.status(409).json({ error: '昵称已占用' });
  }

  user.nickname = cleanNew;
  await saveUsers();
  broadcast({ type: 'PROFILE_UPDATED', payload: user });
  res.json({ success: true, user });
});

// 🔗 WebSocket
wss.on('connection', async function connection(ws, req) {
  let userId = null;

  ws.on('message', async message => {
    try {
      const data = JSON.parse(message);
      switch (data.type) {
        case 'SET_USER_ID':
          userId = data.payload.id;
          if (!users.some(u => u.id === userId)) {
            ws.close(1008, 'Invalid User ID');
            return;
          }
          connections[userId] = ws;
          await flushPendingAndHistory(userId, ws);
          break;
        case 'SEND_MESSAGE':
          await handleSendMessage(data.payload);
          break;
        case 'RECALL_MESSAGE':
          await handleRecallMessage(data.payload);
          break;
      }
    } catch (e) { console.error('WS异常:', e); }
  });

  ws.on('close', () => {
    if (userId) {
      delete connections[userId];
      markUserOffline(userId);
    }
  });
});

// ✅ 消息发送处理
async function handleSendMessage(payload) {
  const { fromId, toId, content, quoteId, tempId } = payload;
  const timestamp = Date.now();
  const messageId = generateMsgId();
  const msgPacket = { id: messageId, fromId, toId, content, timestamp, quoteId, type: 'text' };

  // 写入双方历史
  const [senderHistory, receiverHistory] = await Promise.all([
    decryptFromFile(fromId),
    decryptFromFile(toId)
  ]);
  senderHistory.push({ ...msgPacket, fromSelf: true });
  receiverHistory.push({ ...msgPacket, fromSelf: false });
  await Promise.all([
    encryptAndSave(fromId, senderHistory),
    encryptAndSave(toId, receiverHistory)
  ]);

  // 向前端发送确认消息
  const senderWs = connections[fromId];
  if (senderWs && senderWs.readyState === WebSocket.OPEN) {
    senderWs.send(JSON.stringify({ 
      type: 'MESSAGE_CONFIRMED', 
      payload: { 
        tempId, 
        realId: messageId,
        timestamp,
        fromId,
        toId 
      }
    }));
  }

  // 实时或离线投递
  const targetWs = connections[toId];
  if (targetWs && targetWs.readyState === WebSocket.OPEN) {
    targetWs.send(JSON.stringify({ type: 'NEW_MESSAGE', payload: msgPacket }));
  } else {
    if (!pendingMessages.has(toId)) pendingMessages.set(toId, []);
    pendingMessages.get(toId).push(msgPacket);
  }
}

// ✅ 撤回逻辑
async function handleRecallMessage(payload) {
  const { messageId, fromId, toId } = payload;
  const [senderHistory, receiverHistory] = await Promise.all([
    decryptFromFile(fromId),
    decryptFromFile(toId)
  ]);

  const recallFlag = { 
    type: 'recalled', 
    content: '该消息已被撤回', 
    timestamp: Date.now(),
    quoteId: undefined
  };

  // 发送方标记撤回
  const senderIdx = senderHistory.findIndex(m => m.id === messageId);
  if (senderIdx > -1) {
    senderHistory[senderIdx] = { ...senderHistory[senderIdx], ...recallFlag };
    await encryptAndSave(fromId, senderHistory);
    notifyRecall(messageId, fromId, fromId);
  }

  // 接收方标记撤回
  const receiverIdx = receiverHistory.findIndex(m => m.id === messageId);
  if (receiverIdx > -1) {
    receiverHistory[receiverIdx] = { ...receiverHistory[receiverIdx], ...recallFlag };
    await encryptAndSave(toId, receiverHistory);
    notifyRecall(messageId, fromId, toId);
  }
}

function notifyRecall(msgId, fromId, targetId) {
  const conn = connections[targetId];
  if (conn && conn.readyState === WebSocket.OPEN) {
    conn.send(JSON.stringify({
      type: 'MESSAGE_RECALLED',
      payload: { messageId: msgId, targetId }
    }));
  }
}

// 📮 上线投递
async function flushPendingAndHistory(userId, ws) {
  if (pendingMessages.has(userId)) {
    pendingMessages.get(userId).forEach(msg => {
      ws.send(JSON.stringify({ type: 'NEW_MESSAGE', payload: msg }));
    });
    pendingMessages.delete(userId);
  }
  const history = await decryptFromFile(userId);
  history.forEach(msg => {
    ws.send(JSON.stringify({ type: 'HISTORY_MESSAGE', payload: msg }));
  });
}

function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 9); }
function generateMsgId() { return 'msg_' + generateId(); }

function broadcast(msg) {
  const msgStr = JSON.stringify(msg);
  Object.values(connections).forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msgStr);
  });
}

function markUserOffline(id) {
  const user = users.find(u => u.id === id);
  if (user) {
    user.online = false;
    broadcast({ type: 'USER_LEFT', payload: { id } });
  }
}

server.listen(3000, () => {
  console.log('🚀 服务端启动（文件传输修复版）');
});