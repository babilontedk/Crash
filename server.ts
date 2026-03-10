import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import axios from 'axios';
import cryptoJS from 'crypto-js';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'crash-secret-key';
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;

// --- NOWPayments Routes ---
app.post('/api/payment/create', async (req, res) => {
  const { amount, currency, token } = req.body;
  if (amount < 1) return res.status(400).json({ error: 'Minimum deposit is $1' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const response = await axios.post(
      "https://api.nowpayments.io/v1/payment",
      {
        price_amount: amount,
        price_currency: "usd",
        pay_currency: currency,
        order_id: `DEP_${Date.now()}`,
        order_description: `Deposit for user ${decoded.username}`,
        ipn_callback_url: `${process.env.APP_URL}/api/payment/webhook`
      },
      {
        headers: {
          "x-api-key": NOWPAYMENTS_API_KEY,
          "Content-Type": "application/json"
        }
      }
    );

    const payment = response.data;
    await supabase.from('deposits').insert({
      user_id: decoded.id,
      payment_id: payment.payment_id,
      amount: amount,
      currency: currency,
      status: 'waiting'
    });

    res.json(payment);
  } catch (err: any) {
    console.error('NOWPayments Error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

app.post('/api/payment/webhook', async (req, res) => {
  const hmac = req.headers['x-nowpayments-sig'];
  const notificationsPayload = JSON.stringify(req.body, Object.keys(req.body).sort());

  if (!NOWPAYMENTS_IPN_SECRET) {
    console.error('NOWPAYMENTS_IPN_SECRET is not set');
    return res.status(500).send('Internal Server Error');
  }

  const checkHmac = cryptoJS.HmacSHA512(notificationsPayload, NOWPAYMENTS_IPN_SECRET).toString();

  if (hmac !== checkHmac) {
    console.error('Invalid NOWPayments signature');
    return res.status(401).send('Unauthorized');
  }

  const { payment_id, payment_status, pay_amount, price_amount } = req.body;

  try {
    const { data: deposit } = await supabase.from('deposits').select('*').eq('payment_id', payment_id).single();
    if (!deposit) return res.status(404).send('Deposit not found');

    if (deposit.status !== 'finished' && payment_status === 'finished') {
      await supabase.from('deposits').update({ status: 'finished' }).eq('payment_id', payment_id);
      
      const { data: user } = await supabase.from('users').select('balance').eq('id', deposit.user_id).single();
      await supabase.from('users').update({ balance: (user?.balance || 0) + deposit.amount }).eq('id', deposit.user_id);
      
      await supabase.from('transactions').insert({
        user_id: deposit.user_id,
        amount: deposit.amount,
        type: 'deposit',
        status: 'completed'
      });
      
      // Notify user via socket if connected
      io.emit('payment:finished', { userId: deposit.user_id, amount: deposit.amount });
    } else {
      await supabase.from('deposits').update({ status: payment_status }).eq('payment_id', payment_id);
    }

    res.send('OK');
  } catch (err) {
    console.error('Webhook processing error:', err);
    res.status(500).send('Error');
  }
});

app.get('/api/payment/history', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET) as any;
    const { data: history } = await supabase.from('deposits').select('*').eq('user_id', decoded.id).order('created_at', { ascending: false }).limit(10);
    res.json(history);
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// --- Auth Routes ---
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const hashedPassword = bcrypt.hashSync(password, 10);
    const { data, error } = await supabase.from('users').insert({ username, email, password: hashedPassword }).select().single();
    if (error) throw error;
    const token = jwt.sign({ id: data.id, username }, JWT_SECRET);
    res.json({ token, user: { id: data.id, username, balance: 0, demo_balance: 1000 } });
  } catch (err: any) {
    res.status(400).json({ error: 'Username or email already exists' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
  if (user && bcrypt.compareSync(password, user.password)) {
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    
    // Proactive fix for users affected by the swapped balance bug
    if (user.balance >= 1000.0) {
      await supabase.from('users').update({ balance: 0.0, demo_balance: 1000.0 }).eq('id', user.id);
      user.balance = 0.0;
      user.demo_balance = 1000.0;
    }
    
    res.json({ token, user: { id: user.id, username: user.username, balance: user.balance, demo_balance: user.demo_balance, role: user.role } });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.get('/api/user/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET) as any;
    let { data: user } = await supabase.from('users').select('id, username, email, balance, demo_balance, role').eq('id', decoded.id).single();
    
    if (user && user.balance >= 1000.0) {
      await supabase.from('users').update({ balance: 0.0, demo_balance: 1000.0 }).eq('id', user.id);
      user.balance = 0.0;
      user.demo_balance = 1000.0;
    }
    
    res.json(user);
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// --- Wallet Routes ---
app.post('/api/wallet/refill-demo', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET) as any;
    await supabase.from('users').update({ demo_balance: 1000.0 }).eq('id', decoded.id);
    res.json({ success: true, newDemoBalance: 1000.0 });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.post('/api/wallet/fix-swap', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET) as any;
    await supabase.from('users').update({ balance: 0.0, demo_balance: 1000.0 }).eq('id', decoded.id);
    res.json({ success: true });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.post('/api/wallet/withdraw', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET) as any;
    const { amount, method, details } = req.body;
    
    if (amount < 20) return res.status(400).json({ error: 'Minimum withdrawal is $20' });
    
    const { data: user } = await supabase.from('users').select('balance').eq('id', decoded.id).single();
    if (!user || user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });
    
    const newBalance = user.balance - amount;
    await supabase.from('users').update({ balance: newBalance }).eq('id', decoded.id);
    await supabase.from('withdrawals').insert({ user_id: decoded.id, amount, method, details: JSON.stringify(details) });
    await supabase.from('transactions').insert({ user_id: decoded.id, amount: -amount, type: 'withdrawal', status: 'pending' });
    
    res.json({ success: true, newBalance });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.post('/api/wallet/deposit', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET) as any;
    const { amount } = req.body;
    if (amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    
    const { data: user } = await supabase.from('users').select('balance').eq('id', decoded.id).single();
    const newBalance = (user?.balance || 0) + amount;
    await supabase.from('users').update({ balance: newBalance }).eq('id', decoded.id);
    await supabase.from('transactions').insert({ user_id: decoded.id, amount, type: 'deposit' });
    
    res.json({ balance: newBalance });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// --- Game Engine ---
let gameState = {
  status: 'waiting', // waiting, starting, running, crashed
  multiplier: 1.0,
  startTime: 0,
  crashPoint: 0,
  currentRoundId: 0,
  bets: [] as any[],
  history: [] as any[]
};

function generateCrashPoint(serverSeed: string, clientSeed: string, nonce: number) {
  const hash = crypto
    .createHmac("sha256", serverSeed)
    .update(clientSeed + "-" + nonce)
    .digest("hex");

  const h = parseInt(hash.substring(0, 13), 16);
  const e = Math.pow(2, 52);

  // Provably fair formula
  const crashPoint = Math.floor((100 * e - h) / (e - h)) / 100;
  
  // House edge (optional adjustment)
  // For simplicity, we use the standard formula which has a natural house edge of ~1%
  return Math.max(1.0, crashPoint);
}

async function runGameLoop() {
  while (true) {
    // 1. Waiting Phase
    gameState.status = 'waiting';
    gameState.multiplier = 1.0;
    gameState.bets = [];
    
    const serverSeed = crypto.randomBytes(32).toString('hex');
    const clientSeed = 'crash-royale-v1';
    const nonce = Math.floor(Date.now() / 1000);
    gameState.crashPoint = generateCrashPoint(serverSeed, clientSeed, nonce);
    
    const { data: roundData, error: roundError } = await supabase.from('game_rounds').insert({
      crash_point: gameState.crashPoint,
      server_seed: serverSeed,
      client_seed: clientSeed,
      nonce: nonce,
      status: 'starting'
    }).select().single();
    
    if (roundError) {
      console.error('Failed to create game round:', roundError);
      continue;
    }
    gameState.currentRoundId = roundData.id;

    io.emit('game:waiting', { timeLeft: 5000, roundId: gameState.currentRoundId });
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 2. Running Phase
    gameState.status = 'running';
    gameState.startTime = Date.now();
    io.emit('game:start', { roundId: gameState.currentRoundId });

    const tickRate = 100; // 100ms
    while (gameState.status === 'running') {
      const elapsed = (Date.now() - gameState.startTime) / 1000;
      // Multiplier formula: 1.001 ^ (elapsed * 10) - just an example
      // Professional crash games often use: e^(0.06 * elapsed)
      gameState.multiplier = Math.pow(Math.E, 0.06 * elapsed);
      
      if (gameState.multiplier >= gameState.crashPoint) {
        gameState.multiplier = gameState.crashPoint;
        gameState.status = 'crashed';
      } else {
        // Check auto-cashouts
        for (const bet of gameState.bets) {
          if (bet.status === 'pending' && bet.auto_cashout > 0 && gameState.multiplier >= bet.auto_cashout) {
            await cashOut(bet.user_id, bet.auto_cashout);
          }
        }
        
        io.emit('game:multiplier', { multiplier: gameState.multiplier });
        await new Promise(resolve => setTimeout(resolve, tickRate));
      }
    }

    // 3. Crashed Phase
    io.emit('game:crash', { multiplier: gameState.multiplier });
    await supabase.from('game_rounds').update({ status: 'finished' }).eq('id', gameState.currentRoundId);
    
    // Update history
    gameState.history.unshift(gameState.multiplier);
    if (gameState.history.length > 10) gameState.history.pop();
    
    // Allow a small window for "late cashouts" at the crash point as requested
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Mark remaining pending bets as lost
    for (const bet of gameState.bets) {
      if (bet.status === 'pending') {
        bet.status = 'lost';
        await supabase.from('bets').update({ status: 'lost', profit: 0 }).eq('id', bet.id);
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

async function cashOut(userId: number, multiplier: number) {
  const bet = gameState.bets.find(b => b.user_id === userId && b.status === 'pending');
  if (!bet) return;

  bet.status = 'cashed_out';
  bet.cashout_multiplier = multiplier;
  bet.profit = bet.amount * multiplier;

  await supabase.from('bets').update({ 
    status: 'cashed_out', 
    cashout_multiplier: multiplier, 
    profit: bet.profit 
  }).eq('id', bet.id);
  
  const { data: user } = await supabase.from('users').select('username, balance, demo_balance').eq('id', userId).single();
  if (!user) return;

  if (bet.is_demo) {
    const newDemoBalance = (user.demo_balance || 0) + bet.profit;
    await supabase.from('users').update({ demo_balance: newDemoBalance }).eq('id', userId);
    user.demo_balance = newDemoBalance;
  } else {
    const newBalance = (user.balance || 0) + bet.profit;
    await supabase.from('users').update({ balance: newBalance }).eq('id', userId);
    user.balance = newBalance;
  }

  io.emit('game:cashout', { 
    userId, 
    username: user.username, 
    multiplier, 
    profit: bet.profit,
    newBalance: user.balance,
    newDemoBalance: user.demo_balance,
    isDemo: bet.is_demo
  });
}

io.on('connection', (socket) => {
  socket.on('game:bet', async (data) => {
    const { token, amount, autoCashout, isDemo } = data;
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      if (gameState.status !== 'waiting') return socket.emit('error', 'Game already started');
      
      const { data: user } = await supabase.from('users').select('balance, demo_balance, username').eq('id', decoded.id).single();
      if (!user) return socket.emit('error', 'User not found');
      
      if (isDemo) {
        if (user.demo_balance < amount) return socket.emit('error', 'Insufficient demo balance');
        await supabase.from('users').update({ demo_balance: user.demo_balance - amount }).eq('id', decoded.id);
      } else {
        if (user.balance < amount) return socket.emit('error', 'Insufficient balance');
        await supabase.from('users').update({ balance: user.balance - amount }).eq('id', decoded.id);
      }

      const { data: betData, error: betError } = await supabase.from('bets').insert({
        user_id: decoded.id,
        round_id: gameState.currentRoundId,
        amount,
        auto_cashout: autoCashout || 0,
        is_demo: isDemo ? 1 : 0
      }).select().single();
      
      if (betError) throw betError;
      
      const bet = {
        id: betData.id,
        user_id: decoded.id,
        username: user.username,
        amount,
        auto_cashout: autoCashout || 0,
        status: 'pending',
        is_demo: !!isDemo
      };
      gameState.bets.push(bet);
      io.emit('game:bet_placed', bet);
      
      if (isDemo) {
        socket.emit('bet:success', { newDemoBalance: user.demo_balance - amount, isDemo: true });
      } else {
        socket.emit('bet:success', { newBalance: user.balance - amount, isDemo: false });
      }
    } catch (err: any) {
      console.error('Bet Error:', err);
      if (err.name === 'JsonWebTokenError') {
        socket.emit('error', 'Invalid session. Please login again.');
      } else {
        socket.emit('error', err.message || 'Failed to place bet');
      }
    }
  });

  socket.on('game:cashout_request', async (data) => {
    const { token } = data;
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      if (gameState.status !== 'running' && gameState.status !== 'crashed') return;
      await cashOut(decoded.id, gameState.multiplier);
    } catch (err: any) {
      console.error('Cashout Error:', err);
      if (err.name === 'JsonWebTokenError') {
        socket.emit('error', 'Invalid session. Please login again.');
      } else {
        socket.emit('error', err.message || 'Failed to cashout');
      }
    }
  });

  socket.on('chat:message', async (data) => {
    const { token, message } = data;
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      const { data: user } = await supabase.from('users').select('username').eq('id', decoded.id).single();
      if (user && message.trim().length > 0) {
        io.emit('chat:message', {
          username: user.username,
          message: message.substring(0, 200),
          timestamp: Date.now()
        });
      }
    } catch (err: any) {
      console.error('Chat Error:', err);
      if (err.name === 'JsonWebTokenError') {
        socket.emit('error', 'Invalid session. Please login again.');
      }
    }
  });

  socket.emit('game:state', {
    status: gameState.status,
    multiplier: gameState.multiplier,
    history: gameState.history,
    bets: gameState.bets
  });
});

// --- Admin Routes ---
app.get('/api/admin/stats', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET) as any;
    const { data: user } = await supabase.from('users').select('role').eq('id', decoded.id).single();
    if (user?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });

    const { count: totalUsers } = await supabase.from('users').select('*', { count: 'exact', head: true });
    const { count: totalBets } = await supabase.from('bets').select('*', { count: 'exact', head: true });
    
    // For total profit, we might need a more complex query or just fetch and sum (not ideal for large datasets)
    // For now, let's just return 0 or a placeholder if it's too complex for a single query
    const { data: profitData } = await supabase.from('bets').select('amount, profit').or("status.eq.cashed_out,status.eq.lost");
    const totalProfit = profitData?.reduce((acc, curr) => acc + (curr.amount - curr.profit), 0) || 0;

    res.json({
      totalUsers: { count: totalUsers },
      totalBets: { count: totalBets },
      totalProfit: { profit: totalProfit },
      activeGames: 1
    });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.get('/api/admin/tables', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET) as any;
    const { data: user } = await supabase.from('users').select('role').eq('id', decoded.id).single();
    if (user?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });

    // In Supabase, we can't easily query sqlite_master. 
    // We'll hardcode the tables we know exist based on the schema provided.
    const tables = ['users', 'game_rounds', 'bets', 'withdrawals', 'transactions', 'deposits'];
    res.json(tables);
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.get('/api/admin/table/:name', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET) as any;
    const { data: user } = await supabase.from('users').select('role').eq('id', decoded.id).single();
    if (user?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });

    const tableName = req.params.name;
    if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
      return res.status(400).json({ error: 'Invalid table name' });
    }

    const { data } = await supabase.from(tableName).select('*').order('created_at', { ascending: false }).limit(100);
    res.json(data);
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});


async function main() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  httpServer.listen(3000, '0.0.0.0', () => {
    console.log('Server running on http://localhost:3000');
    runGameLoop();
  });
}

main();
