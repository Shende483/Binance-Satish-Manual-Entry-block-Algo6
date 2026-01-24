
// src/pages/Dashboard.tsx
import React, { useState, useEffect, useContext, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Card, CardContent, Typography, Button, TextField, FormControl,
  InputLabel, Table, TableBody, TableCell, TableHead, TableRow, Chip, Alert, CircularProgress,
  IconButton, Dialog, DialogTitle, DialogContent, DialogActions, Snackbar, Autocomplete,
  MenuItem, Select, Slider
} from '@mui/material';
import { Add, Close, Refresh, Edit } from '@mui/icons-material';
import { ThemeContext } from '../main';
import {
  initializeSocket, getSocket, closePosition,
  setBlockStatus, addMargin, verifyToken, logout, activateBurstMode, deactivateBurstMode,
  getsymbolsMode, orderPreflight, confirmOrder, modifyOrder
} from '../api/api';
import Header from './Header';

interface LivePosition {
  id: string;
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  type: 'BUY' | 'SELL';
  entryPrice: string;
  markPrice: string;
  positionAmt: string;
  unRealizedProfit: string;
  breakEvenPrice: string;
  isolatedMargin: string;
  isolatedWallet: string;
  liquidationPrice: string;
  notional: string;
  updateTime: number;
  adlQuantile?: number;
  isAutoAddMargin?: string;
  isolated?: boolean;
  leverage?: string;
  marginType?: string;
  maxNotionalValue?: string;
}

interface PendingOrder {
  id: string;
  orderId: number;
  ClientId: string;
  symbol: string;
  type: string;
  side: string;
  positionSide: 'LONG' | 'SHORT';
  Qty: number;
  openPrice: number;
  stopLoss: string;
  time: number;
  timeInForce: string;
}

interface PositionGroup {
  key: string;
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  position?: LivePosition;
  pendingOrders: PendingOrder[];
}

interface LiveData {
  accountId: string;
  positionData: {
    positions?: any[];
    filteredPendingOrders?: any[];
  };
}

interface BalanceData {
  accountId: string;
  equity: number;
  balance: number;
}

interface BotStatusData {
  accountId: string;
  userId: string;
  dailyEntries: number;
  maxDailyEntries: number;
  burstEnabled: boolean;
  burstEntriesLeft: number;
  burstUsesToday: number;
  maxBurstUses: number;
  lastEntryMinutesAgo: number | null;
  requiredGapMinutes: number;
  timeUntilNextEntry: number;
  timeUntilNextEntryUntil: number;
  restingEnabled: boolean;
  restingMinutesLeft: number;
  restingUntil: number;
  isTradingHours: boolean;
  maxSlTpPerSymbol: number;
}

const Dashboard: React.FC = () => {
  useContext(ThemeContext);
  const navigate = useNavigate();
  const [accountId] = useState('default');
  const [symbol, setSymbol] = useState('');
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [riskPercent, setRiskPercent] = useState<number>(0.40);
  const [availableSymbols, setAvailableSymbols] = useState<string[]>([]);
  const [balance, setBalance] = useState<number | undefined>(undefined);
  const [positions, setPositions] = useState<LivePosition[]>([]);
  const [pending, setPending] = useState<PendingOrder[]>([]);
  const [groupedData, setGroupedData] = useState<PositionGroup[]>([]);
  const [botStatus, setBotStatus] = useState<BotStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [marginAdd, setMarginAdd] = useState<{ open: boolean; symbol: string; side: 'BUY' | 'SELL' }>({
    open: false, symbol: '', side: 'BUY'
  });
  const [marginAmount, setMarginAmount] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; duration: number; label: string }>({ open: false, duration: 0, label: '' });
  const [restingSecondsLeft, setRestingSecondsLeft] = useState(0);
  const [restingUntil, setRestingUntil] = useState(0);
  const [selectedDuration, setSelectedDuration] = useState<number>(0);
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [orderConfirmOpen, setOrderConfirmOpen] = useState(false);
  const [orderConfirmData, setOrderConfirmData] = useState<any>(null);
  const durationLabels: Record<number, string> = {
    5: '5m', 15: '15m', 30: '30m', 60: '1h',
    240: '4h', 720: '12h', 1440: '24h', 2880: '48h'
  };
  const durations = [5, 15, 30, 60, 240, 720, 1440, 2880];
 const [isScalpingMode, setIsScalpingMode] = useState(false);

  const [modifyDialog, setModifyDialog] = useState<{
    open: boolean;
    type: 'SL' | 'TP';
    symbol: string;
    side: 'BUY' | 'SELL';
    positionSide: 'LONG' | 'SHORT';
    oldPrice: number;
    orderId: string;
    positionAmt: string;
    updateTime: number;
    clientId: string;
  } | null>(null);
  const [newPrice, setNewPrice] = useState('');

  const fetchSymbols = useCallback(async () => {
    if (availableSymbols.length > 0) return;
    try {
      const response = await getsymbolsMode() as { success?: boolean; symbols?: string[] } | undefined;
      if (response && response.symbols) {
        setAvailableSymbols(response.symbols);
      } else {
        setAvailableSymbols(['BTCUSDT']);
      }
    } catch (err) {
      setAvailableSymbols(['BTCUSDT']);
    }
  }, [availableSymbols]);



  useEffect(() => {
    const interval = setInterval(() => {
      if (restingUntil > 0) {
        const now = Date.now();
        const remaining = Math.max(0, (restingUntil - now) / 1000);
        setRestingSecondsLeft(remaining);
        if (remaining <= 0) setRestingUntil(0);
      } else {
        setRestingSecondsLeft(0);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [restingUntil]);


// THIS FORCES LIVE UPDATE EVERY SECOND — LIKE RESTING TIMER
useEffect(() => {
  const interval = setInterval(() => {
    setBotStatus(prev => prev ? { ...prev } : prev); // shallow copy → forces re-render
  }, 1000);
  return () => clearInterval(interval);
}, [botStatus?.timeUntilNextEntryUntil]);



  useEffect(() => {
    if (error) setSnackbarOpen(true);
  }, [error]);

  useEffect(() => {
    const groups: Record<string, PositionGroup> = {};
    positions.forEach(p => {
      const key = `${p.symbol}_${p.positionSide}`;
      if (!groups[key]) {
        groups[key] = { key, symbol: p.symbol, positionSide: p.positionSide, position: p, pendingOrders: [] };
      } else {
        groups[key].position = p;
      }
    });
    pending.forEach(o => {
      const key = `${o.symbol}_${o.positionSide}`;
      if (!groups[key]) {
        groups[key] = { key, symbol: o.symbol, positionSide: o.positionSide, position: undefined, pendingOrders: [o] };
      } else {
        groups[key].pendingOrders.push(o);
      }
    });
    setGroupedData(Object.values(groups));
  }, [positions, pending]);

  useEffect(() => {
    const init = async () => {
      const token = localStorage.getItem('token');
      if (!token) { navigate('/login', { replace: true }); return; }
      try {
        await verifyToken();
        const socket = initializeSocket(token, accountId);
        const handleDataReceived = () => { if (loading) setLoading(false); };
        socket.on('equity-balance-manual', (data: BalanceData) => {
          setBalance(data.balance);
          handleDataReceived();
        });
        socket.on('live-data', (data: LiveData) => {
          console.log('Received live-data:', data);
          const rawPositions = data.positionData?.positions ?? [];
          const mappedPositions: LivePosition[] = rawPositions.map(p => {
            const qty = Number(p.positionAmt);
            return { ...p, id: `${p.symbol}_${p.positionSide}`, type: qty > 0 ? 'BUY' : 'SELL' };
          });
          setPositions(mappedPositions);
          const rawPending = data.positionData?.filteredPendingOrders ?? [];
          const mappedPending: PendingOrder[] = rawPending.map(o => ({ ...o, id: String(o.orderId) }));
          setPending(mappedPending);
          handleDataReceived();
        });
        socket.on('bot-status', (data: BotStatusData) => {
          setBotStatus(data);
          if (data.restingEnabled) setRestingUntil(data.restingUntil);
          else setRestingUntil(0);
          handleDataReceived();
        });
        socket.on('connect_error', () => setError('Connection lost. Reconnecting...'));
        socket.on('auth-error', (res: any) => setError(res.message || 'Auth failed'));
      } catch (err: any) {
        setError(err.message || 'Initialization failed');
        setLoading(false);
        localStorage.removeItem('token');
        navigate('/login', { replace: true });
      }
    };
    init();
    return () => { const socket = getSocket(); if (socket) socket.disconnect(); };
  }, [navigate, accountId, loading]);

  const handleManualRefresh = () => {
    setError('');
    const socket = getSocket();
    if (socket?.connected) socket.emit('refresh-data');
    else setError('Socket not connected. Refresh page.');
  };

  const handlePlaceOrder = async () => {
    setError('');
    if (!symbol || !stopLoss || !takeProfit) { setError('Symbol, SL, TP required'); return; }
    try {
      const pre = await orderPreflight({ symbol, side, stopLoss: Number(stopLoss), takeProfit: Number(takeProfit), riskPercent });
      setOrderConfirmData(pre);
      setOrderConfirmOpen(true);
      setIsScalpingMode(false);
    } catch (err: any) { setError(err.message); }
  };

  const handleConfirmPlaceOrder = async () => {
    try {
      await confirmOrder({...orderConfirmData,
                    isScalping: isScalpingMode
     } );
      setOrderConfirmOpen(false);setIsScalpingMode(false);
      setStopLoss(''); setTakeProfit(''); setRiskPercent(0.30);
    } catch (err: any) { setError(err.message); }
  };

  const handleClose = async (symbol: string, type: 'BUY' | 'SELL', positionSide: string, volume: number) => {
    setError('');
    try { await closePosition(symbol, type, positionSide, volume); }
    catch (err: any) { setError(err.message); }
  };




  const handleToggleBurst = async () => {
    setError('');
    try { if (botStatus?.burstEnabled) await deactivateBurstMode(); else await activateBurstMode(); }
    catch (err: any) { setError(err.message); }
  };

  const handleBlockClick = () => {
    if (restingUntil > Date.now()) {
      setError(`Resting mode active: ${Math.floor(restingSecondsLeft / 60)}m ${Math.floor(restingSecondsLeft % 60)}s left`);
      return;
    }
    if (selectedDuration > 0) {
      setConfirmDialog({ open: true, duration: selectedDuration, label: durationLabels[selectedDuration] });
    } else {
      setError('Select a duration');
    }
  };

  const handleConfirmBlock = async () => {
    setError('');
    try { await setBlockStatus(confirmDialog.duration); }
    catch (err: any) { setError(err.message); }
    setConfirmDialog({ open: false, duration: 0, label: '' });
  };

  const handleAddMargin = async () => {
    setError('');
    try {
      await addMargin(marginAdd.symbol, marginAdd.side, Number(marginAmount));
      setMarginAdd({ open: false, symbol: '', side: 'BUY' });
      setMarginAmount('');
    } catch (err: any) { setError(err.message); }
  };

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  const openModifyDialog = (
    type: 'SL' | 'TP',
    group: PositionGroup,
    order: PendingOrder
  ) => {
    if (!group.position) return;

    setModifyDialog({
      open: true,
      type,
      symbol: group.symbol,
      side: order.side as 'BUY' | 'SELL',
      positionSide: order.positionSide as 'LONG' | 'SHORT',
      oldPrice: Number(order.stopLoss),
      orderId: String(order.orderId),
      positionAmt: order.Qty.toString(),
      updateTime: order.time,
      clientId: order.ClientId
    });
    setNewPrice(order.stopLoss);
  };

  if (loading) {
    return (
      <Box display="flex" flexDirection="column" justifyContent="center" alignItems="center" mt={6}>
        <CircularProgress size={40} thickness={4} />
        <Typography sx={{ mt: 2, fontFamily: 'Inter', fontWeight: 600, fontSize: '0.9rem', color: '#e2e8f0' }}>
          Connecting...
        </Typography>
        <Button variant="outlined" onClick={handleManualRefresh} sx={{ mt: 1.5, fontFamily: 'Inter', fontSize: '0.8rem' }}>
          <Refresh /> Retry
        </Button>
      </Box>
    );
  }

  return (
    <>
      <Header onRefresh={handleManualRefresh} onLogout={handleLogout} />
      <Snackbar open={snackbarOpen} autoHideDuration={6000} onClose={() => { setSnackbarOpen(false); setError(''); }} anchorOrigin={{ vertical: 'top', horizontal: 'center' }} sx={{ zIndex: 9999 }}>
        <Alert onClose={() => { setSnackbarOpen(false); setError(''); }} severity="error" sx={{
          width: '100%', maxWidth: 500, fontFamily: 'Inter', fontSize: '0.8rem', fontWeight: 500,
          background: 'rgba(239, 68, 68, 0.95)', backdropFilter: 'blur(10px)', color: 'white',
          border: '1px solid #f87171', borderRadius: 2, boxShadow: '0 8px 32px rgba(0,0,0,0.3)'
        }}>
          {error}
        </Alert>
      </Snackbar>
      <Box sx={{ p: { xs: 1.5, md: 2 }, minHeight: '100vh', background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)', color: '#e2e8f0', fontFamily: 'Inter, sans-serif' }}>
        <Box sx={{ maxWidth: '1800px', mx: 'auto' }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr 1fr' }, gap: 2, mb: 2 }}>
          
               
   <Card sx={{ 
  background: 'rgba(30, 41, 59, 0.7)', 
  backdropFilter: 'blur(12px)', 
  border: '1px solid rgba(148, 163, 184, 0.2)', 
  borderRadius: 2.5, 
  boxShadow: '0 6px 20px rgba(0,0,0,0.2)' 
}}>
  <CardContent sx={{ p: 2 }}>
    <Typography sx={{ 
      fontFamily: 'Inter', 
      fontWeight: 700, 
      fontSize: '1rem', 
      mb: 1.8, 
      color: '#60a5fa',
      letterSpacing: '0.3px'
    }}>
      Bot Status
    </Typography>

    {botStatus ? (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        
        {/* Last Entry */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography sx={{ fontSize: '0.84rem', color: '#94a3b8', fontWeight: 600 }}>
            Last Entry
          </Typography>
          <Typography sx={{ 
            fontFamily: 'monospace', 
            fontSize: '0.95rem', 
            fontWeight: 700, 
            color: '#e2e8f0' 
          }}>
            {botStatus.lastEntryMinutesAgo ? `${botStatus.lastEntryMinutesAgo} min ago` : 'Never'}
          </Typography>
        </Box>

        {/* Required Gap */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography sx={{ fontSize: '0.84rem', color: '#94a3b8', fontWeight: 600 }}>
            Min Gap
          </Typography>
          <Typography sx={{ 
            fontFamily: 'monospace', 
            fontSize: '0.95rem', 
            fontWeight: 700, 
            color: '#60a5fa' 
          }}>
            {botStatus.requiredGapMinutes} min
          </Typography>
        </Box>

        {/* Trading Hours */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography sx={{ fontSize: '0.84rem', color: '#94a3b8', fontWeight: 600 }}>
            Trading Hours
          </Typography>
          <Chip 
            label={botStatus.isTradingHours ? 'ACTIVE' : 'CLOSED'} 
            size="small"
            sx={{ 
              fontWeight: 800,
              fontSize: '0.76rem',
              background: botStatus.isTradingHours ? '#10b981' : '#64748b',
              color: 'white',
              minWidth: 82,
              textAlign: 'center',
              boxShadow: botStatus.isTradingHours ? '0 0 12px rgba(16,185,129,0.4)' : 'none'
            }} 
          />
        </Box>

        {/* Max SL/TP per Symbol */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography sx={{ fontSize: '0.84rem', color: '#94a3b8', fontWeight: 600 }}>
            Max SL/TP
          </Typography>
          <Typography sx={{ 
            fontFamily: 'monospace', 
            fontSize: '0.95rem', 
            fontWeight: 800, 
            color: '#a78bfa',
            textShadow: '0 0 8px rgba(167,139,250,0.3)'
          }}>
            {botStatus.maxSlTpPerSymbol}
          </Typography>
        </Box>

      </Box>
    ) : (
      <Typography sx={{ fontSize: '0.75rem', color: '#64748b', textAlign: 'center' }}>Loading...</Typography>
    )}
  </CardContent>
</Card>
           
           
           <Card sx={{ 
  background: 'rgba(30, 41, 59, 0.7)', 
  backdropFilter: 'blur(12px)', 
  border: '1px solid rgba(148, 163, 184, 0.2)', 
  borderRadius: 2.5, 
  boxShadow: '0 6px 20px rgba(0,0,0,0.2)' 
}}>
  <CardContent sx={{ p: 2 }}>
    <Typography sx={{ 
      fontFamily: 'Inter', 
      fontWeight: 700, 
      fontSize: '1rem', 
      mb: 1.8, 
      color: '#a78bfa',
      letterSpacing: '0.3px'
    }}>
      Modes
    </Typography>

    {botStatus ? (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.6 }}>
        
        {/* BURST MODE */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography sx={{ fontSize: '0.84rem', color: '#94a3b8', fontWeight: 600 }}>
            Burst Mode
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Chip 
              label={botStatus.burstEnabled ? `ON (${botStatus.burstEntriesLeft})` : 'OFF'} 
              size="small" 
              sx={{ 
                fontWeight: 700,
                fontSize: '0.76rem',
                background: botStatus.burstEnabled ? '#10b981' : '#475569',
                color: 'white',
                minWidth: 72,
                textAlign: 'center'
              }} 
            />
            <Button 
              variant="outlined" 
              size="small" 
              onClick={handleToggleBurst} 
              sx={{ 
                fontSize: '0.72rem', 
                fontWeight: 600,
                px: 1.5,
                borderColor: '#a78bfa',
                color: '#e2e8f0',
                '&:hover': { borderColor: '#c4b5fd', background: 'rgba(167,139,250,0.1)' }
              }}
            >
              Toggle
            </Button>
          </Box>
        </Box>

        {/* BLOCK / RESTING MODE */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography sx={{ fontSize: '0.84rem', color: '#94a3b8', fontWeight: 600 }}>
            Resting Block
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box sx={{ display: 'flex', gap: 0.5 }}>
              <FormControl size="small" sx={{ minWidth: 80 }}>
                <InputLabel sx={{ fontSize: '0.76rem' }}>Duration</InputLabel>
                <Select 
                  value={selectedDuration} 
                  onChange={e => setSelectedDuration(Number(e.target.value))} 
                  label="Duration" 
                  sx={{ fontSize: '0.76rem', height: 36 }}
                >
                  <MenuItem value={0}>—</MenuItem>
                  {durations.map(d => (
                    <MenuItem key={d} value={d}>{durationLabels[d]}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Button 
                variant="outlined" 
                size="small" 
                onClick={handleBlockClick} 
                sx={{ 
                  fontSize: '0.72rem', 
                  fontWeight: 600,
                  px: 1.5,
                  borderColor: '#f59e0b',
                  color: '#e2e8f0',
                  '&:hover': { borderColor: '#fbbf24', background: 'rgba(251,146,60,0.1)' }
                }}
              >
                Set
              </Button>
            </Box>
          </Box>
        </Box>

        {/* CURRENT BLOCK STATUS */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 0.5 }}>
          <Typography sx={{ fontSize: '0.84rem', color: '#94a3b8' }}>
            Status
          </Typography>
          <Typography 
            sx={{ 
              fontFamily: 'monospace',
              fontSize: '1.05rem', 
              fontWeight: 800,
              color: restingUntil > Date.now() ? '#fbbf24' : '#22c55e',
              textShadow: restingUntil > Date.now() ? '0 0 8px rgba(251,191,36,0.4)' : '0 0 6px rgba(34,197,94,0.3)'
            }}
          >
            {restingUntil > Date.now() 
              ? `${Math.floor(restingSecondsLeft / 60)}m ${Math.floor(restingSecondsLeft % 60).toString().padStart(2, '0')}s`
              : 'OFF'
            }
          </Typography>
        </Box>

      </Box>
    ) : (
      <Typography sx={{ fontSize: '0.75rem', color: '#64748b', textAlign: 'center' }}>Loading...</Typography>
    )}
  </CardContent>
</Card>
          
            {/* ────────────────────── BALANCE CARD WITH LIVE COUNTDOWN ────────────────────── */}
<Card sx={{ 
  background: 'rgba(30, 41, 59, 0.7)', 
  backdropFilter: 'blur(12px)', 
  border: '1px solid rgba(148, 163, 184, 0.2)', 
  borderRadius: 2.5, 
  boxShadow: '0 6px 20px rgba(0,0,0,0.2)' 
}}>
  <CardContent sx={{ p: 2 }}>
    <Typography sx={{ fontFamily: 'Inter', fontWeight: 700, fontSize: '1rem', mb: 0.5, color: '#34d399' }}>
      Balance
    </Typography>
    <Typography sx={{ fontFamily: 'Inter', fontWeight: 800, fontSize: '1.75rem', color: '#e2e8f0' }}>
      {balance !== undefined ? `$${balance.toFixed(2)}` : '-'}
    </Typography>

    {botStatus ? (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.2 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography sx={{ fontSize: '0.82rem', color: '#94a3b8' }}>Entries Today</Typography>
          <Chip 
            label={`${botStatus.dailyEntries}/${botStatus.maxDailyEntries}`} 
            size="small" 
            sx={{ 
              background: botStatus.dailyEntries >= botStatus.maxDailyEntries ? '#ef4444' : '#10b981',
              color: 'white', 
              fontWeight: 700, 
              fontSize: '0.75rem' 
            }} 
          />
        </Box>

        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography sx={{ fontSize: '0.82rem', color: '#94a3b8', fontWeight: 600 }}>
            Next Entry In
          </Typography>

        {/* LIVE COUNTDOWN TIMER */}
<Typography
  sx={{
    fontFamily: 'monospace',
    fontSize: '1.15rem',
    fontWeight: 800,
    letterSpacing: '1px',
    color: botStatus?.timeUntilNextEntryUntil && botStatus.timeUntilNextEntryUntil > Date.now() + 300000
      ? '#fbbf24'
      : botStatus?.timeUntilNextEntryUntil && botStatus.timeUntilNextEntryUntil > Date.now()
        ? '#f59e0b'
        : '#22c55e',
    textShadow: botStatus?.timeUntilNextEntryUntil && botStatus.timeUntilNextEntryUntil > Date.now()
      ? '0 0 8px rgba(251,191,36,0.4)'
      : '0 0 8px rgba(34,197,94,0.5)',
    transition: 'all 0.3s ease'
  }}
>
  {botStatus?.timeUntilNextEntryUntil && botStatus.timeUntilNextEntryUntil > Date.now() ? (
    (() => {
      const totalSeconds = Math.floor((botStatus.timeUntilNextEntryUntil - Date.now()) / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      return `${hours.toString().padStart(2, '0')}:${minutes
        .toString()
        .padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    })()
  ) : (
    <span style={{ color: '#22c55e' }}>READY</span>
  )}
</Typography>
        </Box>
      </Box>
    ) : (
      <Typography sx={{ fontSize: '0.75rem', color: '#64748b', textAlign: 'center' }}>—</Typography>
    )}
  </CardContent>
</Card>



          </Box>

        
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '83% 17%' }, gap: 1.5 }}>
           
            <Box sx={{ display: 'grid', gap: 2.2 }}>
              {groupedData.length === 0 ? (
                <Card sx={{ background: 'rgba(30, 41, 59, 0.7)', backdropFilter: 'blur(12px)', border: '1px solid rgba(148, 163, 184, 0.2)', borderRadius: 2.5 }}>
                  <CardContent sx={{ p: 3, textAlign: 'center' }}>
                    <Typography sx={{ color: '#64748b' }}>No positions or pending orders</Typography>
                  </CardContent>
                </Card>
              ) : (
                groupedData.map(group => {
                  const isLong = group.positionSide === 'LONG';
                  return (
                    <Card
                      key={group.key}
                      sx={{
                        background: 'rgba(15, 23, 42, 0.9)',
                        backdropFilter: 'blur(16px)',
                        border: `2.5px solid ${isLong ? '#22c55e' : '#ef4444'}`,
                        borderRadius: 3,
                        boxShadow: '0 10px 30px rgba(0,0,0,0.4)',
                        overflow: 'hidden',
                        transition: 'transform 0.2s',
                        '&:hover': { transform: 'translateY(-2px)' }
                      }}
                    >
                      <CardContent sx={{ p: 2.5 }}>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
                          <Typography sx={{
                            fontFamily: 'Inter', fontWeight: 800, fontSize: '1.3rem',
                            color: isLong ? '#22c55e' : '#ef4444', letterSpacing: '0.5px'
                          }}>
                            {group.symbol} <span style={{ fontWeight: 600, opacity: 0.8 }}>• {group.positionSide}</span>
                          </Typography>
                          <Chip
                            label={group.position?.type || (group.pendingOrders[0]?.side === 'BUY' ? 'BUY' : 'SELL')}
                            color={isLong ? 'success' : 'error'}
                            size="small"
                            sx={{ fontWeight: 700, fontSize: '0.75rem', px: 1 }}
                          />
                        </Box>

                        {group.position && (
                          <Table size="small" sx={{ mb: 2, '& th': { fontSize: '0.75rem', fontWeight: 700, color: '#94a3b8' }, '& td': { fontSize: '0.8rem' } }}>
                            <TableHead>
                              <TableRow sx={{ background: 'rgba(30, 41, 59, 0.6)' }}>
                                {['QTY', 'ENTRY', 'MARK', 'P&L', 'BREAK EVEN', 'NOTIONAL', 'LIQ PRICE', 'MARGIN', 'WALLET', 'ACTIONS'].map(h => (
                                  <TableCell key={h} align="center" sx={{ py: 1 }}>{h}</TableCell>
                                ))}
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              <TableRow sx={{ background: 'rgba(15, 23, 42, 0.4)', '&:hover': { background: 'rgba(30, 41, 59, 0.5)' } }}>
                                <TableCell align="center" sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#60a5fa' }}>
                                  {Number(group.position.positionAmt).toFixed(4)}
                                </TableCell>
                                <TableCell align="center" sx={{ fontFamily: 'monospace', color: '#3b82f6' }}>
                                  {Number(group.position.entryPrice).toFixed(5)}
                                </TableCell>
                                <TableCell align="center" sx ={{ fontFamily: 'monospace', color: '#22c55e' }}>
                                  {Number(group.position.markPrice).toFixed(5)}
                                </TableCell>
                                <TableCell align="center" sx={{ fontFamily: 'monospace', fontWeight: 700, color: Number(group.position.unRealizedProfit) > 0 ? '#22c55e' : '#ef4444' }}>
                                  {(Number(group.position.unRealizedProfit)).toFixed(5)}
                                </TableCell>
                                <TableCell align="center" sx={{ fontFamily: 'monospace' }}>{Number(group.position.breakEvenPrice).toFixed(7)}</TableCell>
                                <TableCell align="center" sx={{ fontFamily: 'monospace', color: '#a78bfa' }}>{Number(group.position.notional).toFixed(2)}</TableCell>
                                <TableCell align="center" sx={{ fontFamily: 'monospace', color: '#ef4444' }}>{Number(group.position.liquidationPrice).toFixed(8)}</TableCell>
                                <TableCell align="center" sx={{ fontFamily: 'monospace' }}>{Number(group.position.isolatedMargin).toFixed(6)}</TableCell>
                                <TableCell align="center" sx={{ fontFamily: 'monospace' }}>{Number(group.position.isolatedWallet).toFixed(6)}</TableCell>
                                <TableCell align="center">
                                  <IconButton size="small" onClick={() => handleClose(group.symbol, group.position!.type, group.positionSide, Math.abs(Number(group.position!.positionAmt)))}>
                                    <Close fontSize="small" />
                                  </IconButton>
                                  <IconButton size="small" onClick={() => setMarginAdd({ open: true, symbol: group.symbol, side: group.position!.type })}>
                                    <Add fontSize="small" />
                                  </IconButton>
                                </TableCell>
                              </TableRow>
                            </TableBody>
                          </Table>
                        )}

                        {group.pendingOrders.length > 0 && (
                          <>
                            <Typography sx={{ fontSize: '0.85rem', fontWeight: 700, mb: 1, color: '#60a5fa', letterSpacing: '0.5px' }}>
                              Pending Orders
                            </Typography>
                            <Table size="small" sx={{ '& th': { fontSize: '0.7rem', color: '#94a3b8' }, '& td': { fontSize: '0.75rem' } }}>
                              <TableHead>
                                <TableRow sx={{ background: 'rgba(30, 41, 59, 0.5)' }}>
                                  {['ID', 'TYPE', 'QTY', 'ENTRY', 'SL', 'CLIENT', 'ACTION'].map(h => (
                                    <TableCell key={h} align="center" sx={{ py: 0.8 }}>{h}</TableCell>
                                  ))}
                                </TableRow>
                              </TableHead>
                 <TableBody>
            {group.pendingOrders.map(o => {
    const isStopMarket = o.type === 'STOP_MARKET';
    const isTakeProfit = o.type === 'TAKE_PROFIT_MARKET';
    const rowColor = isStopMarket ? '#ef4444' : isTakeProfit ? '#22c55e' : '#e2e8f0';
    return (
      <TableRow 
        key={o.id} 
        sx={{ 
          '&:hover': { background: 'rgba(51, 65, 85, 0.3)' },
          background: isStopMarket || isTakeProfit ? 'rgba(0,0,0,0.15)' : 'transparent'
        }}
      >
        <TableCell align="center" sx={{ fontFamily: 'monospace', color: rowColor }}>{o.orderId}</TableCell>
        <TableCell align="center" sx={{ color: rowColor, fontWeight: isStopMarket || isTakeProfit ? 700 : 400 }}>{o.type}</TableCell>
        <TableCell align="center" sx={{ fontWeight: 600, color: rowColor }}>{o.Qty}</TableCell>
        <TableCell align="center" sx={{ fontFamily: 'monospace', color: rowColor }}>
          {o.openPrice > 0 ? o.openPrice.toFixed(5) : '-'}
        </TableCell>
        <TableCell align="center" sx={{ fontFamily: 'monospace', color: isStopMarket ? '#ef4444' : '#22c55e', fontWeight: 700 }}>
          {o.stopLoss}
        </TableCell>
        <TableCell align="center" sx={{ fontFamily: 'monospace', fontSize: '0.65rem', color: rowColor }}>
          {o.ClientId}
        </TableCell>
        <TableCell align="center">
          {isStopMarket && (
            <IconButton size="small" onClick={() => openModifyDialog('SL', group, o)} sx={{ color: '#ef4444' }}>
              <Edit fontSize="small" />
            </IconButton>
          )}
          {isTakeProfit && (
            <IconButton size="small" onClick={() => openModifyDialog('TP', group, o)} sx={{ color: '#22c55e' }}>
              <Edit fontSize="small" />
            </IconButton>
          )}
        </TableCell>
      </TableRow>
    );
  })}
</TableBody>
    </Table>
        </>
          )}
        </CardContent>
           </Card>
                  );
                })
              )}
            </Box>

           
                  
<Card sx={{ 
  background: side === 'BUY' 
    ? 'rgba(34, 197, 94, 0.18)'   // green tint for BUY
    : 'rgba(239, 68, 68, 0.18)',  // red tint for SELL
  backdropFilter: 'blur(16px)', 
  border: `2px solid ${side === 'BUY' ? '#22c55e' : '#ef4444'}`, 
  borderRadius: 3, 
  boxShadow: '0 10px 30px rgba(0,0,0,0.3)',
  transition: 'all 0.3s ease'
}}>
  <CardContent sx={{ p: 2.2 }}>
    <Typography sx={{ fontFamily: 'Inter', fontWeight: 800, fontSize: '1.1rem', mb: 2, color: '#60a5fa', letterSpacing: '0.5px' }}>
      Place Order
    </Typography>

    {/* BUY / SELL Tabs */}
    <Box sx={{ display: 'flex', mb: 2, borderRadius: 2, overflow: 'hidden', border: '1px solid rgba(148,163,184,0.3)' }}>
      <Button
        fullWidth
        variant={side === 'BUY' ? 'contained' : 'text'}
        onClick={() => setSide('BUY')}
        sx={{
          borderRadius: 0,
          background: side === 'BUY' ? '#22c55e' : 'transparent',
          color: side === 'BUY' ? 'white' : '#94a3b8',
          fontWeight: 700,
          fontSize: '0.95rem',
          py: 1.2,
          '&:hover': { background: side === 'BUY' ? '#16a34a' : 'rgba(34,197,94,0.2)' }
        }}
      >
        BUY
      </Button>
      <Button
        fullWidth
        variant={side === 'SELL' ? 'contained' : 'text'}
        onClick={() => setSide('SELL')}
        sx={{
          borderRadius: 0,
          background: side === 'SELL' ? '#ef4444' : 'transparent',
          color: side === 'SELL' ? 'white' : '#94a3b8',
          fontWeight: 700,
          fontSize: '0.95rem',
          py: 1.2,
          '&:hover': { background: side === 'SELL' ? '#dc2626' : 'rgba(239,68,68,0.2)' }
        }}
      >
        SELL
      </Button>
    </Box>

    <Box sx={{ display: 'grid', gap: 1.2 }}>
      <Autocomplete
        options={availableSymbols}
        value={symbol}
        onChange={(_, v) => setSymbol(v || '')}
        onOpen={fetchSymbols}
        loading={availableSymbols.length === 0}
        renderInput={(params) => <TextField {...params} label="Symbol" size="small" sx={{ '& .MuiInputBase-input': { fontSize: '0.9rem' } }} />}
        disableClearable
      />

      <TextField label="Stop Loss" value={stopLoss} onChange={e => setStopLoss(e.target.value)} type="number" size="small" sx={{ '& input': { fontSize: '0.9rem' } }} />
      <TextField label="Take Profit" value={takeProfit} onChange={e => setTakeProfit(e.target.value)} type="number" size="small" sx={{ '& input': { fontSize: '0.9rem' } }} />
    </Box>

    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1.5 }}>
  <Typography sx={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: 600 }}>Risk</Typography>
  <Slider
    value={riskPercent * 100}
    onChange={(_, v) => setRiskPercent((v as number) / 100)}
    step={1}
    min={5}
    max={40}
    marks={[{ value: 5, label: '0.05%' }, { value: 30, label: '0.40%' }]}
    valueLabelDisplay="auto"
    valueLabelFormat={v => `${(v / 100).toFixed(2)}%`}
    sx={{ width: 120, color: '#60a5fa' }}
  />
  <Typography sx={{ fontSize: '0.8rem', fontWeight: 700, color: '#e2e8f0' }}>
    {riskPercent.toFixed(2)}%
  </Typography>
</Box>

    <Button 
      fullWidth 
      variant="contained" 
      onClick={handlePlaceOrder} 
      sx={{ 
        mt: 2, 
        fontSize: '0.85rem', 
        py: 1.4, 
        fontWeight: 700,
        background: side === 'BUY' ? '#22c55e' : '#ef4444',
        '&:hover': { background: side === 'BUY' ? '#16a34a' : '#dc2626' }
      }}
    >
      PLACE {side} ORDER
    </Button>
  </CardContent>
</Card>
          </Box>

         

         
         <Dialog 
  open={orderConfirmOpen} 
  onClose={() => { setOrderConfirmOpen(false); setIsScalpingMode(false); }} 
  maxWidth="sm" 
  fullWidth
  PaperProps={{
    sx: { 
      background: 'rgba(15, 23, 42, 0.95)', 
      backdropFilter: 'blur(16px)', 
      border: '1px solid rgba(148, 163, 184, 0.2)',
      borderRadius: 3,
      boxShadow: '0 20px 40px rgba(0,0,0,0.5)'
    }
  }}
>
  <DialogTitle sx={{ 
    fontFamily: 'Inter', 
    fontWeight: 800, 
    fontSize: '1.35rem', 
    color: '#60a5fa',
    textAlign: 'center',
    pb: 1
  }}>
    Confirm Order — <span style={{ color: '#a78bfa' }}>{orderConfirmData?.symbol}</span>
  </DialogTitle>

  <DialogContent dividers sx={{ py: 3 }}>
    <Box sx={{ display: 'grid', gap: 1.8 }}>
      {[
        ['Side', orderConfirmData?.side, '#60a5fa'],
        ['Qty', orderConfirmData?.quantity, '#e2e8f0'],
        ['Entry', orderConfirmData?.markPrice?.toFixed(5), '#3b82f6'],
        ['SL', orderConfirmData?.stopLoss?.toFixed(5), '#ef4444'],
        ['TP', orderConfirmData?.takeProfit?.toFixed(5), '#22c55e'],
        ['Risk %', (orderConfirmData?.riskPercent * 100).toFixed(2) + '%', '#fbbf24'],
        ['Max Loss', `$${orderConfirmData?.maxLossUSDT?.toFixed(2)}`, '#ef4444'],
        ['Max Profit', `$${orderConfirmData?.maxProfitUSDT?.toFixed(2)}`, '#22c55e'],
        ['R:R', `1:${orderConfirmData?.riskRewardRatio}`, '#a78bfa']
      ].map(([label, value, color]) => (
        <Box key={label} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography sx={{ fontSize: '0.95rem', color: '#94a3b8', fontWeight: 600 }}>
            {label}
          </Typography>
          <Typography sx={{ 
            fontFamily: 'monospace', 
            fontSize: '1.15rem', 
            fontWeight: 800, 
            color: color || '#e2e8f0',
            letterSpacing: '0.5px',
            textShadow: label.includes('SL') || label.includes('Loss') 
              ? '0 0 8px rgba(239,68,68,0.4)' 
              : label.includes('TP') || label.includes('Profit')
                ? '0 0 8px rgba(34,197,94,0.4)'
                : 'none'
          }}>
            {value}
          </Typography>
        </Box>
      ))}
    </Box>

    {/* Scalping Mode Toggle */}
    <Box sx={{ 
      mt: 4, 
      p: 2.5, 
      background: 'rgba(30, 41, 59, 0.7)', 
      borderRadius: 2.5, 
      border: '1px solid rgba(96, 165, 250, 0.3)',
      display: 'flex', 
      alignItems: 'center', 
      gap: 2.5,
      transition: 'all 0.3s ease'
    }}>
      <input
        type="checkbox"
        id="scalping"
        checked={isScalpingMode}
        onChange={(e) => setIsScalpingMode(e.target.checked)}
        style={{ 
          width: 28, 
          height: 28, 
          cursor: 'pointer', 
          accentColor: '#60a5fa',
          borderRadius: '6px'
        }}
      />
      <label 
        htmlFor="scalping" 
        style={{ 
          cursor: 'pointer', 
          fontFamily: 'Inter',
          fontSize: '1.15rem', 
          fontWeight: 800, 
          color: '#60a5fa',
          letterSpacing: '0.5px',
          textShadow: '0 0 12px rgba(96, 165, 250, 0.5)'
        }}
      >
        Scalping Mode <span style={{ fontSize: '0.9rem', opacity: 0.9 }}>(faster & tighter)</span>
      </label>
    </Box>
  </DialogContent>

  <DialogActions sx={{ p: 3, justifyContent: 'space-between', gap: 2 }}>
    <Button 
      onClick={() => { setOrderConfirmOpen(false); setIsScalpingMode(false); }}
      sx={{ 
        fontWeight: 700, 
        fontSize: '1rem',
        px: 4,
        color: '#94a3b8',
        border: '1px solid rgba(148,163,184,0.3)',
        '&:hover': { background: 'rgba(148,163,184,0.1)' }
      }}
    >
      Cancel
    </Button>

    <Button
      variant="contained"
      onClick={handleConfirmPlaceOrder}
      sx={{ 
        fontWeight: 800,
        fontSize: '1.1rem',
        px: 5,
        py: 1.4,
        background: isScalpingMode 
          ? 'linear-gradient(135deg, #8b5cf6, #3b82f6)' 
          : 'linear-gradient(135deg, #22c55e, #16a34a)',
        color: 'white',
        boxShadow: isScalpingMode 
          ? '0 0 20px rgba(139, 92, 246, 0.5)' 
          : '0 0 20px rgba(34, 197, 94, 0.5)',
        borderRadius: 2,
        '&:hover': {
          transform: 'translateY(-2px)',
          boxShadow: isScalpingMode 
            ? '0 0 30px rgba(139, 92, 246, 0.7)' 
            : '0 0 30px rgba(34, 197, 94, 0.7)'
        }
      }}
    >
      {isScalpingMode ? 'Confirm & Scalp' : 'Confirm Order'}
    </Button>
  </DialogActions>
</Dialog>






          <Dialog open={marginAdd.open} onClose={() => setMarginAdd({ ...marginAdd, open: false })}>
            <DialogTitle>Add Margin</DialogTitle>
            <DialogContent><TextField fullWidth label="USDT" value={marginAmount} onChange={e => setMarginAmount(e.target.value)} type="number" sx={{ mt: 1 }} /></DialogContent>
            <DialogActions>
              <Button onClick={() => setMarginAdd({ ...marginAdd, open: false })}>Cancel</Button>
              <Button variant="contained" onClick={handleAddMargin}>Add</Button>
            </DialogActions>
          </Dialog>

          <Dialog open={confirmDialog.open} onClose={() => setConfirmDialog({ open: false, duration: 0, label: '' })}>
            <DialogTitle>Confirm Block</DialogTitle>
            <DialogContent><Typography>Activate for {confirmDialog.label}?</Typography></DialogContent>
            <DialogActions>
              <Button onClick={() => setConfirmDialog({ open: false, duration: 0, label: '' })}>Cancel</Button>
              <Button variant="contained" onClick={handleConfirmBlock}>Confirm</Button>
            </DialogActions>
          </Dialog>



        
          <Dialog open={!!modifyDialog?.open} onClose={() => { setModifyDialog(null); setNewPrice(''); }} maxWidth="xs" fullWidth>
            <DialogTitle sx={{ fontWeight: 700, fontSize: '1rem', color: modifyDialog?.type === 'SL' ? '#ef4444' : '#22c55e' }}>
              Modify {modifyDialog?.type === 'SL' ? 'Stop Loss' : 'Take Profit'} – {modifyDialog?.symbol}
            </DialogTitle>
            <DialogContent dividers>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <Box sx={{ width: 16, height: 3, background: modifyDialog?.type === 'SL' ? '#ef4444' : '#22c55e', borderRadius: 1 }} />
                <Typography sx={{ fontSize: '0.85rem', color: '#94a3b8' }}>
                  Current: {modifyDialog?.oldPrice.toFixed(5)}
                </Typography>
              </Box>
              <TextField
                fullWidth
                label="New Price"
                value={newPrice}
                onChange={e => setNewPrice(e.target.value)}
                type="number"
                size="small"
                sx={{ mt: 1 }}
              />
            </DialogContent>
            <DialogActions>
              <Button onClick={() => { setModifyDialog(null); setNewPrice(''); }}>Cancel</Button>
              <Button
                variant="contained"
                onClick={async () => {
                  if (!modifyDialog || !newPrice) return;
                  try {
                    await modifyOrder({
                      symbol: modifyDialog.symbol,
                      orderId: modifyDialog.orderId,
                      positionAmt: modifyDialog.positionAmt,
                      side: modifyDialog.side,
                      positionSide: modifyDialog.positionSide,
                      oldPrice: modifyDialog.oldPrice,
                      lastupdate: modifyDialog.updateTime,
                      newPrice: Number(newPrice),
                      type: modifyDialog.type,
                      clientId:modifyDialog.clientId
                    });
                    setModifyDialog(null);
                    setNewPrice('');
                  } catch (err: any) {
                    setError(err.message);
                  }
                }}
                sx={{ fontWeight: 600 }}
              >
                Update
              </Button>
            </DialogActions>
          </Dialog>
        </Box>
      </Box>
    </>
  );
};

export default Dashboard;


