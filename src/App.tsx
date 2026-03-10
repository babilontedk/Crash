import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { 
  TrendingUp, 
  Wallet, 
  History, 
  User, 
  LogOut, 
  ChevronRight, 
  AlertCircle,
  MessageSquare,
  Users,
  Trophy,
  ShieldCheck,
  Plus,
  ArrowDownToLine,
  QrCode,
  Copy,
  CheckCircle2,
  Clock
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { QRCodeSVG } from 'qrcode.react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Types ---
interface Bet {
  id: number;
  user_id: number;
  username: string;
  amount: number;
  auto_cashout: number;
  status: 'pending' | 'cashed_out';
  cashout_multiplier?: number;
  profit?: number;
  is_demo?: boolean;
}

interface UserData {
  id: number;
  username: string;
  balance: number;
  demo_balance: number;
  role: string;
}

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [user, setUser] = useState<UserData | null>(null);
  const userRef = useRef<UserData | null>(null);
  
  useEffect(() => {
    userRef.current = user;
  }, [user]);
  const [gameState, setGameState] = useState<{
    status: string;
    multiplier: number;
    history: number[];
    bets: Bet[];
  }>({
    status: 'waiting',
    multiplier: 1.0,
    history: [],
    bets: []
  });

  const [isDemo, setIsDemo] = useState(false);
  const [betAmount, setBetAmount] = useState<number>(10);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawMethod, setWithdrawMethod] = useState('binance');
  const [withdrawAmount, setWithdrawAmount] = useState('20');
  const [withdrawDetails, setWithdrawDetails] = useState({ address: '', email: '', bankName: '', accountNumber: '' });
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [autoCashout, setAutoCashout] = useState<string>('');
  const [isBetting, setIsBetting] = useState(false);
  const [hasBetThisRound, setHasBetThisRound] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register' | null>(null);
  const [authForm, setAuthForm] = useState({ username: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [showDeposit, setShowDeposit] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [adminTables, setAdminTables] = useState<string[]>([]);
  const [adminData, setAdminData] = useState<any[] | null>(null);
  const [activeAdminTab, setActiveAdminTab] = useState('users');
  const [depositData, setDepositData] = useState<any>(null);
  const [depositHistory, setDepositHistory] = useState<any[]>([]);
  const [selectedCurrency, setSelectedCurrency] = useState('btc');
  const [depositAmount, setDepositAmount] = useState('10');
  const [isCreatingPayment, setIsCreatingPayment] = useState(false);
  const [localCurrency, setLocalCurrency] = useState<{ code: string; rate: number; symbol: string }>({ code: 'USD', rate: 1, symbol: '$' });

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [chatMessages, setChatMessages] = useState<{ username: string; message: string; timestamp: number }[]>([]);
  const [chatInput, setChatInput] = useState('');

  useEffect(() => {
    const newSocket = io();
    setSocket(newSocket);

    newSocket.on('game:state', (state) => setGameState(state));
    newSocket.on('chat:message', (msg) => {
      setChatMessages(prev => [...prev, msg].slice(-50));
    });
    newSocket.on('game:waiting', (data) => {
      setGameState(prev => ({ ...prev, status: 'waiting', multiplier: 1.0, bets: [] }));
      setHasBetThisRound(false);
    });
    newSocket.on('game:start', () => {
      setGameState(prev => ({ ...prev, status: 'running' }));
    });
    newSocket.on('game:multiplier', (data) => {
      setGameState(prev => ({ ...prev, multiplier: data.multiplier }));
    });
    newSocket.on('game:crash', (data) => {
      setGameState(prev => ({ 
        ...prev, 
        status: 'crashed', 
        multiplier: data.multiplier,
        history: [data.multiplier, ...prev.history].slice(0, 10)
      }));
    });
    newSocket.on('game:bet_placed', (bet) => {
      setGameState(prev => ({ ...prev, bets: [...prev.bets, bet] }));
    });
    newSocket.on('game:cashout', (data) => {
      setGameState(prev => ({
        ...prev,
        bets: prev.bets.map(b => b.user_id === data.userId ? { ...b, status: 'cashed_out', cashout_multiplier: data.multiplier, profit: data.profit } : b)
      }));
      if (userRef.current && data.userId === userRef.current.id) {
        if (data.isDemo) {
          setUser(prev => prev ? { ...prev, demo_balance: data.newDemoBalance } : null);
        } else {
          setUser(prev => prev ? { ...prev, balance: data.newBalance } : null);
        }
        setHasBetThisRound(false);
      }
    });
    newSocket.on('bet:success', (data) => {
      if (data.isDemo) {
        setUser(prev => prev ? { ...prev, demo_balance: data.newDemoBalance } : null);
      } else {
        setUser(prev => prev ? { ...prev, balance: data.newBalance } : null);
      }
      setHasBetThisRound(true);
    });
    newSocket.on('error', (msg) => setError(msg));
    newSocket.on('payment:finished', (data) => {
      if (userRef.current && data.userId === userRef.current.id) {
        setUser(prev => prev ? { ...prev, balance: prev.balance + data.amount } : null);
        setError(`Deposit of ${data.amount} confirmed!`);
        setTimeout(() => setError(null), 5000);
      }
    });

    // Check auth
    const token = localStorage.getItem('token');
    if (token) {
      fetch('/api/user/me', {
        headers: { Authorization: `Bearer ${token}` }
      }).then(res => res.json()).then(data => {
        if (!data.error) setUser(data);
      });
    }

    // Fetch local currency info
    const fetchCurrencyInfo = async () => {
      try {
        // Use a timeout to avoid hanging
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const ipRes = await fetch('https://ipapi.co/json/', { signal: controller.signal });
        const ipData = await ipRes.json();
        const currencyCode = ipData.currency || 'USD';
        
        const rateRes = await fetch('https://open.er-api.com/v6/latest/USD', { signal: controller.signal });
        const rateData = await rateRes.json();
        const rate = rateData.rates[currencyCode] || 1;
        
        clearTimeout(timeoutId);

        // Simple symbol mapping
        const symbols: Record<string, string> = {
          USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', 
          INR: '₹', CAD: '$', AUD: '$', BRL: 'R$', RUB: '₽'
        };
        
        setLocalCurrency({
          code: currencyCode,
          rate: rate,
          symbol: symbols[currencyCode] || currencyCode
        });
      } catch (err) {
        // Silently fail and keep default USD
        console.warn('Currency info fetch skipped or failed. Defaulting to USD.');
      }
    };
    fetchCurrencyInfo();

    return () => {
      newSocket.close();
    };
  }, []);

  useEffect(() => {
    if (showAdmin && user?.role === 'admin') {
      const fetchTables = async () => {
        const token = localStorage.getItem('token');
        const res = await fetch('/api/admin/tables', {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        if (Array.isArray(data)) {
          setAdminTables(data);
          if (data.length > 0 && !data.includes(activeAdminTab)) {
            setActiveAdminTab(data[0]);
          }
        }
      };
      fetchTables();
    }
  }, [showAdmin, user]);

  useEffect(() => {
    if (showAdmin && activeAdminTab && user?.role === 'admin') {
      const fetchTableData = async () => {
        const token = localStorage.getItem('token');
        const res = await fetch(`/api/admin/table/${activeAdminTab}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        if (Array.isArray(data)) {
          setAdminData(data);
        }
      };
      fetchTableData();
    }
  }, [showAdmin, activeAdminTab, user]);

  // --- Graph Animation ---
  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrame: number;
    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      if (gameState.status === 'running' || gameState.status === 'crashed') {
        const padding = 40;
        const width = canvas.width - padding * 2;
        const height = canvas.height - padding * 2;
        
        ctx.beginPath();
        ctx.strokeStyle = gameState.status === 'crashed' ? '#ef4444' : '#10b981';
        ctx.lineWidth = 4;
        
        // Simple curve based on multiplier
        ctx.moveTo(padding, canvas.height - padding);
        const points = 50;
        for (let i = 0; i <= points; i++) {
          const x = padding + (width * i) / points;
          const m = 1 + (gameState.multiplier - 1) * (i / points);
          const y = canvas.height - padding - (height * (m - 1)) / Math.max(5, gameState.multiplier);
          ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Fill under curve
        ctx.lineTo(canvas.width - padding, canvas.height - padding);
        ctx.lineTo(padding, canvas.height - padding);
        ctx.fillStyle = gameState.status === 'crashed' ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)';
        ctx.fill();
      }

      animationFrame = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationFrame);
  }, [gameState.multiplier, gameState.status]);

  const [isRefilling, setIsRefilling] = useState(false);

  const handleRefillDemo = async () => {
    setIsRefilling(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/wallet/refill-demo', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.success) {
        setUser(prev => prev ? { ...prev, demo_balance: data.newDemoBalance } : null);
      }
    } catch (err) {}
    finally { setIsRefilling(false); }
  };

  const handleFixBalance = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/wallet/fix-swap', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.success) {
        setUser(prev => prev ? { ...prev, balance: 0, demo_balance: 1000 } : null);
        setError('Balance fixed! Real: $0, Demo: $1,000');
      }
    } catch (err) {}
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setUser(null);
    setSocket(null);
    // Re-initialize socket if needed, or just let it reconnect
    window.location.reload();
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authForm)
    });
    const data = await res.json();
    if (data.token) {
      localStorage.setItem('token', data.token);
      setUser(data.user);
      setAuthMode(null);
    } else {
      setError(data.error);
    }
  };

  const placeBet = () => {
    if (!socket || !user) return;
    const token = localStorage.getItem('token');
    socket.emit('game:bet', {
      token,
      amount: betAmount,
      autoCashout: parseFloat(autoCashout) || 0,
      isDemo
    });
  };

  const handleCashout = () => {
    if (!socket || !user) return;
    const token = localStorage.getItem('token');
    socket.emit('game:cashout_request', { token });
  };

  const sendChatMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!socket || !chatInput.trim()) return;
    const token = localStorage.getItem('token');
    socket.emit('chat:message', { token, message: chatInput });
    setChatInput('');
  };

  const handleWithdraw = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsWithdrawing(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/wallet/withdraw', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          amount: parseFloat(withdrawAmount),
          method: withdrawMethod,
          details: withdrawDetails
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setUser(prev => prev ? { ...prev, balance: data.newBalance } : null);
      setError('Withdrawal request submitted successfully!');
      setShowWithdraw(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsWithdrawing(false);
    }
  };
  const handleCreatePayment = async () => {
    setIsCreatingPayment(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/payment/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: parseFloat(depositAmount),
          currency: selectedCurrency,
          token
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setDepositData(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsCreatingPayment(false);
    }
  };

  const fetchDepositHistory = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/payment/history', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      setDepositHistory(data);
    } catch (err) {}
  };

  useEffect(() => {
    if (showDeposit && user) {
      fetchDepositHistory();
    }
  }, [showDeposit, user]);

  return (
    <div className="min-h-screen bg-[#0a0a0c] text-white font-sans selection:bg-emerald-500/30">
      {/* Header */}
      <header className="border-b border-white/5 bg-[#0d0d10]/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <TrendingUp className="text-white w-6 h-6" />
            </div>
            <span className="text-lg sm:text-xl font-bold tracking-tight bg-gradient-to-r from-white to-white/60 bg-clip-text text-transparent">
              CRASH ROYALE
            </span>
          </div>

          <div className="flex items-center gap-4">
            {user && (
              <div className="flex items-center bg-white/5 p-1 rounded-xl border border-white/5">
                <button
                  onClick={() => setIsDemo(false)}
                  className={cn(
                    "px-2 sm:px-3 py-1 text-[9px] sm:text-[10px] font-bold rounded-lg transition-all",
                    !isDemo ? "bg-emerald-500 text-black" : "text-zinc-500 hover:text-zinc-300"
                  )}
                >
                  REAL
                </button>
                <button
                  onClick={() => setIsDemo(true)}
                  className={cn(
                    "px-2 sm:px-3 py-1 text-[9px] sm:text-[10px] font-bold rounded-lg transition-all",
                    isDemo ? "bg-amber-500 text-black" : "text-zinc-500 hover:text-zinc-300"
                  )}
                >
                  DEMO
                </button>
              </div>
            )}
            {user ? (
              <>
                  <div className="flex flex-col items-end bg-white/5 px-3 py-1 sm:px-4 sm:py-1.5 rounded-xl border border-white/5">
                    <div className="flex items-center gap-2">
                      <Wallet className={cn("w-3.5 h-3.5", isDemo ? "text-amber-400" : "text-emerald-400")} />
                      <span className={cn("font-mono font-bold text-sm", isDemo ? "text-amber-400" : "text-emerald-400")}>
                        ${((isDemo ? user.demo_balance : user.balance) || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </span>
                      {!isDemo && (
                        <button 
                          onClick={() => setShowDeposit(true)}
                          className="ml-1 p-1 bg-emerald-500/10 text-emerald-500 rounded-lg hover:bg-emerald-500/20 transition-colors"
                          title="Deposit"
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                    {localCurrency.code !== 'USD' && !isDemo && (
                      <span className="text-[10px] text-zinc-500 font-mono font-medium">
                        ≈ {localCurrency.symbol}{((user.balance || 0) * localCurrency.rate).toLocaleString(undefined, { minimumFractionDigits: 2 })} {localCurrency.code}
                      </span>
                    )}
                    {isDemo && (
                      <span className="text-[10px] text-amber-500/50 font-mono font-medium uppercase tracking-tighter">Demo Balance</span>
                    )}
                  </div>
                <div className="flex items-center gap-2">
                  {user.role === 'admin' && (
                    <button 
                      onClick={() => setShowAdmin(true)}
                      className="p-2 hover:bg-emerald-500/10 rounded-lg transition-colors group"
                      title="Admin Panel"
                    >
                      <ShieldCheck className="w-5 h-5 text-emerald-400 group-hover:scale-110 transition-transform" />
                    </button>
                  )}
                  <button className="p-2 hover:bg-white/5 rounded-lg transition-colors">
                    <User className="w-5 h-5 text-zinc-400" />
                  </button>
                  <button 
                    onClick={() => { localStorage.removeItem('token'); setUser(null); }}
                    className="p-2 hover:bg-red-500/10 rounded-lg transition-colors group"
                  >
                    <LogOut className="w-5 h-5 text-zinc-400 group-hover:text-red-400" />
                  </button>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-3">
                <button 
                  onClick={() => setAuthMode('login')}
                  className="px-4 py-2 text-sm font-medium hover:text-emerald-400 transition-colors"
                >
                  Log In
                </button>
                <button 
                  onClick={() => setAuthMode('register')}
                  className="px-5 py-2 bg-emerald-500 hover:bg-emerald-400 text-black text-sm font-bold rounded-xl transition-all shadow-lg shadow-emerald-500/20 active:scale-95"
                >
                  Sign Up
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Sidebar: History & Stats */}
        <aside className="lg:col-span-3 space-y-6">
          <div className="bg-[#0d0d10] border border-white/5 rounded-2xl p-6">
             <div className="flex items-center justify-between mb-4">
                <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-2">
                  <History className="w-4 h-4" /> Recent History
                </h3>
             </div>
             <div className="flex flex-wrap gap-2">
                {gameState.history.map((h, i) => (
                  <span key={i} className={cn(
                    "px-2 py-1 rounded-md text-[10px] font-bold font-mono",
                    h >= 2 ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-red-500/10 text-red-400 border border-red-500/20"
                  )}>
                    {h.toFixed(2)}x
                  </span>
                ))}
             </div>
          </div>

          <div className="bg-[#0d0d10] border border-white/5 rounded-2xl p-6">
            <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4 flex items-center gap-2">
              <Trophy className="w-4 h-4" /> Top Winners
            </h3>
            <div className="space-y-3">
              {gameState.bets
                .filter(b => b.status === 'cashed_out')
                .sort((a, b) => (b.profit || 0) - (a.profit || 0))
                .slice(0, 5)
                .map((bet, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <span className="text-xs text-zinc-400">{bet.username}</span>
                    <span className="text-xs font-bold text-emerald-400">+${bet.profit?.toFixed(2)}</span>
                  </div>
                ))}
              {gameState.bets.filter(b => b.status === 'cashed_out').length === 0 && (
                <p className="text-[10px] text-zinc-600 italic">No winners yet this round</p>
              )}
            </div>
          </div>
        </aside>

        {/* Center: Game Graph & Betting Controls */}
        <section className="lg:col-span-6 space-y-6">
          <div className="bg-[#0d0d10] border border-white/5 rounded-3xl overflow-hidden relative aspect-[16/10] shadow-2xl">
            <canvas 
              ref={canvasRef} 
              width={800} 
              height={500} 
              className="w-full h-full"
            />
            
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <AnimatePresence mode="wait">
                {gameState.status === 'waiting' && (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 1.1 }}
                    className="text-center"
                  >
                    <div className="text-zinc-500 text-sm font-medium uppercase tracking-[0.2em] mb-2">Next Round In</div>
                    <div className="text-6xl font-black text-white font-mono">5.00s</div>
                  </motion.div>
                )}
                
                {(gameState.status === 'running' || gameState.status === 'crashed') && (
                  <motion.div 
                    key={gameState.status}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="text-center"
                  >
                    <div className={cn(
                      "text-8xl font-black font-mono tracking-tighter transition-colors duration-300",
                      gameState.status === 'crashed' ? "text-red-500" : "text-white"
                    )}>
                      {gameState.multiplier.toFixed(2)}x
                    </div>
                    {gameState.status === 'crashed' && (
                      <div className="text-red-500/80 text-xl font-bold uppercase tracking-widest mt-2">Crashed!</div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Live Stats Overlay */}
            <div className="absolute top-6 left-6 flex gap-4">
              <div className="bg-black/40 backdrop-blur-md border border-white/10 px-3 py-1.5 rounded-lg flex items-center gap-2">
                <Users className="w-3 h-3 text-zinc-400" />
                <span className="text-[10px] font-bold text-zinc-300">{gameState.bets.length} Players</span>
              </div>
              <div className="bg-black/40 backdrop-blur-md border border-white/10 px-3 py-1.5 rounded-lg flex items-center gap-2">
                <ShieldCheck className="w-3 h-3 text-emerald-400" />
                <span className="text-[10px] font-bold text-emerald-400">Provably Fair</span>
              </div>
            </div>
          </div>

          {/* Betting Controls - Moved below graph */}
          <div className="bg-[#0d0d10] border border-white/5 rounded-3xl p-8 shadow-xl">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="space-y-6">
                <div>
                  <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-3 block">Bet Amount</label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500 font-mono">$</span>
                    <input 
                      type="number" 
                      value={betAmount}
                      onChange={(e) => setBetAmount(Number(e.target.value))}
                      className="w-full bg-black/40 border border-white/10 rounded-2xl py-4 pl-10 pr-4 text-white font-mono text-lg focus:border-emerald-500/50 outline-none transition-all"
                    />
                  </div>
                  <div className="grid grid-cols-4 gap-2 mt-3">
                    {[10, 50, 100, 500].map(amt => (
                      <button 
                        key={amt}
                        onClick={() => setBetAmount(amt)}
                        className="py-2 bg-white/5 hover:bg-white/10 rounded-xl text-xs font-bold transition-colors border border-white/5"
                      >
                        ${amt}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-3 block">Auto Cashout</label>
                  <div className="relative">
                    <input 
                      type="text" 
                      placeholder="2.00"
                      value={autoCashout}
                      onChange={(e) => setAutoCashout(e.target.value)}
                      className="w-full bg-black/40 border border-white/10 rounded-2xl py-4 px-6 text-white font-mono text-lg focus:border-emerald-500/50 outline-none transition-all"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 font-mono">x</span>
                  </div>
                </div>
              </div>

              <div className="flex flex-col justify-end">
                {!user ? (
                  <button 
                    onClick={() => setAuthMode('login')}
                    className="w-full py-6 bg-zinc-800 text-zinc-400 font-bold rounded-2xl cursor-not-allowed text-lg"
                  >
                    LOGIN TO BET
                  </button>
                ) : hasBetThisRound ? (
                  <button 
                    onClick={handleCashout}
                    disabled={gameState.status === 'waiting'}
                    className={cn(
                      "w-full py-6 font-bold rounded-2xl transition-all shadow-lg active:scale-95 flex flex-col items-center justify-center leading-tight text-xl",
                      gameState.status === 'waiting' 
                        ? "bg-zinc-800 text-zinc-500 cursor-wait"
                        : "bg-emerald-500 hover:bg-emerald-400 text-black shadow-emerald-500/40"
                    )}
                  >
                    <span className="tracking-tighter">
                      {gameState.status === 'crashed' ? 'LATE CASHOUT' : 'CASHOUT'}
                    </span>
                    <span className="text-sm opacity-70 font-mono">
                      ${(betAmount * gameState.multiplier).toFixed(2)} ({gameState.multiplier.toFixed(2)}x)
                    </span>
                  </button>
                ) : (
                  <div className="space-y-4">
                    <button 
                      onClick={placeBet}
                      disabled={gameState.status !== 'waiting'}
                      className={cn(
                        "w-full py-6 font-bold rounded-2xl transition-all shadow-lg active:scale-95 text-xl tracking-tighter",
                        gameState.status === 'waiting' 
                          ? (isDemo ? "bg-amber-500 hover:bg-amber-400 text-black shadow-amber-500/40" : "bg-emerald-500 hover:bg-emerald-400 text-black shadow-emerald-500/40")
                          : "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                      )}
                    >
                      {gameState.status === 'waiting' ? (isDemo ? 'PLACE DEMO BET' : 'PLACE BET') : 'WAITING FOR NEXT ROUND'}
                    </button>
                    
                    {!isDemo ? (
                      <div className="grid grid-cols-2 gap-3">
                        <button 
                          onClick={() => setShowDeposit(true)}
                          className="py-3 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-500 text-xs font-bold rounded-xl transition-all border border-emerald-500/20 flex items-center justify-center gap-2"
                        >
                          <Plus className="w-4 h-4" />
                          DEPOSIT
                        </button>
                        <button 
                          onClick={() => setShowWithdraw(true)}
                          className="py-3 bg-white/5 hover:bg-white/10 text-zinc-400 text-xs font-bold rounded-xl transition-all border border-white/5 flex items-center justify-center gap-2"
                        >
                          <ArrowDownToLine className="w-4 h-4" />
                          WITHDRAW
                        </button>
                      </div>
                    ) : (
                      <div className="p-4 bg-amber-500/5 border border-amber-500/10 rounded-xl text-center space-y-3">
                        <div>
                          <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest mb-1">Demo Mode Active</p>
                          <p className="text-[10px] text-zinc-500">You are playing with virtual funds.</p>
                        </div>
                        {user.demo_balance < 10 && (
                          <button 
                            onClick={handleRefillDemo}
                            disabled={isRefilling}
                            className="w-full py-2 bg-amber-500/10 hover:bg-amber-500/20 text-amber-500 text-[10px] font-bold rounded-lg transition-all border border-amber-500/20 disabled:opacity-50"
                          >
                            {isRefilling ? 'REFILLING...' : 'REFILL DEMO BALANCE ($1,000)'}
                          </button>
                        )}
                        {user.balance >= 1000 && (
                          <button 
                            onClick={handleFixBalance}
                            className="w-full py-2 bg-red-500/10 hover:bg-red-500/20 text-red-500 text-[10px] font-bold rounded-lg transition-all border border-red-500/20"
                          >
                            FIX SWAPPED BALANCE
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Live Bets Table */}
          <div className="bg-[#0d0d10] border border-white/5 rounded-2xl overflow-hidden shadow-xl">
            <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Live Bets</h3>
              <div className="text-[10px] font-medium text-zinc-500">
                Total: <span className="text-white">${gameState.bets.reduce((acc, b) => acc + b.amount, 0).toFixed(2)}</span>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest border-b border-white/5">
                    <th className="px-6 py-3">User</th>
                    <th className="px-6 py-3">Bet</th>
                    <th className="px-6 py-3">Multiplier</th>
                    <th className="px-6 py-3 text-right">Profit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {gameState.bets.map((bet, i) => (
                    <tr key={i} className={cn(
                      "text-sm transition-colors",
                      bet.status === 'cashed_out' ? "bg-emerald-500/5" : "hover:bg-white/5"
                    )}>
                      <td className="px-6 py-4 font-medium text-zinc-300 flex items-center gap-2">
                        {bet.username}
                        {bet.is_demo && (
                          <span className="px-1.5 py-0.5 bg-amber-500/10 text-amber-500 text-[8px] font-bold rounded border border-amber-500/20">DEMO</span>
                        )}
                      </td>
                      <td className="px-6 py-4 font-mono text-zinc-400">${bet.amount.toFixed(2)}</td>
                      <td className="px-6 py-4">
                        {bet.status === 'cashed_out' ? (
                          <span className="text-emerald-400 font-bold font-mono">{bet.cashout_multiplier?.toFixed(2)}x</span>
                        ) : (
                          <span className="text-zinc-600 font-mono">-</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-right">
                        {bet.status === 'cashed_out' ? (
                          <span className="text-emerald-400 font-bold font-mono">+${bet.profit?.toFixed(2)}</span>
                        ) : (
                          <span className="text-zinc-600 font-mono">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {gameState.bets.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-6 py-12 text-center text-zinc-600 text-xs italic">
                        No bets placed yet...
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* Right Sidebar: Chat & Stats */}
        <aside className="lg:col-span-3 space-y-6">
          <div className="bg-[#0d0d10] border border-white/5 rounded-2xl flex flex-col h-[600px] shadow-xl">
            <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-2">
                <MessageSquare className="w-4 h-4" /> Global Chat
              </h3>
              <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin scrollbar-thumb-white/10">
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-tighter">System</span>
                <p className="text-xs text-zinc-400 leading-relaxed bg-white/5 p-3 rounded-xl border border-white/5">
                  Welcome to Crash Royale! Good luck to all players. Remember to play responsibly.
                </p>
              </div>
              {chatMessages.map((msg, i) => (
                <div key={i} className="flex flex-col gap-1">
                  <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-tighter">{msg.username}</span>
                  <p className="text-xs text-zinc-300 leading-relaxed">{msg.message}</p>
                </div>
              ))}
            </div>

            <div className="p-4 border-t border-white/5">
              <form onSubmit={sendChatMessage} className="relative">
                <input 
                  type="text" 
                  placeholder={user ? "Type a message..." : "Login to chat"}
                  disabled={!user}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  className="w-full bg-black/40 border border-white/10 rounded-xl py-3 px-4 text-xs outline-none focus:border-emerald-500/50 transition-all disabled:opacity-50"
                />
                <button 
                  type="submit"
                  disabled={!user}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-emerald-500 hover:bg-emerald-500/10 rounded-lg transition-colors disabled:opacity-50"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </form>
            </div>
          </div>
        </aside>
      </main>

      {/* Withdrawal Modal */}
      <AnimatePresence>
        {showWithdraw && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowWithdraw(false)}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-xl bg-[#0d0d10] border border-white/10 rounded-3xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]"
            >
              <div className="p-6 border-b border-white/5 flex items-center justify-between bg-zinc-900/50">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20">
                    <ArrowDownToLine className="w-5 h-5 text-emerald-500" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-white">Withdraw Funds</h2>
                    <p className="text-xs text-zinc-500">Minimum withdrawal: $20.00</p>
                  </div>
                </div>
                <button 
                  onClick={() => setShowWithdraw(false)}
                  className="p-2 text-zinc-500 hover:text-white transition-colors"
                >
                  <Plus className="w-6 h-6 rotate-45" />
                </button>
              </div>

              <form onSubmit={handleWithdraw} className="p-6 space-y-6 overflow-y-auto">
                <div className="grid grid-cols-3 gap-3">
                  {['binance', 'paypal', 'bank'].map((method) => (
                    <button
                      key={method}
                      type="button"
                      onClick={() => setWithdrawMethod(method)}
                      className={cn(
                        "flex flex-col items-center gap-2 p-4 rounded-2xl border transition-all",
                        withdrawMethod === method 
                          ? "bg-emerald-500/10 border-emerald-500/50 text-emerald-500" 
                          : "bg-white/5 border-white/5 text-zinc-400 hover:bg-white/10"
                      )}
                    >
                      <span className="text-[10px] font-bold uppercase">{method === 'bank' ? 'Bank Transfer' : method}</span>
                    </button>
                  ))}
                </div>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-tighter">Amount (USD)</label>
                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500 font-mono">$</span>
                      <input 
                        type="number"
                        value={withdrawAmount}
                        onChange={(e) => setWithdrawAmount(e.target.value)}
                        className="w-full bg-black/40 border border-white/10 rounded-2xl py-4 pl-8 pr-4 text-sm outline-none focus:border-emerald-500/50 transition-all font-mono"
                        placeholder="20.00"
                        min="20"
                      />
                    </div>
                  </div>

                  {withdrawMethod === 'binance' && (
                    <div className="space-y-2">
                      <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-tighter">Binance Pay ID / USDT Address (TRC20)</label>
                      <input 
                        type="text"
                        required
                        value={withdrawDetails.address}
                        onChange={(e) => setWithdrawDetails({...withdrawDetails, address: e.target.value})}
                        className="w-full bg-black/40 border border-white/10 rounded-2xl py-4 px-4 text-sm outline-none focus:border-emerald-500/50 transition-all"
                        placeholder="Enter ID or Address"
                      />
                    </div>
                  )}

                  {withdrawMethod === 'paypal' && (
                    <div className="space-y-2">
                      <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-tighter">PayPal Email</label>
                      <input 
                        type="email"
                        required
                        value={withdrawDetails.email}
                        onChange={(e) => setWithdrawDetails({...withdrawDetails, email: e.target.value})}
                        className="w-full bg-black/40 border border-white/10 rounded-2xl py-4 px-4 text-sm outline-none focus:border-emerald-500/50 transition-all"
                        placeholder="your@email.com"
                      />
                    </div>
                  )}

                  {withdrawMethod === 'bank' && (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-tighter">Bank Name</label>
                        <input 
                          type="text"
                          required
                          value={withdrawDetails.bankName}
                          onChange={(e) => setWithdrawDetails({...withdrawDetails, bankName: e.target.value})}
                          className="w-full bg-black/40 border border-white/10 rounded-2xl py-4 px-4 text-sm outline-none focus:border-emerald-500/50 transition-all"
                          placeholder="Bank Name"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-tighter">Account Number / IBAN</label>
                        <input 
                          type="text"
                          required
                          value={withdrawDetails.accountNumber}
                          onChange={(e) => setWithdrawDetails({...withdrawDetails, accountNumber: e.target.value})}
                          className="w-full bg-black/40 border border-white/10 rounded-2xl py-4 px-4 text-sm outline-none focus:border-emerald-500/50 transition-all"
                          placeholder="Account Number"
                        />
                      </div>
                    </div>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={isWithdrawing || parseFloat(withdrawAmount) < 20 || (user && user.balance < parseFloat(withdrawAmount))}
                  className="w-full bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 disabled:hover:bg-emerald-500 text-black font-bold py-4 rounded-2xl transition-all shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2"
                >
                  {isWithdrawing ? (
                    <div className="w-5 h-5 border-2 border-black/20 border-t-black rounded-full animate-spin" />
                  ) : (
                    <>
                      <ArrowDownToLine className="w-5 h-5" />
                      Submit Withdrawal Request
                    </>
                  )}
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showDeposit && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => { setShowDeposit(false); setDepositData(null); }}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-2xl bg-[#0d0d10] border border-white/10 rounded-3xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]"
            >
              <div className="p-6 border-b border-white/5 flex items-center justify-between bg-zinc-900/50">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20">
                    <ArrowDownToLine className="w-5 h-5 text-emerald-500" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-white">Deposit Crypto</h2>
                    <p className="text-xs text-zinc-500">Instant deposits via NOWPayments</p>
                  </div>
                </div>
                <button 
                  onClick={() => { setShowDeposit(false); setDepositData(null); }}
                  className="p-2 text-zinc-500 hover:text-white transition-colors"
                >
                  <Plus className="w-6 h-6 rotate-45" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-8">
                {!depositData ? (
                  <div className="space-y-6">
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                      {['btc', 'eth', 'usdttrc20', 'bch', 'ltc'].map((coin) => (
                        <button
                          key={coin}
                          onClick={() => setSelectedCurrency(coin)}
                          className={cn(
                            "flex flex-col items-center gap-2 p-4 rounded-2xl border transition-all",
                            selectedCurrency === coin 
                              ? "bg-emerald-500/10 border-emerald-500/50 text-emerald-500" 
                              : "bg-white/5 border-white/5 text-zinc-400 hover:bg-white/10"
                          )}
                        >
                          <span className="text-xs font-bold uppercase">{coin.replace('trc20', '')}</span>
                        </button>
                      ))}
                    </div>

                    <div className="space-y-2">
                      <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-tighter">Amount (USD)</label>
                      <div className="relative">
                        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500 font-mono">$</span>
                        <input 
                          type="number"
                          value={depositAmount}
                          onChange={(e) => setDepositAmount(e.target.value)}
                          className="w-full bg-black/40 border border-white/10 rounded-2xl py-4 pl-8 pr-4 text-sm outline-none focus:border-emerald-500/50 transition-all font-mono"
                          placeholder="1.00"
                        />
                      </div>
                      <p className="text-[10px] text-zinc-500">Minimum deposit: $1.00</p>
                    </div>

                    <button
                      onClick={handleCreatePayment}
                      disabled={isCreatingPayment || !depositAmount || parseFloat(depositAmount) < 1}
                      className="w-full bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 disabled:hover:bg-emerald-500 text-black font-bold py-4 rounded-2xl transition-all shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2"
                    >
                      {isCreatingPayment ? (
                        <div className="w-5 h-5 border-2 border-black/20 border-t-black rounded-full animate-spin" />
                      ) : (
                        <>
                          <Plus className="w-5 h-5" />
                          Create Deposit Address
                        </>
                      )}
                    </button>

                    <div className="space-y-4">
                      <h3 className="text-[10px] font-bold text-zinc-500 uppercase tracking-tighter">Recent Deposits</h3>
                      <div className="space-y-2">
                        {depositHistory.length === 0 ? (
                          <p className="text-xs text-zinc-600 italic">No recent deposits found.</p>
                        ) : (
                          depositHistory.map((dep: any) => (
                            <div key={dep.id} className="flex items-center justify-between p-3 bg-white/5 rounded-xl border border-white/5">
                              <div className="flex items-center gap-3">
                                <div className={cn(
                                  "w-2 h-2 rounded-full",
                                  dep.status === 'finished' ? "bg-emerald-500" : "bg-amber-500"
                                )} />
                                <div>
                                  <p className="text-xs font-bold text-zinc-200 uppercase">{dep.currency}</p>
                                  <p className="text-[10px] text-zinc-500">{dep.created_at ? new Date(dep.created_at).toLocaleString() : 'Pending...'}</p>
                                </div>
                              </div>
                              <div className="text-right">
                                <p className="text-xs font-bold text-zinc-200 font-mono">${dep.amount}</p>
                                <p className={cn(
                                  "text-[10px] font-bold uppercase tracking-tighter",
                                  dep.status === 'finished' ? "text-emerald-500" : "text-amber-500"
                                )}>{dep.status}</p>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-8 py-4">
                    <div className="flex flex-col items-center text-center space-y-4">
                      <div className="p-4 bg-white rounded-3xl shadow-xl">
                        <QRCodeSVG value={depositData.pay_address} size={180} />
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-zinc-400">Send exactly</p>
                        <p className="text-2xl font-bold text-white font-mono">{depositData.pay_amount} <span className="text-emerald-500 uppercase">{depositData.pay_currency}</span></p>
                        <p className="text-[10px] text-zinc-500 uppercase tracking-tighter">≈ ${depositData.price_amount} USD</p>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-tighter">Deposit Address</label>
                        <div className="flex gap-2">
                          <div className="flex-1 bg-black/40 border border-white/10 rounded-xl p-3 text-xs font-mono text-zinc-300 break-all">
                            {depositData.pay_address}
                          </div>
                          <button 
                            onClick={() => navigator.clipboard.writeText(depositData.pay_address)}
                            className="p-3 bg-white/5 border border-white/10 rounded-xl hover:bg-white/10 transition-colors text-zinc-400 hover:text-white"
                          >
                            <Copy className="w-5 h-5" />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="p-4 bg-white/5 border border-white/5 rounded-2xl space-y-1">
                          <div className="flex items-center gap-2 text-zinc-500">
                            <Clock className="w-3 h-3" />
                            <span className="text-[10px] font-bold uppercase tracking-tighter">Status</span>
                          </div>
                          <p className="text-xs font-bold text-amber-500 uppercase tracking-tighter">Waiting for Payment</p>
                        </div>
                        <div className="p-4 bg-white/5 border border-white/5 rounded-2xl space-y-1">
                          <div className="flex items-center gap-2 text-zinc-500">
                            <ShieldCheck className="w-3 h-3" />
                            <span className="text-[10px] font-bold uppercase tracking-tighter">Network</span>
                          </div>
                          <p className="text-xs font-bold text-zinc-200 uppercase tracking-tighter">{depositData.pay_currency}</p>
                        </div>
                      </div>

                      <div className="p-4 bg-emerald-500/5 border border-emerald-500/10 rounded-2xl flex items-start gap-3">
                        <AlertCircle className="w-4 h-4 text-emerald-500 mt-0.5" />
                        <p className="text-[10px] text-zinc-400 leading-relaxed">
                          Your balance will be credited automatically after <span className="text-emerald-500 font-bold">1 network confirmation</span>. Do not close this window until you have sent the payment.
                        </p>
                      </div>

                      <button
                        onClick={() => setDepositData(null)}
                        className="w-full bg-white/5 hover:bg-white/10 text-zinc-300 font-bold py-4 rounded-2xl transition-all border border-white/5"
                      >
                        Cancel & Go Back
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showAdmin && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowAdmin(false)}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#0d0d10] border border-white/10 w-full max-w-6xl max-h-[90vh] rounded-3xl overflow-hidden flex flex-col shadow-2xl relative z-10"
            >
              <div className="p-6 border-b border-white/5 flex items-center justify-between bg-white/5">
                <div className="flex items-center gap-3">
                  <ShieldCheck className="w-6 h-6 text-emerald-400" />
                  <h2 className="text-xl font-bold">Admin Database Management</h2>
                </div>
                <button 
                  onClick={() => setShowAdmin(false)}
                  className="p-2 hover:bg-white/10 rounded-xl transition-colors"
                >
                  <Plus className="w-6 h-6 rotate-45" />
                </button>
              </div>

              <div className="flex flex-1 overflow-hidden">
                {/* Sidebar Tabs */}
                <div className="w-48 border-r border-white/5 p-4 space-y-2 bg-black/20 overflow-y-auto">
                  {adminTables.map(tab => (
                    <button
                      key={tab}
                      onClick={() => setActiveAdminTab(tab)}
                      className={cn(
                        "w-full text-left px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all",
                        activeAdminTab === tab ? "bg-emerald-500 text-black" : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
                      )}
                    >
                      {tab.replace('_', ' ')}
                    </button>
                  ))}
                  <div className="pt-8">
                    <button 
                      onClick={async () => {
                        const token = localStorage.getItem('token');
                        const res = await fetch(`/api/admin/table/${activeAdminTab}`, {
                          headers: { Authorization: `Bearer ${token}` }
                        });
                        const data = await res.json();
                        if (Array.isArray(data)) setAdminData(data);
                      }}
                      className="w-full py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all"
                    >
                      Refresh Data
                    </button>
                  </div>
                </div>

                {/* Data Table */}
                <div className="flex-1 overflow-auto p-6">
                  {!adminData ? (
                    <div className="h-full flex flex-col items-center justify-center text-zinc-500 space-y-4">
                      <Clock className="w-12 h-12 animate-pulse" />
                      <p className="font-medium">Click "Refresh Data" to load table contents</p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-bold text-zinc-400 uppercase tracking-widest">
                          Table: {activeAdminTab.toUpperCase()}
                        </h3>
                        <span className="text-[10px] text-zinc-600">Showing last 50 entries</span>
                      </div>
                      <div className="border border-white/5 rounded-2xl overflow-hidden">
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-[10px]">
                            <thead className="bg-white/5 text-zinc-500 uppercase font-bold tracking-tighter">
                              <tr>
                                {adminData.length > 0 && Object.keys(adminData[0]).map(key => (
                                  <th key={key} className="px-4 py-3 border-b border-white/5 whitespace-nowrap">{key}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                              {adminData.map((row: any, i: number) => (
                                <tr key={i} className="hover:bg-white/5 transition-colors">
                                  {Object.values(row).map((val: any, j: number) => (
                                    <td key={j} className="px-4 py-3 font-mono text-zinc-400 truncate max-w-[200px]">
                                      {typeof val === 'object' ? JSON.stringify(val) : String(val)}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {adminData.length === 0 && (
                          <div className="p-12 text-center text-zinc-600 italic">No data found in this table</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Auth Modal */}
      <AnimatePresence>
        {authMode && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setAuthMode(null)}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-[#0d0d10] border border-white/10 rounded-3xl p-8 w-full max-w-md relative z-10 shadow-2xl"
            >
              <h2 className="text-2xl font-bold mb-2">{authMode === 'login' ? 'Welcome Back' : 'Create Account'}</h2>
              <p className="text-zinc-500 text-sm mb-8">Enter your details to access the arena.</p>
              
              <form onSubmit={handleAuth} className="space-y-4">
                {authMode === 'register' && (
                  <div>
                    <label className="text-xs font-medium text-zinc-400 mb-2 block">Username</label>
                    <input 
                      type="text" 
                      required
                      value={authForm.username}
                      onChange={(e) => setAuthForm({ ...authForm, username: e.target.value })}
                      className="w-full bg-black/40 border border-white/10 rounded-xl py-3 px-4 outline-none focus:border-emerald-500/50 transition-all"
                    />
                  </div>
                )}
                <div>
                  <label className="text-xs font-medium text-zinc-400 mb-2 block">Email Address</label>
                  <input 
                    type="email" 
                    required
                    value={authForm.email}
                    onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })}
                    className="w-full bg-black/40 border border-white/10 rounded-xl py-3 px-4 outline-none focus:border-emerald-500/50 transition-all"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-zinc-400 mb-2 block">Password</label>
                  <input 
                    type="password" 
                    required
                    value={authForm.password}
                    onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })}
                    className="w-full bg-black/40 border border-white/10 rounded-xl py-3 px-4 outline-none focus:border-emerald-500/50 transition-all"
                  />
                </div>
                <button className="w-full py-4 bg-emerald-500 hover:bg-emerald-400 text-black font-bold rounded-xl transition-all shadow-lg shadow-emerald-500/20 mt-4 active:scale-95">
                  {authMode === 'login' ? 'Log In' : 'Sign Up'}
                </button>
              </form>
              
              <div className="mt-6 text-center">
                <button 
                  onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}
                  className="text-sm text-zinc-500 hover:text-emerald-400 transition-colors"
                >
                  {authMode === 'login' ? "Don't have an account? Sign up" : "Already have an account? Log in"}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Error Toast */}
      <AnimatePresence>
        {error && (
          <motion.div 
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[200]"
          >
            <div className="bg-red-500 text-white px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3">
              <AlertCircle className="w-5 h-5" />
              <span className="font-medium">{error}</span>
              <button onClick={() => setError(null)} className="ml-4 opacity-70 hover:opacity-100">✕</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

